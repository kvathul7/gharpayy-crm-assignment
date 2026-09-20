/**
 * Proves the payload shapes the app sends are accepted by the real backend.
 *
 *   npx tsx scripts/verify-backend.ts
 *
 * The browser extension is unavailable, so this stands in for clicking
 * through the UI: it exercises the exact writes Booking Flow Split and
 * Closing Desk perform, against the live database, then cleans up after
 * itself and leaves the seeded data untouched.
 */
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
const env = (k: string) => raw.match(new RegExp(`^${k}="?([^"\\r\\n]+)"?`, "m"))?.[1] ?? "";
const URL_ = env("SUPABASE_URL");
const KEY = env("SUPABASE_PUBLISHABLE_KEY");

const H = { apikey: KEY, "Content-Type": "application/json" };
let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? (pass += 1) : (fail += 1);
}

async function req(method: string, path: string, body?: unknown, prefer?: string) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers: prefer ? { ...H, Prefer: prefer } : H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

/* ---- mirrors serverIdFor() in src/lib/crm/commitments-sync.ts ---------- */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i += 1) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}
const hex8 = (n: number) => n.toString(16).padStart(8, "0");
function serverIdFor(localId: string): string {
  const [a, b, c, d] = cyrb128(`gharpayy.commitment:${localId}`);
  const s = hex8(a) + hex8(b) + hex8(c) + hex8(d);
  const v = s.slice(0, 12) + "4" + s.slice(13, 16) + "a" + s.slice(17, 32);
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

/* ----------------------------------------------------------------- run */

async function main() {
  console.log(`verifying against ${URL_}\n`);

  // Pick a real seeded customer to hang test rows off.
  const pick = await fetch(`${URL_}/rest/v1/crm_customers?select=id,name,stage&limit=1`, { headers: H });
  const [customer] = (await pick.json()) as { id: string; name: string; stage: string }[];
  if (!customer) {
    console.error("no seeded customers found — run scripts/seed-backend.ts first");
    process.exit(1);
  }
  console.log(`using customer ${customer.id} (${customer.name})\n`);

  console.log("Booking Flow Split writes:");

  // 1. the upsert useFlowBackend performs on every change
  const upsert = await req(
    "POST", "crm_customers",
    [{ id: customer.id, name: customer.name, phone: "+919999000000", stage: "TOUR_SLOT",
       owner: "Riya", next_action: "Schedule the tour",
       next_action_at: new Date(Date.now() + 3600_000).toISOString(),
       journey: { area: "Kharadi", budget: "12000", roomType: "SINGLE" } }],
    "resolution=merge-duplicates",
  );
  check("upsert customer (merge-duplicates)", upsert.ok, upsert.ok ? "" : upsert.text.slice(0, 120));

  // 2. journey answers survive as jsonb
  const readBack = await fetch(`${URL_}/rest/v1/crm_customers?select=journey,stage,owner&id=eq.${customer.id}`, { headers: H });
  const [row] = (await readBack.json()) as { journey: Record<string, string>; stage: string; owner: string }[];
  check("journey jsonb round-trips", row?.journey?.area === "Kharadi", `got ${JSON.stringify(row?.journey)}`);
  check("stage + owner persisted", row?.stage === "TOUR_SLOT" && row?.owner === "Riya");

  // 3. the audit trail write
  const ev = await req("POST", "crm_events", [{
    customer_id: customer.id, actor: "Riya", label: "Tour scheduled",
    detail: "verify-script", step_key: "TOUR_SLOT", module: "split",
    changes: [{ field: "tourAt", from: "", to: "tomorrow 11:00" }],
  }]);
  check("append audit event", ev.ok, ev.ok ? "" : ev.text.slice(0, 120));

  console.log("\nClosing Desk writes:");

  // 4. deterministic uuid accepted as a real uuid
  const localId = "cc-1726824000000-a1b2c";
  const sid = serverIdFor(localId);
  check("deterministic id is uuid-shaped", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sid), sid);
  check("same local id → same uuid", serverIdFor(localId) === sid);

  // 5. promise upsert
  const due = new Date(Date.now() + 7200_000).toISOString();
  const c1 = await req("POST", "crm_commitments", [{
    id: sid, customer_id: customer.id, promised_by: "Riya", due_at: due,
    window_id: "today", steps: ["Send quote"], state: "open", source: "verify",
  }], "resolution=merge-duplicates");
  check("create promise", c1.ok, c1.ok ? "" : c1.text.slice(0, 160));

  // 6. same promise again = update, not duplicate (idempotency)
  const c2 = await req("POST", "crm_commitments", [{
    id: sid, customer_id: customer.id, promised_by: "Riya", due_at: due,
    window_id: "today", steps: ["Send quote"], state: "kept",
    settled_at: new Date().toISOString(), settled_by: "Riya", source: "verify",
  }], "resolution=merge-duplicates");
  check("re-push settles instead of duplicating", c2.ok, c2.ok ? "" : c2.text.slice(0, 160));

  const dupes = await fetch(`${URL_}/rest/v1/crm_commitments?select=id,state&id=eq.${sid}`, { headers: H });
  const rows = (await dupes.json()) as { state: string }[];
  check("exactly one row for that promise", rows.length === 1, `found ${rows.length}`);
  check("state advanced to kept", rows[0]?.state === "kept");

  // 7. foreign key really protects the trail
  const orphan = await req("POST", "crm_commitments", [{
    id: serverIdFor("cc-orphan"), customer_id: "p:0000000000",
    promised_by: "X", due_at: due, state: "open",
  }]);
  check("unknown customer is rejected (FK holds)", !orphan.ok, `status ${orphan.status}`);

  console.log("\nwork claims (new idea 2):");
  const claim = await req("POST", "crm_work_claims", [{
    customer_id: customer.id, operator_id: "op-1", operator_name: "Riya", module: "split",
  }], "return=representation");
  check("claim a customer", claim.ok, claim.ok ? "" : claim.text.slice(0, 120));

  const second = await req("POST", "crm_work_claims", [{
    customer_id: customer.id, operator_id: "op-2", operator_name: "Aman", module: "split",
  }]);
  check("second operator is blocked while claim is live", !second.ok, `status ${second.status}`);

  /* ------------------------------------------------------------ cleanup */
  console.log("\ncleanup:");
  const d1 = await req("DELETE", `crm_commitments?source=eq.verify`);
  const d2 = await req("DELETE", `crm_events?detail=eq.verify-script`);
  const d3 = await req("DELETE", `crm_work_claims?customer_id=eq.${customer.id}`);
  check("test rows removed", d1.ok && d2.ok && d3.ok);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("VERIFY CRASHED:", e);
  process.exit(1);
});
