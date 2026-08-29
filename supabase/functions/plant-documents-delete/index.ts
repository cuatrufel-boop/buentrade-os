// plant-documents.delete — removes both the storage object and its metadata row. The row is
// deleted first inside the transaction so a failed storage delete never leaves an orphaned DB
// row pointing at a file that's still there but unreachable; if storage delete fails after that,
// it's logged but not fatal — a leftover blob in a private bucket is harmless, an orphaned row
// that a trader clicks and gets a dead link is not.

import postgres from "npm:postgres@3.4.4";
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, id } = body;

    const [existing] = await sql`select * from plant_documents where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown plant_document id" }, 404);

    await sql.begin(async (tx) => {
      await tx`delete from plant_documents where id = ${id}`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "delete", table_name: "plant_documents", record_id: id, before: existing });
    });

    const { error: storageError } = await supabase.storage.from("plant-documents").remove([existing.storage_path]);
    if (storageError) console.error("plant-documents-delete: storage cleanup failed", storageError.message);

    return jsonResponse({ deleted: true, id });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
