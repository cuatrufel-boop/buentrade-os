// messaging — the Messaging screen (approved 2026-09-27). One function, keyed by `action`, same pattern as
// sent-offers-search's offer_sheet: everything the screen reads or writes goes through here.
//
// The goal, in the user's words: clients ignore "hola, buenos días" — they only answer what is relevant to THEM. So
// every morning, per client, this lists every real reason to write to him, each already written as a short question
// in the trader's own style, and the trader picks which one, edits it if he wants and sends it. Nothing is ever sent
// automatically, and nothing is invented: every message comes from a fact shown next to it (his stated monthly
// volume, a note of what he told the trader, a Market Flash bullet), and every message's `source` says where from.
//
// Reasons (options) per client:
//   cycle       he buys N loads a month of a product (from ALL his suppliers — customer_products cadence, the trader's
//               stated figure) and the month is going by. We never know what he bought from others, so the message
//               ASKS ("¿cómo vas de papada?") instead of claiming he ran out.
//   ask_volume  we don't know his monthly volume for a product he buys → ask it, as a question that shows interest.
//   personal    something he told the trader (customer_notes) not used in a message yet.
//   market      a current Market Flash bullet about his product / protein / market he hasn't received yet.
// Sent today → shown as sent (a second message the same day is fine, just with a different reason). Cycle and
// ask_volume come back the next day while still true; personal and market are used once.
//
// Learning (only from the trader): the draft prompt carries the trader's own recent messages, and for the ones he
// edited, what the system proposed next to what he actually sent — so drafts drift toward how he writes.
import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";
import { callClaude } from "../_shared/marketFlash/claude.ts";
import { FRESHNESS_DAYS, listMarketFlash } from "../_shared/marketFlash/store.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
// "Today" for sent-today / drafts-of-the-day. BuenTrade operates from Weston, FL.
const TZ = "America/New_York";

type Option = {
  reason_key: string; kind: "cycle" | "ask_volume" | "personal" | "market";
  product_id: string | null; note_id: string | null; bullet_ids: string[];
  why: string; source: string; score: number; is_new: boolean;
  sent_at: string | null; sent_channel: string | null; sent_message: string | null;
  draft: string | null; subject: string | null;
  fact: Record<string, unknown>; // what the draft is written from — never shown to the client as-is
};

const firstName = (c: any) => String(c.contact_name || c.trade_name || "").trim().split(/\s+/)[0] || "";
const productShortEs = (p: any) => [p.name, p.subcategory].filter(Boolean).join(" ").toLowerCase();
const round1 = (n: number) => Math.round(n * 10) / 10;

async function todayParts() {
  const [r] = await sql`select (now() at time zone ${TZ})::date as today, extract(day from (now() at time zone ${TZ}))::int as dom,
    extract(day from (date_trunc('month', (now() at time zone ${TZ})) + interval '1 month - 1 day'))::int as dim`;
  return r as { today: string; dom: number; dim: number };
}

