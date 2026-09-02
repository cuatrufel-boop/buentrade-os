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
