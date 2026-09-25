// Fixed-layout tables of the bulletin: cold storage, hogs & pigs, cattle on feed, world hog prices, futures.
// Same rule as everywhere in this pipeline: read the numbers by row, recompute every printed % / change
// from the table's own numbers, and DROP (with a reason) anything that doesn't reconcile.
import type { ExtractResult, Fact } from "./types.ts";

const MON: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const num = (s: string) => parseFloat(s.replace(/[,%]/g, ""));
const dmy = (s: string) => { const m = s.match(/(\d{1,2})-([A-Za-z]{3})-(\d{2})/); return m ? `20${m[3]}-${String(MON[m[2]]).padStart(2, "0")}-${m[1].padStart(2, "0")}` : null; };
const clean = (l: string) => l.trim().replace(/\s{2,}/g, "  ");

// ---------- Cold storage (USDA Stocks in Cold Storage) ----------
export function extractColdStorage(pages: string[]): ExtractResult {
  const facts: Fact[] = [], dropped: ExtractResult["dropped"] = [];
  pages.forEach((pt, pi) => {
    const lines = pt.split("\n");
    const hi = lines.findIndex((l) => /USDA STOCKS IN COLD STORAGE REPORT/.test(l));
    if (hi < 0) return;
    const page = pi + 1;
    const dl = lines.slice(hi, hi + 6).find((l) => /\d{1,2}-[A-Za-z]{3}-\d{2}\s+\d{1,2}-[A-Za-z]{3}-\d{2}\s+\d{1,2}-[A-Za-z]{3}-\d{2}/.test(l));
    const dates = dl ? (dl.match(/\d{1,2}-[A-Za-z]{3}-\d{2}/g) || []).map((d) => dmy(d)) : [];
    if (dates.length !== 3) { dropped.push({ kind: "cold_storage", entity: "table", page, reason: "column dates not found" }); return; }
    let group = "", parent = "";
    let seenData = false;
    for (let i = hi + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/Cold Storage Inventories/.test(l) && seenData) break;
      if (!l.trim()) continue; // a blank line does NOT end a group (Turkey's "Total" follows a blank line)
      if (/COMMODITY|Stocks in All|Percent Of|1,000 Pounds|\d{1,2}-[A-Za-z]{3}-\d{2}/.test(l)) continue;
      const indent = l.length - l.trimStart().length;
      const m = l.trim().match(/^([A-Za-z][A-Za-z ,&\-]*?)\s+(\d[\d,]*)\s+(\d[\d,]*)\s+(\d[\d,]*)\s+(\d+)\s+(\d+)$/);
      if (!m) {
        const t = l.trim();
        if (/^[A-Za-z][A-Za-z ]+$/.test(t)) { group = t; parent = ""; }
        continue;
      }
      seenData = true;
      const label = m[1].trim();
      const [ya, pv, cur] = [num(m[2]), num(m[3]), num(m[4])];
      const [p1, p2] = [num(m[5]), num(m[6])];
      // standalone lines that are not part of the group above them
      if (/^(Ducks|Total Poultry|Total Red Meat)$/.test(label)) { group = label; parent = ""; }
      const top = indent <= 10;
      if (top) parent = /,\s*Total$|Total$/.test(label) && label !== "Total" ? label : "";
      const entity = [group, !top && parent ? parent : "", label].filter(Boolean).join(" / ");
      const drop = (r: string) => dropped.push({ kind: "cold_storage", entity, page, reason: r });
      if (Math.abs((cur / ya) * 100 - p1) > 1.01) { drop(`printed ${p1}% of ${dates[0]} but numbers give ${((cur / ya) * 100).toFixed(1)}%`); continue; }
      if (Math.abs((cur / pv) * 100 - p2) > 1.01) { drop(`printed ${p2}% of ${dates[1]} but numbers give ${((cur / pv) * 100).toFixed(1)}%`); continue; }
      const sp = /Pork/i.test(group) ? "pork" : /Beef/i.test(group) ? "beef" : /Chicken/i.test(group) ? "chicken" : /Turkey/i.test(group) ? "turkey" : null;
      if (!sp) { dropped.push({ kind: "cold_storage", entity, page, reason: "out of scope: not pork/beef/chicken/turkey (veal, lamb, ducks, totals)" }); continue; }
      facts.push({
        key: `cold_storage|${entity}`, kind: "cold_storage", species: sp, market: "US", entity, page, source: clean(l), method: "parser",
        values: { as_of: dates[2], unit: "1,000 lb", stocks: cur, year_ago_date: dates[0], year_ago_stocks: ya, prev_month_date: dates[1], prev_month_stocks: pv, pct_of_year_ago: p1, pct_of_prev_month: p2 },
      });
    }
  });
  return { facts, dropped };
}

