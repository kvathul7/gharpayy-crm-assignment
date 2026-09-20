-- ============================================================================
-- Make duplicate audit events impossible.
--
-- Paste into Supabase → SQL Editor → New query → Run.  Safe to run twice.
--
-- Why this exists
-- ---------------
-- Duplicate protection used to live in the client: an in-memory map of "events
-- already pushed for this customer". That map is rebuilt on every page load,
-- so any load where the initial read failed re-sent the entire local history.
-- It was patched twice and broke twice, because client bookkeeping cannot
-- guarantee an invariant that spans devices, tabs and reloads.
--
-- The same event, for the same customer, at the same instant, by the same
-- person, with the same label IS the same event. That is a property of the
-- data, so the database should enforce it — exactly like crm_work_claims
-- already refuses a second live claim.
-- ============================================================================

-- 1. Collapse what is already there, keeping the earliest row of each group.
DELETE FROM public.crm_events a
USING public.crm_events b
WHERE a.ctid > b.ctid
  AND a.customer_id IS NOT DISTINCT FROM b.customer_id
  AND a.at          IS NOT DISTINCT FROM b.at
  AND a.actor       IS NOT DISTINCT FROM b.actor
  AND a.label       IS NOT DISTINCT FROM b.label
  AND COALESCE(a.detail, '') = COALESCE(b.detail, '');

-- 2. Refuse them from now on, whatever the client believes.
--    COALESCE on detail because NULLs never collide in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS crm_events_natural_key_idx
  ON public.crm_events (customer_id, at, actor, label, COALESCE(detail, ''));

-- 3. What survived.
SELECT module, count(*) AS events
FROM public.crm_events
GROUP BY module
ORDER BY events DESC;
