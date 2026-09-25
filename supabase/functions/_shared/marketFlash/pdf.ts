// PDF → text, server-side, ONE implementation for both entry points (manual upload and, later, the email/API
// path). The browser used to build this text itself, but its layout was approximate (columns drifted), which
// silently cost several tables. Here every text item is placed at its absolute column (x / CHAR_W), the way
// pdftotext -layout does, so column-based readers see the same alignment on every row.
import type { NarrativeSection } from "./narrative.ts";

export interface PdfItem { str: string; x: number; y: number; w: number }
const CHAR_W = 4.0;   // points per text column
const Y_TOL = 2.5;    // items within this many points of each other share a row

export async function readPdfItems(bytes: Uint8Array): Promise<PdfItem[][]> {
  // loaded on demand: the upload path sends already-read items and never needs pdf.js inside the Edge Function
  const pdfjs: any = (await import("npm:pdfjs-dist@3.11.174/legacy/build/pdf.js")).default;
  const doc = await pdfjs.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise;
  const pages: PdfItem[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(content.items.filter((it: any) => it.str && it.str.trim() !== "").map((it: any) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })));
  }
  return pages;
}

function groupRows(items: PdfItem[]) {
  const rows: Array<{ y: number; items: PdfItem[] }> = [];
  for (const it of items) {
    const r = rows.find((row) => Math.abs(row.y - it.y) <= Y_TOL);
    if (r) r.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  rows.sort((a, b) => b.y - a.y);
  rows.forEach((r) => r.items.sort((a, b) => a.x - b.x));
  return rows;
}

// pdftotext -layout–like text; pages separated by form feed
export function layoutText(pages: PdfItem[][]): string {
  let out = "";
  for (const items of pages) {
    for (const row of groupRows(items)) {
      let line = "";
      for (const it of row.items) {
        const col = Math.round(it.x / CHAR_W);
        if (line.length === 0) line = " ".repeat(col);
        else if (col > line.length) line += " ".repeat(col - line.length);
        else line += " "; // would overlap the previous item: keep them apart with one space
        line += it.str;
      }
      // pdf.js emits a minus sign as its own item ("- 7,222", "- $15,134,220", "- 17.5%"): glue it to its number — but never
      // in a range like "120 - 179 Pounds" (a digit, one space, then the dash)
      out += line.replace(/\s+$/, "").replace(/(^|\s{2,}|[^\d\s]\s)-\s+(?=\$?\d)/g, "$1-") + "\n";
    }
    out += "\f";
  }
  return out;
}

// "Pork/Beef/Chicken/Turkey Market Trends" — a two-column block of bullet paragraphs. The table-of-contents column
// sits at nearly the same y as the headers, so headers are found by a sliding window of consecutive items (keeping
// the header item's own x/y), and body text is collected per column from the header downward to the next header.
export function narrativeSections(pages: PdfItem[][]): NarrativeSection[] {
  const HEADER_RE = /^([A-Za-z]+)\s+Market\s+Trends?$/i;
  const KNOWN = ["Pork", "Beef", "Chicken", "Turkey", "Lamb", "Sow"];
  for (const items of pages) {
    const rows = groupRows(items);
    const headers: Array<{ species: string; x: number; y: number }> = [];
    for (const row of rows) {
      for (let start = 0; start < row.items.length; start++) {
        for (let end = start; end < Math.min(start + 4, row.items.length); end++) {
          const m = row.items.slice(start, end + 1).map((i) => i.str).join(" ").replace(/\s+/g, " ").trim().match(HEADER_RE);
          if (m && KNOWN.includes(m[1])) { headers.push({ species: m[1], x: row.items[start].x, y: row.items[start].y }); break; }
        }
      }
    }
    if (headers.length < 2) continue;
    const xs = headers.map((h) => h.x);
    const colSplitX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const tocMaxX = Math.min(...xs) - 10;
    const sections: NarrativeSection[] = [];
    for (const h of headers) {
      const isLeft = h.x < colSplitX;
      const sameCol = headers.filter((o) => (o.x < colSplitX) === isLeft && o.y < h.y).sort((a, b) => b.y - a.y);
      const yBottom = sameCol.length ? sameCol[0].y : -Infinity;
      const colItems = items.filter((it) => it.y < h.y && it.y > yBottom && (isLeft ? it.x >= tocMaxX && it.x < colSplitX : it.x >= colSplitX));
      const text = groupRows(colItems).map((r) => r.items.map((i) => i.str).join(" ")).join(" ").replace(/\s+/g, " ").trim();
      if (text) sections.push({ categoryName: h.species, text });
    }
    if (sections.length) return sections;
  }
  return [];
}

// The browser reads the PDF's text items itself (same pdf.js version) and sends them compactly as [text, x, y] per
// page — ~190 KB instead of the 4 MB file, and no PDF parsing inside the Edge Function (which sits close to its
// compute limit). Everything downstream of the items — layout, tables, narrative — is the same code either way.
export function itemsFromCompact(pages: unknown): PdfItem[][] | null {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 200) return null;
  let total = 0;
  const out: PdfItem[][] = [];
  for (const pg of pages) {
    if (!Array.isArray(pg)) return null;
    total += pg.length;
    if (total > 60000) return null;
    const items: PdfItem[] = [];
    for (const it of pg) {
      if (!Array.isArray(it) || typeof it[0] !== "string" || typeof it[1] !== "number" || typeof it[2] !== "number") return null;
      if (it[0].trim() !== "") items.push({ str: it[0], x: it[1], y: it[2], w: 0 });
    }
    out.push(items);
  }
  return out;
}
