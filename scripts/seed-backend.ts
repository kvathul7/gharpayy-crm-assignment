/**
 * Seed the CRM backend from the app's own deterministic seed universe.
 *
 *   npx tsx scripts/seed-backend.ts
 *
 * Uses the exact same seedLeads() the UI renders, so the backend and the
 * screen show the same 260 customers instead of two different worlds.
 *
 * Idempotent: customers upsert on id, and events are only written when the
 * customer had none, so re-running does not duplicate the trail.
 */
import { readFileSync } from "node:fs";
import { seedLeads } from "../src/bookingflow/seed";
import type { FlowLead } from "../src/bookingflow/types";

/* ----------------------------------------------------------------- env */

function loadEnv(): { url: string; key: string } {
  const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const get = (k: string) => {
    const m = raw.match(new RegExp(`^${k}="?([^"\\r\\n]+)"?`, "m"));
    return m?.[1] ?? "";
  };
  const url = get("SUPABASE_URL") || get("VITE_SUPABASE_URL");
  const key = get("SUPABASE_PUBLISHABLE_KEY") || get("VITE_SUPABASE_PUBLISHABLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY missing from .env");
  return { url, key };
}

const { url: SUPABASE_URL, key: SUPABASE_KEY } = loadEnv();

/* ----------------------------------------------- canonical customer id */
// Inlined from src/lib/canonical/customer-id.ts so this script does not pull
// in the "@/" alias chain. Same rule: phone wins, last 10 digits.
function canonicalId(lead: FlowLead): string {
  const digits = (lead.phone ?? "").replace(/\D/g, "");
  if (digits.length >= 10) return `p:${digits.slice(-10)}`;
  const n = (lead.name ?? "").trim().toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-");
  return n ? `n:${n}` : "";
}

/* -------------------------------------------------------------- request */

async function post(table: string, rows: unknown[], extraPrefer = "") {
  if (rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      "Content-Type": "application/json",
      Prefer: ["return=minimal", extraPrefer].filter(Boolean).join(","),
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(`${table} → ${res.status} ${res.statusText}: ${await res.text()}`);
  }
}

async function countOf(table: string): Promise<number> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
    headers: { apikey: SUPABASE_KEY, Prefer: "count=exact", Range: "0-0" },
  });
  const range = res.headers.get("content-range") ?? "*/0";
  return Number(range.split("/")[1] ?? 0);
}

const chunk = <T,>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/* ----------------------------------------------------------------- main */

async function main() {
  const leads = seedLeads();
  console.log(`seed universe: ${leads.length} customers`);

  // Collapse any duplicate canonical ids (same phone = same person).
  const byId = new Map<string, FlowLead>();
  let skipped = 0;
  for (const l of leads) {
    const id = canonicalId(l);
    if (!id) { skipped += 1; continue; }
    byId.set(id, l);
  }
  if (skipped) console.log(`skipped ${skipped} lead(s) with no usable identity`);
  const merged = leads.length - skipped - byId.size;
  if (merged > 0) console.log(`merged ${merged} duplicate-phone lead(s) into one record each`);

  const customers = [...byId.entries()].map(([id, l]) => ({
    id,
    name: l.name,
    phone: l.phone,
    wa_account: l.waAccount ?? null,
    stage: l.stage,
    owner: l.owner ?? null,
    handler: l.handler ?? null,
    temp: l.temp ?? null,
    temp_reason: l.tempReason ?? null,
    labels: l.labels ?? [],
    last_message: l.lastMessage ?? null,
    last_activity_at: l.lastActivityAt ?? null,
    last_action_at: l.lastActionAt ?? null,
    next_action: l.nextAction ?? null,
    next_action_at: l.nextActionAt ?? null,
    journey: l.f ?? {},
    qualified_at: l.qualifiedAt ?? null,
    escalated: !!l.escalated,
    closed_reason: l.closedReason ?? null,
  }));

  console.log(`upserting ${customers.length} customers…`);
  for (const part of chunk(customers, 100)) {
    await post("crm_customers", part, "resolution=merge-duplicates");
  }

  // Only seed the trail when it is empty, so re-runs stay idempotent.
  const existingEvents = await countOf("crm_events");
  if (existingEvents > 0) {
    console.log(`crm_events already has ${existingEvents} rows — leaving the trail alone`);
  } else {
    const events = [...byId.entries()].flatMap(([id, l]) =>
      (l.events ?? []).map((e) => ({
        customer_id: id,
        at: e.at,
        actor: e.actor,
        label: e.label,
        detail: e.detail ?? null,
        step_key: e.stepKey ?? null,
        module: "seed",
        changes: e.changes ?? [],
      })),
    );
    console.log(`inserting ${events.length} audit events…`);
    for (const part of chunk(events, 500)) await post("crm_events", part);
  }

  console.log("\n--- backend now holds ---");
  for (const t of ["crm_customers", "crm_events", "crm_commitments", "crm_work_claims", "call_records"]) {
    console.log(`${t.padEnd(18)} ${await countOf(t)}`);
  }
}

main().catch((err) => {
  console.error("\nSEED FAILED:", err.message);
  process.exit(1);
});
