-- ============================================================================
-- Gharpayy CRM — one-shot backend setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once.
--
-- Creates the backend for the three activated modules:
--   M-POWER CALL · Booking Flow Split · Closing Desk
-- ============================================================================

-- ------------------------------------------------------------ call records
-- M-POWER CALL already had code to write here; the table never existed on
-- this project, and on the original project its policies granted access only
-- to `authenticated` while the app ships no login screen. Hence: zero rows,
-- ever. Created here with policies that match how the app actually runs.
CREATE TABLE IF NOT EXISTS public.call_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  called_at     timestamptz NOT NULL DEFAULT now(),
  operator_id   uuid,
  operator_name text,
  lead_ulid     text,
  canonical_id  text,
  customer_name text,
  agenda        text NOT NULL,
  agenda_source text,
  outcome       text NOT NULL,
  duration_sec  integer,
  capture       jsonb NOT NULL DEFAULT '{}'::jsonb,
  movement      text,
  message_now   text,
  message_sent  boolean NOT NULL DEFAULT false,
  follow_up     jsonb,
  follow_up_state text,
  next_step     jsonb,
  stage_after   text,
  waste         jsonb NOT NULL DEFAULT '[]'::jsonb,
  client_id     text
);

CREATE INDEX IF NOT EXISTS call_records_called_at_idx ON public.call_records (called_at DESC);
CREATE INDEX IF NOT EXISTS call_records_canonical_idx ON public.call_records (canonical_id);
CREATE UNIQUE INDEX IF NOT EXISTS call_records_client_id_idx
  ON public.call_records (client_id) WHERE client_id IS NOT NULL;

-- ---------------------------------------------------------------- customers
-- One customer = one row. The id is canonicalCustomerId(phone, name), the
-- same value every module already computes, so the lead list, the call
-- screen, the work panel and the admin room all read one truth.
CREATE TABLE IF NOT EXISTS public.crm_customers (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  phone            text NOT NULL,
  wa_account       text,
  stage            text NOT NULL DEFAULT 'WHERE',
  owner            text,
  handler          text,
  temp             text,
  temp_reason      text,
  labels           text[] NOT NULL DEFAULT '{}',
  last_message     text,
  last_activity_at timestamptz,
  last_action_at   timestamptz,
  next_action      text,
  next_action_at   timestamptz,          -- the deadline. overdue = now() > this
  journey          jsonb NOT NULL DEFAULT '{}'::jsonb,
  qualified_at     timestamptz,
  escalated        boolean NOT NULL DEFAULT false,
  closed_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_customers_stage_idx       ON public.crm_customers (stage);
CREATE INDEX IF NOT EXISTS crm_customers_owner_idx       ON public.crm_customers (owner);
CREATE INDEX IF NOT EXISTS crm_customers_next_action_idx ON public.crm_customers (next_action_at);

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
  module      text,
  changes     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_events_customer_idx ON public.crm_events (customer_id, at DESC);

-- -------------------------------------------------------------- commitments
-- Closing Desk promises. Every promise is settled or moved with a reason.
CREATE TABLE IF NOT EXISTS public.crm_commitments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id text NOT NULL REFERENCES public.crm_customers(id) ON DELETE CASCADE,
  promised_by text NOT NULL,
  promised_at timestamptz NOT NULL DEFAULT now(),
  due_at      timestamptz NOT NULL,
  window_id   text,
  steps       text[] NOT NULL DEFAULT '{}',
  note        text,
  state       text NOT NULL DEFAULT 'open',   -- open | kept | missed | moved
  settled_at  timestamptz,
  settled_by  text,
  miss_reason text,
  moved_from  timestamptz,
  source      text,                           -- 'call-handoff' = auto-created
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_commitments_customer_idx ON public.crm_commitments (customer_id);
CREATE INDEX IF NOT EXISTS crm_commitments_due_idx      ON public.crm_commitments (due_at) WHERE state = 'open';

-- -------------------------------------------------------------- work claims
-- "Who is on this customer right now" — two operators never collide, and
-- admin sees the same live state the operator sees.
CREATE TABLE IF NOT EXISTS public.crm_work_claims (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    text NOT NULL REFERENCES public.crm_customers(id) ON DELETE CASCADE,
  operator_id    text NOT NULL,
  operator_name  text NOT NULL,
  module         text NOT NULL,
  claimed_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  released_at    timestamptz,
  release_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_work_claims_live_idx
  ON public.crm_work_claims (customer_id) WHERE released_at IS NULL;

-- ----------------------------------------------------------------- touch
CREATE OR REPLACE FUNCTION public.crm_touch_updated_at() RETURNS trigger AS $fn$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS crm_customers_touch ON public.crm_customers;
CREATE TRIGGER crm_customers_touch BEFORE UPDATE ON public.crm_customers
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

DROP TRIGGER IF EXISTS crm_commitments_touch ON public.crm_commitments;
CREATE TRIGGER crm_commitments_touch BEFORE UPDATE ON public.crm_commitments
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

-- ------------------------------------------------------------------- RLS
-- The app ships no login screen, so every visitor is the `anon` role.
-- These tables hold demo CRM data and no credentials, so anon may read and
-- write. To lock down later: add a login, then swap `anon` for
-- `authenticated` in the grants and policies below.
ALTER TABLE public.call_records    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_customers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_work_claims ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.call_records, public.crm_customers, public.crm_events,
  public.crm_commitments, public.crm_work_claims
  TO anon, authenticated;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'call_records','crm_customers','crm_events','crm_commitments','crm_work_claims'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)',
      t || '_all', t);
  END LOOP;
END
$do$;

-- ------------------------------------------------------------------ done
SELECT 'setup complete' AS status,
       (SELECT count(*) FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('call_records','crm_customers','crm_events',
                              'crm_commitments','crm_work_claims')) AS tables_created;
