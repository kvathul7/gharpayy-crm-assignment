// Closing Desk's backend wiring.
//
// Two things have to reach the server for this module to be real:
//   the customer  (shared with Booking Flow Split — useFlowBackend does it)
//   the promise   (crm_commitments — done here)
//
// Promises are pushed whenever the local commitment store changes. The local
// store stays synchronous and authoritative for rendering, so the board never
// waits on the network.

import { useEffect, useRef, useState } from "react";
import { useBookingFlow } from "@/bookingflow/store";
import { importCommitments, useCommitments } from "@/lib/commitments/store";
import { canonicalCustomerId } from "@/lib/canonical/customer-id";
import { fetchCommitmentRows, pushCommitments, rowToCommitment } from "./commitments-sync";
import { fetchCustomers } from "./repo";
import { useFlowBackend, type FlowBackendState } from "./useFlowBackend";

export interface ClosingBackendState extends FlowBackendState {
  /** promises mirrored to the server so far this session */
  promisesSynced: number;
  promiseError: string | null;
}

export function useClosingBackend(): ClosingBackendState {
  const flow = useFlowBackend("closing");
  const commitments = useCommitments();

  const [promisesSynced, setPromisesSynced] = useState(0);
  const [promiseError, setPromiseError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pull promises the server already holds — including any created by the
  // call -> closing handoff, which never passed through this device. Without
  // this the handoff would be invisible on the board it was created for.
  const pulled = useRef(false);
  useEffect(() => {
    if (pulled.current) return;
    pulled.current = true;
    void Promise.all([fetchCommitmentRows(), fetchCustomers(1000)]).then(([rows, customers]) => {
      if (rows.length === 0) return;
      const leads = useBookingFlow.getState().leads;
      // A promise can belong to a customer this device has never seen (the
      // call handoff creates them). Fall back to the server record so the
      // board shows a person, never a raw id.
      const byId = new Map(customers.map((c) => [c.id, c]));
      const mapped = rows.map((r) => {
        const lead = leads.find(
          (l) => l.canonicalId === r.customer_id || canonicalCustomerId({ phone: l.phone, name: l.name }) === r.customer_id,
        );
        const served = byId.get(r.customer_id);
        return rowToCommitment(
          r,
          lead?.id ?? r.customer_id,
          lead?.name ?? served?.name ?? r.customer_id,
          lead?.phone ?? served?.phone ?? "",
        );
      });
      const added = importCommitments(mapped);
      if (added > 0) setPromisesSynced((n) => n + added);
    });
  }, []);

  useEffect(() => {
    if (commitments.length === 0) return;

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // A promise is stored against a Booking Flow leadId; the server keys on
      // the canonical customer id, so translate before pushing.
      const leads = useBookingFlow.getState().leads;
      const resolve = (leadId: string): string | null => {
        const lead = leads.find((l) => l.id === leadId || l.canonicalId === leadId);
        if (lead) return lead.canonicalId || canonicalCustomerId({ phone: lead.phone, name: lead.name }) || null;
        // The id may already be canonical (came from another device).
        return leadId.startsWith("p:") || leadId.startsWith("n:") ? leadId : null;
      };

      void pushCommitments(commitments, resolve).then((r) => {
        if (r.ok) {
          if (r.count > 0) setPromisesSynced((n) => n + r.count);
          setPromiseError(null);
        } else {
          setPromiseError(r.error ?? "promise sync failed");
        }
      });
    }, 900);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [commitments]);

  return { ...flow, promisesSynced, promiseError };
}
