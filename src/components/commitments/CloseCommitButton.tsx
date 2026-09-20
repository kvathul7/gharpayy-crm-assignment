import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Target, CheckCircle2, XCircle, History, AlertTriangle, IndianRupee, Clock, ListChecks, CalendarClock, StickyNote, Sparkles } from "lucide-react";
import { HowButton } from "@/components/common/HowButton";
import { CLOSE_WINDOWS, WINDOW_BY_ID, TONE_STYLE, CLOSE_STEPS, type CloseWindowId } from "@/lib/commitments/windows";
import { promiseStrength, riskFlags } from "@/lib/commitments/insights";
import { NotClosedDialog } from "./NotClosedDialog";
import { suggestPromise } from "@/lib/commitments/suggest";
import { useBookingFlow } from "@/bookingflow/store";
import {
  useCommitments, openCommitmentFor, commitmentsFor, promiseClose, markKept,
  hoursLeft, isExpired, dueFromWindow,
} from "@/lib/commitments/store";

interface Props {
  leadId: string;
  leadName: string;
  leadPhone?: string;
  actorName?: string;
  size?: "xs" | "sm";
  className?: string;
}

function fmt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function shortTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function countdown(h: number) {
  if (h < 0) return `${Math.abs(Math.round(h))}h overdue`;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m left`;
  if (h < 48) return `${Math.round(h)}h left`;
  return `${Math.round(h / 24)}d left`;
}

const QUICK_TIMES = ["10:00", "12:00", "15:00", "18:00", "20:00"];

/**
 * "Definitely Close" — the promise button that must exist on every lead.
 * Four decisions: the hour, the deadline, the moves, an optional note. A live
 * strength meter tells the closer what the promise is worth before committing.
 */
export function CloseCommitButton({ leadId, leadName, leadPhone = "", actorName = "You", size = "xs", className }: Props) {
  const all = useCommitments();
  const live = openCommitmentFor(all, leadId);
  const history = useMemo(() => commitmentsFor(all, leadId), [all, leadId]);

  const [open, setOpen] = useState(false);
  const [windowId, setWindowId] = useState<CloseWindowId>(live?.windowId ?? "48h");
  const [customDate, setCustomDate] = useState("");
  const [timeOfDay, setTimeOfDay] = useState("");
  const [steps, setSteps] = useState<string[]>(live?.steps ?? []);
  const [note, setNote] = useState("");

  // Where the customer actually stands decides the sensible promise. Opening
  // the dialog pre-answers the hour, the deadline and the first move, so a
  // routine promise costs one confirm instead of four decisions.
  const stage = useBookingFlow((st) => st.leads.find((l) => l.id === leadId || l.canonicalId === leadId)?.stage);
  const suggestion = useMemo(() => suggestPromise(stage), [stage]);
  useEffect(() => {
    if (!open || live) return; // editing a live promise keeps its own values
    setWindowId(suggestion.windowId);
    setTimeOfDay(suggestion.timeOfDay);
    setSteps(suggestion.steps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const def = WINDOW_BY_ID[windowId];
  const isChange = !!live;
  const previewDue = dueFromWindow(windowId, customDate, timeOfDay);
  const previewLeft = (new Date(previewDue).getTime() - Date.now()) / 3_600_000;

  const stepOptions = useMemo(
    () => Array.from(new Set([...(def?.howToExecute ?? []).slice(0, 3), ...CLOSE_STEPS])),
    [def],
  );
  const toggleStep = (v: string) =>
    setSteps((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));

  const strength = promiseStrength({ windowId, timeOfDay, customDate, steps, changeCount: live?.changeCount ?? 0 });
  const flags = live ? riskFlags(live) : [];

  const submit = () => {
    if (windowId === "custom" && !customDate) {
      toast.error("Pick the exact date you will close this");
      return;
    }
    promiseClose({ leadId, leadName, leadPhone, windowId, customDate, timeOfDay, steps, note, by: actorName });
    toast.success(isChange ? `Promise moved — ${def.short}` : `Committed: ${leadName} closes ${fmt(previewDue)}`, {
      description: steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"} on your plan` : "No steps picked — add them when you know the plan.",
    });
    setNote("");
    setOpen(false);
  };

  // ⌘/Ctrl+Enter commits — the promise should cost one keystroke, not five clicks.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const left = live ? hoursLeft(live) : 0;
  const overdue = live ? isExpired(live) : false;

  return (
    <div className={cn("inline-flex items-center gap-1", className)}>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            variant={live ? "outline" : "default"}
            size="sm"
            className={cn(
              "h-7 gap-1 rounded-full px-2 text-[11px] font-semibold",
              size === "xs" && "h-6 px-2 text-[10px]",
              live && TONE_STYLE[WINDOW_BY_ID[live.windowId]?.tone ?? "week"],
              overdue && "ring-1 ring-destructive",
            )}
          >
            <Target className="h-3 w-3" />
            {live ? `Closing ${WINDOW_BY_ID[live.windowId]?.short} · ${countdown(left)}` : "Definitely Close"}
          </Button>
        </DialogTrigger>

        <DialogContent className="flex max-h-[90vh] max-w-xl flex-col gap-0 overflow-hidden p-0">
          {/* Header */}
          <DialogHeader className="border-b border-border px-4 pb-3 pt-4 text-left">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Target className="h-4 w-4 text-primary" />
              {isChange ? "Move the close promise" : "Definitely Close"} — {leadName}
            </DialogTitle>
            <DialogDescription className="text-[11px] leading-relaxed">
              {isChange
                ? "Move the deadline and say why. The old one stays in the history."
                : `Pre-filled because ${suggestion.because}. Change anything, then commit — ${"⌘"}/Ctrl+Enter commits.`}
              {" "}Stored with your name so the morning review can check it.
            </DialogDescription>
          </DialogHeader>

          {/* Scroll body */}
          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {live && (
              <div className={cn("rounded-lg border p-2.5 text-[11px]", overdue ? "border-destructive/50 bg-destructive/5" : "border-border bg-muted/40")}>
                <p className="font-semibold">
                  Current promise: {WINDOW_BY_ID[live.windowId]?.short} · due {fmt(live.dueAt)} · {countdown(left)}
                </p>
                <p className="text-muted-foreground">Promised by {live.promisedBy} · moved {live.changeCount}×</p>
                {flags.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {flags.map((f) => (
                      <span key={f} className="rounded-full border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                        {f}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 1 — Time */}
            <Section
              n={1}
              icon={<Clock className="h-3.5 w-3.5" />}
              title="Time"
              subtitle="The hour the money moves"
              done={/^\d{1,2}:\d{2}$/.test(timeOfDay)}
              how={
                <HowButton
                  title="Time — the hour the money moves"
                  why="A date without an hour is not a plan. Naming the hour is what turns a promise into something you can be reminded about and held to."
                  howToExecute={[
                    "Pick the hour the customer said they are free, not the hour that suits you.",
                    "Leave it blank only if the deadline window itself is the plan (e.g. within 3 hours).",
                  ]}
                  whatNotToDo={["Do not pick a time you know you are on another visit."]}
                  doneWhen="The promise carries an exact hour you have blocked out."
                />
              }
            >
              <div className="flex flex-wrap items-center gap-1.5">
                {QUICK_TIMES.map((t) => (
                  <Chip key={t} active={timeOfDay === t} onClick={() => setTimeOfDay(timeOfDay === t ? "" : t)}>
                    {t}
                  </Chip>
                ))}
                <Input
                  type="time"
                  value={timeOfDay}
                  onChange={(e) => setTimeOfDay(e.target.value)}
                  aria-label="Exact time"
                  className="h-7 w-28 text-[11px]"
                />
                {timeOfDay && (
                  <button type="button" onClick={() => setTimeOfDay("")} className="text-[10px] text-muted-foreground underline">
                    clear
                  </button>
                )}
              </div>
            </Section>

            {/* 2 — Deadline */}
            <Section
              n={2}
              icon={<CalendarClock className="h-3.5 w-3.5" />}
              title="Deadline"
              subtitle={def?.short ? `Currently ${def.short}` : "Pick the window"}
              done={windowId !== "custom" || !!customDate}
              how={
                <HowButton
                  title="Deadline — the window you are accountable to"
                  why="The window decides which board the promise lands on. A short window means the Control Tower expects money today; a long one means next week's forecast."
                  howToExecute={[
                    "Pick the window that matches the customer's reality, not the one that looks best.",
                    "Open the ⓘ next to any window for its full operating manual.",
                  ]}
                  whatNotToDo={["Never park an unspoken-to lead in a long window to clear your board."]}
                  doneWhen="The due moment shown below is one you would defend in the morning review."
                />
              }
            >
              <div className="grid gap-1.5 sm:grid-cols-2">
                {CLOSE_WINDOWS.map((w) => {
                  const wDue = dueFromWindow(w.id, customDate, timeOfDay);
                  const active = windowId === w.id;
                  return (
                    <div key={w.id} className="flex items-stretch gap-1">
                      <button
                        type="button"
                        onClick={() => setWindowId(w.id)}
                        aria-pressed={active}
                        className={cn(
                          "flex-1 rounded-lg border px-2.5 py-1.5 text-left transition",
                          active ? cn("border-primary ring-1 ring-primary/40", TONE_STYLE[w.tone]) : "border-border hover:bg-muted",
                        )}
                      >
                        <span className="block text-[11px] font-semibold">{w.short}</span>
                        <span className={cn("block text-[10px]", active ? "opacity-80" : "text-muted-foreground")}>
                          {w.id === "custom" ? "you pick the date" : `→ ${fmt(wDue).replace(/,/g, "")}`}
                        </span>
                      </button>
                      <HowButton
                        className="self-center"
                        title={w.label}
                        why={w.why}
                        howToExecute={w.howToExecute}
                        whatNotToDo={w.whatNotToDo}
                        problemsThatCanOccur={w.problemsThatCanOccur}
                        branches={w.branches}
                        doneWhen={w.doneWhen}
                      />
                    </div>
                  );
                })}
              </div>
              {windowId === "custom" && (
                <Input
                  type="datetime-local"
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                  className="mt-1.5 h-8 text-[11px]"
                />
              )}
              <p className="mt-1.5 rounded-md border border-primary/30 bg-primary/5 p-2 text-[11px]">
                This promise falls due <span className="font-semibold">{fmt(previewDue)}</span>
                <span className="text-muted-foreground"> · {countdown(previewLeft)}</span>
              </p>
            </Section>

            {/* 3 — Steps */}
            <Section
              n={3}
              icon={<ListChecks className="h-3.5 w-3.5" />}
              title="Steps you will take"
              subtitle={steps.length ? `${steps.length} picked · 2–3 is a plan` : "Tick 2–3 concrete moves"}
              done={steps.length >= 2}
              how={
                <HowButton
                  title="Steps — the plan, not the hope"
                  why="Promises break because nobody wrote down the two or three moves that get to money. Ticking the steps makes the promise reviewable: the manager can ask which step is stuck instead of asking how it feels."
                  howToExecute={[
                    "Tick only the steps you will genuinely do before the deadline.",
                    "Two or three steps is a plan; eight steps is a wish list.",
                    "If none of the steps fit, write the real move in the note.",
                  ]}
                  whatNotToDo={["Do not tick every box to look thorough.", "Do not tick a step that depends on someone who has not agreed to it."]}
                  problemsThatCanOccur={["Steps get ticked and never executed — the review compares steps against the activity log."]}
                  doneWhen="Every ticked step is either done or explained by the deadline."
                />
              }
            >
              <div className="flex flex-wrap gap-1">
                {stepOptions.map((sOpt) => (
                  <Chip key={sOpt} active={steps.includes(sOpt)} onClick={() => toggleStep(sOpt)} className="max-w-full truncate text-[10px]">
                    {steps.includes(sOpt) ? "✓ " : ""}{sOpt}
                  </Chip>
                ))}
              </div>
              {steps.length > 4 && (
                <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                  {steps.length} ticked — that is a wish list. Keep the two or three that actually get to money.
                </p>
              )}
            </Section>

            {/* 4 — Note */}
            <Section
              n={4}
              icon={<StickyNote className="h-3.5 w-3.5" />}
              title="Note"
              subtitle="Optional"
              done={note.trim().length > 0}
            >
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Anything worth knowing. Leave blank if there is nothing to add."
                className="text-[11px]"
              />
            </Section>

            {/* Strength meter */}
            <div className="rounded-lg border border-border bg-muted/30 p-2.5">
              <div className="flex items-center gap-2">
                <Sparkles className={cn("h-3.5 w-3.5", strength.grade === "strong" ? "text-emerald-600" : strength.grade === "fair" ? "text-amber-500" : "text-destructive")} />
                <p className="text-[11px] font-semibold">
                  Promise strength · <span className="tabular-nums">{strength.score}%</span>
                </p>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      strength.grade === "strong" ? "bg-emerald-500" : strength.grade === "fair" ? "bg-amber-500" : "bg-destructive",
                    )}
                    style={{ width: `${Math.max(6, strength.score)}%` }}
                  />
                </div>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">{strength.verdict}</p>
              <ul className="mt-1.5 space-y-0.5">
                {strength.parts.map((p) => (
                  <li key={p.label} className="flex items-start gap-1.5 text-[10px] leading-relaxed">
                    {p.ok ? (
                      <CheckCircle2 className="mt-[1px] h-3 w-3 shrink-0 text-emerald-600" />
                    ) : (
                      <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0 text-destructive" />
                    )}
                    <span className={p.ok ? "text-muted-foreground" : "text-foreground"}>
                      <span className="font-medium">{p.label}</span> — {p.hint}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* History */}
            {history.length > 0 && (
              <div className="space-y-1 border-t border-border pt-3">
                <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <History className="h-3 w-3" /> Promise history — nothing is ever deleted
                </p>
                {history.flatMap((c) =>
                  c.history.map((e, i) => (
                    <p key={`${c.id}-${i}`} className="text-[11px] leading-relaxed text-muted-foreground">
                      <span className="font-medium text-foreground">{fmt(e.at)}</span> · {e.by} · {e.kind}
                      {e.dueAt && ` → due ${fmt(e.dueAt)}`}
                      {e.prevDueAt && ` (was ${fmt(e.prevDueAt)})`}
                      {(e.reason || e.note) && ` · ${e.reason ?? e.note}`}
                    </p>
                  )),
                )}
              </div>
            )}
          </div>

          {/* Sticky action bar */}
          <div className="flex flex-wrap items-center gap-2 border-t border-border bg-background px-4 py-3">
            <Button onClick={submit} className="gap-1">
              <Target className="h-3.5 w-3.5" />
              {isChange ? "Move promise" : "Commit to close"}
            </Button>
            <span className="hidden text-[10px] text-muted-foreground sm:inline">⌘↵</span>
            {live && (
              <>
                <Button
                  variant="outline"
                  className="gap-1 text-emerald-600"
                  onClick={() => { markKept(live.id, actorName); toast.success("Marked closed — booking credited"); setOpen(false); }}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" /> It closed
                </Button>
                <NotClosedDialog
                  commitmentId={live.id}
                  leadName={leadName}
                  actorName={actorName}
                  onDone={() => setOpen(false)}
                  trigger={
                    <Button variant="outline" className="gap-1 text-destructive">
                      <XCircle className="h-3.5 w-3.5" /> Did not close
                    </Button>
                  }
                />
              </>
            )}
            <span className="ml-auto text-[10px] text-muted-foreground">
              due {shortTime(previewDue)}
            </span>
          </div>
        </DialogContent>
      </Dialog>

      {live && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Promise detail"
              className={cn(
                "rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted",
                overdue && "border-destructive text-destructive",
              )}
            >
              {overdue ? <AlertTriangle className="h-3 w-3" /> : <IndianRupee className="h-3 w-3" />}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 space-y-1 text-[11px]">
            <p className="font-semibold">{live.leadName} · {WINDOW_BY_ID[live.windowId]?.short}</p>
            <p className="text-muted-foreground">Due {fmt(live.dueAt)} · {countdown(left)}</p>
            {live.steps?.length ? (
              <ul className="space-y-0.5">
                {live.steps.map((st) => (
                  <li key={st} className="text-foreground/90">• {st}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No steps picked yet.</p>
            )}
            {live.note && <p className="rounded bg-muted/60 p-1.5">{live.note}</p>}
            {flags.length > 0 && <p className="font-medium text-destructive">{flags.join(" · ")}</p>}
            <p className="text-muted-foreground">Promised by {live.promisedBy} · moved {live.changeCount}×</p>
          </PopoverContent>
        </Popover>
      )}

      <HowButton
        title="Definitely Close — why this button exists"
        why="A CRM that cannot tell you which leads close today is a list, not a system. This button forces one honest sentence per lead: when the money lands. The Control Tower then works today's promised list, and the daily review compares what was promised against what happened."
        howToExecute={[
          "Use it on every lead you have actually spoken to — pick the window that matches reality.",
          "Set the time, the deadline and the two or three steps that get to money.",
          "Watch the strength meter: anything under 100% is a question you will be asked tomorrow.",
          "Every morning, review your promises due today before you make any new calls.",
          "Mark 'It closed' with the booking, or 'Did not close' with the truth, the same day.",
        ]}
        whatNotToDo={[
          "Do not promise a short window to look good on the board — accuracy is scored, volume is not.",
          "Do not leave expired promises open; an expired promise is a broken one until you say otherwise.",
          "Do not move a date without saying what changed — the history is read in the review.",
        ]}
        problemsThatCanOccur={[
          "Everyone picks 7d and today's forecast stays empty — the board flags this per person.",
          "Promises are made and never settled, so accuracy cannot be measured.",
          "The same lead is promised by two people — the board shows both and the manager decides.",
        ]}
        branches={[
          { condition: "You have not spoken to the lead yet", then: "Do not promise. Call first, then commit." },
          { condition: "The lead is decided and only payment is left", then: "Pick 3h and drive it to money the same session." },
          { condition: "The deadline passes with no close", then: "Settle it honestly today: kept, broken, or moved." },
        ]}
        doneWhen="Every lead you own has either a live promise with a date, or an honest reason it cannot have one."
        withText
      />
    </div>
  );
}

/* ---------------- presentation atoms ---------------- */

function Section({
  n, icon, title, subtitle, done, how, children,
}: {
  n: number; icon: React.ReactNode; title: string; subtitle?: string; done?: boolean;
  how?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold",
            done ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground",
          )}
        >
          {done ? "✓" : n}
        </span>
        <span className="text-muted-foreground">{icon}</span>
        <p className="text-[11px] font-semibold">{title}</p>
        {subtitle && <p className="truncate text-[10px] text-muted-foreground">· {subtitle}</p>}
        {how}
      </div>
      {children}
    </section>
  );
}

function Chip({
  active, onClick, children, className,
}: { active: boolean; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] transition",
        active ? "border-primary bg-primary/10 font-medium text-primary" : "border-border text-muted-foreground hover:bg-muted",
        className,
      )}
    >
      {children}
    </button>
  );
}
