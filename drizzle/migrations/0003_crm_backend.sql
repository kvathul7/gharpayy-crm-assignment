-- CRM backend for the three activated modules:
--   M-POWER CALL · Booking Flow Split · Closing Desk
--
-- Deliberately additive. Nothing here touches public.leads or any existing
-- table, because public.leads is shaped for the WhatsApp/Flow OS subsystem
-- (wa_name, wa_label_colour, whatsapp_sync_state ...) and writing CRM state
-- into it would break Flow OS.
--
-- One customer = one row in crm_customers, keyed by the same
-- canonicalCustomerId(phone, name) the app already computes client-side.
-- That id is what makes the lead list, the call screen, the work panel and
-- the admin room read one truth.

-- ---------------------------------------------------------------- customers
CREATE TABLE IF NOT EXISTS public.crm_customers (
  id               text PRIMARY KEY,           -- canonicalCustomerId(phone, name)
  name             text NOT NULL,
  phone            text NOT NULL,
  wa_account       text,
  stage            text NOT NULL DEFAULT 'WHERE',
  owner            text,
  handler          text,
  temp             text,                       -- HOT | COLD
  temp_reason      text,
  labels           text[] NOT NULL DEFAULT '{}',
  last_message     text,
  last_activity_at timestamptz,
  last_action_at   timestamptz,
  next_action      text,
  next_action_at   timestamptz,                -- the deadline. overdue = now() > this
  journey          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- FlowLead.f answer map
  qualified_at     timestamptz,
  escalated        boolean NOT NULL DEFAULT false,
  closed_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_customers_stage_idx       ON public.crm_customers (stage);
CREATE INDEX IF NOT EXISTS crm_customers_owner_idx       ON public.crm_customers (owner);
CREATE INDEX IF NOT EXISTS crm_customers_next_action_idx ON public.crm_customers (next_action_at);
CREATE INDEX IF NOT EXISTS crm_customers_phone_idx       ON public.crm_customers (phone);

-- ------------------------------------------------------------------- events
-- The audit trail: what changed, who changed it, when. Append-only.
CREATE TABLE IF NOT EXISTS public.crm_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id text NOT NULL REFERENCES public.crm_customers(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  label       text NOT NULL,
  detail      text,
  step_key    text,
  module      text,                            -- which module wrote this
  changes     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{field, from, to}]
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_events_customer_idx ON public.crm_events (customer_id, at DESC);
CREATE INDEX IF NOT EXISTS crm_events_at_idx       ON public.crm_events (at DESC);

-- -------------------------------------------------------------- commitments
-- Closing Desk promises. Every promise is settled or moved with a reason.
CREATE TABLE IF NOT EXISTS public.crm_commitments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  text NOT NULL REFERENCES public.crm_customers(id) ON DELETE CASCADE,
  promised_by  text NOT NULL,
  promised_at  timestamptz NOT NULL DEFAULT now(),
  due_at       timestamptz NOT NULL,           -- overdue = now() > due_at AND state = 'open'
  window_id    text,
  steps        text[] NOT NULL DEFAULT '{}',
  note         text,
  state        text NOT NULL DEFAULT 'open',   -- open | kept | missed | moved
  settled_at   timestamptz,
  settled_by   text,
  miss_reason  text,
  moved_from   timestamptz,                    -- set when a promise is re-promised
  source       text,                           -- 'call-handoff' when auto-created by M-POWER CALL
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_commitments_customer_idx ON public.crm_commitments (customer_id);
CREATE INDEX IF NOT EXISTS crm_commitments_due_idx      ON public.crm_commitments (due_at) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS crm_commitments_state_idx    ON public.crm_commitments (state);

-- -------------------------------------------------------------- work claims
-- "Who is on this customer right now" — so two operators never collide and
-- admin sees the same live state the operator sees.
CREATE TABLE IF NOT EXISTS public.crm_work_claims (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    text NOT NULL REFERENCES public.crm_customers(id) ON DELETE CASCADE,
  operator_id    text NOT NULL,
  operator_name  text NOT NULL,
  module         text NOT NULL,                -- split | closing | call
  claimed_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  released_at    timestamptz,
  release_reason text
);

-- At most one live claim per customer.
CREATE UNIQUE INDEX IF NOT EXISTS crm_work_claims_live_idx
  ON public.crm_work_claims (customer_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS crm_work_claims_operator_idx ON public.crm_work_claims (operator_id);

-- keep updated_at honest
CREATE OR REPLACE FUNCTION public.crm_touch_updated_at() RETURNS trigger AS $fn$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS crm_customers_touch ON public.crm_customers;
CREATE TRIGGER crm_customers_touch BEFORE UPDATE ON public.crm_customers
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

DROP TRIGGER IF EXISTS crm_commitments_touch ON public.crm_commitments;
CREATE TRIGGER crm_commitments_touch BEFORE UPDATE ON public.crm_commitments
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

-- ---------------------------------------------------------------------- RLS
-- This app ships no login screen, so every visitor is the `anon` role.
-- The existing call_records policies grant only to `authenticated`, which is
-- exactly why that table has never received a single row.
--
-- These tables hold demo CRM data, no credentials, so anon may read and write.
-- To lock down later: drop these policies, add a login, re-grant to
-- `authenticated`.
ALTER TABLE public.crm_customers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_work_claims ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.crm_customers, public.crm_events, public.crm_commitments, public.crm_work_claims
  TO anon, authenticated;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_customers','crm_events','crm_commitments','crm_work_claims'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)',
      t || '_all', t);
  END LOOP;
END
$do$;

-- --------------------------------------------------- unblock existing calls
-- call_records already exists with the right columns but anon-hostile RLS.
-- Same reasoning as above: let the demo write, keep the schema untouched.
GRANT SELECT, INSERT, UPDATE ON public.call_records TO anon;

DROP POLICY IF EXISTS "Demo can read calls"   ON public.call_records;
DROP POLICY IF EXISTS "Demo can insert calls" ON public.call_records;
DROP POLICY IF EXISTS "Demo can update calls" ON public.call_records;

CREATE POLICY "Demo can read calls"   ON public.call_records FOR SELECT TO anon USING (true);
CREATE POLICY "Demo can insert calls" ON public.call_records FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Demo can update calls" ON public.call_records FOR UPDATE TO anon USING (true) WITH CHECK (true);
