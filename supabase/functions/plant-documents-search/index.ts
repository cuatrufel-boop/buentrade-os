// plant-documents.search — lists a plant's attached documents with a short-lived signed URL for
// each, generated fresh on every call (never a stored/public link — the bucket is private).

import postgres from "npm:postgres@3.4.4";
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const SIGNED_URL_TTL_SECONDS = 300;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    if (!body.plant_id) return jsonResponse({ error: "plant_id is required" }, 400);

    const docs = await sql`select * from plant_documents where plant_id = ${body.plant_id} order by created_at desc`;

    const results = await Promise.all(docs.map(async (d: any) => {
      const { data } = await supabase.storage.from("plant-documents").createSignedUrl(d.storage_path, SIGNED_URL_TTL_SECONDS);
      return { ...d, download_url: data?.signedUrl || null };
    }));

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
