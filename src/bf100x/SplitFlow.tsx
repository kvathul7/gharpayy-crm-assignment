// The 100x funnel squeezed into 40% of the screen, so WhatsApp can live in the
// other 60%. One screen, nothing to scroll except the questions themselves.
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Activity, ArrowLeft, ArrowRight, BellRing, ListChecks, Menu, PhoneCall, ShieldAlert, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { health, fmtMins } from "@/bookingflow/engine";
import { NEXT_ACTIONS } from "@/bookingflow/journey";
import { useBookingFlow } from "@/bookingflow/store";
import { BATCH_SIZE, ROUNDS } from "@/bookingflow/types";
import { SCREENS, currentScreen, screenIndex, screenProgress } from "./screens";
import { ScreenPanel } from "./ScreenPanel";
import { CapturedPanel } from "./CapturedPanel";
import { KnownStrip } from "./KnownStrip";
import { LabelConsole } from "./LabelConsole";
import { PropertyMatch } from "./PropertyMatch";
import { ClosingDesk } from "./ClosingDesk";
import { ContactActions } from "@/components/common/ContactActions";
import { CloseCommitButton } from "@/components/commitments/CloseCommitButton";
import { canonicalCustomerId } from "@/lib/canonical/customer-id";
import { useFlowBackend } from "@/lib/crm/useFlowBackend";
import { BackendBadge } from "@/components/common/BackendBadge";
import { useWorkClaim } from "@/lib/crm/useWorkClaim";
import { WorkClaimBar } from "@/components/common/WorkClaimBar";

type Pane = "WORK" | "CAPTURED" | "MATCH" | "LABELS" | "CLOSING" | "QUEUE" | "DRAFTS";

const PANES: { id: Pane; label: string }[] = [
  { id: "WORK", label: "Questions" },
  { id: "CAPTURED", label: "Captured" },
  { id: "MATCH", label: "Property match" },
  { id: "LABELS", label: "Labels" },
  { id: "CLOSING", label: "Closing" },
  { id: "DRAFTS", label: "Drafts D1–D4" },
  { id: "QUEUE", label: "All customers" },
];

const WIDTH_KEY = "gharpayy-split-width-pct";
const WIDTH_PRESETS = [40, 50, 60, 100];

const startOfDay = () => new Date(new Date().toDateString()).getTime();

// Everywhere you can jump without leaving the split screen.
const MENU: { to: string; label: string; group: string }[] = [
  { group: "This funnel", to: "/booking-flow", label: "Booking Flow — full screen" },
  { group: "This funnel", to: "/booking-flow-100x", label: "Booking Flow 100x" },
  { group: "This funnel", to: "/closing", label: "Closing desk" },
  { group: "This funnel", to: "/final-moment", label: "Draft Vision (screenshots)" },
  { group: "Lead OS", to: "/flow-os", label: "Flow OS — Lead OS" },
  { group: "Lead OS", to: "/final-e2e-plus", label: "Final E2E Plus" },
  { group: "Lead OS", to: "/mymoves", label: "My Moves" },
  { group: "Lead OS", to: "/booking-os", label: "Booking OS" },
  { group: "Lead OS", to: "/ways", label: "10 Ways" },
  { group: "Lead OS", to: "/conversation-library", label: "Conversation Library" },
  { group: "Everyday CRM", to: "/", label: "Dashboard" },
  { group: "Everyday CRM", to: "/today", label: "Today" },
  { group: "Everyday CRM", to: "/leads", label: "Leads" },
  { group: "Everyday CRM", to: "/tours", label: "Tours" },
  { group: "Everyday CRM", to: "/follow-ups", label: "Follow-ups" },
  { group: "Everyday CRM", to: "/inventory", label: "Inventory" },
  { group: "Everyday CRM", to: "/control-tower-team", label: "Control Tower" },
  { group: "Everyday CRM", to: "/admin", label: "Admin" },
];

/** A customer picked somewhere else (e.g. Movement OS) that this panel should open. */
export interface SplitFocus { name?: string; phone?: string; key?: string; canonicalId?: string }


