// price-history-search — read-only by default. Every real price ever recorded for a product
// (price_history, filled automatically since 2026-09-16 — see applyPlantProductMatch/
// plant-products-update), plus the same market-trend signal (today's best vs the prior-30-day
// average) already used to build the "Price X% better/worse" line in the customer-product signal.
// Returns null trend, not a fabricated one, until there's genuinely a prior day to compare against.
//
// Market Flash v2 (2026-09-25) lives here too — folded into this file instead of new function slugs
// because the Edge Function project cap is maxed at 100/100 (same precedent as customer-product-signal):
//   ingest_market_flash      reads the WHOLE bulletin automatically (tables by deterministic self-validating parsers,
//                            narrative by an audited literal-translation step) and stores every Spanish bullet.
//                            Idempotent by the sha-256 of the PDF (computed here): the same PDF/email twice = one bulletin.
//   list_market_flash        the bulletin's bullets + the terms still to teach, read-only (used by Quotes → Messaging → Market).
//   poll_market_flash_emails / process_market_flash_inbox  the bulletin arriving by email (cron every 15 min).
//   teach_market_flash_term  Pending Matches → "this printed term means this catalog product/family" (learned once,
//                            applies to every stored and future bulletin). Idempotent upsert.
// Mutually exclusive with each other and with the default read below.
// 2026-09-27: the default read no longer returns Market Flash bullets — the bulletin is only a source for Messaging.
import postgres from "npm:postgres@3.4.4";
import { computeProductPriceSignal, jsonResponse } from "../_shared/matching.ts";
import { ingestBulletin, listMarketFlash, teachTerm } from "../_shared/marketFlash/store.ts";
import { diagnoseInbox, dumpXlsx, pollBulletinEmails, processInboxMessage, repairBulletinNarrative, testBulletinMessage, testBulletinRepair } from "../_shared/marketFlash/emailInbox.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();

    if (body.ingest_market_flash) {
      const { items, file_hash, pdf_base64, actor, source } = body.ingest_market_flash;
      const r = await ingestBulletin(sql, { items, file_hash, pdf_base64, actor: actor ?? "unknown", source });
      return jsonResponse(r, "error" in r ? 400 : 200);
    }

    // Bulletin by email (see _shared/marketFlash/emailInbox.ts): poll finds/validates/downloads/reads the PDF; process turns
    // one stored message into a bulletin (called by poll per message, so each step has its own compute budget).
    if (body.poll_market_flash_emails?.xlsx_message_id) return jsonResponse(await dumpXlsx(String(body.poll_market_flash_emails.xlsx_message_id)));
    if (body.poll_market_flash_emails?.diagnose) return jsonResponse(await diagnoseInbox(body.poll_market_flash_emails.count || 8, String(body.poll_market_flash_emails.q || "")));
    // Verification: one real message through the whole real path inside a transaction that is always rolled back.
    if (body.poll_market_flash_emails?.test_message_id) return jsonResponse(await testBulletinMessage(sql, String(body.poll_market_flash_emails.test_message_id), { allowDegraded: body.poll_market_flash_emails.allow_degraded === true }));
    if (body.poll_market_flash_emails) return jsonResponse(await pollBulletinEmails(sql, body.poll_market_flash_emails.max_results || 10));
    // A stored bulletin whose commentary was never read: read it again (its own invocation — it re-downloads the PDF). test_repair = the same, rolled back.
    if (body.repair_market_flash_narrative?.bulletin_id) {
      const id = String(body.repair_market_flash_narrative.bulletin_id);
      return jsonResponse(body.repair_market_flash_narrative.execute_rollback === true ? await testBulletinRepair(sql, id) : await repairBulletinNarrative(sql, id));
    }
    if (body.process_market_flash_inbox) {
      if (!body.process_market_flash_inbox.message_id) return jsonResponse({ error: "process_market_flash_inbox requires message_id" }, 400);
      return jsonResponse(await processInboxMessage(sql, body.process_market_flash_inbox.message_id));
    }

    if (body.list_market_flash) return jsonResponse(await listMarketFlash(sql));

    if (body.teach_market_flash_term) {
      const { term, option_key, actor } = body.teach_market_flash_term;
      const r = await teachTerm(sql, { term, option_key, actor: actor ?? "unknown" });
      return jsonResponse(r, "error" in r ? 400 : 200);
    }

    // One plant's whole price history, every product, in one read (2026-10-02): what the plant's Products & Prices table lists
    // under each current price. Read-only; the per-product read below is unchanged.
    if (body.plant_id && !body.product_id) {
      const rows = await sql`select ph.product_id, ph.price, ph.price_date, ph.created_at from price_history ph where ph.plant_id = ${body.plant_id} order by ph.price_date desc, ph.created_at desc limit 5000`;
      return jsonResponse({ results: rows });
    }

    const { product_id } = body;
    if (!product_id) return jsonResponse({ error: "product_id is required" }, 400);

    const results = await sql`
      select ph.price, ph.price_date, ph.created_at, pl.name as plant_name
      from price_history ph
      join plants pl on pl.id = ph.plant_id
      where ph.product_id = ${product_id}
      order by ph.price_date desc, ph.created_at desc
      limit 200
    `;

    const trend = await computeProductPriceSignal(sql, product_id);

    return jsonResponse({ results, trend });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
