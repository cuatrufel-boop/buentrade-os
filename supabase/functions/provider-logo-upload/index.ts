// provider-logo.upload — same pattern as plant-logo.upload: uploads to the public
// "provider-logos" bucket and writes the resulting public URL onto providers.logo_url. A new
// upload overwrites the previous file at the same fixed path (one logo per provider).

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
    const missing = ["actor", "provider_id", "file_name", "file_base64"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const { actor, provider_id, file_name, file_base64, content_type = null } = body;

    const [existing] = await sql`select * from providers where id = ${provider_id}`;
    if (!existing) return jsonResponse({ error: "unknown provider_id" }, 400);

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
    const storagePath = `${provider_id}/logo.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("provider-logos")
      .upload(storagePath, bytes, { contentType: content_type || "image/png", upsert: true });
    if (uploadError) return jsonResponse({ error: `storage upload failed: ${uploadError.message}` }, 500);

    const { data: publicUrlData } = supabase.storage.from("provider-logos").getPublicUrl(storagePath);
    const logoUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`;

    const provider = await sql.begin(async (tx) => {
      const [provider] = await tx`update providers set logo_url = ${logoUrl}, updated_at = now() where id = ${provider_id} returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "providers", record_id: provider_id, before: { logo_url: existing.logo_url }, after: { logo_url: logoUrl } });
      return provider;
    });

    return jsonResponse({ updated: true, provider });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
