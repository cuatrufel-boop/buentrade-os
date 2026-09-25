// Facts → Spanish bullets, by FIXED templates. Nothing is free-written: every bullet is a sentence pattern
// filled with numbers copied from a verified Fact. No adjectives, no advice, no conclusions — only what
// the bulletin printed (plus plain arithmetic between two printed numbers, marked as such in `computed`).
//
// Levels are tags, not choices: one bullet can serve Product AND Protein AND Market at once.
//   product → tied to one specific cut/item (matched to a catalog product later, never guessed here)
//   protein → has a species (pork/beef/chicken/turkey)
//   market  → always (US or MX)
import type { Fact, Market, Species } from "./types.ts";
import type { NarrativeClaim } from "./narrative.ts";

export interface Bullet {
  key: string;                 // fact key(s) it was built from — identity for de-duplication and trend comparison
  fact_keys: string[];
  kind: string;
  levels: Array<"product" | "protein" | "market">;
  species: Species | null;
  market: Market;
  product_entity: string | null;   // printed cut name to be matched to the catalog (null unless level includes product)
  text_es: string;
  source_note: string;             // provenance shown to the trader, never invented
  page: number;
  computed: boolean;               // true when a number in the text is arithmetic between two printed numbers
  glossary_gaps: string[];         // English terms kept as printed because no certified Spanish term exists yet
  sendable: boolean;               // false while a term is uncertified: held back, never sent with English words in it
  quote_en?: string;               // narrative bullets: the exact source sentence(s) this text translates
}

const MES = ["ene.", "feb.", "mar.", "abr.", "may.", "jun.", "jul.", "ago.", "sep.", "oct.", "nov.", "dic."];
const MES_LARGO = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const fmtDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MES[m - 1]}`; };
const fmtDateY = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MES[m - 1]} ${y}`; };
const fmtMonth = (ym: string) => { const [y, m] = ym.split("-").map(Number); return `${MES_LARGO[m - 1]} de ${y}`; };
const n = (v: number, dec = 2) => v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const nAuto = (v: number) => (Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 3 }));
const usd = (v: number, dec = 2) => `US$${n(v, dec)}`;
const pct = (p: number) => `${Number.isInteger(p) ? Math.abs(p) : n(Math.abs(p), 1)}%`;
// sign → word. Zero → "sin cambio". This is a mapping of the printed sign, not an interpretation.
const moreLess = (p: number) => (p > 0 ? "más" : "menos");
const ZERO: Record<string, string> = { "hace un año": "sin cambio frente al año anterior", "la semana anterior": "sin cambio frente a la semana anterior" };
const versus = (p: number, label: string, ref?: string) => (p === 0 ? `${ZERO[label] || `sin cambio frente a ${label}`}${ref ? ` (${ref})` : ""}` : `${pct(p)} ${moreLess(p)} que ${label}${ref ? ` (${ref})` : ""}`);

const SPECIES_ES: Record<Species, string> = { pork: "cerdo", beef: "res", chicken: "pollo", turkey: "pavo", feed: "" };

// Certified Spanish terms only. Anything else is kept exactly as printed and reported as a gap.
const GLOSSARY: Record<string, string> = {
  "Hams, Total": "jamones (total)", "Bone-in": "con hueso", "Boneless": "sin hueso", "Total": "total",
  "Loins, Total": "lomos (total)", "Ribs": "costillas",
  "Breasts and Breast Meat": "pechugas", "Wings": "alas", "Whole Turkeys": "pavos enteros", "Turkey Breast": "pechuga de pavo",
};
function glossary(entity: string, gaps: string[]): string {
  const parts = entity.split(" / ").slice(1); // drop the group ("Frozen Pork" …), the species is stated separately
  return parts.map((p) => { if (GLOSSARY[p]) return GLOSSARY[p]; gaps.push(p); return p; }).join(" — ");
}

