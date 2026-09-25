// "Weekly <species> Production Statistics" tables (pork, beef, broiler, turkey — USDA via Steiner).
// Structure is fixed: Year Ago / This-or-Last Week (vs year ago) / prior week / This-or-Last Week (vs prior week),
// then YTD pair, then a quarterly history+forecast grid. Every printed "% CH." is recomputed from the
// table's own numbers; if it doesn't match (the bulletin itself has typos, e.g. a 182.2% weight change in
// the turkey Annual row) the figure is DROPPED and reported — never repeated to a customer.
import type { ExtractResult, Fact, Species } from "./types.ts";

const NUM = /-?\d[\d,]*\.?\d*%?/g;
const toNum = (s: string) => parseFloat(s.replace(/[,%]/g, ""));
const MON: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const dmy = (s: string) => { const m = s.match(/(\d{1,2})-([A-Za-z]{3})-(\d{2})/); return m ? `20${m[3]}-${String(MON[m[2]]).padStart(2, "0")}-${m[1].padStart(2, "0")}` : null; };

const TABLES: Array<{ re: RegExp; species: Species; label: string }> = [
  { re: /Weekly Pork Production Statistics/i, species: "pork", label: "cerdo" },
  { re: /Weekly Beef Production Statistics/i, species: "beef", label: "res" },
  { re: /Weekly Broiler Production Statistics/i, species: "chicken", label: "pollo" },
  { re: /Weekly Turkey Production Statistics/i, species: "turkey", label: "pavo" },
];

// a data row: label, optional date, then numbers
function parseRow(line: string) {
  const m = line.match(/^\s*(Year Ago|This Week|Last Week|Prev\. Week|YTD Last Year|YTD This Year)\s+(\d{1,2}-[A-Za-z]{3}-\d{2})\s+(.*)$/);
  if (!m) return null;
  const nums = (m[3].match(NUM) || []).map(toNum);
  return { label: m[1], date: dmy(m[2]), nums, line: line.trim().replace(/\s{2,}/g, "  ") };
}

