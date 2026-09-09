// provider-rate-update-request — the second, distinct action Locations Catalog needed alongside
// "Load Prices": that one only ever pastes rates that already arrived; this one actually reaches
// out and asks the carrier for fresh US Freight numbers. Sends a real email (not just an internal
// stamp — real ask 2026-09-09: "mandar un update A los carriers"), using the SAME Gmail OAuth
// credentials plant-price-emails-poll already holds and already sends trader notifications with —
// no new external service, one already-authenticated account. Stamps
// providers.last_rate_update_requested_at so a carrier nobody's chased in a while looks different
// from one just asked today, same shape as plant_products.last_requested_at (Ask Price).

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const GMAIL_CLIENT_ID = Deno.env.get("GMAIL_CLIENT_ID")!;
const GMAIL_CLIENT_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET")!;
const GMAIL_REFRESH_TOKEN = Deno.env.get("GMAIL_REFRESH_TOKEN")!;

async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

function buildGmailRawMessage(to: string, subject: string, body: string): string {
  const raw = `To: ${to}\r\nFrom: purchasing@buentradegroup.com\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sendGmailMessage(accessToken: string, to: string, subject: string, body: string): Promise<void> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: buildGmailRawMessage(to, subject, body) }),
  });
  if (!res.ok) throw new Error(`Gmail send failed: ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "provider_id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, provider_id } = body;

    const [provider] = await sql`select * from providers where id = ${provider_id}`;
    if (!provider) return jsonResponse({ error: "unknown provider id" }, 404);
    if (!provider.email) return jsonResponse({ error: "this provider has no email on file" }, 400);

    const subject = "BuenTrade — Solicitud de actualización de tarifas";
    const emailBody = `Hola${provider.contact_name ? " " + provider.contact_name : ""},\n\n` +
      `¿Podrían enviarnos su lista de tarifas de flete actualizada (US Freight) para las ciudades que manejamos con ustedes?\n\n` +
      `Gracias,\nBuenTrade`;

    const accessToken = await getAccessToken();
    await sendGmailMessage(accessToken, provider.email, subject, emailBody);

    const updated = await sql.begin(async (tx) => {
      const [updated] = await tx`
        update providers set last_rate_update_requested_at = now()
        where id = ${provider_id}
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "providers", record_id: provider_id, before: provider, after: updated });
      return updated;
    });

    return jsonResponse({ requested: true, provider: updated });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
