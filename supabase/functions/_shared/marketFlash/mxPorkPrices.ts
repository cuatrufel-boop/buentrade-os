// "Mexican Pork Prices" table (SNIIM): USD/kg per cut, two regions, each with Ultimo / Anterior / Cambio.
// Rows are label + up to six numbers; a region with no quote leaves blanks, so the columns are read
// by POSITION (character offset of each header), never by "n-th number in the line". A row is dropped if
// the printed Cambio doesn't equal Ultimo − Anterior (±0.02 rounding) — a mis-read column can't pass.
import type { ExtractResult, Fact } from "./types.ts";

const NUM_RE = /-?\d+\.\d+/g;

export function extractMxPorkPrices(pages: string[]): ExtractResult {
  const facts: Fact[] = [];
  const dropped: ExtractResult["dropped"] = [];
  pages.forEach((pageText, pi) => {
    const lines = pageText.split("\n");
    const hi = lines.findIndex((l) => /Mexican Pork Prices/.test(l));
    if (hi < 0) return;
    const page = pi + 1;
    const wl = lines.slice(hi, hi + 6).find((l) => /W\/E:/.test(l));
    const dl = lines.slice(hi, hi + 8).find((l) => /\d{1,2}\/\d{1,2}\/\d{4}/.test(l));
    const dm = dl && dl.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!wl || !dm) { dropped.push({ kind: "mx_pork_price", entity: "table", page, reason: "week-ending date not found" }); return; }
    const weekEnd = `${dm[3]}-${dm[1].padStart(2, "0")}-${dm[2].padStart(2, "0")}`;

    // the header line with Ultimo/Anterior/Cambio gives the six column positions
    const headIdx = lines.findIndex((l, i) => i > hi && /Ultimo\s+Anterior\s+Cambio\s+Ultimo\s+Anterior\s+Cambio/.test(l));
    if (headIdx < 0) { dropped.push({ kind: "mx_pork_price", entity: "table", page, reason: "column header not found" }); return; }
    const hl = lines[headIdx];
    const cols: number[] = [];
    for (const m of hl.matchAll(/Ultimo|Anterior|Cambio/g)) cols.push((m.index || 0) + m[0].length); // right edge of each header word
    if (cols.length !== 6) { dropped.push({ kind: "mx_pork_price", entity: "table", page, reason: "expected 6 columns" }); return; }

    const fx = lines.slice(headIdx, headIdx + 4).find((l) => /Peso\s*\/\s*1\s*USD/.test(l));
    const fxNums = fx ? (fx.match(NUM_RE) || []).map(parseFloat) : [];

    let started = false;
    for (let i = headIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/Fuente:/.test(line)) break;
      if (/USD\/KG/.test(line) || /Peso\s*\/\s*1\s*USD/.test(line)) continue;
      const label = line.slice(0, 26).trim();
      if (!label) continue;
      if (/^Pie LAB Rastro$/i.test(label)) { started = true; continue; }
      if (!started) continue;
      // numbers with their right-edge position
      const cells: Array<number | null> = [null, null, null, null, null, null];
      let bad = false;
      for (const m of line.matchAll(/-?\d+\.\d+/g)) {
        const right = (m.index || 0) + m[0].length;
        if ((m.index || 0) < 20) continue;
        let best = 0, bd = Infinity;
        cols.forEach((c, ci) => { const d = Math.abs(c - right); if (d < bd) { bd = d; best = ci; } });
        if (bd > 5 || cells[best] !== null) { bad = true; break; }
        cells[best] = parseFloat(m[0]);
      }
      const drop = (reason: string) => dropped.push({ kind: "mx_pork_price", entity: label, page, reason });
      if (bad) { drop("could not assign numbers to columns unambiguously"); continue; }
      const regions: Array<[string, number]> = [["Distrito Federal y Zona Metropolitana", 0], ["Nuevo León", 3]];
      for (const [region, off] of regions) {
        const [last, prev, chg] = [cells[off], cells[off + 1], cells[off + 2]];
        if (last == null) continue; // this region has no quote for this item this week
        if (last <= 0) { drop(`${region}: printed 0.00 (no quote this week)`); continue; }
        if (prev != null && chg != null && Math.abs(last - prev - chg) > 0.02) { drop(`${region}: Cambio ${chg} ≠ Ultimo ${last} − Anterior ${prev}`); continue; }
        facts.push({
          key: `mx_pork_price|${label}|${region}`,
          kind: "mx_pork_price", species: "pork", market: "MX", entity: label, page,
          source: line.trim().replace(/\s{2,}/g, "  "), method: "parser",
          values: {
            region, unit: "USD/kg", week_end: weekEnd,
            price: last, prev_price: prev, change: chg, // change exactly as printed (the bulletin rounds from unrounded prices)
            fx_pesos_per_usd: fxNums[off === 0 ? 0 : 2] ?? null,
          },
        });
      }
    }
  });
  return { facts, dropped };
}
