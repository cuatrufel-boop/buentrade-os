// Trend vs the PREVIOUS bulletin: the same datum (same key, same unit) read from two editions, compared by
// plain arithmetic. No previous value of the same datum → no trend bullet (nothing is estimated). The gap
// between the two editions must fit the series' cadence, so a missed edition can't be passed off as
// "the previous one".
import { labelEs } from "./bullets.ts";
import type { Bullet } from "./bullets.ts";
import type { Fact } from "./types.ts";

interface Series { kind: string; metric: string; unit: (v: Record<string, any>) => string; minDays: number; maxDays: number }
const SERIES: Series[] = [
  { kind: "cut_price_weekly", metric: "price", unit: (v) => v.unit, minDays: 10, maxDays: 21 },
  { kind: "mx_pork_price", metric: "price", unit: (v) => v.unit, minDays: 10, maxDays: 21 },
  { kind: "hog_price_us_mx", metric: "price", unit: (v) => v.unit, minDays: 10, maxDays: 21 },
  { kind: "futures", metric: "price", unit: () => "as printed", minDays: 10, maxDays: 21 },
  { kind: "cold_storage", metric: "stocks", unit: (v) => v.unit, minDays: 25, maxDays: 40 },
];
const MES = ["ene.", "feb.", "mar.", "abr.", "may.", "jun.", "jul.", "ago.", "sep.", "oct.", "nov.", "dic."];
const fd = (iso: string) => { const [, m, d] = iso.split("-").map(Number); return `${d} ${MES[m - 1]}`; };
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const dateOf = (f: Fact) => String((f.values as any).week_end ?? (f.values as any).as_of ?? "");

export function trendBullets(current: Fact[], previous: Fact[], sourceNote: (f: Fact) => string): Bullet[] {
  const prevByKey = new Map(previous.map((f) => [f.key, f]));
  const out: Bullet[] = [];
  for (const f of current) {
    const S = SERIES.find((s) => s.kind === f.kind);
    if (!S) continue;
    const p = prevByKey.get(f.key);
    if (!p) continue;
    const cv = f.values as Record<string, any>, pv = p.values as Record<string, any>;
    const cd = dateOf(f), pd = dateOf(p);
    if (!cd || !pd || S.unit(cv) !== S.unit(pv)) continue;
    const gap = days(pd, cd);
    if (gap < S.minDays || gap > S.maxDays) continue;
    const c = Number(cv[S.metric]), q = Number(pv[S.metric]);
    if (!isFinite(c) || !isFinite(q) || q === 0) continue;
    const change = Math.round((c / q - 1) * 1000) / 10;
    const word = change === 0 ? "sin cambio" : `${Number.isInteger(change) ? Math.abs(change) : Math.abs(change).toFixed(1)}% ${change > 0 ? "más" : "menos"}`;
    const L = labelEs(f)!;
        out.push({
      key: `trend|${f.key}`, fact_keys: [f.key, p.key], kind: "trend_vs_previous", levels: [...(["cut_price_weekly", "mx_pork_price", "cold_storage"].includes(f.kind) ? ["product" as const] : []), ...(f.species !== "feed" ? ["protein" as const] : []), "market" as const],
      species: f.species === "feed" ? null : f.species, market: f.market, product_entity: ["cut_price_weekly", "mx_pork_price", "cold_storage"].includes(f.kind) ? f.entity : null,
      text_es: `${L.text}: ${word} que en el boletín anterior (${fd(pd)}).`,
      source_note: `${sourceNote(f)} · comparado con la edición anterior`, page: f.page, computed: true, 
    });
  }
  return out;
}