// ---------------------------------------------------------------- list
async function list(actor: string, onlyCustomerId: string | null = null) {
  const { dom, dim } = await todayParts();
  const [customers, links, notes, sentAll, businessTypes, fromUs, drafts, works] = await Promise.all([
    sql`select c.id, c.trade_name, c.contact_name, c.email, c.whatsapp, c.phone, c.business_type_id,
               coalesce(ci.name, c.city) as city, st.name_es as state, co.name_en as country
        from customers c left join cities ci on ci.id = c.city_id left join states st on st.id = c.state_id left join countries co on co.id = c.country_id
        where ${onlyCustomerId}::uuid is null or c.id = ${onlyCustomerId}
        order by c.trade_name`,
    sql`select cp.id as link_id, cp.customer_id, cp.product_id, cp.frequency_days, cp.loads_per_cycle,
               p.name, p.subcategory, p.full_name_es, p.full_name_en
        from customer_products cp join products p on p.id = cp.product_id order by p.full_name_en`,
    sql`select n.id, n.customer_id, n.note, n.created_at, n.created_by,
               exists (select 1 from customer_messages m where m.note_id = n.id) as used
        from customer_notes n order by n.created_at desc`,
    sql`select id, customer_id, reason_kind, reason_key, product_id, note_id, message, channel, sent_at,
               (sent_at at time zone ${TZ})::date = (now() at time zone ${TZ})::date as today,
               (request_linked_at at time zone ${TZ})::date = (now() at time zone ${TZ})::date as asked_today
        from customer_messages order by sent_at desc`,
    sql`select id, name_en, name_es from business_types order by sort_order, name_en`,
    // loads delivered by us this calendar month, per client + product (one delivery date = one load)
    sql`select so.customer_id, so.product_id, count(*)::int as loads
        from sales_orders so, jsonb_array_elements_text(so.delivery_dates) d
        where date_trunc('month', d::date) = date_trunc('month', (now() at time zone ${TZ})::date)
        group by 1, 2`,
    sql`select customer_id, reason_key, draft, created_at from customer_message_drafts
        where (created_at at time zone ${TZ})::date = (now() at time zone ${TZ})::date`,
    sql`select customer_id, reason_kind, count(*)::int as sent, count(request_linked_at)::int as requests
        from customer_messages group by 1, 2`,
  ]);

  // Market Flash: the latest bulletin's bullets, only while fresh (same FRESHNESS_DAYS + valid_until rules as quotes used).
  const mf = await listMarketFlash(sql);
  const bulletinFresh = !!mf.bulletin && (Date.now() - new Date(mf.bulletin.as_of).getTime()) / 86400000 <= FRESHNESS_DAYS;
  const today = new Date().toISOString().slice(0, 10);
  const valid = (b: any) => !b.valid_until || String(b.valid_until).slice(0, 10) >= today;
  const bulletSends = bulletinFresh ? await sql`select bullet_id, customer_id from market_flash_bullet_sends` : [];
  const sentBullet = new Set(bulletSends.map((r: any) => `${r.bullet_id}|${r.customer_id}`));
  const speciesByProduct = new Map<string, string>();
  if (bulletinFresh) for (const g of mf.product) for (const pid of g.product_ids) speciesByProduct.set(pid, g.species);
  const catSpecies = await sql`select p.id, c.name_en from products p join categories c on c.id = p.category_id`;
  const SPECIES: Record<string, string> = { Pork: "pork", Beef: "beef", Chicken: "chicken", Turkey: "turkey" };
  for (const r of catSpecies) if (SPECIES[r.name_en]) speciesByProduct.set(r.id, SPECIES[r.name_en]);

  const draftBy = new Map<string, any>(drafts.map((d: any) => [`${d.customer_id}|${d.reason_key}`, d]));
  const fromUsBy = new Map<string, number>(fromUs.map((r: any) => [`${r.customer_id}|${r.product_id}`, r.loads]));

  const clients = customers.map((c: any) => {
    const myLinks = links.filter((l: any) => l.customer_id === c.id);
    const myNotes = notes.filter((n: any) => n.customer_id === c.id);
    const mySent = sentAll.filter((m: any) => m.customer_id === c.id);
    const sentTodayBy = new Map<string, any>();
    for (const m of mySent) if (m.today && !sentTodayBy.has(m.reason_key)) sentTodayBy.set(m.reason_key, m);
    const options: Option[] = [];
    const add = (o: Omit<Option, "sent_at" | "sent_channel" | "sent_message" | "draft" | "subject">) => {
      const s = sentTodayBy.get(o.reason_key);
      const d = draftBy.get(`${c.id}|${o.reason_key}`);
      let draft = null, subject = null;
      if (d) { try { const j = JSON.parse(d.draft); draft = j.message; subject = j.subject; } catch { draft = d.draft; } }
      options.push({ ...o, sent_at: s?.sent_at ?? null, sent_channel: s?.channel ?? null, sent_message: s?.message ?? null, draft, subject });
    };

    const products = myLinks.map((l: any) => {
      const loadsMonth = l.frequency_days ? round1(((l.loads_per_cycle ?? 1) * 30) / l.frequency_days) : null;
      // As the trader stated it ("every 40 days, 1 load") unless it is already a monthly figure — never a 0.8 loads/month.
      const cadence = !l.frequency_days ? null : l.frequency_days === 30 ? `${l.loads_per_cycle ?? 1} load${(l.loads_per_cycle ?? 1) === 1 ? "" : "s"} a month`
        : `${l.loads_per_cycle ?? 1} load${(l.loads_per_cycle ?? 1) === 1 ? "" : "s"} every ${l.frequency_days} days`;
      return { link_id: l.link_id, product_id: l.product_id, name_es: l.full_name_es, name_en: l.full_name_en, short_es: productShortEs(l),
        loads_month: loadsMonth, monthly_input: l.frequency_days === 30 ? l.loads_per_cycle : null, cadence,
        from_us_month: fromUsBy.get(`${c.id}|${l.product_id}`) || 0 };
    });

    // cycle
    for (const p of products) {
      if (!p.loads_month || p.from_us_month >= p.loads_month) continue;
      const uncovered = p.loads_month - p.from_us_month;
      add({
        reason_key: `cycle:${p.product_id}:${new Date().toISOString().slice(0, 7)}`, kind: "cycle", product_id: p.product_id, note_id: null, bullet_ids: [],
        why: `Buys ${p.cadence} of ${p.name_en} (all suppliers) — ${p.from_us_month} from us so far this month (day ${dom} of ${dim})`,
        source: `Clients → ${p.name_en}: ${p.cadence}. Orders: ${p.from_us_month} load${p.from_us_month === 1 ? "" : "s"} delivered by us this month.`,
        score: 2 + 2 * (dom / dim) * (uncovered / p.loads_month), is_new: false,
        fact: { type: "cycle", product_es: p.short_es, buys: p.cadence, day_of_month: dom, days_in_month: dim },
      });
    }

    // ask_volume — one at a time: the product without a monthly figure that was asked least recently (never first)
    const unknown = products.filter((p: any) => !p.loads_month);
    if (unknown.length) {
      const lastAsked = (pid: string) => { const m = mySent.find((x: any) => x.reason_kind === "ask_volume" && x.product_id === pid); return m ? new Date(m.sent_at).getTime() : 0; };
      const todayAsk = unknown.find((p: any) => sentTodayBy.has(`ask:${p.product_id}`));
      const p = todayAsk || [...unknown].sort((a: any, b: any) => lastAsked(a.product_id) - lastAsked(b.product_id) || a.name_en.localeCompare(b.name_en))[0];
      add({
        reason_key: `ask:${p.product_id}`, kind: "ask_volume", product_id: p.product_id, note_id: null, bullet_ids: [],
        why: `We don't know how many loads of ${p.name_en} this client buys a month${unknown.length > 1 ? ` (${unknown.length - 1} more product${unknown.length > 2 ? "s" : ""} after this one)` : ""}`,
        source: `Clients → ${p.name_en}: loads/month is empty.`, score: 1, is_new: false,
        fact: { type: "ask_volume", product_es: p.short_es },
      });
    }

    // personal
    for (const n of myNotes) {
      if (n.used && !sentTodayBy.has(`note:${n.id}`)) continue;
      const ageDays = (Date.now() - new Date(n.created_at).getTime()) / 86400000;
      add({
        reason_key: `note:${n.id}`, kind: "personal", product_id: null, note_id: n.id, bullet_ids: [],
        why: `Told you: ${n.note}`, source: `Your note, ${new Date(n.created_at).toISOString().slice(0, 10)}${n.created_by ? ` (${n.created_by})` : ""}.`,
        score: 3, is_new: ageDays < 1, fact: { type: "personal", note: n.note, noted_on: String(n.created_at).slice(0, 10) },
      });
    }

    // market — product-level bullets for his products first, then one protein-wide and one market-wide bullet
    if (bulletinFresh) {
      const myPids = new Set(products.map((p: any) => p.product_id));
      const mySpecies = new Set([...myPids].map((pid) => speciesByProduct.get(pid as string)).filter(Boolean));
      const seen = new Set<string>();
      const pushBullet = (b: any, scope: string, score: number, productId: string | null) => {
        if (seen.has(b.id) || !valid(b)) return;
        const wasSent = sentBullet.has(`${b.id}|${c.id}`);
        if (wasSent && !sentTodayBy.has(`market:${b.id}`)) return;
        seen.add(b.id);
        add({
          reason_key: `market:${b.id}`, kind: "market", product_id: productId, note_id: null, bullet_ids: [b.id],
          why: `Market Flash (${mf.bulletin.as_of}): ${b.text_es}`, source: `Market Flash bulletin ${mf.bulletin.as_of} — ${b.source_note || scope}.`,
          score, is_new: (Date.now() - new Date(mf.bulletin.created_at).getTime()) / 86400000 < 1,
          fact: { type: "market", bullet_es: b.text_es, scope, country: c.country },
        });
      };
      for (const g of mf.product) {
        const pid = g.product_ids.find((id: string) => myPids.has(id));
        if (!pid) continue;
        const b = g.bullets.find((x: any) => valid(x) && (!sentBullet.has(`${x.id}|${c.id}`) || sentTodayBy.has(`market:${x.id}`)));
        if (b) pushBullet(b, `about ${g.label_en}`, 2.5, pid);
      }
      for (const sp of mySpecies) {
        const b = (mf.protein[sp as string]?.bullets || []).find((x: any) => valid(x) && (!sentBullet.has(`${x.id}|${c.id}`) || sentTodayBy.has(`market:${x.id}`)));
        if (b) pushBullet(b, `${sp} market`, 1.8, null);
      }
      const mkt = c.country === "Mexico" ? mf.market.MX : mf.market.US;
      const b = (mkt?.bullets || []).find((x: any) => valid(x) && (!sentBullet.has(`${x.id}|${c.id}`) || sentTodayBy.has(`market:${x.id}`)));
      if (b) pushBullet(b, c.country === "Mexico" ? "Mexico market" : "US market", 1.5, null);
    }

    options.sort((a, b) => Number(!!a.sent_at) - Number(!!b.sent_at) || b.score - a.score);
    const pending = options.filter((o) => !o.sent_at);
    return {
      id: c.id, trade_name: c.trade_name, contact_name: c.contact_name, first_name: firstName(c),
      city: c.city, state: c.state, country: c.country, email: c.email, phone: c.whatsapp || c.phone, business_type_id: c.business_type_id,
      products, notes: myNotes.map((n: any) => ({ id: n.id, note: n.note, created_at: n.created_at, used: n.used })),
      works: works.filter((w: any) => w.customer_id === c.id).map((w: any) => ({ kind: w.reason_kind, sent: w.sent, requests: w.requests })),
      options, asked_today: mySent.filter((m: any) => m.asked_today).length, score: pending.length ? Math.max(...pending.map((o) => o.score)) : 0,
      uncovered: products.reduce((n: number, p: any) => n + (p.loads_month ? Math.max(0, p.loads_month - p.from_us_month) : 0), 0),
    };
  });

  return {
    business_types: businessTypes,
    bulletin: mf.bulletin ? { as_of: mf.bulletin.as_of, fresh: bulletinFresh } : null,
    clients,
  };
}

