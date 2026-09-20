// NEW IDEA 2 — the visible half of live work claims.
//
// One strip that answers "is anyone else on this customer?" before the
// operator spends a call on someone who is already being worked.

import { Lock, LockOpen, Loader2, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WorkClaimState } from "@/lib/crm/useWorkClaim";

export function WorkClaimBar({
  claim,
  className,
  compact = false,
}: {
  claim: WorkClaimState;
  className?: string;
  compact?: boolean;
}) {
  const { status, takenBy, error, busy } = claim;

  const base = cn("inline-flex items-center gap-1 text-[10px]", className);

  if (status === "checking") {
    return (
      <span className={cn(base, "text-muted-foreground")}>
        <Loader2 className="h-3 w-3 animate-spin" /> Checking who has this…
      </span>
    );
  }

  if (status === "taken") {
    return (
      <span
        className={cn(base, "rounded border border-destructive/40 px-1.5 py-0.5 font-medium text-destructive")}
        title={`${takenBy} claimed this customer. Work someone else so you are not both calling the same person.`}
      >
        <Lock className="h-3 w-3" />
        {takenBy} is on this {compact ? "" : "customer"}
      </span>
    );
  }

  if (status === "mine") {
    return (
      <span className={cn(base, "gap-1.5")}>
        <span className="inline-flex items-center gap-1 rounded border border-emerald-600/40 px-1.5 py-0.5 font-medium text-emerald-700">
          <UserCheck className="h-3 w-3" /> You have this
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 px-1 text-[10px]"
          disabled={busy}
          onClick={() => void claim.release("released by operator")}
        >
          Release
        </Button>
      </span>
    );
  }

  if (status === "error") {
    return (
      <span className={cn(base, "text-destructive")} title={error ?? undefined}>
        <Lock className="h-3 w-3" /> Claim failed — not recorded on the server
      </span>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className={cn("h-5 gap-1 px-1.5 text-[10px]", className)}
      disabled={busy}
      onClick={() => void claim.claim()}
      title="Tell the team you are working this customer, so nobody doubles up."
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <LockOpen className="h-3 w-3" />}
      Claim
    </Button>
  );
}
