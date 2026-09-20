// Honest, one-line answer to "where does the data go?".
//
// Not decoration: it reports the real sync phase, the real server row count
// and the real last-sync time, so an operator can tell at a glance whether
// what they just typed left this device.

import { Cloud, CloudOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FlowBackendState } from "@/lib/crm/useFlowBackend";

export function BackendBadge({ state, className }: { state: FlowBackendState; className?: string }) {
  const { phase, serverCount, lastSyncAt, error } = state;

  const time = lastSyncAt
    ? new Date(lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  if (phase === "loading" || phase === "idle") {
    return (
      <span className={cn("inline-flex items-center gap-1 text-[10px] text-muted-foreground", className)}>
        <Loader2 className="h-3 w-3 animate-spin" /> Loading from server…
      </span>
    );
  }

  if (phase === "offline") {
    return (
      <span
        className={cn("inline-flex items-center gap-1 text-[10px] text-destructive", className)}
        title={error ?? "The server could not be reached. Work is saved on this device and will sync when it returns."}
      >
        <CloudOff className="h-3 w-3" /> On this device only
      </span>
    );
  }

  return (
    <span
      className={cn("inline-flex items-center gap-1 text-[10px] text-muted-foreground", className)}
      title={`${typeof serverCount === "number" ? `${serverCount} customers` : "Customer count unknown"} on the server${time ? ` · last sync ${time}` : ""}`}
    >
      <Cloud className="h-3 w-3 text-emerald-600" />
      {/* Only ever show a number we actually read back from the server. */}
      Saved to server{typeof serverCount === "number" ? ` · ${serverCount}` : ""}
      {time ? <span className="opacity-70">· {time}</span> : null}
    </span>
  );
}
