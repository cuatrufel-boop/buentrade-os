// Ported from plants.html's parsePriceListLine — deliberately ONLY the first, most common shape
// (a name followed by "$price" or "-price" on the SAME line, e.g. real Tyson-style lists) for the
// email-automation pipeline's first version. The other 4 shapes that Load Prices already handles
// (casual short lines, block-format name/price pairs on separate lines, category-header folding,
// temp/pack context folding) are deliberately NOT ported yet — a line that doesn't fit this one
// shape returns null and is skipped, never guessed. Add the other shapes here, one at a time, only
// once this first one is proven correct against real incoming mail.

// Plants write these lists as whole-number shorthand with no decimal point — "98" means $0.98/lb,
// "220" means $2.20/lb. Only scaled when the matched number has no decimal already.
export function priceFromRaw(raw: string): number {
  return /[.,]/.test(raw) ? parseFloat(raw.replace(",", ".")) : parseFloat(raw) / 100;
}

// Strips WhatsApp bold markers and the "@" that separates a name from its price, same as the
// client-side version — without this the name never matches the clean catalog entry.
export function cleanNameText(s: string): string {
  return s.trim().replace(/[-–—:.\s@]+$/, "").replace(/^\*+|\*+$/g, "").trim();
}

export function parsePriceListLineBasic(line: string): { rawText: string; price: number } | null {
  const m = line.match(/\$\s*(\.?\d+(?:[.,]\d+)?)/) || line.match(/[-–—]\s*(\.?\d+(?:[.,]\d+)?)\b/);
  if (!m) return null;
  const price = priceFromRaw(m[1]);
  const rawText = cleanNameText(line.slice(0, m.index));
  if (!rawText) return null; // whole line is just the price, nothing to attach it to — skip
  return { rawText, price };
}

// ---- Block-format (Seaboard-style bilingual table flattened to plain text) ----
// Ported faithfully from plants.html's detectBlockFormatItems/isPriceishLine/parsePriceValue —
// same regexes, same "read backward from the price run" approach, same last-price-column-is-
// Delivered-so-freight-is-already-baked-in rule. This is real, tuned logic (confirmed against an
// actual Seaboard list) — not reinvented for the email pipeline.

export function isSectionHeaderLine(line: string): boolean {
  return /^[A-Za-z][A-Za-z /]*:$/.test(line.trim());
}

export function isPriceishLine(line: string): boolean {
  return /^\$?\.?\d+(?:\.\d+)?$/.test(line) || /^-{2,}$/.test(line) || /check\s*with/i.test(line);
}

export function parsePriceValue(str: string): number | null {
  const m = str.match(/\$?\.?\d+(?:\.\d+)?/);
  if (!m) return null;
  const raw = m[0].replace("$", "");
  return /\./.test(raw) ? parseFloat(raw) : parseFloat(raw) / 100;
}

export function looksLikeBlockFormat(lines: string[]): boolean {
  const priceOnlyLines = lines.filter((l) => !isSectionHeaderLine(l) && isPriceishLine(l));
  return priceOnlyLines.length >= 2 && priceOnlyLines.length / lines.length > 0.12;
}

export interface BlockFormatItem {
  nameEn: string;
  nameEs: string | null;
  price: number;
  freightIncluded: boolean;
}

export function detectBlockFormatItems(lines: string[]): BlockFormatItem[] {
  const items: BlockFormatItem[] = [];
  let descriptive: string[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!isPriceishLine(line)) {
      descriptive.push(line);
      continue;
    }
    if (descriptive.length < 2) { descriptive = []; continue; }
    const prices = [line];
    while (idx + 1 < lines.length && isPriceishLine(lines[idx + 1])) {
      idx++;
      prices.push(lines[idx]);
    }
    // Last price column = Delivered-to-border when 2+ columns exist — freight already baked in.
    const price = parsePriceValue(prices[prices.length - 1]);
    const withoutLead = descriptive.slice(0, Math.max(0, descriptive.length - 2));
    const m = withoutLead.length;
    const nameEn = m >= 2 ? withoutLead[m - 2] : withoutLead[m - 1];
    const nameEs = m >= 2 ? withoutLead[m - 1] : null;
    const freightIncluded = prices.length >= 2;
    if (price != null && nameEn) items.push({ nameEn, nameEs, price, freightIncluded });
    descriptive = [];
  }
  return items;
}
