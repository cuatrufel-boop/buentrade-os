// shipment-alerts-poll — runs every 15 minutes (pg_cron, see the migration that added this
// schedule). This is the decision engine behind "una notificacion donde yo le de ok y se ejecute"
// — real-time, one alert per event, never a digest. Every condition here comes directly from the
// frozen, user-approved flow (project_order_lifecycle_and_alerting_spec memory) — nothing
// invented, nothing pattern-matched from an unrelated existing rule (see
// feedback_never_invent_business_logic_conditions — that's exactly the mistake this function must
// not repeat).
//
// Each shipment's alert-tracking columns (pre_pickup_alert_sent_at, etc.) are the dedup: once an
// alert fires for a given condition, it never fires again for that same shipment — a resolved
// condition just leaves that column set, harmlessly.
//
// Alerts go to sent_offers.won_by — the trader who actually owns this order.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const API_ROOT = "https://geqhjykbxvxugvnpnygn.supabase.co/functions/v1/";
const API_KEY = Deno.env.get("API_PUBLISHABLE_KEY") || "sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe";
// Real correction 2026-09-06: "necesito que la notificacion SIEMPRE me lleve a una accion... una
// pantalla que solo me deje hacer esa accion antes de todo... si es en mi pc o cel debe ser en OS
// con accion" — a raw Gmail-compose/wa.me link let the trader "handle it" entirely outside the app,
// with nothing tracked and no forced screen. Every alert now links into orders.html's own blocking
// urgent-queue overlay via ?focus=<order_number> instead — that queue already forces one action at
// a time, "Ya lo hice" only unlocking after the real button is clicked, and ?focus just moves this
// specific order's item to the front of it. APP_ORIGIN is a Supabase secret (unset until the real
// production domain is confirmed) — never guessed/invented.
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") || "";
function appLink(orderNumber: string): string {
  return `${APP_ORIGIN}/orders.html?focus=${orderNumber}`;
}

