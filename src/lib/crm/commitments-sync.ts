// Puts Closing Desk promises on the hosted backend.
//
// The local store (lib/commitments/store.ts) keeps working exactly as it did:
// it is still the instant, synchronous source the board renders from. This
// module mirrors it to crm_commitments so a promise made on one device is
// visible on another, and to the admin.
//
// Local ids look like "cc-1726824…-a1b2c". The server column is a uuid, so
// rather than ask for a schema change we derive a *deterministic* uuid from
// the local id: the same promise always maps to the same server row, which
// makes every write an idempotent upsert.

import { supabase } from "@/integrations/supabase/client";
import type { CloseCommitment } from "@/lib/commitments/store";
import type { CrmCommitmentRow } from "./types";

// The PostgREST query builder is fluent and self-referential; typing it
// faithfully here would duplicate the supabase-js internals for no gain.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (t: string) => any };

/* ------------------------------------------------- deterministic uuid */

/** cyrb128 — four well-mixed 32-bit hashes from a string. */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i += 1) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

const hex8 = (n: number) => n.toString(16).padStart(8, "0");

/** Stable uuid-shaped id for a local commitment id. */
export function serverIdFor(localId: string): string {
  const [a, b, c, d] = cyrb128(`gharpayy.commitment:${localId}`);
  const s = hex8(a) + hex8(b) + hex8(c) + hex8(d); // 32 hex chars
  // force version 4 / variant bits so postgres accepts it as a uuid
  const v = s.slice(0, 12) + "4" + s.slice(13, 16) + "a" + s.slice(17, 32);
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

/* ------------------------------------------------------------ mapping */

/**
 * Local status vocabulary is open|kept|broken|cancelled; the table stores the
 * same strings so nothing is lost in translation.
 */
export function commitmentToRow(
  c: CloseCommitment,
  customerId: string,
): Partial<CrmCommitmentRow> & { id: string } {
  const moved = c.history.find((h) => h.kind === "changed" && h.prevDueAt);
  return {
    id: c.serverId ?? serverIdFor(c.id),
    customer_id: customerId,
    promised_by: c.promisedBy,
    promised_at: c.promisedAt,
    due_at: c.dueAt,
    window_id: c.windowId,
    steps: c.steps ?? [],
    note: c.note || null,
    state: c.status as CrmCommitmentRow["state"],
    settled_at: c.closedAt ?? null,
    settled_by: c.status === "open" ? null : c.promisedBy,
    miss_reason: c.problem ?? null,
    moved_from: moved?.prevDueAt ?? null,
  };
}

/** Turn a server promise into the shape the Closing board renders. */
export function rowToCommitment(
  r: CrmCommitmentRow,
  leadId: string,
  leadName: string,
  leadPhone = "",
): CloseCommitment {
  return {
    id: `cc-srv-${r.id}`,
    serverId: r.id,
    leadId,
    leadName,
    leadPhone,
    windowId: (r.window_id ?? "24h") as CloseCommitment["windowId"],
    dueAt: r.due_at,
    blocker: "",
    confidence: 80,
    steps: r.steps ?? [],
    note: r.note ?? "",
    promisedBy: r.promised_by,
    promisedAt: r.promised_at,
    status: (r.state === "missed" ? "broken" : r.state) as CloseCommitment["status"],
    problem: r.miss_reason ?? undefined,
    closedAt: r.settled_at ?? undefined,
    changeCount: r.moved_from ? 1 : 0,
    history: [
      {
        at: r.promised_at,
        by: r.promised_by,
        kind: "promised",
        windowId: (r.window_id ?? "24h") as CloseCommitment["windowId"],
        dueAt: r.due_at,
        note: r.source === "call-handoff" ? "Created automatically by M-POWER CALL" : r.note ?? undefined,
        steps: r.steps ?? [],
      },
    ],
  };
}

/* ------------------------------------------------------------ pushing */

const pushed = new Map<string, string>();

function fingerprint(c: CloseCommitment): string {
  return JSON.stringify([c.dueAt, c.status, c.windowId, c.steps, c.note, c.problem, c.history.length]);
}

export interface CommitmentPushResult {
  ok: boolean;
  count: number;
  error?: string;
}

/**
 * Mirror the promises that changed.
 * `resolveCustomerId` maps a Booking Flow leadId to the canonical customer id
 * the server knows, because crm_commitments.customer_id is a real foreign key.
 */
export async function pushCommitments(
  all: CloseCommitment[],
  resolveCustomerId: (leadId: string) => string | null,
): Promise<CommitmentPushResult> {
  const rows: (Partial<CrmCommitmentRow> & { id: string })[] = [];
  const staged: string[] = [];

  for (const c of all) {
    const fp = fingerprint(c);
    if (pushed.get(c.id) === fp) continue;
    const customerId = resolveCustomerId(c.leadId);
    // No known customer on the server yet — skip rather than trip the foreign
    // key. The next push retries once the customer syncs.
    if (!customerId) continue;
    rows.push(commitmentToRow(c, customerId));
    staged.push(c.id);
    pushed.set(c.id, fp);
  }

  if (rows.length === 0) return { ok: true, count: 0 };

  try {
    const { error } = await db.from("crm_commitments").upsert(rows, { onConflict: "id" });
    if (error) throw error;
    return { ok: true, count: rows.length };
  } catch (error) {
    for (const id of staged) pushed.delete(id); // retry next time
    const message = error instanceof Error ? error.message : String(error);
    console.error("[crm] pushCommitments failed:", message);
    return { ok: false, count: 0, error: message };
  }
}

/** Promises already on the server — read once when the board mounts. */
export async function fetchCommitmentRows(): Promise<CrmCommitmentRow[]> {
  try {
    const { data, error } = await db
      .from("crm_commitments")
      .select("*")
      .order("due_at", { ascending: true })
      .limit(1000);
    if (error) throw error;
    return (data ?? []) as CrmCommitmentRow[];
  } catch (error) {
    console.error("[crm] fetchCommitmentRows failed:", error);
    return [];
  }
}

export function resetCommitmentPushState() {
  pushed.clear();
}
