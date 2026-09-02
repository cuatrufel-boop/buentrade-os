// plant_pending_matches.create's real write logic, extracted the same way and for the same reason
// as productMatcher.ts/applyPlantProductMatch.ts — one shared connection for plant-price-emails-
// poll instead of a fresh HTTP call per unresolved line.

import { writeAuditLog } from "./matching.ts";

export type CreatePendingMatchResult =
  | { pending_match: Record<string, any>; idempotent_replay?: true }
  | { error: string };

export async function createPendingMatch(
  sql: any,
  hmacSecret: string,
  { actor, plant_id, raw_text, detected_price = null, candidate_product_ids = [], idempotency_key = null }: {
    actor: string; plant_id: string; raw_text: string; detected_price?: number | null;
    candidate_product_ids?: string[]; idempotency_key?: string | null;
  },
): Promise<CreatePendingMatchResult> {
  if (!actor || !plant_id || !raw_text) return { error: "missing required fields" };

  if (idempotency_key) {
    const [existing] = await sql`select * from plant_pending_matches where idempotency_key = ${idempotency_key}`;
    if (existing) return { pending_match: existing, idempotent_replay: true };
  }

  const [plant] = await sql`select id from plants where id = ${plant_id}`;
  if (!plant) return { error: "unknown plant_id" };

  const result = await sql.begin(async (tx: any) => {
    const [row] = await tx`
      insert into plant_pending_matches (plant_id, raw_text, detected_price, candidate_product_ids, idempotency_key)
      values (${plant_id}, ${raw_text}, ${detected_price}, ${tx.json(candidate_product_ids)}, ${idempotency_key})
      returning *
    `;
    await writeAuditLog(tx, hmacSecret, {
      actor, action: "insert", table_name: "plant_pending_matches", record_id: row.id, after: { pending_match: row },
    });
    return row;
  });

  return { pending_match: result };
}