// Same fixed rule as offers.html's computeBorderArrivalDate — ship date + 2 calendar days, weekend
// rolls to Monday. Kept in sync manually since this runs in a different runtime (Edge Function,
// not the browser) — if that client-side function ever changes, this must change with it.
function computeBorderArrivalDate(fromDateStr: string): string | null {
  if (!fromDateStr) return null;
  const d = new Date(fromDateStr + "T00:00:00");
  d.setDate(d.getDate() + 2);
  const dow = d.getDay();
  if (dow === 6) d.setDate(d.getDate() + 2);
  else if (dow === 0) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Real correction 2026-09-06: this used to build a second push action ("WhatsApp Carrier"/"Email
// Plant") that opened wa.me/Gmail directly, bypassing the app entirely. Now there's exactly one
// action, always: open the order's forced screen in BuenTrade OS (appLink). The real send action
// (WhatsApp/Email/Confirmar pago/Enviar a Aduana) lives INSIDE that screen, same as every other
// document send in this codebase — "nada se manda sin que el trader vea."
async function sendPush(actor: string, title: string, body: string, orderNumber: string) {
  await fetch(API_ROOT + "push-send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY, apikey: API_KEY },
    body: JSON.stringify({ actor, title, body, url: `/orders.html?focus=${orderNumber}`, actions: [{ action: "open_app", title: "Abrir en BuenTrade OS", url: `/orders.html?focus=${orderNumber}` }] }),
  }).catch(() => {}); // best-effort — a push failure must never break the poll loop for other shipments
}

// Real ask 2026-09-06: "siempre me notifique con push, el os, el cel y el correo... si estoy
// cenando me notifica el cel" — email is the one channel here that ALSO reaches a phone with zero
// new setup: the trader's own Gmail app already pushes a native notification for new mail, so
// sending here doubles as a real mobile alert, not just an inbox entry. Reuses the exact same
// Gmail OAuth this project already holds for plant-price-emails-poll — same account, same scopes,
// no new credential.
const GMAIL_CLIENT_ID = Deno.env.get("GMAIL_CLIENT_ID")!;
const GMAIL_CLIENT_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET")!;
const GMAIL_REFRESH_TOKEN = Deno.env.get("GMAIL_REFRESH_TOKEN")!;

async function getGmailAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN, grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}
// Real bug found live 2026-09-06: the body declares charset="UTF-8" and rendered fine, but the
// Subject header had NO charset declaration at all — RFC 5322 headers default to 7-bit/ASCII, so
// Gmail's UI mis-decoded the raw UTF-8 bytes as Latin-1, producing "Ã¢Â€Â"" instead of "—" and
// "Ã°ÂŸÂ“Âž" instead of "📎". RFC 2047 requires non-ASCII header text to be explicitly marked with
// =?UTF-8?B?...?=; encodeMimeHeader does that the same way the body's bytes are already encoded.
function encodeMimeHeader(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}
function buildGmailRawMessage(to: string, subject: string, body: string): string {
  const raw = `To: ${to}\r\nFrom: purchasing@buentradegroup.com\r\nSubject: ${encodeMimeHeader(subject)}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sendEmail(accessToken: string, to: string, subject: string, body: string) {
  await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: buildGmailRawMessage(to, subject, body) }),
  }).catch(() => {}); // best-effort, same as sendPush — one channel failing never blocks the others
}

// The one real alert call every condition below uses — push AND email together, every time, so
// no single channel being missed (permission revoked, phone off, whatever) means the trader never
// hears about it at all. Both channels now always resolve to the SAME forced screen in the app
// (appLink) — the email's link was missing entirely before this correction; only the bypass
// compose-links were ever included in the email body, so reading an alert by email left the
// trader with no way into the app at all, only a raw external link.
async function notify(gmailToken: string, actor: string, title: string, body: string, orderNumber: string) {
  const link = appLink(orderNumber);
  await Promise.all([
    sendPush(actor, title, body, orderNumber),
    sendEmail(gmailToken, actor, title, `${body}\n\nAbrir en BuenTrade OS: ${link}`),
  ]);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const gmailToken = await getGmailAccessToken();
    const shipments = await sql`
      select sh.*, o.won_by, o.product_name, o.plant_name,
        (select po.delivery_dates->>0 from purchase_orders po where po.order_number = sh.order_number limit 1) as pickup_date,
        (select po.docs_on from purchase_orders po where po.order_number = sh.order_number limit 1) as docs_on,
        pl.whatsapp as plant_whatsapp, pl.phone as plant_phone, pl.email as plant_email,
        car.name as carrier_name, car.whatsapp as carrier_whatsapp, car.phone as carrier_phone,
        (
          select count(*)::int from shipment_pickup_documents d
          where d.shipment_id = sh.id and d.forwarded_to_customs_at is null
        ) as pending_docs_count
      from shipments sh
      join sent_offers o on o.id = sh.sent_offer_id
      left join plants pl on pl.id = o.plant_id
      left join providers car on car.id = sh.carrier_provider_id
      where sh.status != 'delivered' and o.won_by is not null
    `;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let alertsSent = 0;

    for (const sh of shipments) {
      // Point 5 — before pickup, matters to plant AND carrier, neither notifies proactively.
      if (sh.status === "pending_pickup" && sh.pickup_date) {
        const pickup = new Date(sh.pickup_date + "T00:00:00");
        const daysUntil = Math.round((pickup.getTime() - today.getTime()) / 86400000);

        if (daysUntil < 0 && !sh.missed_pickup_alert_sent_at) {
          await notify(gmailToken, sh.won_by, `⚠ Missed pickup — ${sh.order_number} — ${sh.plant_name}`,
            `${sh.product_name} — ${sh.plant_name}. Pickup date (${sh.pickup_date}) already passed and this load is still pending_pickup. Confirm with plant and carrier now.`,
            sh.order_number);
          await sql`update shipments set missed_pickup_alert_sent_at = now() where id = ${sh.id}`;
          alertsSent++;
        } else if (daysUntil === 1 && !sh.pre_pickup_alert_sent_at) {
          // Real corrections 2026-09-06: (1) never same-day — "que tal si recoge a las 6am": by the
          // time a "today" alert would fire, an early-morning pickup could already be missed. Only
          // ever alerts the day before now, giving real lead time. (2) The WhatsApp message ITSELF
          // goes to a US plant/carrier — English, same rule as every other plant/carrier-facing
          // document in this codebase (PO/FO are English-only). (3) The alert TEXT (to the trader)
          // now names the plant and product, not just an order number — "si tengo 100 ordenes debo
          // saber de que estoy hablando."
          // Real correction 2026-09-06: payment + release # moved OUT of this alert — the user
          // clarified they don't happen the day before pickup, they happen closer to when the
          // order is first created ("no es un dia antes, es como una semana antes... muy cerca a
          // despues de generar ordenes" — still unconfirmed exactly, see the separate
          // plant-payment reminder below). This alert stays scoped to pickup-day logistics only.
          // Real ask 2026-09-06: "cada notificacion debe dar los datos explicitos de la accion" —
          // the trader-facing text names the exact date and the exact carrier, not just "tomorrow."
          await notify(gmailToken, sh.won_by, `Pickup tomorrow (${sh.pickup_date}) — ${sh.order_number} — ${sh.plant_name}`,
            `${sh.product_name} — ${sh.plant_name}. Pickup scheduled for ${sh.pickup_date}${sh.carrier_name ? ` with ${sh.carrier_name}` : ""}. Confirm with plant and carrier that everything is ready.`,
            sh.order_number);
          await sql`update shipments set pre_pickup_alert_sent_at = now() where id = ${sh.id}`;
          alertsSent++;
        }
      }

      // Real correction 2026-09-06: pay-the-plant and ask-for-release# are TWO separate steps, not
      // one message that (backwards) asked the PLANT to self-report whether they'd been paid. The
      // real sequence: 1) BuenTrade pays soon after the order is won (timing still provisional,
      // "te confirmo" — 1 day is a starting point, same spirit as RATE_STALE_DAYS elsewhere in
      // this codebase); 2) the trader confirms it in Orders (confirmPlantPaymentSent — sends the
      // plant a real payment-confirmation email, not asked for here); 3) only once plant_paid_at is
      // set does this poll separately ask for the release number.
      const PLANT_PAYMENT_REMINDER_DAYS_AFTER_WON = 1;
      if (sh.status === "pending_pickup" && !sh.plant_payment_alert_sent_at && !sh.plant_paid_at) {
        const daysSinceWon = (Date.now() - new Date(sh.created_at).getTime()) / 86400000;
        if (daysSinceWon >= PLANT_PAYMENT_REMINDER_DAYS_AFTER_WON) {
          await notify(gmailToken, sh.won_by, `Pay plant — ${sh.order_number} — ${sh.plant_name}`,
            `${sh.product_name} — ${sh.plant_name}. Pay the plant now, then confirm it in Orders — that sends the plant a real payment confirmation and unlocks asking for the release number.`,
            sh.order_number);
          await sql`update shipments set plant_payment_alert_sent_at = now() where id = ${sh.id}`;
          alertsSent++;
        }
      }
      if (sh.status === "pending_pickup" && sh.plant_paid_at && !sh.release_number_alert_sent_at) {
        await notify(gmailToken, sh.won_by, `Pedir Release Number — ${sh.order_number} — ${sh.plant_name}`,
          `${sh.product_name} — ${sh.plant_name}. Pago confirmado — pide el release number para que el transportista pueda recoger la carga.`,
          sh.order_number);
        await sql`update shipments set release_number_alert_sent_at = now() where id = ${sh.id}`;
        alertsSent++;
      }

      // Point 6 — right after pickup, request BOL/packing list/label photos (always) + USDA papers
      // (if Docs) from BOTH carrier and plant. A 30-min delay after picked_up_at, not instant —
      // the trader who just clicked "Confirm Pickup" is already looking at the screen; the real
      // risk is forgetting to actually go request the documents afterward.
      if (sh.status === "picked_up" && sh.picked_up_at && !sh.pickup_docs_alert_sent_at) {
        const minutesSincePickup = (Date.now() - new Date(sh.picked_up_at).getTime()) / 60000;
        if (minutesSincePickup >= 30) {
          const docsLine = sh.docs_on
            ? "label photos, Bill of Lading, packing list, and USDA papers"
            : "label photos, Bill of Lading, and packing list";

          await notify(gmailToken, sh.won_by, `Pickup documents needed — ${sh.order_number} — ${sh.plant_name}`,
            `${sh.product_name} — ${sh.plant_name}. Ask the plant and carrier for: ${docsLine}. These get forwarded to the customs agency.`,
            sh.order_number);
          await sql`update shipments set pickup_docs_alert_sent_at = now() where id = ${sh.id}`;
          alertsSent++;
        }
      }

      // Point 4/9 — the fixed 2-day window to the US-side border handoff, computed from the real
      // pickup time when known (falls back to the planned date only if it hasn't actually picked
      // up yet, which shouldn't happen for picked_up/unloading but is a safe fallback).
      if ((sh.status === "picked_up" || sh.status === "unloading") && !sh.border_overdue_alert_sent_at) {
        // Real bug found live 2026-09-06: postgres.js returns timestamptz columns as native Date
        // objects, not strings — String(dateObject) produces "Sun Sep 06 2026 01:32:42 GMT..." and
        // slicing that gives "Sun Sep 06", not a real ISO date. computeBorderArrivalDate then built
        // an Invalid Date and .toISOString() threw, crashing this ENTIRE poll (one bad shipment
        // took down alerts for every shipment) the moment any load first reached picked_up/
        // unloading. toISOString() first normalizes to the real ISO date before slicing.
        const fromDate = sh.picked_up_at ? new Date(sh.picked_up_at).toISOString().slice(0, 10) : sh.pickup_date;
        const expected = fromDate ? computeBorderArrivalDate(fromDate) : null;
        if (expected && new Date(expected + "T00:00:00") < today) {
          await notify(gmailToken, sh.won_by, `⚠ Debería haber llegado a la frontera — ${sh.order_number} — ${sh.plant_name}`,
            `${sh.product_name} — ${sh.plant_name}. Se esperaba en la frontera (entrega a aduana US) el ${expected} y no hay actualización.`,
            sh.order_number);
          await sql`update shipments set border_overdue_alert_sent_at = now() where id = ${sh.id}`;
          alertsSent++;
        }
      }

      // Real correction 2026-09-06: "debe haber alarmas urgentes de asegurarse de recibir docs de
      // planta despues de pickup... la carga debe irse notificando a la aduana con los docs
      // correspondientes en el mismo momento" — this used to only ever be a passive line in the
      // client's "Necesita tu atención" panel; it never actually reached the trader as a real
      // push+email alert. Unlike every other alert here, this one is genuinely urgent and re-fires
      // (at most once an hour, not every 15-min poll tick) for as long as ANY document is still
      // sitting unforwarded — the whole point is that it keeps nagging until the trader acts,
      // instead of firing once and going quiet.
      if ((sh.pending_docs_count || 0) > 0) {
        const lastSent = sh.docs_ready_alert_sent_at ? new Date(sh.docs_ready_alert_sent_at).getTime() : 0;
        if (Date.now() - lastSent > 60 * 60 * 1000) {
          await notify(gmailToken, sh.won_by, `📎 Docs listos para aduana — ${sh.order_number} — ${sh.plant_name}`,
            `${sh.product_name} — ${sh.plant_name}. ${sh.pending_docs_count} documento(s) de recogida recibido(s) — todavía sin enviar a la agencia aduanal.`,
            sh.order_number);
          await sql`update shipments set docs_ready_alert_sent_at = now() where id = ${sh.id}`;
          alertsSent++;
        }
      }
    }

    return jsonResponse({ checked: shipments.length, alerts_sent: alertsSent });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