// ---------------------------------------------------------------- draft (written in the trader's style)
const DRAFT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["message", "subject"],
  properties: { message: { type: "string" }, subject: { type: "string" } },
};

async function draft(body: any) {
  const { customer_id, actor, regenerate } = body;
  const optionKey = body.reason_key;
  if (!customer_id || !optionKey) return { status: 400, payload: { error: "customer_id and reason_key are required" } };
  if (!regenerate) {
    const [cached] = await sql`select draft from customer_message_drafts where customer_id = ${customer_id} and reason_key = ${optionKey}
      and (created_at at time zone ${TZ})::date = (now() at time zone ${TZ})::date`;
    if (cached) { try { return { status: 200, payload: JSON.parse(cached.draft) }; } catch { return { status: 200, payload: { message: cached.draft, subject: "" } }; } }
  }
  const all = await list(actor, customer_id);
  const client = all.clients.find((c: any) => c.id === customer_id);
  const option = client?.options.find((o: Option) => o.reason_key === optionKey);
  if (!client || !option) return { status: 404, payload: { error: "no such client/reason today" } };

  // Learn only from the trader: his last sent messages; where he changed the proposal, both versions.
  const mine = await sql`select draft, message, reason_kind from customer_messages where sent_by = ${actor ?? ""} order by sent_at desc limit 15`;
  const examples = mine.map((m: any) => (m.draft && m.draft.trim() !== m.message.trim()
    ? `- (${m.reason_kind}) the system proposed: "${m.draft}" → he actually sent: "${m.message}"`
    : `- (${m.reason_kind}) he sent: "${m.message}"`)).join("\n");
  const bizName = client.business_type_id ? (all.business_types.find((b: any) => b.id === client.business_type_id)?.name_es ?? null) : null; // the trader's own Spanish wording

  const system = `You write ONE short WhatsApp/email message from a meat trader (BuenTrade) to one of his clients in Mexico, in the trader's own voice.
Purpose: the client is busy and ignores generic greetings and price lists; he only answers what is relevant to HIM. The message must make him answer — ideally by asking the trader to look for a product.
Rules (all mandatory):
- Mexican Spanish, always "tú" (never "usted", never Argentine voseo like "comprás"). Start with the client's first name. Don't assume the client's gender: avoid gendered adjectives about them unless the name makes it unambiguous.
- At most 2 short sentences (under 35 words). Sound like a person who knows him, never like a template, a newsletter or a bot. No emojis, no links, no prices, no signature.
- Use ONLY the fact given. Never add facts, numbers, places, news or claims that are not in it. His city/business may be mentioned only as who he is.
- End with a question that is easy to answer (yes/no or a product).
- cycle: we do NOT know what he bought from other suppliers — ASK how he is doing with that product / if he already needs more, and offer to look for it. Never claim he ran out, never mention that we track his purchases or numbers.
- ask_volume: ask, with genuine interest in his business, how many loads of that product he moves a month.
- personal: a warm, human question about what he told us. Do not push product unless the note itself is about his business.
- market: tell him the fact in plain words as something useful for him, then ask how it affects him / if he wants you to secure product.
Also return an email subject of 2-5 words (no "Cotización", no prices).`;
  const user = `Client: ${client.first_name || client.trade_name} (${client.trade_name})${client.city ? `, ${client.city}${client.state ? `, ${client.state}` : ""}` : ""}${bizName ? ` — ${bizName}` : ""}.
Reason: ${option.kind}
Fact: ${JSON.stringify(option.fact)}
${examples ? `How this trader actually writes (learn his tone, length and words from these; when he corrected a proposal, write like his correction):\n${examples}` : "No examples from this trader yet — keep it natural, short and direct."}`;

  const out = await callClaude(system, user, DRAFT_SCHEMA, 400);
  const payload = { message: String(out.message || "").trim(), subject: String(out.subject || "").trim() };
  await sql`insert into customer_message_drafts (customer_id, reason_key, draft) values (${customer_id}, ${optionKey}, ${JSON.stringify(payload)})
    on conflict (customer_id, reason_key) do update set draft = excluded.draft, created_at = now()`;
  return { status: 200, payload };
}

