// orders.invoiceSignature — one function, two actions, kept to one to stay under Supabase's
// 100-function project cap (already hit once this week).
//
// action "issue" (called from trading-tool.html's Real Costs panel, "Create Invoice"): generates a
// fresh unguessable token and saves it on the shipment. This is what makes the remote sign link
// safe to email/WhatsApp to the customer — anyone with the order_number alone (BT-0001, BT-0002...
// easily guessable) could otherwise mark someone else's order delivered.
//
// action "redeem" (called from sign-invoice.html, a PUBLIC page with no login — the customer signs
// on their own phone, not a BuenTrade device): verifies the token matches, then records
// invoice_signed_at — the customer's own proof-of-receipt, independent of shipment status.
//
// Real bug found live 2026-09-07: this used to reuse shipments-update-status to ALSO mark the
// shipment 'delivered' here, and used that same status to dedupe ("already delivered = already
// signed, don't re-process"). The user clarified those are two different real-world facts:
// "Delivered" (Carga entregada con Éxito) is the trader confirming the load physically arrived at
// the border — independent of whether the customer has gotten around to signing yet. Once
// "delivered" could be true with no signature on file, that dedupe check would tell the
// customer's real first signature "ya fue firmada," which never happened. invoice_signed_at is
// its own column now, set here directly — this action no longer touches shipment status at all.
//
// Real ask 2026-09-14: "busca la mejor forma en el mercado... como lo hacen las grandes empresas"
// — brought this up to the same real audit standard DocuSign/HelloSign hold an e-signature to:
// action "track_open" (called once when sign-invoice.html first loads, before the customer signs)
// records the first time the link was actually opened; "issue" now sets a real 30-day expiry so an
// old link can't be signed forever; "redeem" now requires an explicit consent flag, rejects an
// expired link, and records IP + device (user-agent) + a SHA-256 hash of the signed PDF bytes —
// the same tamper-evidence idea those tools use (proves later whether the retained file still
// matches what was actually signed).
const LINK_VALID_DAYS = 30;

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Real ask 2026-09-15: the real token (above) is what actually gates track_open/redeem — this is
// just a short, WhatsApp-message-friendly lookup key so the outbound link can read /f/x7k9m2
// instead of the long token URL. 8 chars from a 32-symbol alphabet (no 0/O/1/I/l) is ~40 bits,
// plenty for a random lookup key with a 30-day expiry, collision-checked below regardless.
const SHORT_CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
function randomShortCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => SHORT_CODE_ALPHABET[b % SHORT_CODE_ALPHABET.length]).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const { action } = body;
    if (!action) return jsonResponse({ error: "missing required fields", missing: ["action"] }, 400);

    // Real ask 2026-09-15: sign-invoice.html loaded from the short link (/f/x7k9m2, rewritten by
    // netlify.toml to /sign-invoice.html?c=x7k9m2) has only the short code, not an order_number yet
    // — that's the whole point of the short link. Handle it before the order_number-required check
    // every other action needs, and hand back exactly what the page needs to continue the normal
    // flow (order_number + the real token) so track_open/redeem still do the real validation.
    if (action === "resolve_short_code") {
      const { short_code } = body;
      if (!short_code) return jsonResponse({ error: "missing required fields", missing: ["short_code"] }, 400);
      const [shipment] = await sql`select order_number, invoice_token from shipments where invoice_short_code = ${short_code}`;
      if (!shipment) return jsonResponse({ error: "invalid_short_code" }, 404);
      return jsonResponse({ order_number: shipment.order_number, token: shipment.invoice_token });
    }

    const { order_number } = body;
    if (!order_number) return jsonResponse({ error: "missing required fields", missing: ["order_number"] }, 400);

    const [shipment] = await sql`select * from shipments where order_number = ${order_number}`;
    if (!shipment) return jsonResponse({ error: "unknown order_number" }, 404);

    if (action === "issue") {
      const { actor } = body;
      if (!actor) return jsonResponse({ error: "missing required fields", missing: ["actor"] }, 400);
      const token = randomToken();
      const expiresAt = new Date(Date.now() + LINK_VALID_DAYS * 86400000).toISOString();
      // Collision-check the short code against the unique index — astronomically unlikely at 8
      // chars/32 symbols, but a retry loop costs nothing and keeps the guarantee real.
      let shortCode = "";
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = randomShortCode();
        const [clash] = await sql`select id from shipments where invoice_short_code = ${candidate}`;
        if (!clash) { shortCode = candidate; break; }
      }
      if (!shortCode) return jsonResponse({ error: "could not generate a unique short code, try again" }, 500);
      // A fresh "issue" always means a brand-new link — the open/expiry state from any earlier,
      // now-dead link must not leak into this one.
      const [updated] = await sql`
        update shipments set invoice_token = ${token}, invoice_short_code = ${shortCode}, invoice_link_expires_at = ${expiresAt}, invoice_link_opened_at = null
        where id = ${shipment.id} returning *
      `;
      await writeAuditLog(sql, HMAC_SECRET, { actor, action: "update", table_name: "shipments", record_id: shipment.id, before: shipment, after: updated });
      return jsonResponse({ issued: true, token, short_code: shortCode, expires_at: expiresAt });
    }

    // Called once by sign-invoice.html right after it confirms the token is real, before the
    // customer has necessarily signed anything yet — this is the "someone actually opened the
    // link" audit event, same as an email read-receipt / DocuSign's "viewed" status.
    if (action === "track_open") {
      const { token } = body;
      if (!token) return jsonResponse({ error: "missing required fields", missing: ["token"] }, 400);
      if (!shipment.invoice_token || shipment.invoice_token !== token) return jsonResponse({ error: "invalid_token" }, 403);
      if (shipment.invoice_link_expires_at && new Date(shipment.invoice_link_expires_at) < new Date()) {
        return jsonResponse({ error: "link_expired" }, 403);
      }
      if (!shipment.invoice_link_opened_at) {
        await sql`update shipments set invoice_link_opened_at = now() where id = ${shipment.id}`;
      }
      return jsonResponse({ tracked: true, already_signed: !!shipment.invoice_signed_at });
    }

    if (action === "redeem") {
      const {
        token, invoice_url = null, signed_by_name = null,
        // Real ask 2026-09-14: same audit fields a real e-signature product records.
        pdf_hash = null, consent_confirmed = false,
      } = body;
      if (!token) return jsonResponse({ error: "missing required fields", missing: ["token"] }, 400);
      if (!shipment.invoice_token || shipment.invoice_token !== token) return jsonResponse({ error: "invalid_token" }, 403);
      if (shipment.invoice_signed_at) return jsonResponse({ already_signed: true });
      if (shipment.invoice_link_expires_at && new Date(shipment.invoice_link_expires_at) < new Date()) {
        return jsonResponse({ error: "link_expired" }, 403);
      }
      if (!consent_confirmed) return jsonResponse({ error: "consent_required" }, 400);

      // Best-effort real client IP — Supabase's edge runtime sets x-forwarded-for; never blocks
      // the actual signature if the header is missing for some reason.
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
      const userAgent = req.headers.get("user-agent") || null;

      // Real bug found live 2026-09-08: "despues de la firma del cliente ya la invoice debe
      // quedar guardada en esa orden entregada" — invoice_url/signed_by_name arrived in every
      // redeem call but were never written anywhere, only invoice_signed_at. Now the signed PDF
      // and who signed it are actually retained on the order, not silently discarded.
      const [updated] = await sql`
        update shipments set
          invoice_signed_at = now(), invoice_url = ${invoice_url}, invoice_signed_by = ${signed_by_name},
          invoice_signed_ip = ${ip}, invoice_signed_user_agent = ${userAgent},
          invoice_signed_pdf_hash = ${pdf_hash}, invoice_consent_confirmed = true
        where id = ${shipment.id} returning *
      `;
      await writeAuditLog(sql, HMAC_SECRET, {
        actor: "customer-signature", action: "update", table_name: "shipments", record_id: shipment.id,
        before: shipment, after: updated,
      });
      return jsonResponse({ redeemed: true, shipment: updated });
    }

    // The Certificate of Signature PDF (see sign-invoice.html's buildSignatureCertificatePdf) is
    // built and uploaded client-side AFTER redeem returns, since its content (the server-confirmed
    // IP/timestamp) only exists once redeem has run — this just records where it landed.
    if (action === "save_certificate_url") {
      const { certificate_url } = body;
      if (!certificate_url) return jsonResponse({ error: "missing required fields", missing: ["certificate_url"] }, 400);
      if (!shipment.invoice_signed_at) return jsonResponse({ error: "not_signed_yet" }, 400);
      await sql`update shipments set invoice_certificate_url = ${certificate_url} where id = ${shipment.id}`;
      return jsonResponse({ saved: true });
    }

    return jsonResponse({ error: "invalid action", valid_actions: ["issue", "resolve_short_code", "track_open", "redeem", "save_certificate_url"] }, 400);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
