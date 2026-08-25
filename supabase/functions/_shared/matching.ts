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
