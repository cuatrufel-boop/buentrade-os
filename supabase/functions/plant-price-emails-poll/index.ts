// First real step of the email-ingestion automation: proves the Gmail OAuth setup actually works
// before anything gets built on top of it. This version ONLY reads — lists the most recent
// messages in the connected mailbox (purchasing@buentradegroup.com) and returns sender/subject/
// snippet. Never writes anything, never touches plant_products or plant_pending_matches. The real
// parse-and-match pipeline is a deliberate next step, once this foundation is verified live.

import { jsonResponse } from "../_shared/matching.ts";

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

function headerValue(headers: { name: string; value: string }[], name: string): string {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const maxResults = body.max_results || 5;

    const accessToken = await getAccessToken();

    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const listData = await listRes.json();
    if (!listRes.ok) throw new Error(`Gmail list failed: ${JSON.stringify(listData)}`);

    const messages = [];
    for (const m of listData.messages || []) {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const msgData = await msgRes.json();
      if (!msgRes.ok) continue;
      messages.push({
        id: m.id,
        from: headerValue(msgData.payload.headers, "From"),
        subject: headerValue(msgData.payload.headers, "Subject"),
        date: headerValue(msgData.payload.headers, "Date"),
        snippet: msgData.snippet,
      });
    }

    return jsonResponse({ mailbox_total_estimate: listData.resultSizeEstimate, messages });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
