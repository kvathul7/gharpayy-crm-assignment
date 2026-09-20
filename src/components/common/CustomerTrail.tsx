// The server-side trail for one customer: what changed, who changed it, when.
//
// The local history a module keeps only proves what happened on *this* device.
// This reads crm_events, so it also shows work done by another operator on
// another machine — which is what makes the trail an audit trail rather than
// a log.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { fetchEvents } from "@/lib/crm/repo";
import type { CrmEventRow } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export function CustomerTrail({
  customerId,
  limit = 25,
  className,
}: {
  customerId: string | null;
  limit?: number;
  className?: string;
}) {
  const [rows, setRows] = useState<CrmEventRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    if (!customerId) {
      setRows([]);
      return;
    }
    setRows(null);
    void fetchEvents(customerId, limit).then((r) => {
      if (alive) setRows(r);
    });
    return () => {
      alive = false;
    };
  }, [customerId, limit]);

  if (!customerId) {
    return (
      <p className={cn("text-[11px] text-muted-foreground", className)}>
        Not linked to a server customer yet — nothing to show from other devices.
      </p>
    );
  }

  if (rows === null) {
    return (
      <p className={cn("inline-flex items-center gap-1 text-[11px] text-muted-foreground", className)}>
        <Loader2 className="h-3 w-3 animate-spin" /> Loading the server trail…
      </p>
    );
  }

  if (rows.length === 0) {
    return <p className={cn("text-[11px] text-muted-foreground", className)}>No server events for this customer yet.</p>;
  }

  return (
    <div className={cn("space-y-1", className)}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Server trail · {rows.length} event{rows.length === 1 ? "" : "s"}
      </p>
      {rows.map((e) => (
        <p key={e.id} className="text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">{when(e.at)}</span> · {e.actor} · {e.label}
          {e.detail ? ` · ${e.detail}` : ""}
          {e.module ? <span className="opacity-60"> [{e.module}]</span> : null}
          {e.changes?.length
            ? e.changes
                .filter((c) => c.field && (c.from || c.to))
                .map((c) => ` · ${c.field}: ${c.from || "—"} → ${c.to || "—"}`)
                .join("")
            : ""}
        </p>
      ))}
    </div>
  );
}
