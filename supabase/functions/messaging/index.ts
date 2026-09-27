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
import { listMarketFlash } from "../_shared/marketFlash/store.ts";

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

// ---------------------------------------------------------------- relevance: which bulletin facts matter to a client
// The bulletin is raw statistics. A fact is worth a message only if it is about something the client buys (his exact cut
// first, then his protein), in his place when the data is regional (SNIIM: CDMX / Nuevo León), and it actually moved.
// Each pick carries an `angle` — why it matters to him as a buyer — which the draft turns into a question.
const MONTHS = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre";
function pctOf(text: string, tail: string): number | null {
  const m = text.match(new RegExp(`(\\d+(?:\\.\\d+)?)% (más|menos) ${tail}`));
  return m ? (m[2] === "menos" ? -1 : 1) * parseFloat(m[1]) : null;
}
function regionIsLocal(region: string | null, c: any): boolean {
  if (!region) return false;
  const st = String(c.state || "").toLowerCase(), city = String(c.city || "").toLowerCase();
  if (/distrito federal|zona metropolitana/i.test(region)) return /ciudad de méxico|estado de méxico|cdmx/.test(st + " " + city);
  return st && region.toLowerCase().includes(st);
}
function angleFor(b: any, text: string, c: any): { angle: string; weight: number; local: boolean } | null {
  const week = pctOf(text, "que la semana anterior"), year = pctOf(text, "que hace un año");
  if (b.kind === "cut_price_forecast_month" || b.kind === "cut_price_forecast_week") {
    const months = [...text.matchAll(new RegExp(`(${MONTHS}) (\\d+(?:\\.\\d+)?)% (más|menos)`, "g"))].map((m) => ({ m: m[1], v: (m[3] === "menos" ? -1 : 1) * parseFloat(m[2]) }));
    const vals = months.length ? months.map((x) => x.v) : (year != null ? [year] : []);
    if (!vals.length) return null;
    const low = Math.min(...vals);
    if (months.length > 1 && months[months.length - 1].v - months[0].v >= 3)
      return { angle: `el boletín proyecta que este corte suba hacia ${months[months.length - 1].m} — conviene asegurar antes`, weight: 3 + Math.min(2, (months[months.length - 1].v - months[0].v) / 10), local: false };
    if (low <= -10) return { angle: `precio muy por debajo del año pasado (hasta ${Math.abs(low)}% menos, según la proyección) — buen momento para abastecerse`, weight: 3 + Math.min(2, Math.abs(low) / 15), local: false };
    return null;
  }
  if (b.kind === "cut_price_weekly") {
    if (week != null && Math.abs(week) >= 3) return { angle: week < 0 ? `bajó ${Math.abs(week)}% en la semana — buen momento de compra` : `subió ${week}% en la semana — asegurar antes de que siga`, weight: 2.6 + Math.min(2, Math.abs(week) / 5), local: false };
    if (year != null && year <= -10) return { angle: `${Math.abs(year)}% más barato que hace un año`, weight: 2.3 + Math.min(2, Math.abs(year) / 15), local: false };
    return null;
  }
  if (b.kind === "mx_pork_price") {
    if (week == null || week === 0) return null; // "sin cambio" is not news
    const region = (text.match(/ en (.+?), semana/) || [])[1] || null;
    const local = regionIsLocal(region, c);
    const where = /distrito federal/i.test(region || "") ? "CDMX" : region;
    return { angle: `en ${where} el precio local ${week > 0 ? "subió" : "bajó"} ${Math.abs(week)}% en la semana (SNIIM)${week > 0 ? " — el producto de EE.UU. puede salirle mejor" : ""}`, weight: (local ? 2.8 : 1.4) + Math.min(1.5, Math.abs(week) / 5), local };
  }
  // Volume only: a drop in dollar VALUE is not "less product" (July: chicken to Mexico fell in value but rose in tons).
  if (b.kind === "export_change" && /a México/.test(text) && /toneladas métricas/.test(text)) {
    const less = / menos /.test(text);
    return { angle: less ? "está entrando menos producto de EE.UU. a México — la oferta se aprieta" : "está entrando más producto de EE.UU. a México", weight: less ? 1.7 : 1.5, local: false };
  }
  return null;
}
const EN_MONTH: Record<string, string> = { ene: "Jan", feb: "Feb", mar: "Mar", abr: "Apr", may: "May", jun: "Jun", jul: "Jul", ago: "Aug", sep: "Sep", oct: "Oct", nov: "Nov", dic: "Dec" };
const EN_SPECIES: Record<string, string> = { cerdo: "pork", pollo: "chicken", res: "beef", pavo: "turkey" };
const enDate = (d: string) => { const m = d.match(/(\d+) (\w{3})/); return m ? `${EN_MONTH[m[2].toLowerCase()] || m[2]} ${m[1]}` : d; };
function shortWhy(b: any, text: string): string {
  const sign = (v: number | null) => v == null ? "" : `${v > 0 ? "+" : ""}${v}%`;
  const week = pctOf(text, "que la semana anterior"), year = pctOf(text, "que hace un año");
  const wk = (text.match(/semana al (\d+ \w+)\.?/) || [])[1];
  if (b.kind === "mx_pork_price") {
    const region = (text.match(/ en (.+?), semana/) || [])[1] || "";
    return `${/distrito federal/i.test(region) ? "CDMX" : region} local price ${sign(week)}${wk ? ` · week of ${enDate(wk)}` : ""} (SNIIM)`;
  }
  if (b.kind === "cut_price_weekly") return `US price ${week != null ? `${sign(week)} on the week` : ""}${year != null ? `${week != null ? ", " : ""}${sign(year)} vs a year ago` : ""}${wk ? ` · week of ${enDate(wk)}` : ""}`;
  if (b.kind === "cut_price_forecast_month" || b.kind === "cut_price_forecast_week") {
    const months = [...text.matchAll(new RegExp(`(${MONTHS}) (\\d+(?:\\.\\d+)?)% (más|menos)`, "g"))].map((m) => `${EN_MONTH[m[1].slice(0, 3)] || m[1]} ${m[3] === "menos" ? "-" : "+"}${m[2]}%`);
    return `Forecast vs a year ago: ${months.length ? months.join(", ") : sign(year)}`;
  }
  if (b.kind === "export_change") {
    const t = text.match(/de (carne de \w+|pavo|variety meats de \w+)[^:]*a México en (\w+) de \d+: ([\d,]+) toneladas métricas (más|menos)/);
    const sp = t ? t[1].replace("carne de ", "").replace("variety meats de ", "") : "";
    return t ? `US ${t[1].startsWith("variety") ? `${EN_SPECIES[sp] || sp} variety meats` : EN_SPECIES[sp] || sp} exports to Mexico ${t[4] === "menos" ? "-" : "+"}${t[3]} t vs a year ago (${EN_MONTH[t[2].slice(0, 3)] || t[2]})` : "US exports to Mexico";
  }
  return text;
}
function marketCandidates(mf: any, c: any, myPids: Set<string>, mySpecies: Set<string>, shortByPid: Map<string, string>, alreadySent: (id: string) => boolean) {
  const out: any[] = [];
  for (const g of mf.product) {
    const pid = g.product_ids.find((id: string) => myPids.has(id));
    if (!pid) continue;
    for (const b of g.bullets) {
      if (alreadySent(b.id)) continue;
      const a = angleFor(b, b.text_es, c);
      if (a) out.push({ b, text: b.text_es, short: `${g.label_en.split(" — ").slice(1).join(" ") || g.label_en} — ${shortWhy(b, b.text_es)}`, angle: a.angle, score: a.weight, local: a.local, productId: pid, productEs: shortByPid.get(pid) || g.label_es, scope: `about ${g.label_en}`, entity: g.label_es });
    }
  }
  for (const sp of mySpecies) for (const b of (mf.protein[sp]?.bullets || [])) {
    // protein-wide: only supply into Mexico — the analyst's general commentary often names cuts this client doesn't buy
    if (alreadySent(b.id) || b.kind !== "export_change") continue;
    const a = angleFor(b, b.text_es, c);
    if (a && (b.kind !== "export_change" || c.country === "Mexico")) out.push({ b, text: b.text_es, short: shortWhy(b, b.text_es), angle: a.angle, score: a.weight, local: false, productId: null, productEs: null, scope: `${sp} market`, entity: b.kind === "export_change" ? "exports" : `protein:${sp}:${b.kind}` });
  }
  // the strongest fact per product/topic, then the best two overall
  out.sort((x, y) => y.score - x.score);
  const seen = new Set<string>(), picks: any[] = [];
  for (const x of out) { if (seen.has(x.entity)) continue; seen.add(x.entity); picks.push(x); if (picks.length === 2) break; }
  return picks;
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
    sql`select id, customer_id, reason_kind, reason_key, product_id, note_id, message, channel, sent_at, reason_why,
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

  // Market Flash: always the LATEST bulletin (2026-09-27: it arrives late — the Sep 5 edition landed Sep 25 — so a fixed
  // freshness window left Messaging with nothing). Each message says when its data is from; forecasts look ahead anyway.
  const mf = await listMarketFlash(sql);
  const bulletSends = mf.bulletin ? await sql`select bullet_id, customer_id from market_flash_bullet_sends` : [];
  const sentBullet = new Set(bulletSends.map((r: any) => `${r.bullet_id}|${r.customer_id}`));
  const speciesByProduct = new Map<string, string>();
  for (const g of mf.product) for (const pid of g.product_ids) speciesByProduct.set(pid, g.species);
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

    // market — the bulletin facts that matter to THIS client, strongest first (see marketCandidates)
    if (mf.bulletin) {
      const myPids = new Set(products.map((p: any) => p.product_id));
      const mySpecies = new Set([...myPids].map((pid) => speciesByProduct.get(pid as string)).filter(Boolean) as string[]);
      const shortByPid = new Map(products.map((p: any) => [p.product_id, p.short_es]));
      const picks = marketCandidates(mf, c, myPids, mySpecies, shortByPid, (id: string) => sentBullet.has(`${id}|${c.id}`) && !sentTodayBy.has(`market:${id}`));
      for (const k of picks) {
        add({
          reason_key: `market:${k.b.id}`, kind: "market", product_id: k.productId, note_id: null, bullet_ids: [k.b.id],
          why: k.short, source: `${k.text} — Market Flash, data as of ${String(mf.bulletin.as_of).slice(0, 10)} — ${k.b.source_note || k.scope}.`,
          score: k.score, is_new: (Date.now() - new Date(mf.bulletin.created_at).getTime()) / 86400000 < 1,
          fact: { type: "market", fact_es: k.text, angle_es: k.angle, data_as_of: String(mf.bulletin.as_of).slice(0, 10), product_es: k.productEs, client_city: c.city, local: k.local },
        });
      }
    }

    // A message sent today stays on the list as Sent even if its reason has changed since (volume filled in, note used…).
    const KIND: Record<string, Option["kind"]> = { cycle: "cycle", ask_volume: "ask_volume", personal: "personal", market: "market" };
    for (const [key, m] of sentTodayBy) {
      if (options.some((o) => o.reason_key === key)) continue;
      options.push({ reason_key: key, kind: KIND[m.reason_kind], product_id: m.product_id, note_id: m.note_id, bullet_ids: [],
        why: m.reason_why || "Sent earlier today", source: "Sent earlier today.", score: 0, is_new: false,
        sent_at: m.sent_at, sent_channel: m.channel, sent_message: m.message, draft: null, subject: null, fact: {} });
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
    bulletin: mf.bulletin ? { as_of: mf.bulletin.as_of, created_at: mf.bulletin.created_at } : null,
    clients,
  };
}

// ---------------------------------------------------------------- draft (written in the trader's style)
const DRAFT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["message", "subject"],
  properties: { message: { type: "string" }, subject: { type: "string" } },
};

async function draft(body: any) {
  const { customer_id, actor, regenerate, previous } = body;
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
- At most 2 short sentences, 30 words maximum in total. Sound like a person who knows him, never like a template, a newsletter or a bot. No emojis, no links, no prices, no signature.
- Use ONLY the fact given. Never add facts, numbers, places (e.g. \"la frontera\"), news or claims that are not in it. His city/business may be mentioned only as who he is.
- End with a question that is easy to answer (yes/no or a product).
- cycle: we do NOT know what he bought from other suppliers — ASK how he is doing with that product / if he already needs more, and offer to look for it. Never claim he ran out, never mention that we track his purchases or numbers.
- ask_volume: ask, with genuine interest in his business, how many loads of that product he moves a month.
- personal: a warm, human question about what he told us. Do not push product unless the note itself is about his business.
- market: in plain words, give the fact AND its angle (why it matters to him as a buyer — the angle_es field), say when the data is from as the fact says it (e.g. "la semana del 4 de septiembre", "el boletín proyecta para octubre") — never "esta semana" unless the fact says so — then ask one easy question (how it's affecting him / if he wants you to secure product). Keep numbers exactly as given.
Also return an email subject of 2-5 words (no "Cotización", no prices).`;
  const user = `Client: ${client.first_name || client.trade_name} (${client.trade_name})${client.city ? `, ${client.city}${client.state ? `, ${client.state}` : ""}` : ""}${bizName ? ` — ${bizName}` : ""}.
Reason: ${option.kind}
Fact: ${JSON.stringify(option.fact)}
${regenerate && previous ? `The trader asked for a DIFFERENT version — do not repeat this one, change the angle and the wording (same fact, same rules): "${previous}"\n` : ""}${examples ? `How this trader actually writes (learn his tone, length and words from these; when he corrected a proposal, write like his correction):\n${examples}` : "No examples from this trader yet — keep it natural, short and direct."}`;

  const out = await callClaude(system, user, DRAFT_SCHEMA, 400);
  const payload = { message: String(out.message || "").trim(), subject: String(out.subject || "").trim() };
  await sql`insert into customer_message_drafts (customer_id, reason_key, draft) values (${customer_id}, ${optionKey}, ${JSON.stringify(payload)})
    on conflict (customer_id, reason_key) do update set draft = excluded.draft, created_at = now()`;
  return { status: 200, payload };
}

// ---------------------------------------------------------------- writes (idempotent, audited)
async function send(body: any) {
  const { customer_id, reason_key, message, channel, actor, idempotency_key, draft: proposed, reason_why } = body;
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
      insert into customer_messages (customer_id, reason_kind, reason_key, product_id, note_id, bullet_ids, draft, message, channel, sent_by, idempotency_key, reason_why)
      values (${customer_id}, ${reason_kind}, ${reason_key}, ${product_id}, ${note_id}, ${JSON.stringify(bullet_ids)}::jsonb, ${proposed ?? null}, ${message}, ${channel}, ${actor}, ${idempotency_key}, ${reason_why ?? null})
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
      draft, send, add_note: addNote, delete_note: deleteNote, set_loads: setLoads,
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
