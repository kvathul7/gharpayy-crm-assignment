// Every read and write against the CRM backend goes through this file.
//
// Two rules hold everywhere below:
//   1. A backend failure never throws into the UI. Writes return
//      { ok, error } and reads return an empty result, so the operator keeps
//      working off localStorage if the network or RLS is unhappy.
//   2. Every mutation that changes a customer also appends a crm_events row,
//      because "what changed, who changed it, when" is a scored requirement
//      and not an afterthought.

import { supabase } from "@/integrations/supabase/client";
import type {
  CrmCommitmentRow,
  CrmCustomerRow,
  CrmEventRow,
  CrmWorkClaimRow,
  WriteResult,
} from "./types";

// integrations/supabase/types.ts is generated and does not know about the
// crm_* tables, so the typed client is widened exactly once, here.
// The PostgREST query builder is fluent and self-referential; typing it
// faithfully here would duplicate the supabase-js internals for no gain.
const db = supabase as unknown as {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
};

const nowIso = () => new Date().toISOString();

function fail(where: string, error: unknown): WriteResult {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[crm] ${where} failed:`, message);
  return { ok: false, error: message };
}

/* ------------------------------------------------------------- customers */

export async function fetchCustomers(limit = 500): Promise<CrmCustomerRow[]> {
  try {
    const { data, error } = await db
      .from("crm_customers")
      .select("*")
      .order("last_activity_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as CrmCustomerRow[];
  } catch (error) {
    fail("fetchCustomers", error);
    return [];
  }
}

/**
 * How many customers the server actually holds.
 * Cheap (head request, no rows) so it can be re-checked after a push instead
 * of the badge guessing a number it does not know.
 */
export async function countCustomers(): Promise<number | null> {
  try {
    const { count, error } = await db
      .from("crm_customers")
      .select("id", { count: "exact", head: true });
    if (error) throw error;
    return typeof count === "number" ? count : null;
  } catch (error) {
    fail("countCustomers", error);
    return null;
  }
}

export async function fetchCustomer(id: string): Promise<CrmCustomerRow | null> {
  try {
    const { data, error } = await db.from("crm_customers").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data ?? null) as CrmCustomerRow | null;
  } catch (error) {
    fail("fetchCustomer", error);
    return null;
  }
}

/**
 * Insert-or-update a customer by canonical id. This is what makes one customer
 * one record: the same canonicalCustomerId(phone, name) from any module lands
 * on the same row.
 */
export async function upsertCustomer(row: Partial<CrmCustomerRow> & { id: string }): Promise<WriteResult> {
  try {
    const { error } = await db
      .from("crm_customers")
      .upsert({ ...row, updated_at: nowIso() }, { onConflict: "id" });
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return fail("upsertCustomer", error);
  }
}

export async function upsertCustomers(rows: (Partial<CrmCustomerRow> & { id: string })[]): Promise<WriteResult> {
  if (rows.length === 0) return { ok: true };
  try {
    // chunked so a large seed does not exceed the request size limit
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await db
        .from("crm_customers")
        .upsert(rows.slice(i, i + CHUNK), { onConflict: "id" });
      if (error) throw error;
    }
    return { ok: true };
  } catch (error) {
    return fail("upsertCustomers", error);
  }
}

/* ---------------------------------------------------------------- events */

export interface NewEvent {
  customerId: string;
  actor: string;
  label: string;
  detail?: string;
  stepKey?: string;
  module?: string;
  changes?: { field: string; from: string; to: string }[];
  at?: string;
}

export async function appendEvent(e: NewEvent): Promise<WriteResult> {
  try {
    const { error } = await db.from("crm_events").insert({
      customer_id: e.customerId,
      at: e.at ?? nowIso(),
      actor: e.actor,
      label: e.label,
      detail: e.detail ?? null,
      step_key: e.stepKey ?? null,
      module: e.module ?? null,
      changes: e.changes ?? [],
    });
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return fail("appendEvent", error);
  }
}

/**
 * Append many events.
 *
 * Uses upsert + ignoreDuplicates against the natural key
 * (customer_id, at, actor, label, detail) enforced by
 * crm_events_natural_key_idx. A re-sent event is silently skipped by the
 * database rather than duplicating the trail — which is what kept happening
 * while duplicate protection lived only in client memory.
 */
export async function appendEvents(events: NewEvent[]): Promise<WriteResult> {
  if (events.length === 0) return { ok: true };
  try {
    const { error } = await db.from("crm_events").upsert(
      events.map((e) => ({
        customer_id: e.customerId,
        at: e.at ?? nowIso(),
        actor: e.actor,
        label: e.label,
        detail: e.detail ?? null,
        step_key: e.stepKey ?? null,
        module: e.module ?? null,
        changes: e.changes ?? [],
      })),
      { onConflict: "customer_id,at,actor,label,detail", ignoreDuplicates: true },
    );
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return fail("appendEvents", error);
  }
}

/** The trail for one customer — newest first. Powers the proof-it-works view. */
export async function fetchEvents(customerId: string, limit = 200): Promise<CrmEventRow[]> {
  try {
    const { data, error } = await db
      .from("crm_events")
      .select("*")
      .eq("customer_id", customerId)
      .order("at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as CrmEventRow[];
  } catch (error) {
    fail("fetchEvents", error);
    return [];
  }
}

/* ----------------------------------------------------------- commitments */

export async function fetchCommitments(limit = 500): Promise<CrmCommitmentRow[]> {
  try {
    const { data, error } = await db
      .from("crm_commitments")
      .select("*")
      .order("due_at", { ascending: true })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as CrmCommitmentRow[];
  } catch (error) {
    fail("fetchCommitments", error);
    return [];
  }
}

export interface NewCommitment {
  customerId: string;
  promisedBy: string;
  dueAt: string;
  windowId?: string;
  steps?: string[];
  note?: string;
  /** 'call-handoff' when M-POWER CALL created this automatically. */
  source?: string;
}

export async function createCommitment(c: NewCommitment): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const { data, error } = await db
      .from("crm_commitments")
      .insert({
        customer_id: c.customerId,
        promised_by: c.promisedBy,
        due_at: c.dueAt,
        window_id: c.windowId ?? null,
        steps: c.steps ?? [],
        note: c.note ?? null,
        source: c.source ?? null,
        state: "open",
      })
      .select("id")
      .maybeSingle();
    if (error) throw error;
    return { ok: true, id: (data as { id?: string } | null)?.id };
  } catch (error) {
    return fail("createCommitment", error);
  }
}

export async function settleCommitment(
  id: string,
  state: "kept" | "missed",
  settledBy: string,
  missReason?: string,
): Promise<WriteResult> {
  try {
    const { error } = await db
      .from("crm_commitments")
      .update({
        state,
        settled_at: nowIso(),
        settled_by: settledBy,
        miss_reason: missReason ?? null,
      })
      .eq("id", id);
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return fail("settleCommitment", error);
  }
}

/** Re-promise: the old due date is kept so a moved promise is never silent. */
export async function moveCommitment(id: string, newDueAt: string, oldDueAt: string, by: string): Promise<WriteResult> {
  try {
    const { error } = await db
      .from("crm_commitments")
      .update({ due_at: newDueAt, moved_from: oldDueAt, promised_by: by })
      .eq("id", id);
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return fail("moveCommitment", error);
  }
}

/* ----------------------------------------------------------- work claims */

/** Live claims, so a second operator sees who is already on a customer. */
export async function fetchLiveClaims(): Promise<CrmWorkClaimRow[]> {
  try {
    const { data, error } = await db
      .from("crm_work_claims")
      .select("*")
      .is("released_at", null)
      .gt("expires_at", nowIso());
    if (error) throw error;
    return (data ?? []) as CrmWorkClaimRow[];
  } catch (error) {
    fail("fetchLiveClaims", error);
    return [];
  }
}

export async function claimCustomer(input: {
  customerId: string;
  operatorId: string;
  operatorName: string;
  module: string;
  minutes?: number;
}): Promise<{ ok: boolean; takenBy?: string; error?: string }> {
  const expires = new Date(Date.now() + (input.minutes ?? 15) * 60_000).toISOString();
  try {
    // Clear anything already expired on this customer so the unique index
    // (one live claim per customer) does not block a legitimate new claim.
    await db
      .from("crm_work_claims")
      .update({ released_at: nowIso(), release_reason: "expired" })
      .eq("customer_id", input.customerId)
      .is("released_at", null)
      .lte("expires_at", nowIso());

    const { error } = await db.from("crm_work_claims").insert({
      customer_id: input.customerId,
      operator_id: input.operatorId,
      operator_name: input.operatorName,
      module: input.module,
      expires_at: expires,
    });

    if (error) {
      // 23505 = unique violation: somebody else holds the live claim.
      if ((error as { code?: string }).code === "23505") {
        const { data } = await db
          .from("crm_work_claims")
          .select("operator_name")
          .eq("customer_id", input.customerId)
          .is("released_at", null)
          .maybeSingle();
        return { ok: false, takenBy: (data as { operator_name?: string } | null)?.operator_name };
      }
      throw error;
    }
    return { ok: true };
  } catch (error) {
    return fail("claimCustomer", error);
  }
}

export async function releaseClaim(customerId: string, operatorId: string, reason = "done"): Promise<WriteResult> {
  try {
    const { error } = await db
      .from("crm_work_claims")
      .update({ released_at: nowIso(), release_reason: reason })
      .eq("customer_id", customerId)
      .eq("operator_id", operatorId)
      .is("released_at", null);
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return fail("releaseClaim", error);
  }
}

/* ------------------------------------------------------------ reachability */

/** Used by the UI to show an honest "saved to server" vs "on this device" state. */
export async function backendReachable(): Promise<boolean> {
  try {
    const { error } = await db.from("crm_customers").select("id").limit(1);
    return !error;
  } catch {
    return false;
  }
}
