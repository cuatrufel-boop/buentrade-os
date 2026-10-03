// Nothing a reader saw may end up nowhere. Every candidate a reader could not place on its own (a line with no price, a formula, a
// picture or file it could not read, a message with nothing in it...) is routed here into Pending Matches with its reason, so a person
// decides — or, for an unread file/message a person already dismissed before, it is remembered and not queued again.

import { canonicalPendingText, normalize } from "./matching.ts";
import { describeReason, routeFor } from "./pendingReasons.ts";
import { matchProductFromPlantText } from "./productMatcher.ts";
import { createPendingMatch } from "./pendingMatch.ts";

export type RoutableRow = {
  source: string; rawText: string; price: number | null;
  outcome: string; reasonCode: string | null; reasonDetail: string | null;
  pendingMatchId?: string | null; extra?: Record<string, unknown>;
};

// Codes that describe a failure of the queue itself — they cannot be queued, so they stay visible as 'dropped' in the ledger.
const UNQUEUEABLE = new Set(["pending_error", "declined_queue_error", "declined_match_error"]);
// Product lines whose text names no product (a bare price, "file row 5") — there is nothing for the matcher to look up.
const NO_PRODUCT_TEXT = new Set(["text_price_without_product", "xlsx_row_no_description"]);

export async function routeDropsToPending(
  db: any, hmacSecret: string, actor: string,
  { plantId, messageId, rows, dryRun }: { plantId: string; messageId: string; rows: RoutableRow[]; dryRun: boolean },
): Promise<string[]> {
  const errors: string[] = [];
  type Dismissal = { id: string; key: string };
  let dismissed = null as Dismissal[] | null;
  const dismissedFor = async (key: string): Promise<string | null> => {
    let list: Dismissal[] | null = dismissed;
    if (!list) {
      const prior = await db`select id, raw_text from plant_pending_matches where plant_id = ${plantId} and signal_type = 'unread' and resolved_at is not null and coalesce(resolved_by, '') not like 'auto:%'`;
      list = prior.map((r: any) => ({ id: r.id, key: canonicalPendingText(r.raw_text) })) as Dismissal[];
      dismissed = list;
    }
    return list.find((d) => d.key === key)?.id ?? null;
  };

  for (const row of rows) {
    if (row.outcome !== "dropped" || !row.reasonCode || UNQUEUEABLE.has(row.reasonCode)) continue;
    const code = row.reasonCode;
    const text = describeReason(code, row.reasonDetail);
    try {
      if (routeFor(code) === "unread") {
        const prior = await dismissedFor(canonicalPendingText(row.rawText));
        if (prior) { row.outcome = "dismissed"; row.reasonDetail = `${text} — a person already dismissed this`; row.pendingMatchId = prior; continue; }
        if (dryRun) { row.outcome = "pending"; row.reasonDetail = text; continue; }
        const created = await createPendingMatch(db, hmacSecret, {
          actor, plant_id: plantId, raw_text: row.rawText, detected_price: null, candidate_product_ids: [],
          idempotency_key: `${messageId}|unread|${code}|${normalize(row.rawText)}`, signal_type: "unread",
          reason_code: code, reason_detail: text, source: row.source,
        });
        if ("error" in created) { errors.push(`pending ${row.rawText}: ${created.error}`); continue; }
        row.outcome = "pending"; row.reasonDetail = text; row.pendingMatchId = created.pending_match.id;
        continue;
      }

      let candidateIds: string[] = [];
      let conflicted = false;
      if (!NO_PRODUCT_TEXT.has(code) && row.rawText) {
        const found = await matchProductFromPlantText(db, { plant_id: plantId, raw_text: row.rawText, cache_refs: true });
        if (!("error" in found)) {
          candidateIds = found.matched ? [found.product.id] : found.candidates.map((p: any) => p.id);
          conflicted = found.matched ? false : found.conflicted === true;
        }
      }
      if (dryRun) { row.outcome = "pending"; row.reasonDetail = text; continue; }
      const created = await createPendingMatch(db, hmacSecret, {
        actor, plant_id: plantId, raw_text: row.rawText, detected_price: row.price, candidate_product_ids: candidateIds,
        idempotency_key: `${messageId}|${code}|${normalize(row.rawText)}`, candidates_conflicted: conflicted,
        reason_code: code, reason_detail: text, source: row.source,
      });
      if ("error" in created) { errors.push(`pending ${row.rawText}: ${created.error}`); continue; }
      row.outcome = "pending"; row.reasonDetail = text; row.pendingMatchId = created.pending_match.id;
    } catch (e) {
      errors.push(`route ${row.rawText}: ${e}`); // stays 'dropped' in the ledger — visible, never silent
    }
  }
  return errors;
}
