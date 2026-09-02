// The real email-ingestion pipeline: reads recent mail in purchasing@buentradegroup.com, matches
// each message's sender to a known plant, splits the body into lines, and detects items two ways
// (see _shared/priceListLine.ts, both ported faithfully from Load Prices, same order it already
// uses — block-format checked first): single-line "name + $price" (form #1), or block-format
// (Seaboard-style: name-line(s) then a price PER price column below — last column = Delivered,
// so freight_included is set and Quotes never double-charges freight on top of it). Any other real
// shape (casual short lines, category-header folding, prose sentences with multiple items) is
// deliberately NOT handled yet — those lines are simply skipped, never guessed.
//   - a confident catalog match applies straight to plant_products via the SAME endpoint Load
//     Prices already uses (plant-products-apply-match), including the plant's own docs_included
//     default — never a second copy of that write logic.
//   - an unsure match becomes a plant_pending_matches row for a human to resolve once (see
//     plant-pending-matches-create) — never auto-applied, never guessed.
// plant_price_emails_processed makes every run idempotent — a message already seen is skipped, so
// re-polling never re-applies or re-queues the same line twice. A message from an address that
// doesn't match any plant's email is recorded (so it isn't invisible) but nothing is guessed from
// it — no plant, no safe place to apply anything.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, normalize } from "../_shared/matching.ts";
import { detectBlockFormatItems, looksLikeBlockFormat, parsePriceListLineBasic } from "../_shared/priceListLine.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

const GMAIL_CLIENT_ID = Deno.env.get("GMAIL_CLIENT_ID")!;
const GMAIL_CLIENT_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET")!;
const GMAIL_REFRESH_TOKEN = Deno.env.get("GMAIL_REFRESH_TOKEN")!;
// Same API_ROOT + non-secret publishable key every page's own callApi() already uses (see
// plants.html) — not sensitive (it's already public in the client-side HTML), used here so this
// function calls its sibling functions exactly the same way the frontend does.
const SUPABASE_URL = "https://geqhjykbxvxugvnpnygn.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe";
const EMAIL_AUTOMATION_ACTOR = "email-automation@buentradegroup.com";

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

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

// Walks a (possibly multipart) Gmail message payload for the first text/plain part. HTML-only
// emails (no plain-text alternative) return "" — deliberately not scraped from HTML tags, since
// that's a real source of noise the pasted-text flow never had to deal with.
function extractPlainText(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts || []) {
    const found = extractPlainText(part);
    if (found) return found;
  }
  return "";
}

