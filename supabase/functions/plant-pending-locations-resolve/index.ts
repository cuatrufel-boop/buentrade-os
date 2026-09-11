// plant_pending_locations.resolve — the human's Yes/No answer to "should this pickup location be
// added to this plant's Locations?" (see applyPlantProductMatch.ts for how a row gets queued here
// in the first place). approved:true creates the real plant_locations row right here (a plain
// insert — protein/freight/contact are left for the trader to fill in later, same as any location
// added by hand); approved:false just closes the suggestion out, on purpose leaving nothing behind
// for a location the trader said isn't real/isn't this plant's. Already-resolved is a no-op success
// (idempotent), not an error — the same "resolvePlantPendingMatch" reasoning as the matches queue.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "id", "approved"].filter((k) => body[k] == null);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, id, approved } = body;

    const [existing] = await sql`select * from plant_pending_locations where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown pending location id" }, 400);
    if (existing.resolved_at) return jsonResponse({ pending_location: existing, idempotent_replay: true });

    const result = await sql.begin(async (tx) => {
      let plantLocation = null;
      if (approved) {
        const [alreadyLinked] = await tx`select * from plant_locations where plant_id = ${existing.plant_id} and location_id = ${existing.location_id}`;
        if (alreadyLinked) {
          plantLocation = alreadyLinked;
        } else {
          const [created] = await tx`
            insert into plant_locations (plant_id, location_name, location_id)
            values (${existing.plant_id}, ${existing.location_name}, ${existing.location_id})
            returning *
          `;
          plantLocation = created;
          await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "plant_locations", record_id: created.id, after: created });
        }
      }
      const [row] = await tx`
        update plant_pending_locations set resolved_at = now(), resolved_by = ${actor}, approved = ${approved}
        where id = ${id}
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, {
        actor, action: "update", table_name: "plant_pending_locations", record_id: row.id, before: { pending_location: existing }, after: { pending_location: row },
      });
      return { row, plantLocation };
    });

    return jsonResponse({ pending_location: result.row, plant_location: result.plantLocation }, 200);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
