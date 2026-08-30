// Shared across every Edge Function that has to answer "is this the same thing as something that
// already exists, or genuinely new?" — products, suppliers, plants, customers all need the exact
// same discipline (case/typo-insensitive comparison, never a silent guess, never a dead end).
// One copy, imported everywhere, so a fix or a rule change happens once, not once per function.

import { createHmac } from "node:crypto";

export function normalize(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeLoose(s: string | null | undefined): string {
  return normalize(s).replace(/\b(pork|beef|chicken|lamb)\b/g, "").replace(/\s+/g, " ").trim();
}

// Plain Levenshtein edit distance — small, dependency-free, exactly what's needed to catch a
// one-or-two-character slip ("St Luis" vs "St Louis") without flagging genuinely different names.
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

export function isNearDuplicate(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  const dist = editDistance(a, b);
  const longer = Math.max(a.length, b.length);
  if (longer < 4) return false; // too short for edit-distance to mean anything
  return dist <= 2 && dist / longer < 0.3;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Rule 5, absolute, no exceptions (see feedback-catalog-matching-is-the-core-system, "never block
// even for a case-only duplicate that's obviously the same product") — every caller of this
// returns a 409 with the real candidate(s) and requires override_duplicate_check to proceed, never
// an unconditional refusal.
export function duplicateResponse(payload: Record<string, unknown>) {
  return new Response(JSON.stringify({ error: "possible_duplicate", ...payload }), {
    status: 409,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Every write, in every function, goes through this — one hash-chained audit_log row per write,
// in the SAME transaction as the write itself, so a row that exists with no audit trail (or the
// reverse) is impossible by construction.
// "City, ST" / "City ST" only — a plant's pickup-location text is a mechanical fact (unlike a
// product cut name, there's no real linguistic ambiguity in a city+state pair), so this is the one
// place in the catalog-matching system that's allowed to auto-create rather than stop and ask.
// Confirmed real requirement 2026-08-30: "todo tiene que estar conectado... todo es automatico" —
// manual add stays available (providers.html's "+ Add New City to Catalog"), this is just the
// automatic path so a plant's own location never sits disconnected from the same catalog every
// carrier rate already resolves to. Anything that doesn't parse as a clean city+state (a warehouse
// name, a country, freeform notes) is left unlinked rather than guessed.
export function parseCityState(text: string | null | undefined): { city: string; state: string } | null {
  if (!text) return null;
  const m = text.trim().match(/^(.+?),?\s+([A-Za-z]{2})$/);
  if (!m) return null;
  return { city: m[1].trim(), state: m[2].toUpperCase() };
}

export async function matchOrCreateLocationId(tx: any, locationName: string | null | undefined): Promise<string | null> {
  const parsed = parseCityState(locationName);
  if (!parsed) return null;
  const [existing] = await tx`select id from locations where lower(city) = lower(${parsed.city}) and upper(state) = upper(${parsed.state})`;
  if (existing) return existing.id;
  // Same race-safe insert-or-fetch shape as the price-list plant_id fix — two people (or a create
  // and a rate load) resolving the same brand-new city at the same instant never produces a
  // duplicate row or a lost write.
  const [created] = await tx`insert into locations (city, state) values (${parsed.city}, ${parsed.state}) on conflict (city, state) do nothing returning id`;
  if (created) return created.id;
  const [raced] = await tx`select id from locations where lower(city) = lower(${parsed.city}) and upper(state) = upper(${parsed.state})`;
  return raced ? raced.id : null;
}

export async function writeAuditLog(
  tx: any,
  hmacSecret: string,
  entry: { actor: string; action: "insert" | "update" | "delete"; table_name: string; record_id: string; before?: unknown; after?: unknown },
) {
  const [lastEntry] = await tx`select hash from audit_log order by id desc limit 1`;
  const prevHash = lastEntry?.hash ?? null;
  const payload = JSON.stringify({ prevHash, ...entry });
  const hash = createHmac("sha256", hmacSecret).update(payload).digest("hex");
  await tx`
    insert into audit_log (actor, action, table_name, record_id, before, after, prev_hash, hash)
    values (${entry.actor}, ${entry.action}, ${entry.table_name}, ${entry.record_id}, ${entry.before ? tx.json(entry.before) : null}, ${entry.after ? tx.json(entry.after) : null}, ${prevHash}, ${hash})
  `;
}