export function SplitFlow({ embedded = false, focus, panelOnly = false }: { embedded?: boolean; focus?: SplitFocus; panelOnly?: boolean }) {
  const { leads, me, mode, setMode, claim, setNext, logActivity, escalate, batches, buildBatch, closeBatch, reopenBatch } = useBookingFlow();
  // Booking Flow Split and Closing Desk share this store, so this one call
  // puts both modules on the hosted backend.
  const backend = useFlowBackend("split");
  const [widthPct, setWidthPct] = useState(40);

  // The split screen assumes two columns: the CRM beside WhatsApp Web. On a
  // phone there is no second column to give away — 40% of 390px is a 156px
  // panel next to a placeholder telling you to open WhatsApp Web, which you
  // cannot do on a phone anyway. Below the md breakpoint the panel simply
  // takes the whole screen. Desktop behaviour is untouched.
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => setIsNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const [dragging, setDragging] = useState(false);
  const [closeNote, setCloseNote] = useState("");
  const [closingId, setClosingId] = useState<string | null>(null);

  // remember the width the operator picked, like a column width in a sheet
  useEffect(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (saved >= 20 && saved <= 100) setWidthPct(saved);
  }, []);
  useEffect(() => { localStorage.setItem(WIDTH_KEY, String(widthPct)); }, [widthPct]);
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const pct = Math.min(100, Math.max(25, Math.round((e.clientX / window.innerWidth) * 100)));
      setWidthPct(pct);
    };
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [dragging]);
  const [leadId, setLeadId] = useState<string>("");
  const [screenId, setScreenId] = useState<string>("");
  const [pane, setPane] = useState<Pane>("WORK");
  const [nextAction, setNextAction] = useState(NEXT_ACTIONS[0]!);
  const [due, setDue] = useState(() => new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 16));
  const [mounted, setMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityType, setActivityType] = useState("Call completed");
  const [activityNote, setActivityNote] = useState("");
  useEffect(() => setMounted(true), []);

  // the queue: everyone who still needs a decision, worst first
  const queue = useMemo(() => {
    if (!mounted) return [];
    return leads
      .filter((l) => l.stage !== "CLOSED" && l.f?.["checkinDay"] !== "CHECKED_IN")
      .map((l) => ({ l, h: health(l) }))
      .sort((a, b) => Number(b.h.sla === "LATE") - Number(a.h.sla === "LATE") || b.h.signals.length - a.h.signals.length)
      .map(({ l }) => l);
  }, [leads, mounted]);

  const lead = leads.find((l) => l.id === leadId) ?? queue[0];

  // NEW IDEA 2 — the server decides who is on this customer.
  const claimCustomerId = lead
    ? lead.canonicalId || canonicalCustomerId({ phone: lead.phone, name: lead.name }) || null
    : null;
  const workClaim = useWorkClaim(claimCustomerId, me, "split");

  useEffect(() => {
    if (lead) setScreenId(currentScreen(lead.f ?? {}).id);
  }, [lead?.id]);

  // A customer clicked in another view (Movement OS, Admin) opens right here —
  // always resolved through the one canonical customer id.
  useEffect(() => {
    if (!focus || leads.length === 0) return;
    const want = focus.canonicalId || canonicalCustomerId({ phone: focus.phone, name: focus.name });
    const match = want ? leads.find((l) => (l.canonicalId || canonicalCustomerId({ phone: l.phone, name: l.name })) === want) : undefined;
    if (!match) {
      setLeadId("");
      toast.error("This customer is not linked to Booking Flow yet. No duplicate was created.");
      return;
    }
    setLeadId(match.id);
    setPane("WORK");
    setScreenId(currentScreen(match.f ?? {}).id);
  }, [focus?.key, focus?.phone, focus?.name, focus?.canonicalId, leads.length]);

  const screen = SCREENS.find((s) => s.id === screenId) ?? (lead ? currentScreen(lead.f ?? {}) : SCREENS[0]!);
  const idx = screenIndex(screen.id);
  const h = mounted && lead ? health(lead) : undefined;

  // header result line — what this shift has actually produced
  const stats = useMemo(() => {
    if (!mounted) return { calls: 0, saved: 0, left: 0, tower: 0, late: 0 };
    const from = startOfDay();
    let calls = 0;
    let saved = 0;
    leads.forEach((l) =>
      l.events.forEach((e) => {
        if (+new Date(e.at) < from) return;
        saved += 1;
        if (/call|talk|spoke|phone/i.test(`${e.label} ${e.detail ?? ""}`)) calls += 1;
      }),
    );
    const left = leads.filter((l) => l.stage !== "CLOSED" && (!l.owner || !l.nextAction || !l.nextActionAt)).length;
    const hs = leads.map((l) => health(l));
    return { calls, saved, left, tower: hs.filter((x) => x.toTower).length, late: hs.filter((x) => x.sla === "LATE").length };
  }, [leads, mounted]);

  function step(dir: -1 | 1) {
    const n = idx + dir;
    if (n >= 0 && n < SCREENS.length) setScreenId(SCREENS[n]!.id);
  }

  function nextCustomer() {
    const i = queue.findIndex((l) => l.id === lead?.id);
    const pick = queue[i + 1] ?? queue[0];
    if (pick) setLeadId(pick.id);
  }

  return (
    <div className={cn("flex w-full overflow-hidden", panelOnly ? "h-full" : embedded ? "h-[calc(100vh-10rem)]" : "h-screen")}>
    <div className="flex min-w-0 flex-col overflow-hidden bg-background" style={{ width: panelOnly || isNarrow ? "100%" : `${widthPct}%` }}>
      {/* Result header — never scrolls away */}
      <header className="shrink-0 border-b px-2 py-1">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <div className="flex min-w-0 items-center gap-1 overflow-hidden">
            <h1 className="shrink-0 text-xs font-semibold">Booking Flow</h1>
            {mounted && (
              <div className="flex min-w-0 gap-1 overflow-x-auto">
                <Badge variant="outline" className="shrink-0 px-1 text-[9px]"><PhoneCall className="mr-0.5 h-2.5 w-2.5" />{stats.calls} calls</Badge>
                <Badge variant="outline" className="shrink-0 px-1 text-[9px]"><ListChecks className="mr-0.5 h-2.5 w-2.5" />{stats.saved} saved</Badge>
                {stats.late > 0 && <Badge variant="destructive" className="shrink-0 px-1 text-[9px]">{stats.late} late</Badge>}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!panelOnly && !isNarrow && (
              <div className="flex items-center gap-0.5 rounded-md border px-1 py-0.5">
                <span className="text-[9px] text-muted-foreground">W</span>
                {WIDTH_PRESETS.map((p) => (
                  <button key={p} type="button" onClick={() => setWidthPct(p)}
                    className={cn("rounded px-1 text-[9px]", widthPct === p ? "bg-primary/15 text-primary" : "text-muted-foreground")}>
                    {p}%
                  </button>
                ))}
              </div>
            )}
            <Button size="sm" variant={mode === "GUIDED" ? "default" : "outline"} className="h-6 px-2 text-[10px]" onClick={() => setMode("GUIDED")}>Understand</Button>
            <Button size="sm" variant={mode === "EXPERT" ? "default" : "outline"} className="h-6 px-2 text-[10px]" onClick={() => setMode("EXPERT")}>Expert</Button>
            <div className="relative">
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => setMenuOpen((v) => !v)} aria-expanded={menuOpen} aria-label="Open app menu">
                <Menu className="h-3 w-3" />
              </Button>
              {menuOpen && (
                <>
                  <button type="button" aria-label="Close menu" className="fixed inset-0 z-40 cursor-default" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 z-50 mt-1 max-h-[70vh] w-56 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
                    {(() => {
                      let lastGroup = "";
                      return MENU.map((m) => (
                        <div key={m.to}>
                          {m.group !== lastGroup && ((lastGroup = m.group), (<p className="px-2 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{m.group}</p>))}
                          <Link to={m.to} onClick={() => setMenuOpen(false)}
                            className="block rounded-sm px-2 py-1 text-[11px] hover:bg-accent hover:text-accent-foreground">
                            {m.label}
                          </Link>
                        </div>
                      ));
                    })()}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
          <p className="min-w-0 flex-1 truncate text-[9px] leading-tight text-muted-foreground">
            Outcome: every customer leaves this screen with a named owner and a dated next step.
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {stats.left > 0 && (
              <Badge variant="destructive" className="px-1 text-[9px]" title="Customers with no owner, no next step or no deadline. Every item must carry both.">
                {stats.left} unowned/undated
              </Badge>
            )}
            <BackendBadge state={backend} />
          </div>
        </div>
      </header>

      {/* Customer line + the five answers, compact */}
      {lead && (
        <div className="shrink-0 border-b px-2 py-1">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{lead.name} <span className="text-[11px] font-normal text-muted-foreground">{lead.phone}</span></p>
              <p className="truncate text-[10px] text-muted-foreground">“{lead.lastMessage}”</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={nextCustomer}>Next<ArrowRight className="ml-1 h-3 w-3" /></Button>
            </div>
          </div>
          {mounted && h && (
            <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
              <Badge variant="outline" className="text-[10px]">{h.stepNo}. {h.complete ? "Checked in" : h.step?.title}</Badge>
              <Badge variant={lead.owner ? "secondary" : "destructive"} className="text-[10px]">{lead.owner ?? "no owner"}</Badge>
              <Badge variant="outline" className="text-[10px]">waiting on {h.waitingOn}</Badge>
              <Badge variant={lead.nextAction ? "outline" : "destructive"} className="text-[10px]">{lead.nextAction ?? "no next step"}</Badge>
              <WorkClaimBar claim={workClaim} compact />
              <Badge variant={lead.nextActionAt && h.sla !== "LATE" ? "outline" : "destructive"} className="text-[10px]">
                {lead.nextActionAt ? (h.sla === "LATE" ? `late ${fmtMins(h.minutesLate)}` : new Date(lead.nextActionAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) : "no deadline"}
              </Badge>
            </div>
          )}
          {/* Copy the number, dial it, or open the WhatsApp chat — always labelled */}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <ContactActions phone={lead.phone} name={lead.name} />
            <Button size="sm" className="h-7 px-2 text-[10px]" onClick={() => setActivityOpen(true)}>
              <Activity className="mr-1 h-3 w-3" />Log activity
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => {
              const at = new Date(Date.now() + 2 * 3_600_000).toISOString();
              setNext(lead.id, "Follow up on decision", at);
              setNextAction("Follow up on decision");
              setDue(at.slice(0, 16));
              toast.success("Follow-up set for 2 hours");
            }}>
              <BellRing className="mr-1 h-3 w-3" />Follow
            </Button>
          </div>
        </div>
      )}

      {/* What is already filled — pinned, readable while answering */}
      {lead && <KnownStrip lead={lead} />}

      {/* Pane tabs — every tool of the funnel, inside the split panel */}
      <div className="shrink-0 overflow-x-auto border-b px-3 py-1.5">
        <div className="flex gap-1">
          {PANES.map((p) => (
            <button key={p.id} type="button" onClick={() => setPane(p.id)}
              className={cn("shrink-0 rounded-md border px-2 py-0.5 text-[10px]",
                p.id === pane ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground")}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Screen rail — one row, horizontally scrollable, never wraps the layout */}
      {lead && pane === "WORK" && (
        <div className="shrink-0 overflow-x-auto border-b px-3 py-1.5">
          <div className="flex gap-1">
            {SCREENS.map((s, i) => {
              const p = screenProgress(lead.f ?? {}, s);
              return (
                <button key={s.id} type="button" onClick={() => setScreenId(s.id)}
                  className={cn("shrink-0 rounded-md border px-1.5 py-0.5 text-[10px]",
                    s.id === screen.id ? "border-primary bg-primary/10 text-primary" : p.done === p.total ? "text-primary/70" : "text-muted-foreground")}>
                  {i + 1}. {s.title} {p.done}/{p.total}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* The only scrolling area */}
      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {pane === "CLOSING" ? (
          <ClosingDesk onOpenLead={(id) => { setLeadId(id); setPane("WORK"); }} />
        ) : pane === "DRAFTS" ? (
          <div className="space-y-2">
            <p className="text-[10px] text-muted-foreground">Four drafts a day for {me} — D1, D2, D3, D4 · {BATCH_SIZE} customers each. Close a draft when all 30 have a next step and a deadline.</p>
            {ROUNDS.map((r) => {
              const batch = batches.find((b) => b.handler === me && b.round === r);
              const rows = batch ? batch.leadIds.map((id) => leads.find((l) => l.id === id)).filter(Boolean) as typeof leads : [];
              const done = rows.filter((l) => l.nextAction && l.nextActionAt).length;
              return (
                <div key={r} className={cn("rounded-md border p-2", batch?.closedAt && "border-primary/40 bg-primary/5")}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold">D{r} · {rows.length || BATCH_SIZE} customers</p>
                      <p className="truncate text-[10px] text-muted-foreground">
                        {!batch ? "Not opened yet" : batch.closedAt ? `Closed ${new Date(batch.closedAt).toLocaleString()}${batch.closeNote ? ` — ${batch.closeNote}` : ""}` : `${done}/${rows.length} have a next step and deadline`}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {!batch ? (
                        <Button size="sm" className="h-7 px-2 text-[10px]" onClick={() => {
                          const made = buildBatch(me, r);
                          toast[made ? "success" : "error"](made ? `D${r} opened with ${made.leadIds.length} customers` : "No customers left to fill this draft");
                        }}>Open D{r}</Button>
                      ) : batch.closedAt ? (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => { reopenBatch(batch.id); toast.success(`D${r} reopened`); }}>Reopen</Button>
                      ) : (
                        <Button size="sm" variant="secondary" className="h-7 px-2 text-[10px]" onClick={() => { setClosingId(batch.id); setCloseNote(""); }}>Close draft</Button>
                      )}
                    </div>
                  </div>
                  {batch && !batch.closedAt && rows.length > 0 && (
                    <div className="mt-1.5 space-y-1">
                      {rows.slice(0, 30).map((l) => (
                        <button key={l.id} type="button" onClick={() => { setLeadId(l.id); setPane("WORK"); }}
                          className={cn("flex w-full items-center justify-between gap-2 rounded border px-2 py-1 text-left", l.id === lead?.id && "border-primary bg-primary/5")}>
                          <span className="truncate text-[11px]">{l.name}</span>
                          <Badge variant={l.nextAction && l.nextActionAt ? "outline" : "destructive"} className="shrink-0 text-[9px]">
                            {l.nextAction && l.nextActionAt ? "done" : "pending"}
                          </Badge>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : pane === "QUEUE" ? (
          <div className="space-y-1.5">
            <p className="text-[10px] text-muted-foreground">{queue.length} customers still need a decision — worst first.</p>
            {queue.slice(0, 60).map((l) => {
              const lh = health(l);
              return (
                <div key={l.id} className={cn("rounded-md border p-2", l.id === lead?.id && "border-primary bg-primary/5")}>
                  <div className="flex items-start justify-between gap-2">
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { setLeadId(l.id); setPane("WORK"); }}>
                      <p className="truncate text-xs font-medium">{l.name} <span className="font-normal text-muted-foreground">{l.phone}</span></p>
                      <p className="truncate text-[10px] text-muted-foreground">{lh.stepNo}. {lh.step?.title ?? "Checked in"} · {l.owner ?? "no owner"} · {l.nextAction ?? "no next step"}</p>
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      {lh.sla === "LATE" && <Badge variant="destructive" className="text-[10px]">late</Badge>}
                      <ContactActions phone={l.phone} name={l.name} compact />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : !lead ? (
          <p className="pt-10 text-center text-sm text-muted-foreground">Nothing left in the queue — every customer is closed or checked in.</p>
        ) : pane === "WORK" ? (
          <ScreenPanel
            lead={lead}
            screen={screen}
            expert={mode === "EXPERT"}
            canPrev={idx > 0}
            canNext={idx < SCREENS.length - 1}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
          />
        ) : pane === "MATCH" ? (
          <PropertyMatch lead={lead} />
        ) : pane === "LABELS" ? (
          <LabelConsole lead={lead} />
        ) : (
          <CapturedPanel lead={lead} />
        )}
      </main>

      {/* Action bar — always on screen */}
      {lead && (
        <footer className="shrink-0 border-t px-2 py-1">
          <div className="flex items-center gap-1 overflow-x-auto">
            <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={idx === 0} onClick={() => step(-1)}><ArrowLeft className="h-3 w-3" /></Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={idx >= SCREENS.length - 1} onClick={() => step(1)}><ArrowRight className="h-3 w-3" /></Button>
            {!lead.owner && (
              <Button size="sm" className="h-7 px-2 text-[10px]" onClick={() => { claim(lead.id); toast.success(`${lead.name} is yours, ${me}`); }}>
                <UserCheck className="mr-1 h-3 w-3" />Own it
              </Button>
            )}
            <CloseCommitButton leadId={lead.id} leadName={lead.name} leadPhone={lead.phone} actorName={me} size="xs" />
            <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => { escalate(lead.id, "Operator asked for help"); toast.success("Control Tower notified"); }}>Tower</Button>
            <select className="h-7 min-w-[8rem] flex-1 rounded-md border bg-background px-1 text-[10px]" value={nextAction} onChange={(e) => setNextAction(e.target.value)}>
              {NEXT_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <Input type="datetime-local" className="h-7 w-[8.8rem] shrink-0 text-[10px]" value={due} onChange={(e) => setDue(e.target.value)} />
            <Button size="sm" variant="secondary" className="h-7 shrink-0 px-2 text-[10px]"
              onClick={() => { setNext(lead.id, nextAction, new Date(due).toISOString()); toast.success("Next step and deadline locked"); }}>
              Lock
            </Button>
          </div>
        </footer>
      )}

      {lead && (
        <Dialog open={activityOpen} onOpenChange={setActivityOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Log activity · {lead.name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <label className="block text-xs font-medium">
                Activity
                <select className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" value={activityType} onChange={(e) => setActivityType(e.target.value)}>
                  <option>Call completed</option>
                  <option>WhatsApp message sent</option>
                  <option>Customer replied</option>
                  <option>Property options shared</option>
                  <option>Tour discussed</option>
                  <option>Internal note</option>
                </select>
              </label>
              <label className="block text-xs font-medium">
                What happened?
                <Input className="mt-1" autoFocus placeholder="Outcome, promise, blocker or detail…" value={activityNote} onChange={(e) => setActivityNote(e.target.value)} onKeyDown={(e) => {
                  if (e.key === "Enter" && activityNote.trim()) {
                    logActivity(lead.id, activityType, activityNote);
                    setActivityNote("");
                    setActivityOpen(false);
                    toast.success("Activity added to the customer story");
                  }
                }} />
              </label>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setActivityOpen(false)}>Cancel</Button>
              <Button disabled={!activityNote.trim()} onClick={() => {
                logActivity(lead.id, activityType, activityNote);
                setActivityNote("");
                setActivityOpen(false);
                toast.success("Activity added to the customer story");
              }}>Save activity</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <Dialog open={!!closingId} onOpenChange={(o) => !o && setClosingId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Close this draft</DialogTitle></DialogHeader>
          <label className="block text-xs font-medium">
            What happened in this draft?
            <Input className="mt-1" autoFocus placeholder="30 customers worked, 6 tours set…" value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosingId(null)}>Cancel</Button>
            <Button onClick={() => { if (closingId) closeBatch(closingId, closeNote); setClosingId(null); toast.success("Draft closed"); }}>Close draft</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>


      {/* Drag this edge to set the panel width, exactly like a sheet column */}
      {!panelOnly && !isNarrow && widthPct < 100 && (
        <>
          <div
            role="separator"
            aria-label="Drag to resize the panel"
            onPointerDown={() => setDragging(true)}
            className={cn("w-1.5 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary", dragging && "bg-primary")}
          />
          <div className="flex min-w-0 flex-1 items-center justify-center bg-muted/30 p-4 text-center">
            <p className="text-[11px] text-muted-foreground">
              Keep WhatsApp Web open in this space.<br />Drag the grey bar, or use the width buttons, to set the sizes you want.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
