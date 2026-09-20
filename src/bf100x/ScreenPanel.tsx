// Four or five questions on one screen. Same options, same rules, fewer clicks:
// picking an option saves itself, and one button saves + moves to the next screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, History, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isExtraRequired, isStepDone, missingOn } from "@/bookingflow/journey";
import type { JStep } from "@/bookingflow/journey";
import type { FlowLead } from "@/bookingflow/types";
import { useBookingFlow } from "@/bookingflow/store";
import { SCREENS, currentScreen, screenIndex, screenProgress } from "./screens";
import type { Screen } from "./screens";

const inputType = (kind: JStep["kind"] | "TEXT" | "NUMBER" | "DATE" | "DATETIME") =>
  kind === "DATE" ? "date" : kind === "DATETIME" ? "datetime-local" : kind === "NUMBER" ? "number" : "text";

const fieldsOf = (st: JStep) => [st.field, ...(st.extra ?? []).map((x) => x.field)];

export function ScreenPanel({
  lead,
  screen,
  expert,
  onPrev,
  onNext,
  canPrev,
  canNext,
}: {
  lead: FlowLead;
  screen: Screen;
  expert: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  canPrev?: boolean;
  canNext?: boolean;
}) {
  const { answerStep, editFields } = useBookingFlow();
  const f = lead.f ?? {};
  const [draft, setDraft] = useState<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft({}), [screen.id, lead.id]);

  const now = currentScreen(f);
  const idx = screenIndex(screen.id);
  const nowIdx = screenIndex(now.id);
  const locked = idx > nowIdx && !expert;
  const p = screenProgress(f, screen);
  const val = (k: string) => draft[k] ?? f[k] ?? "";
  const put = (k: string, v: string) => setDraft((s) => ({ ...s, [k]: v }));

  const merged = useMemo(() => ({ ...f, ...draft }), [f, draft]);

  /** Writes one step's answers to the timeline. Returns false if it is half-filled. */
  function commit(st: JStep, source: Record<string, string>, quiet = false) {
    const full = { ...f, ...source };
    if (!full[st.field]) {
      if (!quiet) toast.error(`${st.title} still needs an answer`);
      return false;
    }
    const missingExtra = (st.extra ?? []).filter((x) => !full[x.field] && isExtraRequired(full, st, x.field));
    if (missingExtra.length) {
      if (!quiet) toast.error(`${st.title}: also fill ${missingExtra.map((m) => m.label).join(", ")}`);
      return false;
    }
    const payload: Record<string, string> = {};
    fieldsOf(st).forEach((k) => {
      if (source[k] !== undefined && source[k] !== f[k]) payload[k] = source[k]!;
    });
    if (Object.keys(payload).length === 0) return true;
    if (isStepDone(f, st)) editFields(lead.id, payload, "corrected on the 100x screen", st.key);
    else answerStep(lead.id, st.key, payload);
    return true;
  }

  /** Typed answers save themselves — on Enter, or the moment focus leaves the box. */
  function commitTyped(st: JStep) {
    if (!fieldsOf(st).some((k) => draft[k] !== undefined && draft[k] !== f[k])) return;
    if (!commit(st, draft, true)) return;
    setDraft((s) => {
      const copy = { ...s };
      fieldsOf(st).forEach((k) => delete copy[k]);
      return copy;
    });
    toast.success(`${st.title} saved`);
  }

  /** One click on an option is the answer — save it right away when nothing else is needed. */
  function chooseOption(st: JStep, value: string) {
    const nextDraft = { ...draft, [st.field]: value };
    const full = { ...f, ...nextDraft };
    const stillNeeded = (st.extra ?? []).filter((x) => !full[x.field] && isExtraRequired(full, st, x.field));
    if (stillNeeded.length === 0 && commit(st, nextDraft, true)) {
      setDraft((s) => {
        const copy = { ...s };
        fieldsOf(st).forEach((k) => delete copy[k]);
        return copy;
      });
      toast.success(`${st.title} saved`);
      return;
    }
    setDraft(nextDraft);
  }

  function saveAll(silent = false) {
    const touched = screen.steps.filter((st) =>
      fieldsOf(st).some((k) => draft[k] !== undefined && draft[k] !== f[k]),
    );
    if (touched.length === 0) {
      if (!silent) toast.error("Answer at least one question on this screen first");
      return touched.length === 0;
    }
    for (const st of touched) if (!commit(st, draft)) return false;
    setDraft({});
    toast.success(`${touched.length} ${touched.length === 1 ? "answer" : "answers"} saved on one screen`);
    return true;
  }

  const saveAndNext = useCallback(() => {
    if (Object.keys(draft).length > 0 && !saveAll(true)) return;
    if (canNext) onNext?.();
    else toast.success("This is the last screen");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, canNext, onNext]);

  /** Enter moves to the next box, and from the last box to the next screen. */
  function focusNextField(from: HTMLElement) {
    const list = rootRef.current?.querySelectorAll("input:not([disabled])");
    const boxes: HTMLInputElement[] = list ? (Array.from(list) as HTMLInputElement[]) : [];
    const i = boxes.indexOf(from as HTMLInputElement);
    const next: HTMLInputElement | undefined = i >= 0 ? boxes[i + 1] : undefined;
    if (next) {
      next.focus();
      next.select?.();
      return;
    }
    saveAndNext();
  }

  // chooseOption closes over draft state and is rebuilt every render, so the
  // key handler reads it through a ref instead of re-subscribing each time.
  const chooseRef = useRef(chooseOption);
  chooseRef.current = chooseOption;

  // The screen answers multiple-choice questions with the number keys.
  // Every choice used to cost a mouse click even though the operator's
  // hands were already on the keyboard for the typed answers; a five
  // question screen was five clicks that Enter alone could not remove.
  // 1-9 picks an option on the first question still unanswered, so a whole
  // screen can be completed without reaching for the mouse.
  const activeChoice = useMemo(
    () => screen.steps.find((st) => st.kind === "CHOICE" && !val(st.field)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [screen, draft, lead.f],
  );
  // Keyboard on the whole screen: Enter or Ctrl/Cmd+Enter moves on, arrows walk screens.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveAndNext();
        return;
      }
      if (e.key === "Enter" && !typing && el?.tagName !== "BUTTON") {
        e.preventDefault();
        saveAndNext();
        return;
      }
      if (!typing && /^[1-9]$/.test(e.key) && activeChoice?.options?.length) {
        const pick = activeChoice.options[Number(e.key) - 1];
        if (pick) {
          e.preventDefault();
          chooseRef.current(activeChoice, pick.value);
          return;
        }
      }
      if (!typing && (e.key === "ArrowRight" || e.key === "PageDown")) { e.preventDefault(); saveAndNext(); }
      if (!typing && (e.key === "ArrowLeft" || e.key === "PageUp")) { e.preventDefault(); if (canPrev) onPrev?.(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveAndNext, canPrev, onPrev, activeChoice]);

  const nav = (
    <div className="flex items-center gap-1.5">
      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={!canPrev} onClick={() => onPrev?.()}>
        <ArrowLeft className="mr-1 h-3.5 w-3.5" />Previous screen
      </Button>
      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={!canNext} onClick={saveAndNext}>
        Save &amp; next screen<ArrowRight className="ml-1 h-3.5 w-3.5" />
      </Button>
    </div>
  );

  return (
    <Card className="p-4" ref={rootRef}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[10px]">Screen {idx + 1} of {SCREENS.length}</Badge>
        <Badge variant="secondary" className="text-[10px]">{screen.title}</Badge>
        <Badge variant="outline" className="text-[10px]">{p.done}/{p.total} answered</Badge>
        {locked && <Badge variant="outline" className="text-[10px]"><Lock className="mr-1 h-3 w-3" />Opens after “{now.title}”</Badge>}
        {idx === nowIdx && <Badge className="text-[10px]">Do this now</Badge>}
        <div className="ml-auto">{nav}</div>
      </div>

      {locked ? (
        <p className="mt-3 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          Finish “{now.title}” first. Still needed there: {now.steps.flatMap((s) => missingOn(f, s)).join(", ") || "an answer"}.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {screen.steps.map((st, i) => {
            const done = isStepDone(f, st);
            return (
              <div key={st.key} className={cn("rounded-lg border p-3", done && "bg-muted/30")}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-xs text-muted-foreground">{i + 1}.</span>
                  <p className="text-sm font-medium">{st.question}</p>
                  {done && <Badge className="bg-primary/15 text-[10px] text-primary hover:bg-primary/15"><Check className="mr-1 h-3 w-3" />done</Badge>}
                  <span className="ml-auto text-[10px] text-muted-foreground">waiting on {st.waitingOn}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{st.help}</p>

                {st.kind === "CHOICE" ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {st.options?.map((o, oi) => (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => chooseOption(st, o.value)}
                        title={o.hint}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-[11px] transition",
                          val(st.field) === o.value ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent",
                          o.effect && "border-destructive/50",
                        )}
                      >
                        {st.key === activeChoice?.key && oi < 9 && (
                          <span className="mr-1 font-mono text-[9px] opacity-60">{oi + 1}</span>
                        )}
                        {o.label}{o.effect === "ESCALATE" ? " → Tower" : o.effect === "CLOSE" ? " → closes" : ""}
                      </button>
                    ))}
                  </div>
                ) : (
                  <Input
                    className="mt-2 h-8 max-w-xs text-xs"
                    type={inputType(st.kind)}
                    placeholder={st.placeholder}
                    value={val(st.field)}
                    onChange={(e) => put(st.field, e.target.value)}
                    onBlur={() => commitTyped(st)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      commitTyped(st);
                      if (e.ctrlKey || e.metaKey) saveAndNext();
                      else focusNextField(e.currentTarget);
                    }}
                  />
                )}

                <div className="mt-2 flex flex-wrap gap-3">
                  {(st.extra ?? []).map((x) => (
                    <label key={x.field} className="text-[11px]">
                      <span className="text-muted-foreground">{x.label}{isExtraRequired(merged, st, x.field) ? " *" : ""}</span>
                      <Input
                        className="mt-1 h-8 w-[13rem] text-xs"
                        type={inputType(x.kind)}
                        placeholder={x.placeholder}
                        value={val(x.field)}
                        onChange={(e) => put(x.field, e.target.value)}
                        onBlur={() => commitTyped(st)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          commitTyped(st);
                          if (e.ctrlKey || e.metaKey) saveAndNext();
                          else focusNextField(e.currentTarget);
                        }}
                      />
                    </label>
                  ))}
                </div>

                <StepHistory lead={lead} stepKey={st.key} />

                {!done && missingOn(merged, st).length > 0 && (
                  <p className="mt-1.5 flex items-center gap-1 text-[11px] text-destructive">
                    <AlertTriangle className="h-3 w-3" />Still missing: {missingOn(merged, st).join(", ")}
                  </p>
                )}
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button size="sm" onClick={() => saveAll()}>Save this screen</Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft({})} disabled={Object.keys(draft).length === 0}>Clear my edits</Button>
            {nav}
            <span className="text-[11px] text-muted-foreground">
              Keyboard: <b>1</b>–<b>9</b> answers the highlighted question, <b>Enter</b> saves and jumps to the next box, <b>Enter</b> on the last box moves to the next screen.
              <b> Ctrl/⌘+Enter</b> jumps ahead any time, <b>←</b> and <b>→</b> walk the screens.
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Who changed this answer, when, and what it was before. */
function StepHistory({ lead, stepKey }: { lead: FlowLead; stepKey: string }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const rows = (lead.events ?? []).filter((e) => e.stepKey === stepKey);
  if (rows.length === 0) return null;
  return (
    <div className="mt-2">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-[10px] text-muted-foreground underline-offset-2 hover:underline">
        <History className="h-3 w-3" />{rows.length} change{rows.length === 1 ? "" : "s"} · last by {rows[rows.length - 1]!.actor}
      </button>
      {open && (
        <ol className="mt-1 space-y-0.5 rounded-md border bg-muted/30 p-2 text-[10px]">
          {[...rows].reverse().map((e, i) => (
            <li key={i}>
              <span className="font-medium">{e.actor}</span> · {mounted ? new Date(e.at).toLocaleString() : ""}
              {e.changes?.length
                ? ` — ${e.changes.map((c) => `${c.field}: ${c.from || "empty"} → ${c.to}`).join(", ")}`
                : e.detail ? ` — ${e.detail}` : ""}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
