// NEW IDEA 2 — live work claims.
//
// "Who is on this customer right now", answered by the server rather than by
// hope. The unique index on crm_work_claims (one live claim per customer) is
// what actually enforces it, so two operators cannot both hold a customer
// even if they click at the same millisecond — the second insert is rejected
// by Postgres, not by client-side politeness.
//
// Claiming and releasing are real events, so both land in the audit trail.

import { useCallback, useEffect, useRef, useState } from "react";
import { appendEvent, claimCustomer, fetchLiveClaims, releaseClaim } from "./repo";

export type ClaimStatus = "checking" | "free" | "mine" | "taken" | "error";

export interface WorkClaimState {
  status: ClaimStatus;
  /** who holds it, when status is "taken" */
  takenBy: string | null;
  error: string | null;
  claim: () => Promise<void>;
  release: (reason?: string) => Promise<void>;
  busy: boolean;
}

/**
 * A stable id for this browser session. Two tabs in the same browser share it;
 * two different browsers do not — which is exactly what makes the collision
 * test meaningful.
 */
function operatorSessionId(): string {
  if (typeof window === "undefined") return "ssr";
  const KEY = "gharpayy.operator.session";
  let id = window.sessionStorage.getItem(KEY);
  if (!id) {
    id = `op-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(KEY, id);
  }
  return id;
}

export function useWorkClaim(customerId: string | null, operatorName: string, module: string): WorkClaimState {
  const [status, setStatus] = useState<ClaimStatus>("checking");
  const [takenBy, setTakenBy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const operatorId = useRef<string>("");
  if (!operatorId.current) operatorId.current = operatorSessionId();

  // Remember what we hold, so we can release it when the operator moves on.
  const held = useRef<string | null>(null);

  const refresh = useCallback(async (id: string) => {
    setStatus("checking");
    const claims = await fetchLiveClaims();
    const live = claims.find((c) => c.customer_id === id);
    if (!live) {
      setTakenBy(null);
      setStatus("free");
      return;
    }
    if (live.operator_id === operatorId.current) {
      setTakenBy(live.operator_name);
      setStatus("mine");
      held.current = id;
      return;
    }
    setTakenBy(live.operator_name);
    setStatus("taken");
  }, []);

  const release = useCallback(
    async (reason = "done") => {
      const id = held.current;
      if (!id) return;
      held.current = null;
      setBusy(true);
      const out = await releaseClaim(id, operatorId.current, reason);
      setBusy(false);
      if (out.ok) {
        void appendEvent({
          customerId: id,
          actor: operatorName,
          label: "Released the customer",
          detail: reason,
          module,
        });
        setStatus("free");
        setTakenBy(null);
      } else {
        setError(out.error ?? "could not release");
        setStatus("error");
      }
    },
    [module, operatorName],
  );

  const claim = useCallback(async () => {
    if (!customerId) return;
    setBusy(true);
    setError(null);
    const out = await claimCustomer({
      customerId,
      operatorId: operatorId.current,
      operatorName,
      module,
    });
    setBusy(false);

    if (out.ok) {
      held.current = customerId;
      setStatus("mine");
      setTakenBy(operatorName);
      void appendEvent({
        customerId,
        actor: operatorName,
        label: "Claimed the customer",
        detail: `working in ${module}`,
        module,
      });
      return;
    }

    // Somebody else got there first — the database said so, not the UI.
    if (out.takenBy) {
      setTakenBy(out.takenBy);
      setStatus("taken");
      return;
    }
    setError(out.error ?? "could not claim");
    setStatus("error");
  }, [customerId, module, operatorName]);

  // Switching customers releases the previous one and checks the new one.
  useEffect(() => {
    let alive = true;
    const previous = held.current;
    if (previous && previous !== customerId) void release("moved to another customer");

    if (!customerId) {
      setStatus("free");
      setTakenBy(null);
      return;
    }
    void refresh(customerId).then(() => {
      if (!alive) return;
    });

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  // Leaving the screen must not strand a claim for 15 minutes.
  useEffect(() => {
    const onLeave = () => {
      const id = held.current;
      if (!id) return;
      // keepalive so the release survives the page going away
      void releaseClaim(id, operatorId.current, "left the screen");
    };
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
      onLeave();
    };
  }, []);

  return { status, takenBy, error, claim, release, busy };
}