// ---------- Hogs & Pigs quarterly report ----------
export function extractHogsAndPigs(pages: string[]): ExtractResult {
  const facts: Fact[] = [], dropped: ExtractResult["dropped"] = [];
  pages.forEach((pt, pi) => {
    const lines = pt.split("\n");
    const hi = lines.findIndex((l) => /USDA HOGS AND PIGS REPORT:/.test(l));
    if (hi < 0) return;
    const page = pi + 1;
    const dm = lines[hi].match(/REPORT:\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
    if (!dm) { dropped.push({ kind: "hogs_pigs", entity: "table", page, reason: "report date not found" }); return; }
    const asOf = `${dm[3]}-${String(({ January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 } as Record<string, number>)[dm[1]] || 0).padStart(2, "0")}-${dm[2].padStart(2, "0")}`;
    let group = "";
    for (let i = hi + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/Quarterly Hog Report Update/.test(l)) break;
      const t = l.trim();
      if (!t || /^CATEGORY|Urner Barry|ANALYST|USDA\s+$|Range/.test(t)) continue;
      if (/^(SOW FARROWINGS|PIG CROP|PIGS PER LITTER)$/.test(t)) { group = t; continue; }
      const m = t.match(/^([A-Za-z0-9][A-Za-z0-9 \-+,]*?)\s+(\d[\d,.]*)\s+(\d[\d,.]*)\s+(\d[\d,.]*)\s+([\d.]+)%\s+([\d.]+)%/);
      if (!m) continue;
      const label = m[1].trim().replace(/\s+\d$/, "");
      const entity = [group, label].filter(Boolean).join(" / ");
      const [v24, v25, v26, p24, p25] = [num(m[2]), num(m[3]), num(m[4]), num(m[5]), num(m[6])];
      const drop = (r: string) => dropped.push({ kind: "hogs_pigs", entity, page, reason: r });
      if (Math.abs((v26 / v25) * 100 - p25) > 0.15) { drop(`printed ${p25}% of 2025 but numbers give ${((v26 / v25) * 100).toFixed(1)}%`); continue; }
      if (Math.abs((v26 / v24) * 100 - p24) > 0.15) { drop(`printed ${p24}% of 2024 but numbers give ${((v26 / v24) * 100).toFixed(1)}%`); continue; }
      const unit = group === "PIGS PER LITTER" ? "pigs per litter" : "thousand head";
      facts.push({ key: `hogs_pigs|${entity}`, kind: "hogs_pigs", species: "pork", market: "US", entity, page, source: clean(l), method: "parser", values: { report_date: asOf, unit, y2026: v26, y2025: v25, y2024: v24, pct_of_2025: p25, pct_of_2024: p24 } });
    }
  });
  return { facts, dropped };
}

