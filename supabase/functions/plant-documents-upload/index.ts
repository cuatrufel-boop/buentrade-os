// plant-documents.upload — accepts one file (base64) for a plant's pickup/health/permit
// documents, stores it in the private "plant-documents" Storage bucket, and records the metadata
// row. File content never touches Postgres — only the storage_path does.

import postgres from "npm:postgres@3.4.4";
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB — generous for a scanned PDF/photo, not unlimited

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "plant_id", "file_name", "file_base64"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const { actor, plant_id, file_name, file_base64, content_type = null, idempotency_key = null } = body;

    const [plant] = await sql`select id from plants where id = ${plant_id}`;
    if (!plant) return jsonResponse({ error: "unknown plant_id" }, 400);

    if (idempotency_key) {
      const [existing] = await sql`select * from plant_documents where idempotency_key = ${idempotency_key}`;
      if (existing) return jsonResponse({ created: true, document: existing, idempotent_replay: true });
    }

    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(file_base64), (c) => c.charCodeAt(0));
    } catch {
      return jsonResponse({ error: "file_base64 is not valid base64" }, 400);
    }
    if (bytes.byteLength > MAX_FILE_BYTES) {
      return jsonResponse({ error: "file_too_large", message: "Files must be 15MB or smaller." }, 400);
    }

    const storagePath = `${plant_id}/${crypto.randomUUID()}-${file_name}`;
    const { error: uploadError } = await supabase.storage
      .from("plant-documents")
      .upload(storagePath, bytes, { contentType: content_type || "application/octet-stream" });
    if (uploadError) return jsonResponse({ error: `storage upload failed: ${uploadError.message}` }, 500);

    const doc = await sql.begin(async (tx) => {
      const [doc] = await tx`
        insert into plant_documents (plant_id, file_name, storage_path, content_type, file_size, uploaded_by, idempotency_key)
        values (${plant_id}, ${file_name}, ${storagePath}, ${content_type}, ${bytes.byteLength}, ${actor}, ${idempotency_key})
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "plant_documents", record_id: doc.id, after: doc });
      return doc;
    });

    return jsonResponse({ created: true, document: doc }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