export function extractProduction(pages: string[]): ExtractResult {
  const facts: Fact[] = [];
  const dropped: ExtractResult["dropped"] = [];
  pages.forEach((pageText, pi) => {
    const page = pi + 1;
    const lines = pageText.split("\n");
    for (const T of TABLES) {
      const hi = lines.findIndex((l) => T.re.test(l));
      if (hi < 0) continue;
      const drop = (entity: string, reason: string) => dropped.push({ kind: "production", entity: `${T.species}: ${entity}`, page, reason });
      const head = lines.slice(hi, hi + 6).join(" ");
      const slUnit = /\(million hd\)/i.test(head) ? "million head" : /\(1000 hd\)/i.test(head) ? "thousand head" : null;
      const rowsAll = lines.slice(hi, hi + 14).map(parseRow).filter((r): r is NonNullable<ReturnType<typeof parseRow>> => !!r);
      const [ya, tw, pw, tw2, ytdLy, ytdTy] = rowsAll;
      if (!ya || !tw || !pw || !tw2 || ya.label !== "Year Ago" || ya.nums.length !== 3 || tw.nums.length !== 6 || pw.nums.length !== 3 || tw2.nums.length !== 6) {
        drop("weekly block", "row structure not as expected"); continue;
      }
      if (tw.date !== tw2.date) { drop("weekly block", "the two 'this week' rows carry different dates"); continue; }
      const cols = ["slaughter", "dressed_weight", "production"] as const;
      const units = { slaughter: slUnit, dressed_weight: "lb", production: "million lb" } as Record<string, string | null>;
      const chk = (cur: number, base: number, printed: number) => Math.abs((cur / base - 1) * 100 - printed) <= 0.15;
      const values: Record<string, number | string | null> = { week_end: tw.date, year_ago_week_end: ya.date, prev_week_end: pw.date };
      let ok = true;
      cols.forEach((c, i) => {
        const cur = tw.nums[i * 2], yoy = tw.nums[i * 2 + 1], cur2 = tw2.nums[i * 2], wow = tw2.nums[i * 2 + 1];
        if (cur !== cur2) { ok = false; drop(c, "value differs between the two 'this week' rows"); return; }
        if (!chk(cur, ya.nums[i], yoy)) { ok = false; drop(c, `printed ${yoy}% vs year ago but numbers give ${((cur / ya.nums[i] - 1) * 100).toFixed(1)}%`); return; }
        if (!chk(cur, pw.nums[i], wow)) { ok = false; drop(c, `printed ${wow}% vs prior week but numbers give ${((cur / pw.nums[i] - 1) * 100).toFixed(1)}%`); return; }
        values[c] = cur; values[`${c}_yoy_pct`] = yoy; values[`${c}_wow_pct`] = wow; values[`${c}_unit`] = units[c];
        values[`${c}_year_ago`] = ya.nums[i]; values[`${c}_prev_week`] = pw.nums[i];
      });
      if (ok) {
        facts.push({
          key: `prod_weekly|${T.species}`, kind: "prod_weekly", species: T.species, market: "US", entity: `Weekly ${T.species} production`,
          page, source: [ya.line, tw.line, pw.line, tw2.line].join(" | "), values, method: "parser",
        });
      }
      // YTD
      if (ytdLy && ytdTy && ytdLy.label === "YTD Last Year" && ytdTy.label === "YTD This Year" && ytdLy.nums.length === 3 && ytdTy.nums.length === 6) {
        const v: Record<string, number | string | null> = { through: ytdTy.date, last_year_through: ytdLy.date };
        let yok = true;
        cols.forEach((c, i) => {
          const cur = ytdTy.nums[i * 2], pct = ytdTy.nums[i * 2 + 1];
          if (!chk(cur, ytdLy.nums[i], pct)) { yok = false; drop(`YTD ${c}`, `printed ${pct}% but numbers give ${((cur / ytdLy.nums[i] - 1) * 100).toFixed(1)}%`); return; }
          v[c] = cur; v[`${c}_yoy_pct`] = pct; v[`${c}_unit`] = units[c]; v[`${c}_last_year`] = ytdLy.nums[i];
        });
        if (yok) facts.push({ key: `prod_ytd|${T.species}`, kind: "prod_ytd", species: T.species, market: "US", entity: `${T.species} production year-to-date`, page, source: `${ytdLy.line} | ${ytdTy.line}`, values: v, method: "parser" });
      }
      // Quarterly grid: only the production column, only periods that end AFTER the last actual week (a forecast by date)
      const qStart = lines.findIndex((l, i) => i > hi && /Quarterly History/i.test(l));
      if (qStart >= 0 && tw.date) {
        const asOf = tw.date;
        let year = 0;
        const prodByKey: Record<string, number> = {};
        const rowsQ: Array<{ label: string; year: number; nums: number[]; line: string }> = [];
        for (const l of lines.slice(qStart + 1, qStart + 32)) {
          const m = l.match(/^\s*(Q[1-4]|Annual)\s*(\d{4})?\s+(.*)$/);
          if (!m) continue;
          if (m[2]) year = +m[2];
          const nums = (m[3].replace(/Y\/Y % CH\./g, "").match(NUM) || []).map(toNum);
          rowsQ.push({ label: m[1], year, nums, line: l.trim().replace(/\s{2,}/g, "  ") });
        }
        // Annual rows carry no year of their own: they take the year of the quarters above them
        for (const r of rowsQ) prodByKey[`${r.label}|${r.year}`] = r.nums[r.nums.length >= 6 ? 4 : 2];
        for (const r of rowsQ) {
          if (r.year < +asOf.slice(0, 4) || r.nums.length !== 6) continue;
          const isAnnual = r.label === "Annual";
          const qEnd = isAnnual ? `${r.year}-12-31` : `${r.year}-${String(+r.label[1] * 3).padStart(2, "0")}-30`;
          if (qEnd <= asOf) continue; // already completed → not a forecast
          const prod = r.nums[4], pct = r.nums[5];
          const prior = prodByKey[`${r.label}|${r.year - 1}`];
          if (prior == null || !chk(prod, prior, pct)) { drop(`${r.label} ${r.year} production`, `printed ${pct}% but numbers give ${prior ? ((prod / prior - 1) * 100).toFixed(1) : "n/a"}%`); continue; }
          facts.push({
            key: `prod_forecast|${T.species}|${r.label}|${r.year}`, kind: "prod_forecast", species: T.species, market: "US",
            entity: `${T.species} production ${r.label} ${r.year}`, page, source: r.line,
            values: { period: `${r.label} ${r.year}`, production: prod, production_unit: "million lb", yoy_pct: pct, prior_period_production: prior },
            method: "parser",
          });
        }
      }
    }
  });
  return { facts, dropped };
}