// ---------- Cattle on Feed ----------
export function extractCattleOnFeed(pages: string[]): ExtractResult {
  const facts: Fact[] = [], dropped: ExtractResult["dropped"] = [];
  pages.forEach((pt, pi) => {
    const lines = pt.split("\n");
    if (!lines.some((l) => /^Cattle on Feed\s*$/.test(l.trim()))) return;
    const page = pi + 1;
    for (const l of lines) {
      const m = l.match(/^(Placed on Feed During \w+|Fed Cattle Marketed in \w+|On Feed \w+ \d+)\s+(\d[\d,]*)\s+(\d[\d,]*)\s+(\d[\d,]*)\s+([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)/);
      if (!m) continue;
      const [v24, v25, v26, act, est, diff] = [num(m[2]), num(m[3]), num(m[4]), num(m[5]), num(m[6]), num(m[7])];
      const drop = (r: string) => dropped.push({ kind: "cattle_on_feed", entity: m[1], page, reason: r });
      if (Math.abs((v26 / v25) * 100 - act) > 0.15) { drop(`printed ${act}% but numbers give ${((v26 / v25) * 100).toFixed(1)}%`); continue; }
      if (Math.abs(act - est - diff) > 0.15) { drop(`difference ${diff} ≠ actual ${act} − estimate ${est}`); continue; }
      facts.push({ key: `cattle_on_feed|${m[1]}`, kind: "cattle_on_feed", species: "beef", market: "US", entity: m[1], page, source: clean(l), method: "parser", values: { unit: "thousand head", y2026: v26, y2025: v25, y2024: v24, actual_pct_of_year_prior: act, analyst_estimate_pct: est, vs_estimate_pts: diff } });
    }
  });
  return { facts, dropped };
}

// ---------- World hog prices (only the US and Mexico rows are in scope) ----------
export function extractWorldHogPrices(pages: string[]): ExtractResult {
  const facts: Fact[] = [], dropped: ExtractResult["dropped"] = [];
  pages.forEach((pt, pi) => {
    const lines = pt.split("\n");
    const hi = lines.findIndex((l) => /World Hog Prices/.test(l));
    if (hi < 0) return;
    const page = pi + 1;
    const dl = lines.slice(hi, hi + 8).find((l) => /\d{1,2}-[A-Za-z]{3}-\d{2}\s+\d{1,2}-[A-Za-z]{3}-\d{2}\s+\d{1,2}-[A-Za-z]{3}-\d{2}/.test(l));
    const dates = dl ? (dl.match(/\d{1,2}-[A-Za-z]{3}-\d{2}/g) || []).map((d) => dmy(d)) : [];
    if (dates.length !== 3) { dropped.push({ kind: "world_hog_price", entity: "table", page, reason: "column dates not found" }); return; }
    for (const l of lines.slice(hi + 1)) {
      const m = l.match(/^\s*(.+?)\s+\(US\$\/kg\)\s+(carcass wt\.|liveweight)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+[56]\s+(-?\d+)%/);
      if (!m) continue;
      const label = m[1].trim();
      const drop = (r: string) => dropped.push({ kind: "world_hog_price", entity: label, page, reason: r });
      if (!/^(US Lean Hog Carcass|Mexico Live Pigs)/.test(label)) { drop("out of scope: only US and Mexico are used"); continue; }
      const [cur, prev, ya, pct] = [num(m[3]), num(m[4]), num(m[5]), num(m[6])];
      if (Math.abs((cur / ya - 1) * 100 - pct) > 1.01) { drop(`printed ${pct}% but numbers give ${((cur / ya - 1) * 100).toFixed(1)}%`); continue; }
      facts.push({
        key: `world_hog_price|${label}`, kind: "hog_price_us_mx", species: "pork", market: /^Mexico/.test(label) ? "MX" : "US", entity: label, page, source: clean(l), method: "parser",
        values: { basis: m[2], unit: "USD/kg", week_end: dates[0], price: cur, prev_week_end: dates[1], prev_price: prev, year_ago_date: dates[2], year_ago_price: ya, yoy_pct: pct },
      });
    }
  });
  return { facts, dropped };
}

// ---------- Commodity futures (corn / soybeans / soybean meal / WTI crude) ----------
// The bulletin's own unit labels for these charts contradict each other ("$/bu." vs "$/ton" for corn), so NO
// unit is asserted for them — numbers are published exactly as printed.
export function extractFutures(pages: string[]): ExtractResult {
  const facts: Fact[] = [], dropped: ExtractResult["dropped"] = [];
  pages.forEach((pt, pi) => {
    const lines = pt.split("\n");
    const page = pi + 1;
    let commodity = "";
    let dates: (string | null)[] = [];
    for (const l of lines) {
      const left = l.slice(0, 78);
      const dl = left.match(/(\d{1,2}-[A-Za-z]{3}-\d{2})\s+(\d{1,2}-[A-Za-z]{3}-\d{2})\s+(\d{1,2}-[A-Za-z]{3}-\d{2})/);
      if (dl) dates = [dmy(dl[1]), dmy(dl[2]), dmy(dl[3])];
      const hm = left.match(/^\s*(Corn|Soybean Meal|Soybean|Crude Oil)\s+Futures/);
      if (hm) { commodity = hm[1]; continue; }
      const m = left.match(/^\s*((?:Sept?|Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug)\s+'?\d{2})\s+([\d.]+)\s+([\d.]+)\s+[56]\s+(-?[\d.]+)\s+([\d.]+)\s+[56]\s+(-?[\d.]+)/);
      if (!m || !commodity || dates.length !== 3) continue;
      const [cur, prev, chg, ly, lchg] = [num(m[2]), num(m[3]), num(m[4]), num(m[5]), num(m[6])];
      const entity = `${commodity} ${m[1]}`;
      const drop = (r: string) => dropped.push({ kind: "futures", entity, page, reason: r });
      if (Math.abs(cur - prev - chg) > 0.02) { drop(`change ${chg} ≠ ${cur} − ${prev}`); continue; }
      if (Math.abs(cur - ly - lchg) > 0.02) { drop(`change vs last year ${lchg} ≠ ${cur} − ${ly}`); continue; }
      facts.push({
        key: `futures|${entity}`, kind: "futures", species: "feed", market: "US", entity, page, source: clean(l.slice(0, 78)), method: "parser",
        values: { commodity, contract: m[1], week_end: dates[0], price: cur, prev_week_end: dates[1], prev_price: prev, change: chg, year_ago_date: dates[2], year_ago_price: ly, change_vs_year_ago: lchg },
      });
    }
  });
  return { facts, dropped };
}