// ---------------------------------------------------------------- writes (idempotent, audited)
async function send(body: any) {
  const { customer_id, reason_key, message, channel, actor, idempotency_key, draft: proposed } = body;
  const missing = ["customer_id", "reason_key", "message", "channel", "actor", "idempotency_key"].filter((k) => !body[k]);
  if (missing.length) return { status: 400, payload: { error: "missing required fields", missing } };
  if (!["whatsapp", "email"].includes(channel)) return { status: 400, payload: { error: "channel must be whatsapp or email" } };
  const [existing] = await sql`select * from customer_messages where idempotency_key = ${idempotency_key}`;
  if (existing) return { status: 200, payload: { message: existing, duplicate: true } };
  const kind = String(reason_key).split(":")[0];
  const reason_kind = ({ cycle: "cycle", ask: "ask_volume", note: "personal", market: "market" } as Record<string, string>)[kind];
  if (!reason_kind) return { status: 400, payload: { error: "unknown reason_key" } };
  const part = String(reason_key).split(":")[1] || null;
  const product_id = reason_kind === "cycle" || reason_kind === "ask_volume" ? part : (body.product_id ?? null);
  const note_id = reason_kind === "personal" ? part : null;
  const bullet_ids = reason_kind === "market" && part ? [part] : [];
  const row = await sql.begin(async (tx: any) => {
    const [m] = await tx`
      insert into customer_messages (customer_id, reason_kind, reason_key, product_id, note_id, bullet_ids, draft, message, channel, sent_by, idempotency_key)
      values (${customer_id}, ${reason_kind}, ${reason_key}, ${product_id}, ${note_id}, ${JSON.stringify(bullet_ids)}::jsonb, ${proposed ?? null}, ${message}, ${channel}, ${actor}, ${idempotency_key})
      on conflict (idempotency_key) do nothing returning *`;
    if (!m) return null;
    // a Market Flash bullet reaches a client once — same log Quotes used, so Market Flash's "sent to N" stays true
    for (const b of bullet_ids) {
      await tx`insert into market_flash_bullet_sends (bullet_id, customer_id, channel, sent_by) values (${b}, ${customer_id}, ${channel}, ${actor}) on conflict (bullet_id, customer_id) do nothing`;
    }
    await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "customer_messages", record_id: m.id, after: m });
    return m;
  });
  if (!row) { const [again] = await sql`select * from customer_messages where idempotency_key = ${idempotency_key}`; return { status: 200, payload: { message: again, duplicate: true } }; }
  return { status: 200, payload: { message: row } };
}

