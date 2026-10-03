// One place that says WHY something is waiting in Pending Matches, and what kind of thing it is.
//  - "product": a line that names (or should name) a product — the trader picks the product and, when the plant gave no price,
//    types one or dismisses the line.
//  - "unread": a file or message the system could not read at all — the trader looks at it and dismisses it; the dismissal is
//    remembered for that plant + that exact text.
// Reason codes are written by the readers (plant-price-emails-poll); the sentence the trader sees is built here from the code and the
// detail the reader captured (the exact words that stood where the price should be, the error, the file type...).

export type RouteKind = "product" | "unread";

const PRODUCT_CODES = new Set([
  "text_no_price_stated", "text_not_available", "text_formula", "text_price_without_product",
  "xlsx_row_no_price", "xlsx_row_no_description", "formula_in_image", "image_row_no_price",
  "match_error", "apply_error",
]);

export function routeFor(code: string): RouteKind {
  return PRODUCT_CODES.has(code) ? "product" : "unread";
}

export function describeReason(code: string, detail?: string | null): string {
  const d = (detail || "").trim();
  const says = d ? ` — says "${d}"` : "";
  switch (code) {
    case "no_catalog_candidate": return "No catalog product matches this text";
    case "multiple_candidates": return "More than one catalog product could match";
    case "candidates_conflict_with_line": return "The closest products disagree with something the line says";
    case "needs_review_cut_style": return "Cut style with no exact catalog product — needs a person";
    case "text_no_price_stated": return `Listed with no price${says}`;
    case "text_not_available": return `Listed as not available${says}`;
    case "text_formula": return `Price is a formula${d ? ` — "${d}"` : ""}`;
    case "text_price_without_product": return "A price with no product beside it";
    case "xlsx_row_no_price": return `Spreadsheet row with no price${d ? ` — ${d}` : ""}`;
    case "xlsx_row_no_description": return "Spreadsheet row with a price but no description";
    case "formula_in_image": return "Price in the picture is a formula";
    case "image_row_no_price": return "Picture row with no usable price";
    case "match_error":
    case "apply_error": return `The system hit an error on this line${d ? ` — ${d}` : ""}`;
    case "attachment_type_not_read": return `Attached file the system cannot read yet${d ? ` (${d})` : ""}`;
    case "xlsx_extra_file": return "Second spreadsheet in this email — not read";
    case "xlsx_extra_sheet": return `Spreadsheet sheet not read${d ? ` — ${d}` : ""}`;
    case "xlsx_layout_not_recognized": return `Spreadsheet layout not recognized${d ? ` — ${d}` : ""}`;
    case "xlsx_unreadable": return `Spreadsheet could not be opened${d ? ` — ${d}` : ""}`;
    case "xlsx_empty_sheet": return "Spreadsheet is empty";
    case "xlsx_fetch_failed":
    case "image_fetch_failed": return `Attachment could not be downloaded${d ? ` — ${d}` : ""}`;
    case "image_unreadable": return `Picture could not be read${d ? ` — ${d}` : ""}`;
    case "llm_extraction_failed": return `Email text could not be read${d ? ` — ${d}` : ""}`;
    case "facility_not_recognized": return `Facility "${d}" is not one of this plant's locations — its prices were applied without a pickup city`;
    case "message_without_candidates": return "Nothing readable found in this email";
    default: return d ? `${code} — ${d}` : code;
  }
}
