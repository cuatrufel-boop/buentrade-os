// Replaces the regex-based line/block parsers (parsePriceListLineBasic, detectBlockFormatItems,
// section-header folding) with Claude's own Structured Outputs — real, current Anthropic API
// feature (anthropic-beta: structured-outputs-2025-11-13), confirmed against the live docs before
// building this. Handles every real shape found this session (single-line "name - $price",
// Seaboard's block-format table, Tyson's Fresh/Frozen section headers, AND the one shape regex
// genuinely could not — Wholestone's prose sentence with three prices in one sentence) with one
// unified extraction step instead of N hand-written heuristics, one per format.
//
// Deliberately scoped to extraction ONLY — "find every product+price pair in this messy text."
// Does NOT decide which catalog SKU anything maps to; that stays with the existing, already-tested,
// rule-based matcher (_shared/productMatcher.ts) — never bypassed, never duplicated here. The LLM
// step only replaces the fragile "where is the price in this sentence" guesswork; the strict
// business rules (never cross Fresh/Frozen, never auto-create, always confirm an ambiguous match)
// still live entirely in deterministic code, same as before.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = "claude-sonnet-5";

export interface ExtractedItem {
  name: string;
  price: number; // USD/lb, already normalized to a decimal by the model (see prompt rule below)
  temperature: "Fresh" | "Frozen" | "Unknown";
  delivered: boolean; // true = a stated Delivered/landed price (freight included), false = FOB/unstated
}

// Real fix, confirmed live: Anthropic's structured-outputs JSON Schema validator rejects a
// nullable enum written as {"type": ["string", "null"], "enum": [..., null]} — "Unknown" as a
// plain enum member (not null) is what actually works.
const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The product name/description exactly as written in the source text — do not repeat a section header or temperature word that's already captured in the temperature field." },
          price: { type: "number", description: "The price in USD per lb, as a decimal (e.g. 0.98)." },
          temperature: { type: "string", enum: ["Fresh", "Frozen", "Unknown"], description: "Fresh or Frozen if stated anywhere for this item (directly, or via a section header covering it) — Unknown only if genuinely never stated." },
          delivered: { type: "boolean", description: "true only if this specific price is explicitly stated as Delivered/landed (freight already included) — e.g. a second price column labeled Delivered, or the word 'Delivered' near this price. false for FOB or when nothing is said about freight." },
        },
        required: ["name", "price", "temperature", "delivered"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You extract real product price offers from a raw meat-packing plant price-list email. This may be a clean line-per-item list, a table flattened into plain text, or ordinary prose mentioning prices mid-sentence.

Rules:
- Only extract lines that name a real, sellable product WITH a real price attached to it. Never extract a phone number, a fax number, an address, a date, a lead-time note ("2 weeks"), a signature block, a legal disclaimer, or a greeting/closing line as if it were a product.
- Prices are usually written as whole-number shorthand with NO decimal point — "$98" means $0.98/lb, "220" means $2.20/lb. Convert these: divide by 100. A price that ALREADY has a decimal point (e.g. "0.95", "$1.20") is correct as written — do not divide it again.
- A single sentence can genuinely contain several distinct product+price pairs (e.g. "Fresh COV $0.95/lb, Frozen COV $0.98/lb, Frozen Poly $0.96/lb" is three separate items, not one). Extract each one separately.
- If the SAME product name appears twice with two different prices (e.g. once under a "Fresh" section and once under a "Frozen" section), extract BOTH as separate items — never merge or drop one.
- A price stated with a formula instead of a number (e.g. "DPS*1.2+0.12") is not extractable — skip it, do not guess a numeric value.
- A line that only says "Call for availability", "N/A", "Check with X", or similar with no real number is not extractable — skip it.
- If a whole table/list has no per-item temperature stated anywhere (no Fresh/Frozen section headers, no per-item word), leave temperature null for all of them rather than guessing.
- Never invent a product that isn't actually named in the text.`;

export async function extractItemsWithLLM(bodyText: string): Promise<ExtractedItem[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "structured-outputs-2025-11-13",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: bodyText }],
      output_format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic API failed: ${JSON.stringify(data)}`);

  const textBlock = (data.content || []).find((b: any) => b.type === "text");
  if (!textBlock) throw new Error(`No text content in Anthropic response: ${JSON.stringify(data)}`);
  const parsed = JSON.parse(textBlock.text);
  return (parsed.items || []) as ExtractedItem[];
}

// A second, real shape confirmed live: Wholestone's "fresh offers" aren't text or an HTML table at
// all — the email body embeds a PICTURE of a price grid (item / pack-style / FOB price / a
// per-plant, per-date load-availability calendar). No text extractor can see a word of that; this
// reads the image directly with Claude's vision input, same Structured Outputs approach as the
// text path. Deliberately scoped to just item + pack-style + price — the date-by-date load
// calendar (fractional loads like 0.5) is real but explicitly out of scope for now (real, standing
// call: BuenTrade can always float a price as if it were a full load and negotiate the actual
// quantity once a bid comes back, rather than the system pre-filtering on a load calendar it would
// have to track and refresh constantly).
export interface ExtractedImageItem {
  item: string; // the row's item name/code, exactly as printed (e.g. "BI Sirloins 12118")
  packStyle: string; // the row's pack-style code, exactly as printed (e.g. "VP 4/4", "CBO")
  price: number | null; // USD/lb as a decimal; null when isFormula is true
  isFormula: boolean; // true when the price cell is a formula (e.g. "DPS*1.2+0.12"), not a number
  temperature: "Fresh" | "Frozen" | "Unknown"; // from the image itself, or from the surrounding email text passed as context
}

const IMAGE_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: { type: "string", description: "The row's item name/code exactly as printed, including any numeric code (e.g. 'BI Sirloins 12118')." },
          packStyle: { type: "string", description: "The row's pack-style code exactly as printed (e.g. 'VP 4/4', 'CBO')." },
          price: { type: "number", description: "The price in USD per lb as a decimal (e.g. 0.92). Use 0 when isFormula is true." },
          isFormula: { type: "boolean", description: "true when the price cell shows a formula (e.g. 'DPS*1.2+0.12') instead of a plain number — price is meaningless in that case, ignore it downstream." },
          temperature: { type: "string", enum: ["Fresh", "Frozen", "Unknown"], description: "Fresh or Frozen if the image itself states it (a column, a header) OR if the surrounding email text (given as context) says what this whole picture is — e.g. an email saying 'below are our fresh offers, attached is our frozen list' means every row in the image is Fresh. Unknown only if genuinely neither says." },
        },
        required: ["item", "packStyle", "price", "isFormula", "temperature"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const IMAGE_SYSTEM_PROMPT = `You read a price-list image from a meat-packing plant. It is a grid with one row per product: an item name/code column, a pack-style column, a price column, and (often) a block of per-date availability columns on the right showing how many loads are available on each date.