async function addNote(body: any) {
  const { customer_id, note, actor, idempotency_key } = body;
  const missing = ["customer_id", "note", "actor", "idempotency_key"].filter((k) => !body[k] || (k === "note" && !String(body[k]).trim()));
  if (missing.length) return { status: 400, payload: { error: "missing required fields", missing } };
  const row = await sql.begin(async (tx: any) => {
    const [n] = await tx`insert into customer_notes (customer_id, note, created_by, idempotency_key) values (${customer_id}, ${String(note).trim()}, ${actor}, ${idempotency_key})
      on conflict (idempotency_key) do nothing returning *`;
    if (n) await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "customer_notes", record_id: n.id, after: n });
    return n;
  });
  const [n] = row ? [row] : await sql`select * from customer_notes where idempotency_key = ${idempotency_key}`;
  return { status: 200, payload: { note: n } };
}

async function deleteNote(body: any) {
  const { id, actor } = body;
  if (!id || !actor) return { status: 400, payload: { error: "id and actor are required" } };
  await sql.begin(async (tx: any) => {
    const [before] = await tx`select * from customer_notes where id = ${id}`;
    if (!before) return;
    await tx`delete from customer_notes where id = ${id}`;
    await writeAuditLog(tx, HMAC_SECRET, { actor, action: "delete", table_name: "customer_notes", record_id: id, before });
  });
  return { status: 200, payload: { deleted: true } };
}

