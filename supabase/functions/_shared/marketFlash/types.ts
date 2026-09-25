// Market Flash pipeline — shared types. A Fact is ONE atomic, source-verified datum read from the
// bulletin (deterministic parsers for tables; the LLM is only ever used for narrative sentences).
// A Bullet is composed from Facts by fixed Spanish templates — nothing is ever free-written.

export type Species = "pork" | "beef" | "chicken" | "turkey" | "feed";
export type Market = "US" | "MX";

export interface Fact {
  key: string;            // stable identity used to compare against the previous bulletin
  kind: string;           // e.g. cut_price_weekly, cut_price_forecast, mx_pork_price
  species: Species;
  market: Market;
  entity: string;         // label exactly as printed in the bulletin
  page: number;           // 1-based PDF page
  source: string;         // the verbatim source line(s) the numbers came from
  values: Record<string, number | string | null>;
  method: "parser" | "llm";
}

export interface Dropped {
  kind: string;
  entity: string;
  page: number;
  reason: string;
}

export interface ExtractResult {
  facts: Fact[];
  dropped: Dropped[];
}
