// Per-cut wholesale price charts ("YEAR OVER YEAR PRICE COMPARISON AND FORECAST", $/cwt).
// Deterministic: every value is read from a table row of the bulletin and must pass three checks
// that come from the bulletin itself, so a mis-read column or row is DROPPED, never guessed:
//   1. the printed "% CH." must equal the recomputed change between the row's two numbers,
//   2. an actual-vs-forecast reading from column position must agree with the row's date,
//   3. the row for the chart's own caption date ("Sep 4, 2026 = 72.66") must carry that same value.
import type { ExtractResult, Fact, Species } from "./types.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_RE = MONTHS.join("|");
const ROW_RE = new RegExp(`(?:^|\\s)(\\d{1,2}-(?:${MONTH_RE})|(?:${MONTH_RE}))\\s+((?:\\d[\\d,]*\\.\\d+\\s+)+)(-?\\d+\\.\\d+)%\\s*$`);
const ANCHOR_RE = /(?:wk\.\s*end\.\s*)?([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})\s*=\s*([\d,.]+)/;
// A chart title is the nearest non-blank line above its "$/cwt YEAR OVER YEAR…" line, starting at the
// left margin (col ≤ 2) with letters — titles vary in wording ("Ham, …, FOB Plant, USDA",
// "USDA, 50CL BEEF TRIM, …", "NE BONELESS BREAST …"), so shape is checked, not a keyword.
const TITLE_RE = /^ {0,2}[A-Za-z].{8,}/;
const NOT_TITLE_RE = /^\s*(?:\$\/cwt|Source:|\d{4}-\d{2}|5 YR\. MONTHLY|Jan\s+Feb|YEAR OVER YEAR|-\s*DOLLARS)/;
const SPECIES_MARKERS: Array<[RegExp, Species]> = [
  [/^Weekly Pork Production Statistics/i, "pork"],
  [/^WEEKLY STEER AND HEIFER SLAUGHTER/i, "beef"],
  [/^Weekly Broiler Production Statistics/i, "chicken"],
  [/^Weekly Turkey Production Statistics/i, "turkey"],
];

const num = (s: string) => parseFloat(s.replace(/,/g, ""));
const monthIdx = (m: string) => MONTHS.indexOf(m.slice(0, 3).replace(/^./, (c) => c.toUpperCase()));
const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

interface Row {
  label: string;
  weekly: boolean;
  nums: number[];
  pct: number;
  gap: number;
  line: string;
}

