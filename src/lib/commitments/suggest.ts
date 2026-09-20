// Stage-aware defaults for the close promise.
//
// The promise dialog used to open on a flat "48h" with no hour and no steps,
// so every promise cost the same four decisions regardless of how close the
// customer actually was. A customer sitting on PAYMENT is not a 48-hour
// problem; one that has only just been quoted is not a 3-hour problem.
//
// Pre-filling the obvious answer is the click reduction: the operator opens
// the dialog and commits, instead of re-deciding what the stage already says.
// Everything stays editable — this changes the starting point, not the rules.

import { WINDOW_BY_ID, type CloseWindowId } from "./windows";

export interface PromiseSuggestion {
  windowId: CloseWindowId;
  timeOfDay: string;
  steps: string[];
  /** Shown in the dialog so the operator knows why it was pre-filled. */
  because: string;
}

const QUICK_TIMES = ["10:00", "12:00", "15:00", "18:00", "20:00"];

/** The next sensible working hour, so "when" is answered before it is asked. */
export function nextQuickTime(now = new Date()): string {
  const mins = now.getHours() * 60 + now.getMinutes();
  for (const t of QUICK_TIMES) {
    const [h, m] = t.split(":").map(Number);
    if (h * 60 + m > mins + 45) return t;
  }
  return QUICK_TIMES[0]!; // nothing left today — first slot tomorrow
}

/**
 * How urgent the close is, by where the customer actually stands.
 * Stage keys come from the Booking Flow journey (see bookingflow/journey.ts).
 */
export function suggestPromise(stage: string | undefined, now = new Date()): PromiseSuggestion {
  const time = nextQuickTime(now);
  const s = (stage ?? "").toUpperCase();

  // Money is already in motion — hours, not days.
  if (s === "PAYMENT" || s === "RESERVED") {
    return { windowId: "3h", timeOfDay: time, steps: stepsFor("3h"), because: "payment is already in motion" };
  }
  // A decision is live: quote sent, negotiating, booking being raised.
  if (s === "QUOTE" || s === "NEGOTIATE" || s === "BOOKING" || s === "APPROVAL") {
    return { windowId: "24h", timeOfDay: time, steps: stepsFor("24h"), because: "a decision is already on the table" };
  }
  // Post-tour: the customer has seen the place, momentum is short-lived.
  if (s.startsWith("TOUR_") || s === "CHECKIN_PREP") {
    return { windowId: "24h", timeOfDay: time, steps: stepsFor("24h"), because: "post-tour momentum fades fast" };
  }
  // Everything earlier keeps the original default.
  return { windowId: "48h", timeOfDay: time, steps: stepsFor("48h"), because: "still early in the journey" };
}

/** The window's own first recommended move — a real option, never invented. */
function stepsFor(windowId: CloseWindowId): string[] {
  const first = WINDOW_BY_ID[windowId]?.howToExecute?.[0];
  return first ? [first] : [];
}
