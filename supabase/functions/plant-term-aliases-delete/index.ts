// plant_term_aliases.delete — real ask 2026-09-12 ("debe poderse abrir y editar los que ya
// reconocio"): a word taught wrong for a plant had no way to be removed — only re-taught to a
// different meaning (plant-term-aliases-set's upsert). Removing it here just means the matcher
// asks about that word again next time, same as if it had never been taught — never touches any
// price or product already saved using it while it was recognized.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, id } = body;

    const [existing] = await sql`select * from plant_term_aliases where id = ${id}`;
    if (!existing) return jsonResponse({ deleted: true, id, already_deleted: true });

    await sql.begin(async (tx) => {
      await tx`delete from plant_term_aliases where id = ${id}`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "delete", table_name: "plant_term_aliases", record_id: id, before: existing });
    });

    return jsonResponse({ deleted: true, id });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