export function extractPriceCharts(pages: string[]): ExtractResult {
  const facts: Fact[] = [];
  const dropped: ExtractResult["dropped"] = [];

  // Flatten to lines keeping the page number and the running species marker.
  const flat: Array<{ text: string; page: number; species: Species | null }> = [];
  let species: Species | null = null;
  pages.forEach((p, pi) => {
    for (const text of p.split("\n")) {
      for (const [re, sp] of SPECIES_MARKERS) if (re.test(text.trim())) species = sp;
      flat.push({ text, page: pi + 1, species });
    }
  });

  const yoyIdx: number[] = [];
  flat.forEach((l, i) => { if (/YEAR OVER YEAR PRICE COMPARISON AND FORECAST/.test(l.text)) yoyIdx.push(i); });

  yoyIdx.forEach((yi, n) => {
    // title = nearest previous title-looking line (chart title precedes its own "$/cwt YEAR OVER YEAR" line)
    let title = "";
    for (let k = yi - 1; k >= Math.max(0, yi - 4); k--) {
      const t = flat[k].text;
      if (!t.trim()) continue;
      if (TITLE_RE.test(t) && !NOT_TITLE_RE.test(t)) title = t.replace(/\s*Page\s*\d*\s*$/, "").trim();
      break; // only the nearest non-blank line can be the title
    }
    const end = n + 1 < yoyIdx.length ? yoyIdx[n + 1] - 4 : Math.min(flat.length, yi + 50);
    const block = flat.slice(yi, end);
    const page = flat[yi].page;
    const sp = flat[yi].species;
    const drop = (reason: string) => dropped.push({ kind: "cut_price", entity: title || `(untitled chart #${n + 1})`, page, reason });
    if (!title) return drop("chart title not found");
    if (!sp) return drop("species section not identified");

    let anchor: { y: number; m: number; d: number; value: number } | null = null;
    for (let bi = 0; bi < block.length; bi++) {
      // the caption is sometimes wrapped ("wk. end. Sep 4, 2026 =" / "1,468.45") — join with the next line
      const am = (block[bi].text + " " + (block[bi + 1] ? block[bi + 1].text.trim() : "")).match(ANCHOR_RE);
      if (am && monthIdx(am[1]) >= 0) { anchor = { y: +am[3], m: monthIdx(am[1]), d: +am[2], value: num(am[4]) }; break; }
    }
    if (!anchor) return drop("caption (e.g. 'Sep 4, 2026 = 72.66') not found");

    const rows: Row[] = [];
    for (const l of block) {
      const m = l.text.match(ROW_RE);
      if (!m) continue;
      const nums = (m[2].match(/\d[\d,]*\.\d+/g) || []).map(num);
      const gap = (m[2].match(/\s*$/) || [""])[0].length;
      rows.push({ label: m[1], weekly: m[1].includes("-"), nums, pct: parseFloat(m[3]), gap, line: l.text.trim().replace(/\s{2,}/g, "  ") });
    }

    // date of each row
    const anchorDate = Date.UTC(anchor.y, anchor.m, anchor.d);
    const anchorLabel = `${anchor.d}-${MONTHS[anchor.m]}`;
    let prevMonth = -1;
    let monthYear = anchor.y;
    // first monthly row's year: rows begin months before the caption month
    const firstMonthly = rows.find((r) => !r.weekly);
    if (firstMonthly && monthIdx(firstMonthly.label) > anchor.m) monthYear = anchor.y - 1;

    const parsed: Array<Row & { role: "actual" | "forecast"; yrAgo: number; value: number; avg5: number | null; dateIso: string }> = [];
    for (const r of rows) {
      let role: "actual" | "forecast";
      let dateIso: string;
      if (r.weekly) {
        const [d, mo] = r.label.split("-");
        const t = Date.UTC(anchor.y, monthIdx(mo), +d);
        role = t <= anchorDate ? "actual" : "forecast";
        dateIso = iso(anchor.y, monthIdx(mo), +d);
      } else {
        const mi = monthIdx(r.label);
        if (prevMonth !== -1 && mi < prevMonth) monthYear++;
        prevMonth = mi;
        role = Date.UTC(monthYear, mi, 1) < Date.UTC(anchor.y, anchor.m, 1) ? "actual" : "forecast";
        dateIso = iso(monthYear, mi, 1);
      }
      // column-position reading: an actual value sits under CURRENT (wide gap before "% CH."),
      // a forecast under FORECAST (right next to it) — must agree with the date reading.
      const gapRole: "actual" | "forecast" = r.gap >= 8 ? "actual" : "forecast";
      // weekly rows: [year-ago, value]; monthly rows: [5-yr avg, year-ago, value] (some charts have no 5-yr avg)
      if (r.nums.length < 2 || r.nums.length > (r.weekly ? 2 : 3)) { drop(`row ${r.label}: unexpected number count ${r.nums.length}`); continue; }
      if (gapRole !== role) { drop(`row ${r.label}: column position (${gapRole}) disagrees with its date (${role})`); continue; }
      const value = r.nums[r.nums.length - 1];
      const yrAgo = r.nums[r.nums.length - 2];
      const recomputed = (value / yrAgo - 1) * 100;
      if (Math.abs(recomputed - r.pct) > 0.15) { drop(`row ${r.label}: printed ${r.pct}% but numbers give ${recomputed.toFixed(1)}%`); continue; }
      parsed.push({ ...r, role, yrAgo, value, avg5: r.weekly || r.nums.length < 3 ? null : r.nums[0], dateIso });
    }

    const cur = parsed.find((r) => r.weekly && r.role === "actual" && r.label === anchorLabel);
    if (!cur) return drop(`weekly row for the caption date ${anchorLabel} not found`);
    if (Math.abs(cur.value - anchor.value) > 0.005) return drop(`caption says ${anchor.value} but the ${anchorLabel} row says ${cur.value}`);

    const base = { species: sp, market: "US" as const, entity: title, page, method: "parser" as const };
    const prevWk = [...parsed].filter((r) => r.weekly && r.role === "actual" && r.dateIso < cur.dateIso).pop();
    facts.push({
      ...base,
      key: `cut_price_weekly|${sp}|${title}`,
      kind: "cut_price_weekly",
      source: cur.line,
      values: {
        price: cur.value, unit: "USD/cwt", week_end: cur.dateIso,
        yrago_price: cur.yrAgo, yoy_pct: cur.pct,
        prev_price: prevWk ? prevWk.value : null, prev_week_end: prevWk ? prevWk.dateIso : null,
        wow_pct: prevWk ? Math.round((cur.value / prevWk.value - 1) * 1000) / 10 : null,
      },
    });
    const fcWk = parsed.find((r) => r.weekly && r.role === "forecast");
    if (fcWk) {
      facts.push({
        ...base, key: `cut_price_forecast_week|${sp}|${title}`, kind: "cut_price_forecast_week", source: fcWk.line,
        values: { price: fcWk.value, unit: "USD/cwt", for_week: fcWk.dateIso, yrago_price: fcWk.yrAgo, yoy_pct: fcWk.pct },
      });
    }
    for (const r of parsed.filter((x) => !x.weekly && x.role === "forecast").slice(0, 3)) {
      facts.push({
        ...base, key: `cut_price_forecast_month|${sp}|${title}|${r.dateIso.slice(0, 7)}`, kind: "cut_price_forecast_month", source: r.line,
        values: { price: r.value, unit: "USD/cwt", month: r.dateIso.slice(0, 7), yrago_price: r.yrAgo, yoy_pct: r.pct },
      });
    }
  });

  return { facts, dropped };
}
