// Call Conversation Engine — mission → call → agenda screen → three outputs.
// The operator never types a message and never decides the next step alone.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useMovement } from "@/movement/store";
import { NEXT_ACTION_LABEL, type MovementState } from "@/movement/types";
import { rankedForCustomer } from "@/movement-care/properties";
import { buildOutputs, wasteFlags } from "./compose";
import { knownFacts, noAnswerPlan, suggestAgenda } from "./infer";
import { callMission } from "./mission";
import { useCallEngine } from "./store";
import { pushCallRecord } from "./sync";
import { syncCall } from "@/lib/crm/call-sync";
import {
  ACTIVITIES, AGENDAS, DISLIKE_REASONS, MOVEMENT_LABEL, OUTCOMES, PRICE_REACTIONS, PROMISES, REACTIONS,
  TOUR_REFUSALS, agendaDef, emptyCapture,
  type AgendaKey, type CallCapture, type CallOutputs, type CallRecord, type OutcomeKind,
} from "./types";

const Chip = ({ on, children, onClick }: { on?: boolean; children: React.ReactNode; onClick: () => void }) => (
  <button
    onClick={onClick}
    className={cn(
      "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
      on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted",
    )}
  >
    {children}
  </button>
);

const Title = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>
);

interface Props {
  lead: MovementState;
  onLogged?: () => void;
}

