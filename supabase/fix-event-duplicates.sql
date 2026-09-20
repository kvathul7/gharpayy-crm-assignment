-- ============================================================================
-- Make duplicate audit events impossible.
--
-- Paste into Supabase → SQL Editor → New query → Run.  Safe to run repeatedly.
--
-- Why this exists
-- ---------------
-- Duplicate protection used to live in the client: an in-memory map of "events
-- already pushed for this customer". That map is rebuilt on every page load, so
-- any load whose initial read failed re-sent the entire local history. It was
-- patched twice and broke twice; 2,842 seeded events reached 11,371.
--
-- The same event, for the same customer, at the same instant, by the same
-- person, with the same label IS the same event. That is a property of the
-- data, so the database enforces it — exactly like crm_work_claims already
-- refuses a second live claim.
--
-- `detail` is normalised to '' rather than NULL because NULLs never collide in
-- a unique index, and because ON CONFLICT can only target a plain column list:
-- an expression index such as COALESCE(detail,'') would reject the client's
-- upsert with 23505 instead of letting it skip the row quietly.
-- ============================================================================

-- 0. No NULL details, so the natural key is always comparable.
UPDATE public.crm_events SET detail = '' WHERE detail IS NULL;

ALTER TABLE public.crm_events ALTER COLUMN detail SET DEFAULT '';

-- 1. Collapse what is already there, keeping the earliest row of each group.
DELETE FROM public.crm_events a
USING public.crm_events b
WHERE a.ctid > b.ctid
  AND a.customer_id = b.customer_id
  AND a.at          = b.at
  AND a.actor       = b.actor
  AND a.label       = b.label
  AND a.detail      = b.detail;

-- 2. Replace the expression index with one ON CONFLICT can actually target.
DROP INDEX IF EXISTS public.crm_events_natural_key_idx;

CREATE UNIQUE INDEX IF NOT EXISTS crm_events_natural_key_idx
  ON public.crm_events (customer_id, at, actor, label, detail);

-- 3. What survived.
SELECT module, count(*) AS events
FROM public.crm_events
GROUP BY module
ORDER BY events DESC;
