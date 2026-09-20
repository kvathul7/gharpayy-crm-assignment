// M-POWER CALL → backend.
//
// Three things must land on the server when a call is committed, and the
// operator must be told the truth about whether they did:
//
//   1. the customer          → crm_customers (same canonical id as the other
//                              two modules, so no duplicate record is made)
//   2. the call itself       → call_records
//   3. the trail             → crm_events
//
// And, when the call outcome qualifies, NEW IDEA 1 fires:
//   4. a Closing Desk promise → crm_commitments, carrying the same customer
//      id, an owner and a real deadline.
//
// Nothing here writes localStorage. The local stores are updated by the
// caller as before; this module reports honestly whether the *server* got it.

import type { CallRecord } from "@/callengine/types";
import type { MovementState } from "@/movement/types";
import { canonicalCustomerId } from "@/lib/canonical/customer-id";
import { appendEvent, createCommitment, upsertCustomer } from "./repo";

// Which calls mean a close is genuinely in play.
// MovementClass is the engine's own classification of what the call moved:
// "commercial" = price/quote territory, "booking" = the booking itself,
// "tour" = a visit is now real. Those three are close-relevant; "data" and
// "property" are still discovery.
const HANDOFF_MOVEMENTS = new Set<string>(["commercial", "booking", "tour"]);

// Agenda is the backstop: some calls end on the right subject even when the
// engine could not classify a movement.
const HANDOFF_AGENDAS = new Set<string>([
  "post-tour",
  "closing",
  "price",
  "objection",
  "tour-confirm",
]);

export interface CallSyncResult {
  ok: boolean;
  customerId: string | null;
  /** which pieces reached the server */
  customerSaved: boolean;
  callSaved: boolean;
  eventSaved: boolean;
  /** NEW IDEA 1 — set when a closing promise was created by the handoff */
  handoff: { created: boolean; dueAt?: string; owner?: string; reason?: string };
  errors: string[];
}

/** Hours until the promise is due, by how hot the call left the customer. */
function handoffWindowHours(record: CallRecord): number {
  if (record.movement === "booking" || record.agenda === "closing") return 3;
  if (record.movement === "commercial" || record.agenda === "price") return 24;
  return 48;
}

export function shouldHandOff(record: CallRecord): boolean {
  if (record.outcome !== "connected") return false;
  if (record.movement && HANDOFF_MOVEMENTS.has(record.movement)) return true;
  return HANDOFF_AGENDAS.has(record.agenda);
}

/**
 * Persist one committed call. Returns what actually reached the server so the
 * UI can say "saved" or "NOT saved" instead of guessing.
 */
export async function syncCall(lead: MovementState, record: CallRecord): Promise<CallSyncResult> {
  const customerId =
    lead.canonicalId || canonicalCustomerId({ phone: lead.phone, name: lead.name }) || null;

  const result: CallSyncResult = {
    ok: false,
    customerId,
    customerSaved: false,
    callSaved: false,
    eventSaved: false,
    handoff: { created: false },
    errors: [],
  };

  if (!customerId) {
    result.errors.push("This lead has no phone or name, so it has no canonical customer id.");
    return result;
  }

  const owner = record.operatorName || lead.primaryOwnerName || "Unassigned";
  const nextStep = record.nextStep;
  const dueAt = nextStep?.dueAt ?? null;

  // 1. the customer — upsert on the canonical id, so the row Booking Flow
  //    Split and Closing Desk already use is updated, never duplicated.
  const customer = await upsertCustomer({
    id: customerId,
    name: lead.name,
    phone: lead.phone ?? "",
    owner,
    handler: owner,
    last_action_at: record.ts,
    last_activity_at: record.ts,
    next_action: nextStep?.label ?? null,
    next_action_at: dueAt,
    ...(record.stageAfter ? { stage: record.stageAfter } : {}),
  });
  result.customerSaved = customer.ok;
  if (!customer.ok && customer.error) result.errors.push(`customer: ${customer.error}`);

  // 2. the trail
  const event = await appendEvent({
    customerId,
    actor: owner,
    label: `M-POWER CALL · ${record.agenda}`,
    detail: [
      `outcome: ${record.outcome}`,
      record.movement ? `movement: ${record.movement}` : "",
      nextStep?.label ? `next: ${nextStep.label}` : "",
      dueAt ? `by ${new Date(dueAt).toLocaleString()}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    module: "call",
    at: record.ts,
    changes: [
      ...(record.stageAfter ? [{ field: "stage", from: lead.stage ?? "", to: record.stageAfter }] : []),
      ...(nextStep?.label ? [{ field: "next_action", from: lead.nextAction?.note ?? "", to: nextStep.label }] : []),
      ...(dueAt ? [{ field: "next_action_at", from: lead.nextAction?.dueAt ?? "", to: dueAt }] : []),
    ],
  });
  result.eventSaved = event.ok;
  if (!event.ok && event.error) result.errors.push(`trail: ${event.error}`);

  // 3. NEW IDEA 1 — call → closing handoff.
  if (shouldHandOff(record)) {
    const hours = handoffWindowHours(record);
    const promiseDue = new Date(Date.now() + hours * 3_600_000).toISOString();
        const movedSomewhere = record.movement && record.movement !== "none";
    const reason = movedSomewhere
      ? `the call moved them to "${record.movement}"`
      : `the call was a "${record.agenda}" conversation`;

    const promise = await createCommitment({
      customerId,
      promisedBy: owner,
      dueAt: promiseDue,
      windowId: hours <= 3 ? "3h" : hours <= 24 ? "24h" : "48h",
      steps: [nextStep?.label ?? "Follow up on decision"].filter(Boolean),
      note: `Auto-created from M-POWER CALL — ${reason}. Message ready to send: ${(record.messageNow ?? "").slice(0, 160)}`,
      source: "call-handoff",
    });

    result.handoff = {
      created: promise.ok,
      dueAt: promise.ok ? promiseDue : undefined,
      owner,
      reason,
    };
    if (!promise.ok && promise.error) result.errors.push(`handoff: ${promise.error}`);

    // The handoff itself is an auditable act.
    if (promise.ok) {
      await appendEvent({
        customerId,
        actor: owner,
        label: "Handed to Closing Desk",
        detail: `${reason} · promise due ${new Date(promiseDue).toLocaleString()}`,
        module: "call-handoff",
        changes: [{ field: "closing_promise", from: "", to: promiseDue }],
      });
    }
  }

  result.ok = result.customerSaved && result.eventSaved;
  return result;
}