// USDA Hogs & Pigs labels — fixed, closed set. A label not listed here is HELD (sendable=false), never guessed.
const HOGS_ES: Record<string, string> = {
  "ALL HOGS AND PIGS": "total de cerdos y lechones", "KEPT FOR BREEDING": "cerdos para reproducción", "KEPT FOR MARKET": "cerdos para mercado",
  "180 Pounds and over": "cerdos para mercado de 180 lb o más", "120 - 179 Pounds": "cerdos para mercado de 120 a 179 lb", "50 - 119 Pounds": "cerdos para mercado de 50 a 119 lb", "Under 50 Pounds": "cerdos para mercado de menos de 50 lb",
  "SOW FARROWINGS": "partos de hembras", "PIG CROP": "lechones nacidos", "PIGS PER LITTER": "lechones por camada",
};
const PERIOD_ES: Record<string, string> = { "DEC - FEB": "dic.–feb.", "MAR - MAY": "mar.–may.", "DEC - MAY": "dic.–may.", "JUN - AUG": "jun.–ago.", "SEP - NOV": "sep.–nov.", "JUN - NOV": "jun.–nov." };
const MES_EN: Record<string, string> = { Jan: "enero", Feb: "febrero", Mar: "marzo", Apr: "abril", May: "mayo", Jun: "junio", Jul: "julio", Aug: "agosto", Sep: "septiembre", Oct: "octubre", Nov: "noviembre", Dec: "diciembre", August: "agosto" };

const CONTRACT_MES: Record<string, string> = { Sep: "sep.", Sept: "sep.", Oct: "oct.", Nov: "nov.", Dec: "dic.", Jan: "ene.", Feb: "feb.", Mar: "mar.", Apr: "abr.", May: "may.", Jun: "jun.", Jul: "jul.", Aug: "ago." };
const FUT_ES: Record<string, string> = { Corn: "maíz", Soybean: "soya", "Soybean Meal": "harina de soya", "Crude Oil": "petróleo WTI" };

// The ONE place a datum's Spanish name is built — used by the bullets below and by the trend bullets (compare.ts),
// so English words can never leak into one and not the other. `gaps` lists terms still uncertified.
export function labelEs(f: Fact): { text: string; gaps: string[] } | null {
  const v = f.values as Record<string, any>, gaps: string[] = [];
  switch (f.kind) {
    case "cut_price_weekly": return { text: "{{CUT}}", gaps };
    case "mx_pork_price": return { text: `${f.entity} en ${v.region}`, gaps };
    case "hog_price_us_mx": return { text: /^Mexico/.test(f.entity) ? "Cerdo vivo en México (peso vivo)" : "Cerdo en canal en EE.UU. (Iowa/Minnesota, peso en canal)", gaps };
    case "futures": {
      const [mo, yr] = String(v.contract).split(/\s+/);
      return { text: `Futuros de ${FUT_ES[v.commodity] || v.commodity}, contrato ${CONTRACT_MES[mo] || mo} ${yr}`, gaps };
    }
    case "cold_storage": { const what = glossary(f.entity, gaps); return { text: `Inventario en frío de ${SPECIES_ES[f.species]}${what ? ` — ${what}` : ""} en EE.UU.`, gaps }; }
  }
  return null;
}

const src = (f: Fact, bulletinDate: string) => `Boletín Steiner Consulting · datos al ${fmtDateY(bulletinDate)} · pág. ${f.page}`;

function base(f: Fact, bulletinDate: string, extra: Partial<Bullet> & Pick<Bullet, "text_es" | "levels">): Bullet {
  return {
    key: f.key, fact_keys: [f.key], kind: f.kind, species: f.species === "feed" ? null : f.species, market: f.market,
    product_entity: null, source_note: src(f, bulletinDate), page: f.page, computed: false, glossary_gaps: [], sendable: true, ...extra,
  };
}
const lv = (product: boolean, species: Species): Bullet["levels"] => [...(product ? ["product" as const] : []), ...(species !== "feed" ? ["protein" as const] : []), "market" as const];

