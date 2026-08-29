// plant-logo.upload — uploads a plant's logo image to the public "plant-logos" bucket and writes
// the resulting public URL straight onto plants.logo_url. A new upload overwrites the previous
// file at the same fixed path (one logo per plant, no orphaned old logos accumulating).

import postgres from "npm:postgres@3.4.4";
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB — a logo image, not a scanned document

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "plant_id", "file_name", "file_base64"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const { actor, plant_id, file_name, file_base64, content_type = null } = body;

    const [existing] = await sql`select * from plants where id = ${plant_id}`;
    if (!existing) return jsonResponse({ error: "unknown plant_id" }, 400);

    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(file_base64), (c) => c.charCodeAt(0));
    } catch {
      return jsonResponse({ error: "file_base64 is not valid base64" }, 400);
    }
    if (bytes.byteLength > MAX_FILE_BYTES) {
      return jsonResponse({ error: "file_too_large", message: "Logo images must be 5MB or smaller." }, 400);
    }

    const ext = (file_name.split(".").pop() || "png").toLowerCase();
    const storagePath = `${plant_id}/logo.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("plant-logos")
      .upload(storagePath, bytes, { contentType: content_type || "image/png", upsert: true });
    if (uploadError) return jsonResponse({ error: `storage upload failed: ${uploadError.message}` }, 500);

    const { data: publicUrlData } = supabase.storage.from("plant-logos").getPublicUrl(storagePath);
    // Cache-bust — same path every time (upsert), so a new logo needs a changed URL or the
    // browser (and other traders' already-loaded pages) keeps showing the old cached image.
    const logoUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`;

    const plant = await sql.begin(async (tx) => {
      const [plant] = await tx`update plants set logo_url = ${logoUrl}, updated_at = now() where id = ${plant_id} returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "plants", record_id: plant_id, before: { logo_url: existing.logo_url }, after: { logo_url: logoUrl } });
      return plant;
    });

    return jsonResponse({ updated: true, plant });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