You are also given the plain-text body of the email this image came from, for context only — not to extract items from (a separate step already reads that text). Use it only to figure out things the image itself doesn't state, most importantly temperature: if the email says something like "below are our fresh offers, attached is our frozen list," that tells you every row in this image is Fresh even though the image has no Fresh/Frozen column.

Rules:
- Extract ONE item per product row: its item name/code, its pack-style code, its price, and its temperature.
- Ignore the per-date availability columns entirely — do not extract dates, load counts, or plant/facility sub-rows. Only the item, pack-style, price, and temperature matter.
- If a row appears twice (e.g. once per facility) with the identical item, pack-style, and price, extract it only once.
- If the price cell contains a formula (e.g. "DPS*1.2+0.12") instead of a plain number, set isFormula true and price 0 — never invent a numeric value for a formula.
- Transcribe the item name and pack-style exactly as printed, including abbreviations — do not expand or translate them.
- Never invent a row that isn't actually in the image.`;

export async function extractItemsFromImage(base64Data: string, mediaType: string, emailContext: string): Promise<ExtractedImageItem[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "structured-outputs-2025-11-13",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: IMAGE_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
          { type: "text", text: `Email body text (context only, do not extract items from this):\n\n${emailContext}\n\nExtract every product row from the price list image above.` },
        ],
      }],
      output_format: { type: "json_schema", schema: IMAGE_EXTRACTION_SCHEMA },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic API failed: ${JSON.stringify(data)}`);

  const textBlock = (data.content || []).find((b: any) => b.type === "text");
  if (!textBlock) throw new Error(`No text content in Anthropic response: ${JSON.stringify(data)}`);
  const parsed = JSON.parse(textBlock.text);
  return (parsed.items || []) as ExtractedImageItem[];
}
