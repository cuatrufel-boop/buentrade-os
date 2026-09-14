// plant_pending_matches.create's real write logic, extracted the same way and for the same reason
// as productMatcher.ts/applyPlantProductMatch.ts — one shared connection for plant-price-emails-
// poll instead of a fresh HTTP call per unresolved line.

import { normalize, writeAuditLog } from "./matching.ts";

export type CreatePendingMatchResult =
  | { pending_match: Record<string, any>; idempotent_replay?: true }
  | { error: string };

export async function createPendingMatch(
  sql: any,
  hmacSecret: string,
  { actor, plant_id, raw_text, detected_price = null, candidate_product_ids = [], idempotency_key = null, signal_type = "price", candidates_conflicted = false }: {
    actor: string; plant_id: string; raw_text: string; detected_price?: number | null;
    candidate_product_ids?: string[]; idempotency_key?: string | null; signal_type?: "price" | "declined";
    candidates_conflicted?: boolean;
  },
): Promise<CreatePendingMatchResult> {
  if (!actor || !plant_id || !raw_text) return { error: "missing required fields" };

  if (idempotency_key) {
    const [existing] = await sql`select * from plant_pending_matches where idempotency_key = ${idempotency_key}`;
    if (existing) return { pending_match: existing, idempotent_replay: true };
  }

  const [plant] = await sql`select id from plants where id = ${plant_id}`;
  if (!plant) return { error: "unknown plant_id" };

  // Real ask 2026-09-14: "no pueden aparecer el mismo producto varias veces... siempre debe quedar
  // el precio mas nuevo" — idempotency_key above only catches the exact same email being
  // reprocessed; it's built from the Gmail message id (see plant-price-emails-poll), so the SAME
  // still-unresolved line arriving in a DIFFERENT later email always got a fresh idempotency_key
  // and just piled up as a second, third, fourth row in the review queue for the same real product.
  // Global fix (this function is the one real write path for every plant, not a per-plant screen):
  // before inserting, look for an existing UNRESOLVED row for this same plant + normalized raw text
  // + signal type, and refresh IT (new price, new candidates, bumped to "now") instead of creating
  // a duplicate. A row that was already resolved is left alone — a fresh, genuinely new occurrence
  // after that gets its own new row, same as today.
  const normalizedText = normalize(raw_text);
  const [existingUnresolved] = await sql`
    select * from plant_pending_matches
    where plant_id = ${plant_id} and signal_type = ${signal_type} and resolved_at is null
      and lower(trim(regexp_replace(raw_text, '\\s+', ' ', 'g'))) = ${normalizedText}
    order by created_at desc limit 1
  `;

  const result = await sql.begin(async (tx: any) => {
    if (existingUnresolved) {
      const [row] = await tx`
        update plant_pending_matches set
          detected_price = ${detected_price}, candidate_product_ids = ${tx.json(candidate_product_ids)},
          idempotency_key = ${idempotency_key}, candidates_conflicted = ${candidates_conflicted}, created_at = now()
        where id = ${existingUnresolved.id} returning *
      `;
      await writeAuditLog(tx, hmacSecret, {
        actor, action: "update", table_name: "plant_pending_matches", record_id: row.id,
        before: existingUnresolved, after: { pending_match: row },
      });
      return row;
    }
    const [row] = await tx`
      insert into plant_pending_matches (plant_id, raw_text, detected_price, candidate_product_ids, idempotency_key, signal_type, candidates_conflicted)
      values (${plant_id}, ${raw_text}, ${detected_price}, ${tx.json(candidate_product_ids)}, ${idempotency_key}, ${signal_type}, ${candidates_conflicted})
      returning *
    `;
    await writeAuditLog(tx, hmacSecret, {
      actor, action: "insert", table_name: "plant_pending_matches", record_id: row.id, after: { pending_match: row },
    });
    return row;
  });

  return { pending_match: result };
}