async function callSibling(fn: string, body: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`, apikey: SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${fn} failed with ${res.status}`);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const maxResults = body.max_results || 20;
    const debugMessageId = body.debug_message_id || null;

    const accessToken = await getAccessToken();
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`, { headers: authHeaders });
    const listData = await listRes.json();
    if (!listRes.ok) throw new Error(`Gmail list failed: ${JSON.stringify(listData)}`);

    const [{ id: usdCurrencyId }] = await sql`select id from currencies where code = 'USD'`;
    const today = new Date().toISOString().slice(0, 10);

    const results = [];
    for (const m of listData.messages || []) {
      const [already] = await sql`select message_id from plant_price_emails_processed where message_id = ${m.id}`;
      if (already) { results.push({ id: m.id, skipped: "already_processed" }); continue; }

      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: authHeaders });
      const msgData = await msgRes.json();
      if (!msgRes.ok) { results.push({ id: m.id, skipped: "gmail_fetch_failed" }); continue; }

      const fromHeader = headerValue(msgData.payload.headers, "From");
      const subject = headerValue(msgData.payload.headers, "Subject");
      const emailMatch = fromHeader.match(/<([^>]+)>/);
      const fromEmail = (emailMatch ? emailMatch[1] : fromHeader).trim().toLowerCase();

      const [plant] = await sql`select id, name, docs_included from plants where lower(email) = ${fromEmail}`;
      if (!plant) {
        await sql`insert into plant_price_emails_processed (message_id, from_email, subject) values (${m.id}, ${fromEmail}, ${subject}) on conflict (message_id) do nothing`;
        results.push({ id: m.id, skipped: "no_matching_plant", from: fromEmail });
        continue;
      }

      const bodyText = extractPlainText(msgData.payload);
      // Same preprocessing Load Prices applies before either detector ever sees the text — a blank
      // line (Gmail's plain-text flattening of an HTML table inserts one after every cell) breaks
      // the block-format detector's "consume the whole run of consecutive price lines" step, so
      // skipping this step silently produces wrong names and misses the two-column Delivered price.
      const lines = bodyText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

      if (debugMessageId === m.id) {
        return jsonResponse({
          debug: true, bodyTextLength: bodyText.length, lineCount: lines.length,
          looksLikeBlockFormat: looksLikeBlockFormat(lines),
          blockItems: detectBlockFormatItems(lines),
          first20Lines: lines.slice(0, 20),
        });
      }

      // Same order Load Prices already uses: block-format is checked FIRST (a name-line-then-
      // price-line-below list can fool the single-line scanner into latching onto false "prices"
      // like a lead-time line), only falling back to the single-line scan when it doesn't look
      // like a block-format list at all.
      type Item = { rawText: string; nameEn?: string; nameEs?: string | null; price: number; freightIncluded: boolean };
      let items: Item[] = [];
      if (looksLikeBlockFormat(lines)) {
        items = detectBlockFormatItems(lines).map((it) => ({
          rawText: it.nameEs ? `${it.nameEn} — ${it.nameEs}` : it.nameEn,
          nameEn: it.nameEn, nameEs: it.nameEs, price: it.price, freightIncluded: it.freightIncluded,
        }));
      } else {
        for (const line of lines) {
          const parsed = parsePriceListLineBasic(line);
          if (parsed) items.push({ rawText: parsed.rawText, price: parsed.price, freightIncluded: false });
        }
      }

      let applied = 0, pending = 0, skipped = lines.length - items.length;
      const errors: string[] = [];
      for (const item of items) {
        let matchRes;
        try {
          matchRes = await callSibling("products-match-from-plant-text", {
            plant_id: plant.id, raw_text: item.rawText, name_en: item.nameEn || null, name_es: item.nameEs || null,
          });
        } catch (e) { skipped++; errors.push(`match ${item.rawText}: ${e}`); continue; }
        try {
          if (matchRes.matched) {
            await callSibling("plant-products-apply-match", {
              actor: EMAIL_AUTOMATION_ACTOR, plant_id: plant.id, product_id: matchRes.product.id,
              raw_text: normalize(item.rawText), price: item.price,
              price_currency_id: usdCurrencyId, price_date: today,
              docs_included: plant.docs_included === true, freight_included: item.freightIncluded,
            });
            applied++;
          } else {
            await callSibling("plant-pending-matches-create", {
              actor: EMAIL_AUTOMATION_ACTOR, plant_id: plant.id, raw_text: item.rawText,
              detected_price: item.price, candidate_product_ids: (matchRes.candidates || []).map((p: any) => p.id),
              idempotency_key: `${m.id}|${normalize(item.rawText)}`,
            });
            pending++;
          }
        } catch (e) { skipped++; errors.push(`apply ${item.rawText}: ${e}`); }
      }

      await sql`
        insert into plant_price_emails_processed (message_id, plant_id, from_email, subject, lines_applied, lines_pending, lines_skipped)
        values (${m.id}, ${plant.id}, ${fromEmail}, ${subject}, ${applied}, ${pending}, ${skipped})
        on conflict (message_id) do nothing
      `;
      results.push({ id: m.id, plant: plant.name, applied, pending, skipped, errors: errors.slice(0, 5) });
    }

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
