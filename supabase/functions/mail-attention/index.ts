// mail-attention — everything the mailbox readers could not place by themselves, for a person to look at:
//   search           → open unrecognized senders + open intake issues
//   assign_sender    → "this address belongs to that plant": learned forever (plant_sender_addresses); the messages it already sent in the
//                      last 3 days that were set aside for want of a plant are released so the readers read them again
//   dismiss_sender   → "ignore this address": stays dismissed
//   resolve_issue    → a person handled an issue (an attachment that would not save, a reply with no release number...)
//   who_is           → read-only: how the readers would recognize an address right now (plant and which contact, carrier, ambiguous...)
// Every write is audit-logged. A repeated call is a no-op, never an error.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";
import { resolveSender } from "../_shared/mailIntake.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const { action = "search", actor } = body;

    if (action === "search") {
      const senders = await sql`select from_email, first_seen, last_seen, times, last_subject, last_reason, candidates from mail_unrecognized_senders where status = 'open' order by last_seen desc limit 200`;
      const issues = await sql`select id, message_id, handler, from_email, subject, reason_code, reason_detail, created_at, last_seen from mail_intake_issues where resolved_at is null order by created_at desc limit 200`;
      return jsonResponse({ senders, issues });
    }

    if (action === "who_is") {
      const address = String(body.address || "").trim().toLowerCase();
      if (!address) return jsonResponse({ error: "missing required fields", missing: ["address"] }, 400);
      return jsonResponse({ address, resolution: await resolveSender(sql, address) });
    }

    if (!actor) return jsonResponse({ error: "missing required fields", missing: ["actor"] }, 400);

    if (action === "assign_sender" || action === "dismiss_sender") {
      const email = String(body.from_email || "").trim().toLowerCase();
      if (!email) return jsonResponse({ error: "missing required fields", missing: ["from_email"] }, 400);
      const [row] = await sql`select * from mail_unrecognized_senders where from_email = ${email}`;
      if (!row) return jsonResponse({ error: "unknown sender" }, 400);
      if (row.status !== "open") return jsonResponse({ sender: row, idempotent_replay: true });

      if (action === "dismiss_sender") {
        const result = await sql.begin(async (tx: any) => {
          const [upd] = await tx`update mail_unrecognized_senders set status = 'dismissed', resolved_by = ${actor}, resolved_at = now() where from_email = ${email} returning *`;
          await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "mail_unrecognized_senders", record_id: email, before: row, after: upd });
          return upd;
        });
        return jsonResponse({ sender: result });
      }

      if (!body.plant_id) return jsonResponse({ error: "missing required fields", missing: ["plant_id"] }, 400);
      const [plant] = await sql`select id, name from plants where id = ${body.plant_id}`;
      if (!plant) return jsonResponse({ error: "unknown plant_id" }, 400);
      const result = await sql.begin(async (tx: any) => {
        await tx`
          insert into plant_sender_addresses (plant_id, email, source, created_by)
          values (${plant.id}, ${email}, 'assigned', ${actor})
          on conflict (email) do update set plant_id = excluded.plant_id
        `;
        const [upd] = await tx`update mail_unrecognized_senders set status = 'assigned', plant_id = ${plant.id}, resolved_by = ${actor}, resolved_at = now() where from_email = ${email} returning *`;
        // What this address sent while nobody knew it was set aside, never applied. Releasing those handled-marks lets the readers read
        // the same messages again, now with the plant known (older than 3 days they would be too stale to act on anyway).
        const price = await tx`delete from plant_price_emails_processed where from_email = ${email} and plant_id is null and processed_at > now() - interval '3 days' returning message_id`;
        const pickup = await tx`delete from pickup_docs_emails_processed where from_email = ${email} and processed_at > now() - interval '3 days' returning message_id`;
        const rel = await tx`delete from release_number_emails_processed where from_email = ${email} and processed_at > now() - interval '3 days' returning message_id`;
        const released = { price: price.length, pickup: pickup.length, release: rel.length };
        await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "mail_unrecognized_senders", record_id: email, before: row, after: { sender: upd, plant: plant.name, released } });
        return { upd, released };
      });
      return jsonResponse({ sender: result.upd, released: result.released });
    }

    if (action === "resolve_issue") {
      if (!body.id) return jsonResponse({ error: "missing required fields", missing: ["id"] }, 400);
      const [row] = await sql`select * from mail_intake_issues where id = ${body.id}`;
      if (!row) return jsonResponse({ error: "unknown issue id" }, 400);
      if (row.resolved_at) return jsonResponse({ issue: row, idempotent_replay: true });
      const result = await sql.begin(async (tx: any) => {
        const [upd] = await tx`update mail_intake_issues set resolved_at = now(), resolved_by = ${actor} where id = ${body.id} returning *`;
        await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "mail_intake_issues", record_id: String(body.id), before: row, after: upd });
        return upd;
      });
      return jsonResponse({ issue: result });
    }

    return jsonResponse({ error: "unknown action", actions: ["search", "assign_sender", "dismiss_sender", "resolve_issue", "who_is"] }, 400);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
