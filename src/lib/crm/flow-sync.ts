// Bridges the Booking Flow store (which Booking Flow Split and Closing Desk
// both read) to the CRM backend.
//
// The store keeps working exactly as before. This is a layer on top:
// localStorage stays the fast local truth, the backend becomes the shared
// truth. If the backend is unreachable the operator notices nothing.

import type { FlowEvent, FlowLead } from "@/bookingflow/types";
import type { CrmCustomerRow } from "./types";
import { appendEvents, upsertCustomers } from "./repo";

/* ------------------------------------------------------------- mapping */

export function leadToRow(l: FlowLead): Partial<CrmCustomerRow> & { id: string } {
  return {
    id: l.canonicalId || l.id,
    name: l.name,
    phone: l.phone,
    wa_account: l.waAccount ?? null,
    stage: l.stage,
    owner: l.owner ?? null,
    handler: l.handler ?? null,
    temp: l.temp ?? null,
    temp_reason: l.tempReason ?? null,
    labels: l.labels ?? [],
    last_message: l.lastMessage ?? null,
    last_activity_at: l.lastActivityAt ?? null,
    last_action_at: l.lastActionAt ?? null,
    next_action: l.nextAction ?? null,
    next_action_at: l.nextActionAt ?? null,
    journey: l.f ?? {},
    qualified_at: l.qualifiedAt ?? null,
    escalated: !!l.escalated,
    closed_reason: l.closedReason ?? null,
  };
}

export function rowToLead(r: CrmCustomerRow, existing?: FlowLead): FlowLead {
  return {
    ...(existing ?? ({} as FlowLead)),
    id: existing?.id ?? r.id,
    canonicalId: r.id,
    name: r.name,
    phone: r.phone,
    waAccount: r.wa_account ?? existing?.waAccount ?? "Gharpayy Sales 01",
    stage: r.stage,
    owner: r.owner ?? undefined,
    handler: r.handler ?? undefined,
    temp: (r.temp as FlowLead["temp"]) ?? undefined,
    tempReason: r.temp_reason ?? undefined,
    labels: r.labels ?? [],
    lastMessage: r.last_message ?? existing?.lastMessage ?? "",
    lastActivityAt: r.last_activity_at ?? existing?.lastActivityAt ?? r.updated_at,
    lastActionAt: r.last_action_at ?? undefined,
    nextAction: r.next_action ?? undefined,
    nextActionAt: r.next_action_at ?? undefined,
    f: r.journey ?? {},
    q: existing?.q ?? {},
    unread: existing?.unread ?? 0,
    qualifiedAt: r.qualified_at ?? undefined,
    escalated: r.escalated,
    closedReason: r.closed_reason ?? undefined,
    events: existing?.events ?? [],
  };
}

/* ---------------------------------------------------- change detection */

/** The fields whose change is worth a round trip. */
const TRACKED: (keyof FlowLead)[] = [
  "stage", "owner", "handler", "temp", "tempReason", "labels", "lastMessage",
  "lastActivityAt", "lastActionAt", "nextAction", "nextActionAt", "f",
  "qualifiedAt", "escalated", "closedReason", "name", "phone",
];

function fingerprint(l: FlowLead): string {
  const picked: Record<string, unknown> = {};
  for (const k of TRACKED) picked[k as string] = l[k];
  return JSON.stringify(picked);
}

/** Which leads actually changed since the last push. */
export function diffLeads(leads: FlowLead[], seen: Map<string, string>): FlowLead[] {
  const changed: FlowLead[] = [];
  for (const l of leads) {
    const key = l.canonicalId || l.id;
    if (!key) continue;
    const fp = fingerprint(l);
    if (seen.get(key) !== fp) {
      changed.push(l);
      seen.set(key, fp);
    }
  }
  return changed;
}

/** Events not yet pushed, flattened for crm_events. */
export function newEventsFor(
  lead: FlowLead,
  pushedCounts: Map<string, number>,
  module: string,
): { customerId: string; actor: string; label: string; detail?: string; stepKey?: string; module: string; changes?: FlowEvent["changes"]; at: string }[] {
  const key = lead.canonicalId || lead.id;
  const already = pushedCounts.get(key) ?? 0;
  const events = lead.events ?? [];
  if (events.length <= already) return [];
  const fresh = events.slice(already);
  pushedCounts.set(key, events.length);
  return fresh
    // The journey screen saves on Enter *and* on blur, so the same answer can
    // raise a second event where nothing actually changed. Those no-ops would
    // pad the audit trail with edits that never happened.
    .filter((e) => {
      const ch = e.changes ?? [];
      if (ch.length === 0) return true;
      return ch.some((c) => c.from !== c.to);
    })
    .map((e) => ({
    customerId: key,
    actor: e.actor,
    label: e.label,
    detail: e.detail,
    stepKey: e.stepKey,
    module,
    changes: e.changes,
    at: e.at,
  }));
}

/* ------------------------------------------------------------- pushing */

const seenFingerprints = new Map<string, string>();
const pushedEventCounts = new Map<string, number>();

export interface PushOutcome {
  ok: boolean;
  customers: number;
  events: number;
  error?: string;
}

/**
 * Push whatever changed. Safe to call often — unchanged leads cost nothing.
 * Never throws: a failed push leaves the local store untouched and reports it.
 */
export async function pushChanged(leads: FlowLead[], module: string): Promise<PushOutcome> {
  const changed = diffLeads(leads, seenFingerprints);
  if (changed.length === 0) return { ok: true, customers: 0, events: 0 };

  const rows = changed.map(leadToRow);
  const customerResult = await upsertCustomers(rows);
  if (!customerResult.ok) {
    // roll the fingerprints back so the next attempt retries these leads
    for (const l of changed) seenFingerprints.delete(l.canonicalId || l.id);
    return { ok: false, customers: 0, events: 0, error: customerResult.error };
  }

  const events = changed.flatMap((l) => newEventsFor(l, pushedEventCounts, module));
  if (events.length > 0) {
    const eventResult = await appendEvents(events);
    if (!eventResult.ok) {
      for (const l of changed) pushedEventCounts.delete(l.canonicalId || l.id);
      return { ok: false, customers: rows.length, events: 0, error: eventResult.error };
    }
  }

  return { ok: true, customers: rows.length, events: events.length };
}

/**
 * Mark everything currently on a lead as already pushed, without sending it.
 *
 * This is the fix for a real duplication bug: the "already pushed" counters
 * live in memory, so on every fresh page load they started empty and the whole
 * historical event log looked new again. One reload of Booking Flow Split
 * re-sent all 2,842 seeded events; two reloads tripled the trail.
 *
 * Called right after hydrate, so a session only ever pushes the work it
 * actually does.
 */
export function primePushState(leads: FlowLead[]) {
  for (const l of leads) {
    const key = l.canonicalId || l.id;
    if (!key) continue;
    seenFingerprints.set(key, fingerprint(l));
    pushedEventCounts.set(key, (l.events ?? []).length);
  }
}

/** Forget what we have pushed — used after a reset or a backend switch. */
export function resetPushState() {
  seenFingerprints.clear();
  pushedEventCounts.clear();
}

/** Seed the backend from the local universe on first run. */
export async function pushAll(leads: FlowLead[], module: string): Promise<PushOutcome> {
  resetPushState();
  return pushChanged(leads, module);
}