async function setBusinessType(body: any) {
  const { customer_id, business_type_id, actor } = body;
  if (!customer_id || !actor) return { status: 400, payload: { error: "customer_id and actor are required" } };
  const r = await sql.begin(async (tx: any) => {
    const [before] = await tx`select id, business_type_id from customers where id = ${customer_id}`;
    if (!before) return null;
    const [after] = await tx`update customers set business_type_id = ${business_type_id || null} where id = ${customer_id} returning id, business_type_id`;
    await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "customers", record_id: customer_id, before, after });
    return after;
  });
  return r ? { status: 200, payload: { customer: r } } : { status: 404, payload: { error: "unknown customer" } };
}

// Monthly volume, written in the SAME existing cadence fields Clients uses (every 30 days, N loads).
async function setLoads(body: any) {
  const { link_id, loads_month, actor } = body;
  if (!link_id || !actor) return { status: 400, payload: { error: "link_id and actor are required" } };
  const n = loads_month == null || loads_month === "" ? null : Number(loads_month);
  if (n != null && !(n > 0 && Number.isInteger(n))) return { status: 400, payload: { error: "loads_month must be a whole number of loads, or empty" } };
  const r = await sql.begin(async (tx: any) => {
    const [before] = await tx`select * from customer_products where id = ${link_id}`;
    if (!before) return null;
    const [after] = await tx`update customer_products set frequency_days = ${n == null ? null : 30}, loads_per_cycle = ${n} where id = ${link_id} returning *`;
    await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "customer_products", record_id: link_id, before, after });
    return after;
  });
  return r ? { status: 200, payload: { link: r } } : { status: 404, payload: { error: "unknown link" } };
}