export function buildBullets(facts: Fact[], bulletinDate: string): Bullet[] {
  const out: Bullet[] = [];
  const monthlyByCut = new Map<string, Fact[]>();
  for (const f of facts) if (f.kind === "cut_price_forecast_month") { const k = `${f.species}|${f.entity}`; monthlyByCut.set(k, [...(monthlyByCut.get(k) || []), f]); }

  for (const f of facts) {
    const v = f.values as Record<string, any>;
    switch (f.kind) {
      case "cut_price_weekly": {
        const wow = v.wow_pct as number | null;
        const t = `{{CUT}}, semana al ${fmtDate(v.week_end)}: US$${n(v.price)}/cwt — ${versus(v.yoy_pct, "hace un año", usd(v.yrago_price))}` +
          (wow != null ? `; ${versus(wow, "la semana anterior", usd(v.prev_price))}` : "") + ".";
        out.push(base(f, bulletinDate, { levels: lv(true, f.species), product_entity: f.entity, text_es: t, computed: wow != null }));
        break;
      }
      case "cut_price_forecast_week":
        out.push(base(f, bulletinDate, { levels: lv(true, f.species), product_entity: f.entity, text_es: `{{CUT}} — el boletín proyecta para la semana del ${fmtDate(v.for_week)}: US$${n(v.price)}/cwt (${versus(v.yoy_pct, "hace un año")}).` }));
        break;
      case "mx_pork_price": {
        const chg = v.change as number | null;
        const t = `${labelEs(f)!.text}, semana al ${fmtDate(v.week_end)}: US$${n(v.price)}/kg` +
          (chg != null && v.prev_price != null ? (chg === 0 ? `, sin cambio vs la semana anterior (US$${n(v.prev_price)})` : `, ${chg > 0 ? "sube" : "baja"} US$${n(Math.abs(chg))} vs la semana anterior (US$${n(v.prev_price)})`) : "") + " (SNIIM).";
        out.push(base(f, bulletinDate, { levels: ["product", "protein", "market"], product_entity: f.entity, text_es: t }));
        break;
      }
      case "prod_weekly": {
        const sp = SPECIES_ES[f.species], w = fmtDate(v.week_end);
        const mk = (label: string, col: string, unitEs: string, fmt: (x: number) => string) =>
          out.push(base(f, bulletinDate, {
            key: `${f.key}|${col}`, levels: lv(false, f.species),
            text_es: `${label} de ${sp} en EE.UU., semana al ${w}: ${fmt(v[col])} ${unitEs} — ${versus(v[`${col}_yoy_pct`], "hace un año")}; ${versus(v[`${col}_wow_pct`], "la semana anterior")}.`,
          }));
        mk("Producción semanal", "production", "millones de lb", (x) => n(x, 1));
        mk("Sacrificio semanal", "slaughter", v.slaughter_unit === "million head" ? "millones de cabezas" : "mil cabezas", nAuto);
        mk("Peso promedio en canal", "dressed_weight", "lb", (x) => n(x, 2));
        break;
      }
      case "prod_ytd":
        out.push(base(f, bulletinDate, { levels: lv(false, f.species), text_es: `Producción de ${SPECIES_ES[f.species]} en EE.UU. en lo que va del año (al ${fmtDate(v.through)}): ${n(v.production, 0)} millones de lb — ${versus(v.production_yoy_pct, "el mismo periodo del año pasado")}.` }));
        break;
      case "prod_forecast":
        out.push(base(f, bulletinDate, { levels: lv(false, f.species), text_es: `El boletín proyecta la producción de ${SPECIES_ES[f.species]} en EE.UU. para ${String(v.period).replace("Annual", "el año")}: ${n(v.production, 0)} millones de lb (${versus(v.yoy_pct, "el periodo equivalente del año anterior")}).` }));
        break;
      case "cold_storage": {
        const L = labelEs(f)!;
        out.push(base(f, bulletinDate, {
          levels: lv(false, f.species), glossary_gaps: L.gaps, sendable: L.gaps.length === 0,
          text_es: `${L.text} al ${fmtDate(v.as_of)}: ${n(v.stocks, 0)} mil lb (${v.pct_of_year_ago}% del nivel de hace un año; ${v.pct_of_prev_month}% del mes anterior).`,
        }));
        break;
      }
      case "hogs_pigs": {
        const [g, l] = f.entity.includes(" / ") ? f.entity.split(" / ") : ["", f.entity];
        const gaps: string[] = [];
        const lab = g ? `${HOGS_ES[g] || (gaps.push(g), g)}, ${PERIOD_ES[l] || (gaps.push(l), l)}` : (HOGS_ES[l] || (gaps.push(l), l));
        const unitEs = v.unit === "pigs per litter" ? "" : " mil cabezas";
        out.push(base(f, bulletinDate, {
          levels: lv(false, "pork"), glossary_gaps: gaps, sendable: gaps.length === 0,
          text_es: `Reporte trimestral de cerdos y lechones de EE.UU. al ${fmtDateY(v.report_date)} — ${lab}: ${nAuto(v.y2026)}${unitEs} (${n(v.pct_of_2025, 1)}% del nivel de 2025).`,
        }));
        break;
      }
      case "cattle_on_feed": {
        const e = f.entity;
        const what = /^Placed/.test(e) ? "Ganado ingresado a corrales de engorda" : /^Fed/.test(e) ? "Ganado comercializado desde corrales de engorda" : "Inventario de ganado en corrales de engorda";
        const whenRaw = e.replace(/^Placed on Feed During |^Fed Cattle Marketed in |^On Feed /, "");
        const when = whenRaw.replace(/^(\w+)( \d+)?$/, (_m, mo, d) => (d ? `${d.trim()} de ` : "") + (MES_EN[mo] || mo));
        out.push(base(f, bulletinDate, { levels: lv(false, "beef"), text_es: `${what} en EE.UU. (${/^On Feed/.test(e) ? "al " : "en "}${when}): ${n(v.y2026, 0)} mil cabezas — ${n(v.actual_pct_of_year_prior, 1)}% del año anterior; el promedio de estimados de analistas era ${n(v.analyst_estimate_pct, 1)}%.` }));
        break;
      }
      case "hog_price_us_mx": {
        out.push(base(f, bulletinDate, { levels: lv(false, "pork"), text_es: `${labelEs(f)!.text}, semana al ${fmtDate(v.week_end)}: US$${n(v.price)}/kg — ${versus(v.yoy_pct, "hace un año", usd(v.year_ago_price))}; semana anterior US$${n(v.prev_price)}/kg.` }));
        break;
      }
      case "futures": {
        out.push(base(f, bulletinDate, { levels: ["market"], species: null, text_es: `${labelEs(f)!.text}, cierre del ${fmtDate(v.week_end)}: ${n(v.price)} (semana anterior ${n(v.prev_price)}; hace un año ${n(v.year_ago_price)}).` }));
        break;
      }
      case "export_change": {
        const P: Record<string, string> = {
          pork_fresh_frozen_preserved: "carne de cerdo fresca, congelada y preservada", pork_variety_meats: "variety meats de cerdo",
          beef_and_veal: "carne de res y ternera", beef_variety_meats: "variety meats de res",
          chicken_fresh_frozen: "carne de pollo fresca y congelada", turkey: "pavo",
        };
        const dest = v.destination === "Mexico" ? "a México" : "a todos los destinos";
        const amount = v.measure === "value" ? `US$${Math.abs(v.change).toLocaleString("en-US")}` : `${Math.abs(v.change).toLocaleString("en-US")} toneladas métricas`;
        const dir = v.change > 0 ? "más" : "menos";
        out.push(base(f, bulletinDate, {
          levels: lv(false, f.species),
          text_es: v.change === 0 ? `Exportaciones de EE.UU. de ${P[v.product]} ${dest} en ${fmtMonth(v.month)}: sin cambio vs ${fmtMonth(v.vs_month)}.`
            : `Exportaciones de EE.UU. de ${P[v.product]} ${dest} en ${fmtMonth(v.month)}: ${amount} ${v.measure === "value" ? "de valor " : ""}${dir} que en ${fmtMonth(v.vs_month)}.`,
        }));
        break;
      }
    }
  }

  // one bullet per cut for the month-by-month forecast (first three months, each with its own printed %)
  for (const [, arr] of monthlyByCut) {
    const f0 = arr[0];
    const items = arr.map((m) => { const v = m.values as Record<string, any>; const mm = +String(v.month).slice(5); return `${MES_LARGO[mm - 1]} US$${n(v.price)} (${versus(v.yoy_pct, "hace un año")})`; });
    out.push({
      key: `${f0.kind}|${f0.species}|${f0.entity}`, fact_keys: arr.map((a) => a.key), kind: "cut_price_forecast_month", levels: lv(true, f0.species), species: f0.species, market: "US",
      product_entity: f0.entity, text_es: `{{CUT}} — el boletín proyecta (US$/cwt): ${items.join("; ")}.`, source_note: src(f0, bulletinDate), page: f0.page, computed: false, glossary_gaps: [], sendable: true,
    });
  }
  return out;
}

// Narrative sentences: always attributed and quoted — the first-person "we think…" of the bulletin must never
// read as BUENTRADE's own opinion. Product level is intentionally not assigned (no guessing which catalog
// item a phrase like "hams and picnics" means).
export function narrativeBullets(claims: NarrativeClaim[], bulletinDate: string): Bullet[] {
  const hash = (t: string) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return Math.abs(h).toString(36); };
  return claims.map((c) => ({
    key: `narrative|${c.species}|${hash(c.quote_en)}`, fact_keys: [], kind: c.stance === "forward_looking" ? "narrative_view" : "narrative_observed",
    levels: ["protein", "market"] as Bullet["levels"], species: c.species, market: "US" as Market, product_entity: null,
    text_es: `Según el boletín de Steiner Consulting: «${c.text_es.trim()}»`,
    source_note: `Boletín Steiner Consulting · datos al ${fmtDateY(bulletinDate)} · pág. ${c.page ?? 2}`, page: c.page ?? 2,
    computed: false, glossary_gaps: [], sendable: true, quote_en: c.quote_en,
  }));
}
