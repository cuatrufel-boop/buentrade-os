// "Y/Y Ch. in <month> vs. <month> US … Exports" bar-chart pages — two panels side by side, one bar per
// destination, printed value at the end of each bar.
// In the extracted text a label and its number can land on different lines (e.g. chicken → Mexico), and the
// two panels interleave on the same lines, so pairing is NOT done by line. Instead, per panel:
//   • split panels at the column where the second title starts,
//   • take labels and numbers each in vertical order and pair them by rank,
//   • accept the panel only if (a) label count = number count, (b) values are in descending order — the
//     way the chart is drawn — and (c) the destinations sum to the printed "World Total".
// Any panel that fails one of the three is DROPPED whole; nothing is guessed. Only the World Total and
// Mexico bars are kept (US and Mexico are the only markets in scope).
import type { ExtractResult, Fact, Species } from "./types.ts";

const MON: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

// Known panel titles → what the panel measures. Unknown titles are refused (fail closed).
const PANELS: Array<{ re: RegExp; species: Species; measure: "volume" | "value"; product: string }> = [
  { re: /US Fr, Froz & Pres Pork Export Volume/i, species: "pork", measure: "volume", product: "pork_fresh_frozen_preserved" },
  { re: /US Pork Variety Meat Exports/i, species: "pork", measure: "volume", product: "pork_variety_meats" },
  { re: /US Beef and Veal Export Volume/i, species: "beef", measure: "volume", product: "beef_and_veal" },
  { re: /US Beef Variety Meat Exports/i, species: "beef", measure: "volume", product: "beef_variety_meats" },
  { re: /US Fresh\/Frozen Chicken Meat Exports/i, species: "chicken", measure: "volume", product: "chicken_fresh_frozen" },
  { re: /US Chicken Export Value/i, species: "chicken", measure: "value", product: "chicken_fresh_frozen" },
  { re: /US Turkey Exports\s*$/i, species: "turkey", measure: "volume", product: "turkey" },
  { re: /US Turkey Export Value/i, species: "turkey", measure: "value", product: "turkey" },
];

interface Seg { col: number; text: string }
const segs = (line: string): Seg[] => {
  const out: Seg[] = [];
  for (const m of line.matchAll(/\S+(?: \S+)*/g)) out.push({ col: m.index || 0, text: m[0] });
  return out;
};
const NUMTOK = /^-?\$?[\d,]+$/;
const toNum = (s: string) => parseFloat(s.replace(/[$,]/g, ""));

export function extractExports(pages: string[]): ExtractResult {
  const facts: Fact[] = [], dropped: ExtractResult["dropped"] = [];
  pages.forEach((pt, pi) => {
    const page = pi + 1;
    const lines = pt.split("\n");
    lines.forEach((tl, ti) => {
      const titles = [...tl.matchAll(/Y\/Y Ch\. in (\w+)\. (\d{2}) vs\. (\w+) (\d{2})/g)];
      if (!titles.length) return;
      // panel titles (one or two per title line)
      const splitCol = titles.length > 1 ? (titles[1].index || 0) - 1 : Infinity;
      const titleTexts = titles.map((t, k) => tl.slice(t.index || 0, k + 1 < titles.length ? titles[k + 1].index : undefined).trim());
      // block ends at the axis line (≥4 pure-number segments) or after 30 lines
      const block: string[] = [];
      for (let i = ti + 2; i < Math.min(lines.length, ti + 32); i++) {
        const sg = segs(lines[i]);
        if (sg.filter((s) => NUMTOK.test(s.text)).length >= 4) break;
        block.push(lines[i]);
      }
      titles.forEach((t, k) => {
        const titleText = titleTexts[k];
        const spec = PANELS.find((p) => p.re.test(titleText));
        const drop = (reason: string) => dropped.push({ kind: "export_change", entity: titleText.slice(0, 80), page, reason });
        if (!spec) return drop("out of scope or unrecognized panel title");
        const mCur = MON[t[1]], yCur = 2000 + +t[2], yPrev = 2000 + +t[4];
        const inPanel = (col: number) => (k === 0 ? col < splitCol : col >= splitCol);
        const labels: string[] = [];
        const nums: Array<{ v: number; raw: string }> = [];
        for (const line of block) {
          for (const s of segs(line)) {
            if (!inPanel(s.col)) continue;
            const tx = s.text;
            if (/%$/.test(tx) || /^(Change|Y\/Y|Source|Unit)/i.test(tx)) continue; // chart callouts, not bars
            if (NUMTOK.test(tx)) { nums.push({ v: toNum(tx), raw: tx }); continue; }
            const lm = tx.match(/^([A-Z][A-Za-z ,.()*&\-]*[A-Za-z)*])\s+(-?\$?[\d,]+)$/); // label + number in one segment
            if (lm) { labels.push(lm[1].trim()); nums.push({ v: toNum(lm[2]), raw: lm[2] }); continue; }
            // a label may be glued to a callout in the same segment ("Korea, South pork variety meats:"):
            // the label is the leading run of capitalized words, everything from the first lowercase word on is callout
            const words = tx.split(" "), lead: string[] = [];
            for (const w of words) { if (/^[A-Z(]/.test(w)) lead.push(w); else break; }
            if (lead.length && /^[A-Z][A-Za-z ,.()*&\-]*$/.test(lead.join(" "))) labels.push(lead.join(" ").trim());
          }
        }
        if (labels.length < 3 || labels.length !== nums.length) return drop(`labels (${labels.length}) and numbers (${nums.length}) do not pair up`);
        const wi = labels.findIndex((l) => /^World Total$/i.test(l));
        if (wi !== 0) return drop("'World Total' is not the first row");
        const rows = labels.map((l, i) => ({ label: l, v: nums[i].v }));
        const dests = rows.slice(1);
        for (let i = 1; i < dests.length; i++) if (dests[i].v > dests[i - 1].v) return drop(`values not in descending order at ${dests[i].label}`);
        const sum = dests.reduce((a, r) => a + r.v, 0);
        const tol = spec.measure === "value" ? 5 : 12;
        if (Math.abs(sum - rows[0].v) > tol) return drop(`destinations sum to ${sum} but World Total is ${rows[0].v}`);
        const totalPct = null;
        for (const r of rows) {
          if (r.label !== "World Total" && r.label !== "Mexico") continue;
          facts.push({
            key: `export_change|${spec.product}|${spec.measure}|${r.label}`,
            kind: "export_change", species: spec.species, market: r.label === "Mexico" ? "MX" : "US",
            entity: `${titleText.replace(/^Y\/Y Ch\. in \w+\. \d{2} vs\. \w+ \d{2}\s*/, "")} — ${r.label}`, page, method: "parser",
            source: `${r.label} ${nums[rows.indexOf(r)].raw} (panel: ${titleText})`,
            values: {
              product: spec.product, measure: spec.measure, unit: spec.measure === "volume" ? "metric tons" : "USD",
              destination: r.label, change: r.v, month: `${yCur}-${String(mCur).padStart(2, "0")}`, vs_month: `${yPrev}-${String(mCur).padStart(2, "0")}`, total_pct: totalPct,
            },
          });
        }
      });
    });
  });
  return { facts, dropped };
}