export function CallEngine({ lead, onLogged }: Props) {
  const mv = useMovement();
  const engine = useCallEngine();

  const suggestion = useMemo(() => suggestAgenda(lead), [lead]);
  const [agenda, setAgenda] = useState<AgendaKey>(suggestion.agenda);
  const [agendaTouched, setAgendaTouched] = useState(false);
  const [phase, setPhase] = useState<"mission" | "capture" | "outputs">("mission");
  const [outcome, setOutcome] = useState<OutcomeKind>("connected");
  const [cap, setCap] = useState<CallCapture>(emptyCapture);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [outputs, setOutputs] = useState<CallOutputs | null>(null);
  const [nowText, setNowText] = useState("");
  const [followText, setFollowText] = useState("");
  const [saving, setSaving] = useState(false);

  const facts = useMemo(() => knownFacts(lead), [lead]);
  const def = agendaDef(agenda);
  const attempt = engine.noAnswerStreak(lead.ulid) + 1;
  const plan = useMemo(() => noAnswerPlan(lead, attempt), [lead, attempt]);
  const nextPlan = useMemo(() => noAnswerPlan(lead, attempt + 1), [lead, attempt]);
  const mission = useMemo(() => callMission(lead, agenda, cap), [lead, agenda, cap]);
  const media = useMemo(() => rankedForCustomer(lead, []).slice(0, 3), [lead]);

  const set = (p: Partial<CallCapture>) => setCap((c) => ({ ...c, ...p }));
  const toggle = (key: "activities" | "promises" | "matters", value: string) =>
    setCap((c) => {
      const list = c[key] ?? [];
      return { ...c, [key]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] };
    });

  function startCall() {
    mv.startCall(lead.ulid);
    setStartedAt(Date.now());
    setPhase("capture");
  }

  function finish(kind: OutcomeKind) {
    setOutcome(kind);
    const out = buildOutputs(
      lead,
      agenda,
      cap,
      kind,
      kind === "connected" ? undefined : plan.ask,
      kind === "connected" ? undefined : nextPlan.ask,
    );
    setOutputs(out);
    setNowText(out.now);
    setFollowText(out.followUp.text);
    setPhase("outputs");
  }

  async function commit() {
    if (!outputs) return;
    const durationSec = startedAt ? Math.round((Date.now() - startedAt) / 1000) : undefined;
    const waste = wasteFlags(lead, cap, outputs.movement);

    mv.logCall(lead.ulid, outcome === "connected" ? "connected" : outcome === "not-relevant" ? "wrong-number" : "no-answer", def.label);
    mv.capture(lead.ulid, {
      moveInDate: cap.moveIn ?? undefined,
      location: cap.area ?? undefined,
      officeOrCollege: cap.officeOrCollege ?? undefined,
      budget: cap.budget ?? undefined,
      roomType: cap.roomType ?? undefined,
      inBangalore: cap.inBangalore ?? undefined,
      forSelf: cap.forWhom ? cap.forWhom === "Self" : undefined,
      priceIntent:
        cap.priceReaction === "accepted" || cap.priceReaction === "reasonable"
          ? "ok"
          : cap.priceReaction === "needs-discount"
            ? "stretch"
            : cap.priceReaction === "too-expensive"
              ? "no"
              : undefined,
    });
    if (cap.tourAt) mv.scheduleTour(lead.ulid, cap.tourAt, cap.propertyName ?? undefined);
    mv.sendMessage(lead.ulid, nowText);
    mv.setNextAction(lead.ulid, {
      kind: outputs.nextStep.kind,
      dueAt: outputs.nextStep.dueAt,
      ownerId: mv.actor.id,
      ownerName: mv.actor.name,
      note: outputs.nextStep.label,
    });
    mv.log(lead.ulid, "note", `${def.label} · ${MOVEMENT_LABEL[outputs.movement]}${cap.note ? ` — ${cap.note}` : ""}`);

    const record = {
      id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: new Date().toISOString(),
      ulid: lead.ulid,
      canonicalId: lead.canonicalId,
      name: lead.name,
      operatorId: mv.actor.id,
      operatorName: mv.actor.name,
      agenda,
      agendaSource: agendaTouched ? "operator" : "system",
      outcome,
      durationSec,
      capture: cap,
      movement: outputs.movement,
      messageNow: nowText,
      messageSent: true,
      followUp: { ...outputs.followUp, text: followText },
      followUpState: "armed",
      nextStep: outputs.nextStep,
      stageAfter: lead.stage,
      waste,
    } as CallRecord;

    engine.save(record);

    // The local writes above keep the operator moving. The server is the
    // source of shared truth, so what this toast claims is decided by what
    // the SERVER accepted — never by the fact that localStorage succeeded.
    setSaving(true);
    const [callPush, sync] = await Promise.all([pushCallRecord(record), syncCall(lead, record)]);
    setSaving(false);

    const serverOk = callPush.ok && sync.ok;
    const problems = [...(callPush.ok ? [] : [`call record: ${callPush.error}`]), ...sync.errors];

    if (serverOk) {
      toast.success(`${def.label} saved to the server · next: ${outputs.nextStep.label}`, {
        description:
          sync.handoff.created && sync.handoff.dueAt
            ? `Handed to Closing Desk — ${sync.handoff.owner} must close by ${new Date(sync.handoff.dueAt).toLocaleString()}`
            : `Customer ${sync.customerId} updated · ${MOVEMENT_LABEL[outputs.movement]}`,
      });
    } else {
      toast.error("NOT saved to the server — this call is only on this device", {
        description: problems.join(" · ").slice(0, 300) || "The backend rejected the write.",
        duration: 12000,
      });
    }
    setPhase("mission");
    setCap(emptyCapture());
    setOutputs(null);
    setStartedAt(null);
    onLogged?.();
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    toast.success("Copied — paste into WhatsApp");
  }

  // Requirement: every item carries an owner and a deadline, and what is
  // late is red on this screen — not in a report somewhere else.
  const ownerName = lead.nextAction?.ownerName || lead.primaryOwnerName || "";
  const nextOverdue = !!lead.nextAction && new Date(lead.nextAction.dueAt).getTime() < Date.now();

  return (
    <div className="space-y-3 rounded-lg border p-3">
      {/* Fixed header — the lead's details stay visible for the whole call, never scroll away. */}
      <div className="sticky top-0 z-20 -mx-3 -mt-3 mb-1 space-y-1.5 border-b bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{lead.name ?? "Customer"}</div>
            <div className="text-[10px] text-muted-foreground">M-POWER CALL · {def.label}</div>
            <div className="text-[10px] text-muted-foreground">
              Outcome: this customer ends the call with a written message, an armed follow-up and a dated next step.
            </div>
          </div>
          <div className="flex max-w-[45%] shrink-0 flex-col items-end gap-1 text-right">
            <Badge variant={ownerName ? "outline" : "destructive"} className="max-w-full whitespace-normal text-[10px] leading-tight">
              {ownerName ? `owner: ${ownerName}` : "no owner"}
            </Badge>
            {lead.nextAction ? (
              <Badge variant={nextOverdue ? "destructive" : "outline"} className="max-w-full whitespace-normal text-[10px] leading-tight">
                {nextOverdue ? "OVERDUE · " : "next: "}
                {NEXT_ACTION_LABEL[lead.nextAction.kind]} ·{" "}
                {new Date(lead.nextAction.dueAt).toLocaleString([], {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </Badge>
            ) : (
              <Badge variant="destructive" className="text-[10px]">
                no deadline set
              </Badge>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          {facts.map((f) => (
            <div key={f.label} className="flex justify-between gap-2 text-[11px]">
              <span className="text-muted-foreground">{f.label}</span>
              <span className={cn("truncate font-medium", !f.known && "text-muted-foreground/60")}>{f.value}</span>
            </div>
          ))}
        </div>
      </div>


      {/* Agenda */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Title>Why are we calling</Title>
          {!agendaTouched && <Badge variant="secondary" className="text-[9px]">system: {suggestion.why}</Badge>}
        </div>
        <div className="flex flex-wrap gap-1">
          {AGENDAS.map((a) => (
            <Chip key={a.key} on={agenda === a.key} onClick={() => { setAgenda(a.key); setAgendaTouched(true); }}>
              {a.label}
            </Chip>
          ))}
        </div>
      </div>

      {/* The mission stays on screen for the whole call and updates as the operator captures. */}
      <Separator />
      <div className="rounded-md border bg-muted/40 p-2.5 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-xs font-semibold">{mission.headline}</div>
            <div className="text-[11px] text-muted-foreground">{mission.situation}</div>
          </div>
          <Badge variant="secondary" className="shrink-0 text-[9px]">{mission.scenario.split("-")[0]} · {mission.progress}%</Badge>
        </div>

        <div className="h-1 w-full overflow-hidden rounded bg-border">
          <div className="h-full bg-primary transition-all" style={{ width: `${mission.progress}%` }} />
        </div>

        <div className="rounded border bg-background p-2 text-[11px]">
          <span className="text-muted-foreground">Open with: </span>
          <span className="font-medium">{mission.openWith}</span>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <Title>Do</Title>
            <ul className="mt-1 space-y-0.5">
              {mission.dos.map((d) => (
                <li key={d} className="text-[11px] leading-snug">✓ {d}</li>
              ))}
            </ul>
          </div>
          <div>
            <Title>Don't</Title>
            <ul className="mt-1 space-y-0.5">
              {mission.donts.map((d) => (
                <li key={d} className="text-[11px] leading-snug text-muted-foreground">✕ {d}</li>
              ))}
            </ul>
          </div>
        </div>

        <div>
          <Title>Need from this call — ticks itself as you capture</Title>
          <div className="mt-1 flex flex-wrap gap-1">
            {mission.needs.map((n) => (
              <Badge
                key={n.label}
                variant={n.done ? "secondary" : "outline"}
                className={cn("text-[10px]", n.done && "text-primary")}
              >
                {n.done ? "✓" : "○"} {n.label}
              </Badge>
            ))}
          </div>
        </div>

        <div className="rounded border border-primary/40 bg-primary/5 p-2 text-[11px]">
          <span className="text-muted-foreground">Ask for: </span>
          <span className="font-semibold">{mission.ctaLabel}</span>
          <div className="text-[10px] text-muted-foreground">{mission.ctaHow}</div>
        </div>

      </div>

      {phase === "mission" && (
        <Button className="w-full" onClick={startCall}>Call {lead.name ?? "customer"}</Button>
      )}

      {phase === "capture" && (
        <>
          <Separator />
          <div className="flex flex-wrap gap-1.5">
            {OUTCOMES.map((o) => (
              <Chip key={o.key} on={outcome === o.key} onClick={() => setOutcome(o.key)}>{o.label}</Chip>
            ))}
          </div>

          {outcome === "connected" ? (
            <div className="space-y-3">
              <VerifyPanel lead={lead} cap={cap} set={set} />
              {(agenda === "qualification" || agenda === "follow-up") && (
                <>
                  <div>
                    <Title>Move-in</Title>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {[["Today", 0], ["1–3 Days", 2], ["4–7 Days", 6], ["8–15 Days", 12], ["15+ Days", 20]].map(([label, d]) => (
                        <Chip
                          key={label as string}
                          on={cap.moveIn === isoInDays(d as number)}
                          onClick={() => set({ moveIn: isoInDays(d as number) })}
                        >
                          {label as string}
                        </Chip>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Input className="h-8 text-xs" placeholder="Area" value={cap.area ?? ""} onChange={(e) => set({ area: e.target.value })} />
                    <Input className="h-8 text-xs" placeholder="Office / College" value={cap.officeOrCollege ?? ""} onChange={(e) => set({ officeOrCollege: e.target.value })} />
                  </div>
                  <div>
                    <Title>Currently</Title>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Chip on={cap.inBangalore === true} onClick={() => set({ inBangalore: true })}>Already in Bangalore</Chip>
                      <Chip on={cap.inBangalore === false} onClick={() => set({ inBangalore: false })}>Coming to Bangalore</Chip>
                    </div>
                  </div>
                  <div>
                    <Title>Budget</Title>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {[["<10K", 9000], ["10–15K", 15000], ["15–20K", 20000], ["20–25K", 25000], ["25K+", 30000]].map(([label, v]) => (
                        <Chip key={label as string} on={cap.budget === v} onClick={() => set({ budget: v as number })}>{label as string}</Chip>
                      ))}
                    </div>
                  </div>
                  <div>
                    <Title>Room</Title>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {["Private", "2 Sharing", "3 Sharing", "Flexible"].map((r) => (
                        <Chip key={r} on={cap.roomType === r} onClick={() => set({ roomType: r })}>{r}</Chip>
                      ))}
                    </div>
                  </div>
                  <div>
                    <Title>For whom</Title>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {(["Self", "Friend", "Family"] as const).map((r) => (
                        <Chip key={r} on={cap.forWhom === r} onClick={() => set({ forWhom: r })}>{r}</Chip>
                      ))}
                    </div>
                  </div>
                  <div>
                    <Title>What matters most</Title>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {["Price", "Location", "Food", "Room Quality", "Privacy", "Amenities", "Near Office/College"].map((m) => (
                        <Chip key={m} on={cap.matters?.includes(m)} onClick={() => toggle("matters", m)}>{m}</Chip>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {(agenda === "property-feedback" || agenda === "property-intro" || agenda === "alternative" || agenda === "post-tour") && (
                <>
                  <Input className="h-8 text-xs" placeholder="Property discussed" value={cap.propertyName ?? ""} onChange={(e) => set({ propertyName: e.target.value })} />
                  <div>
                    <Title>Did they see it</Title>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {(["yes", "partially", "not-yet"] as const).map((s) => (
                        <Chip key={s} on={cap.seen === s} onClick={() => set({ seen: s })}>
                          {s === "yes" ? "Yes" : s === "partially" ? "Partially" : "Not yet"}
                        </Chip>
                      ))}
                    </div>
                  </div>
                  <div>
                    <Title>Customer reaction</Title>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {REACTIONS.map((r) => (
                        <Chip key={r.key} on={cap.reaction === r.key} onClick={() => set({ reaction: r.key })}>{r.label}</Chip>
                      ))}
                    </div>
                  </div>
                  <div>
                    <Title>If not liked — why</Title>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {DISLIKE_REASONS.map((r) => (
                        <Chip key={r} on={cap.dislikeReason === r} onClick={() => set({ dislikeReason: r })}>{r}</Chip>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {(agenda === "price" || agenda === "closing" || agenda === "objection") && (
                <div className="space-y-2 rounded-md border p-2">
                  <Title>Price discussed</Title>
                  <div className="grid grid-cols-2 gap-2">
                    <Input className="h-8 text-xs" placeholder="Property" value={cap.price?.propertyName ?? ""} onChange={(e) => set({ price: { ...blankPrice(cap), propertyName: e.target.value } })} />
                    <Input className="h-8 text-xs" placeholder="Room type" value={cap.price?.roomType ?? ""} onChange={(e) => set({ price: { ...blankPrice(cap), roomType: e.target.value } })} />
                    <Input className="h-8 text-xs" placeholder="Listed rent" inputMode="numeric" value={cap.price?.listed ?? ""} onChange={(e) => set({ price: { ...blankPrice(cap), listed: Number(e.target.value) || null } })} />
                    <Input className="h-8 text-xs" placeholder="Price quoted" inputMode="numeric" value={cap.price?.quoted || ""} onChange={(e) => set({ price: { ...blankPrice(cap), quoted: Number(e.target.value) || 0 } })} />
                    <Input className="h-8 text-xs" placeholder="Deposit" inputMode="numeric" value={cap.price?.deposit ?? ""} onChange={(e) => set({ price: { ...blankPrice(cap), deposit: Number(e.target.value) || null } })} />
                    <Input className="h-8 text-xs" placeholder="Maintenance" inputMode="numeric" value={cap.price?.maintenance ?? ""} onChange={(e) => set({ price: { ...blankPrice(cap), maintenance: Number(e.target.value) || null } })} />
                    <Input className="col-span-2 h-8 text-xs" placeholder="Valid till (e.g. 8 PM today)" value={cap.price?.validity ?? ""} onChange={(e) => set({ price: { ...blankPrice(cap), validity: e.target.value } })} />
                  </div>
                  <Title>Reaction to price</Title>
                  <div className="flex flex-wrap gap-1">
                    {PRICE_REACTIONS.map((r) => (
                      <Chip key={r.key} on={cap.priceReaction === r.key} onClick={() => set({ priceReaction: r.key })}>{r.label}</Chip>
                    ))}
                  </div>
                </div>
              )}

              {(agenda === "tour-schedule" || agenda === "tour-confirm") && (
                <div className="space-y-2">
                  <Input className="h-8 text-xs" placeholder="Property" value={cap.propertyName ?? ""} onChange={(e) => set({ propertyName: e.target.value })} />
                  <Input
                    type="datetime-local"
                    className="h-8 text-xs"
                    value={cap.tourAt ? cap.tourAt.slice(0, 16) : ""}
                    onChange={(e) => set({ tourAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
                  />
                  <Title>If refused — why</Title>
                  <div className="flex flex-wrap gap-1">
                    {TOUR_REFUSALS.map((r) => (
                      <Chip key={r} on={cap.tourRefusal === r} onClick={() => set({ tourRefusal: r })}>{r}</Chip>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <Title>What happened in this call</Title>
                <div className="mt-1 flex flex-wrap gap-1">
                  {ACTIVITIES.map((a) => (
                    <Chip key={a} on={cap.activities.includes(a)} onClick={() => toggle("activities", a)}>{a}</Chip>
                  ))}
                </div>
              </div>

              <div>
                <Title>What did you promise</Title>
                <div className="mt-1 flex flex-wrap gap-1">
                  {PROMISES.map((p) => (
                    <Chip key={p} on={cap.promises.includes(p)} onClick={() => toggle("promises", p)}>{p}</Chip>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2 rounded-md border bg-muted/40 p-2.5">
              <div className="text-xs font-semibold">{plan.title} · attempt #{plan.attempt}</div>
              <div className="text-[11px] text-muted-foreground">Condition {plan.condition} — approved message, sent exactly as written.</div>
              <div className="rounded border bg-background p-2 text-[11px] whitespace-pre-wrap">{plan.ask}</div>
              <div className="text-[10px] text-muted-foreground">Next attempt if still silent: {nextPlan.ask}</div>
              <div className="flex flex-wrap gap-1">
                {plan.options.map((o) => (
                  <Badge key={o} variant="outline" className="text-[10px]">{o}</Badge>
                ))}
              </div>
            </div>
          )}

          <div>
            <Title>Media to attach — matched on area, budget, room and availability</Title>
            <div className="mt-1 flex flex-wrap gap-1">
              {media.map((m, i) => (
                <Chip key={m.id} on={(cap.mediaCount ?? 0) > i} onClick={() => set({ mediaCount: (cap.mediaCount ?? 0) > i ? i : i + 1 })}>
                  {m.name} · {m.area} · ₹{m.fromPrice.toLocaleString("en-IN")}
                </Chip>
              ))}
            </div>
          </div>

          <Textarea rows={2} className="text-xs" placeholder="Anything the customer said that the fields don't cover" value={cap.note ?? ""} onChange={(e) => set({ note: e.target.value })} />
          <Button className="w-full" onClick={() => finish(outcome)}>End call · build message, follow-up and next step</Button>
        </>
      )}

      {phase === "outputs" && outputs && (
        <>
          <Separator />
          <div className="flex items-center gap-2">
            <Badge className="text-[10px]">{MOVEMENT_LABEL[outputs.movement]}</Badge>
            <span className="text-[11px] text-muted-foreground">{def.label} · {outcome}</span>
          </div>

          <div className="space-y-1.5">
            <Title>1 · Send now</Title>
            {outputs.mediaHint && <div className="text-[10px] text-muted-foreground">{outputs.mediaHint}</div>}
            <Textarea rows={8} className="text-xs" value={nowText} onChange={(e) => setNowText(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="flex-1" onClick={() => copy(nowText)}>Copy for WhatsApp</Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Title>2 · Follow-up · {new Date(outputs.followUp.dueAt).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</Title>
            <div className="text-[10px] text-muted-foreground">{outputs.followUp.trigger} — it cancels itself if the customer moves.</div>
            <Textarea rows={4} className="text-xs" value={followText} onChange={(e) => setFollowText(e.target.value)} />
          </div>

          <div className="rounded-md border p-2">
            <Title>3 · Next step</Title>
            <div className="text-xs font-medium">{outputs.nextStep.label}</div>
            <div className="text-[11px] text-muted-foreground">
              Due {new Date(outputs.nextStep.dueAt).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · Owner {mv.actor.name}
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setPhase("capture")}>Back</Button>
            <Button className="flex-1" size="sm" onClick={commit} disabled={saving}>
            {saving ? "Saving to the server…" : "Send, arm follow-up and set next step"}
          </Button>
          </div>
        </>
      )}
    </div>
  );
}

const isoInDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();

/** Every call is a re-verification call: the details stay on screen, tick to confirm or type to correct. */
function VerifyPanel({
  lead,
  cap,
  set,
}: {
  lead: MovementState;
  cap: CallCapture;
  set: (p: Partial<CallCapture>) => void;
}) {
  const q = lead.q ?? {};
  const verified = cap.verified ?? [];
  const tick = (label: string) =>
    set({ verified: verified.includes(label) ? verified.filter((v) => v !== label) : [...verified, label] });

  const rows: {
    label: string;
    crm: string;
    live: string;
    onChange: (v: string) => void;
  }[] = [
    {
      label: "Move-in",
      crm: fmtDate(q.moveInDate ?? lead.checkInDate),
      live: cap.moveIn ? fmtDate(cap.moveIn) : "",
      onChange: (v) => set({ moveIn: v ? new Date(v).toISOString() : null }),
    },
    { label: "Area", crm: q.location ?? "", live: cap.area ?? "", onChange: (v) => set({ area: v }) },
    {
      label: "Office / College",
      crm: q.officeOrCollege ?? "",
      live: cap.officeOrCollege ?? "",
      onChange: (v) => set({ officeOrCollege: v }),
    },
    {
      label: "Budget",
      crm: q.budget ? String(q.budget) : "",
      live: cap.budget ? String(cap.budget) : "",
      onChange: (v) => set({ budget: Number(v) || null }),
    },
    { label: "Room", crm: q.roomType ?? "", live: cap.roomType ?? "", onChange: (v) => set({ roomType: v }) },
    {
      label: "In Bangalore",
      crm: q.inBangalore === null || q.inBangalore === undefined ? "" : q.inBangalore ? "Yes" : "No",
      live: cap.inBangalore === null || cap.inBangalore === undefined ? "" : cap.inBangalore ? "Yes" : "No",
      onChange: (v) => set({ inBangalore: /^y/i.test(v) ? true : /^n/i.test(v) ? false : null }),
    },
    {
      label: "For whom",
      crm: q.forSelf === null || q.forSelf === undefined ? "" : q.forSelf ? "Self" : "Someone else",
      live: cap.forWhom ?? "",
      onChange: (v) => set({ forWhom: (v as CallCapture["forWhom"]) || null }),
    },
  ];

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-2.5">
      <div className="flex items-center justify-between">
        <Title>On the call — verify or correct</Title>
        <span className="text-[10px] text-muted-foreground">
          {verified.length}/{rows.length} verified
        </span>
      </div>
      <div className="space-y-1">
        {rows.map((r) => {
          const value = r.live || r.crm;
          const ok = verified.includes(r.label);
          return (
            <div key={r.label} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-[10px] text-muted-foreground">{r.label}</span>
              <Input
                className={cn("h-7 flex-1 text-xs", ok && "border-primary/60 bg-primary/5")}
                placeholder="Not known — fill it in"
                value={value}
                onChange={(e) => r.onChange(e.target.value)}
              />
              <button
                type="button"
                onClick={() => tick(r.label)}
                title="Confirmed by the customer"
                className={cn(
                  "h-7 w-7 shrink-0 rounded border text-xs",
                  ok ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                ✓
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");

function blankPrice(c: CallCapture) {
  return c.price ?? { propertyName: "", roomType: "", listed: null, quoted: 0, deposit: null, maintenance: null, validity: "" };
}