// Quotes → "did this search come from a message?" — messages sent in the last 24h about one of these products.
async function quoteOrigin(body: any) {
  const ids = Array.isArray(body.product_ids) ? body.product_ids.filter(Boolean) : [];
  if (!ids.length) return { status: 200, payload: { messages: [] } };
  const rows = await sql`
    select m.id, m.customer_id, c.trade_name, m.product_id, m.reason_kind, m.sent_at, m.channel
    from customer_messages m join customers c on c.id = m.customer_id
    where m.product_id = any(${ids}) and m.sent_at >= now() - interval '24 hours'
      and m.request_linked_at is null and m.origin_dismissed_at is null
    order by m.sent_at desc`;
  return { status: 200, payload: { messages: rows } };
}
async function linkOrigin(body: any) {
  const { message_id, actor } = body;
  if (!message_id || !actor) return { status: 400, payload: { error: "message_id and actor are required" } };
  await sql.begin(async (tx: any) => {
    const [before] = await tx`select * from customer_messages where id = ${message_id}`;
    if (!before || before.request_linked_at) return;
    const [after] = await tx`update customer_messages set request_linked_at = now(), request_linked_by = ${actor}, request_product_id = product_id where id = ${message_id} returning *`;
    await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "customer_messages", record_id: message_id, before, after });
  });
  return { status: 200, payload: { linked: true } };
}
async function dismissOrigin(body: any) {
  const { message_ids, actor } = body;
  if (!Array.isArray(message_ids) || !message_ids.length || !actor) return { status: 400, payload: { error: "message_ids and actor are required" } };
  await sql`update customer_messages set origin_dismissed_at = now() where id = any(${message_ids}) and origin_dismissed_at is null and request_linked_at is null`;
  return { status: 200, payload: { dismissed: message_ids.length } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const handlers: Record<string, (b: any) => Promise<{ status: number; payload: any }>> = {
      draft, send, add_note: addNote, delete_note: deleteNote, set_business_type: setBusinessType, set_loads: setLoads,
      quote_origin: quoteOrigin, link_origin: linkOrigin, dismiss_origin: dismissOrigin,
    };
    if (body.action === "list") return jsonResponse(await list(body.actor ?? ""));
    const h = handlers[body.action];
    if (!h) return jsonResponse({ error: "unknown action" }, 400);
    const r = await h(body);
    return jsonResponse(r.payload, r.status);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
