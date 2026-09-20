// Puts the Booking Flow store on the hosted backend.
//
// Booking Flow Split and Closing Desk both read useBookingFlow, so mounting
// this hook in either one activates both modules against the same server
// truth. The store keeps behaving exactly as it did — localStorage is still
// the instant local copy — this only adds a server layer on top:
//
//   mount  → pull server rows, merge them into the local universe
//   change → push whatever actually changed, plus its audit events
//
// Nothing here can break the UI. Every backend call already returns instead
// of throwing, and a failed sync just leaves the operator on local data.

import { useEffect, useRef, useState } from "react";
import { useBookingFlow } from "@/bookingflow/store";
import type { FlowLead } from "@/bookingflow/types";
import { canonicalCustomerId } from "@/lib/canonical/customer-id";
import { countCustomers, fetchCustomers } from "./repo";
import { primePushState, pushChanged, rowToLead } from "./flow-sync";
import type { CrmCustomerRow } from "./types";

export type SyncPhase = "idle" | "loading" | "synced" | "offline";

export interface FlowBackendState {
  phase: SyncPhase;
  /** customers held on the server, or null when we genuinely do not know */
  serverCount: number | null;
  /** last time a push or pull succeeded */
  lastSyncAt: string | null;
  error: string | null;
}

/** canonical id for a lead, computed the same way every other module does it */
export function leadKey(l: FlowLead): string {
  return l.canonicalId || canonicalCustomerId({ phone: l.phone, name: l.name }) || l.id;
}

/**
 * Fold server rows into the local universe.
 * Server wins on the shared fields; local keeps its own event log and the
 * screenshot-capture bits the server does not store.
 */
export function mergeServerRows(local: FlowLead[], rows: CrmCustomerRow[]): FlowLead[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const used = new Set<string>();

  const merged = local.map((lead) => {
    const key = leadKey(lead);
    const row = byId.get(key);
    if (!row) return lead.canonicalId ? lead : { ...lead, canonicalId: key };
    used.add(key);
    return rowToLead(row, lead);
  });

  // Customers that exist on the server but not on this device — another
  // operator created them. Bring them in so every device sees one universe.
  const incoming = rows
    .filter((r) => !used.has(r.id))
    .map((r) => rowToLead(r));

  return [...incoming, ...merged];
}

export function useFlowBackend(module: string): FlowBackendState {
  const [state, setState] = useState<FlowBackendState>({
    phase: "idle",
    serverCount: null,
    lastSyncAt: null,
    error: null,
  });

  // guards so a remount does not re-pull or double-subscribe
  const hydrated = useRef(false);
  const pushing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    let alive = true;

    (async () => {
      setState((s) => ({ ...s, phase: "loading" }));

      // Ask how MANY rows exist before deciding what to do.
      //
      // fetchCustomers() returns [] both when the server is empty and when it
      // is unreachable, and those two cases need opposite behaviour: an empty
      // server should be seeded from this device, an unreachable one must not
      // be written to at all. Conflating them made a flaky mobile request
      // re-push the entire local trail as if the server had never seen it,
      // duplicating thousands of events.
      let count = await countCustomers();
      if (count === null) {
        await new Promise((r) => setTimeout(r, 1500));
        count = await countCustomers();
      }
      if (!alive) return;

      if (count === null) {
        // Unreachable. Keep working locally, claim nothing, and push nothing.
        // Priming here is what stops the duplicate storm.
        primePushState(useBookingFlow.getState().leads);
        setState((s) => ({
          ...s,
          phase: "offline",
          serverCount: null,
          error: "The server could not be reached.",
        }));
        return;
      }

      if (count > 0) {
        const rows = await fetchCustomers(1000);
        if (!alive) return;
        if (rows.length > 0) {
          const local = useBookingFlow.getState().leads;
          const nextLeads = mergeServerRows(local, rows);
          useBookingFlow.setState({ leads: nextLeads });
          primePushState(nextLeads);
        } else {
          // The count says rows exist but this read came back empty — treat it
          // as a bad read, not as permission to re-seed.
          primePushState(useBookingFlow.getState().leads);
        }
        setState({
          phase: "synced",
          serverCount: count,
          lastSyncAt: new Date().toISOString(),
          error: null,
        });
      } else {
        // Genuinely empty server. This is the one case where pushing the whole
        // local universe is correct, so the push state is deliberately NOT
        // primed here.
        setState((s) => ({ ...s, serverCount: 0 }));
      }

      // Push whatever this device knows that the server does not.
      void flush();
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function flush() {
    if (pushing.current) return;
    pushing.current = true;
    try {
      const leads = useBookingFlow.getState().leads;
      const out = await pushChanged(leads, module);
      if (out.ok) {
        if (out.customers > 0 || out.events > 0) {
          // Ask the server what it actually holds. Previously a successful push
          // flipped the badge to "synced" while leaving a count of 0 on screen,
          // which read as "Saved to server - 0" and was simply untrue.
          const fresh = await countCustomers();
          setState((s) => ({
            ...s,
            phase: "synced",
            serverCount: fresh ?? s.serverCount,
            lastSyncAt: new Date().toISOString(),
            error: null,
          }));
        }
      } else {
        setState((s) => ({ ...s, phase: "offline", error: out.error ?? "sync failed" }));
      }
    } finally {
      pushing.current = false;
    }
  }

  // Push on every store change, coalesced so a burst of keystrokes is one call.
  useEffect(() => {
    const unsub = useBookingFlow.subscribe(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 1200);
    });
    return () => {
      unsub();
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
