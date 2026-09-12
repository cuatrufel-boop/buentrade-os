# Session Logs

## 2026-09-12 — Credit USD Limit connected to Collections cupo (hard block at the plant bid)

**Files changed:** `supabase/functions/_shared/matching.ts`, `supabase/functions/sent-offers-create/index.ts`,
`supabase/functions/sent-offers-log-event/index.ts`, `supabase/functions/sent-offers-mark-won/index.ts`,
`trading-tool.html`, `quotes.html`.

### What was wrong
- `customers.credit_limit` existed as a field but wasn't actually connected to any real gate before
  a trader kept selling to an over-limit customer — the only existing check ran at `markWon` (order
  creation) and could be skipped with one click ("Create Anyway"), which the user clarified was
  never meant as a credit override in the first place (it was assumed to be for stale plant
  pricing — traced live in the code and confirmed it has always been the credit-limit override,
  since the 2026-09-08 `creditLimitOverlay` comment).
- The exposure formula existed in two different places computing two different numbers:
  `collections-search` (AR aging, invoiced-only shipments) vs. `sent-offers-mark-won` (all unpaid
  shipments, invoiced or not) — never unified.

### What's live now (verified live against staging, not just code review)
1. **New shared helper** `computeCustomerExposure()` in `_shared/matching.ts` — one formula
   (outstanding = sum of unpaid shipments' `sale_amount`, invoiced or not, + credit_limit), reused
   by every caller instead of being computed three different ways.
2. **Hard block, no override, at the first contact with the plant** — explicit ask: "el boton de
   bloqueo verdadero cuando voy a pasarle un bid a la planta." `sent-offers-log-event` now rejects
   (`409 credit_limit_exceeded`) a `to: "plant"` event outright when the customer's outstanding
   balance plus this offer would exceed their credit limit — no override field accepted at all.
   `trading-tool.html`'s `negoSendToPlant` was reordered so this check runs **before** the
   email/WhatsApp to the plant goes out (it used to send first, log after — the block would have
   been meaningless with the old order). Verified live: called against a real "sent" offer
   ($49,200) for a test customer with `credit_limit=$30` → real `409`, no message sent; the same
   offer's customer-side log event (`to: "customer"`) still returns `200` — quoting the customer is
   never blocked.
3. **Non-blocking advisory when quoting/offering the customer** — `sent-offers-create` now returns
   a `credit_warning` (Spanish copy, since it's shown alongside a customer-facing offer — the one
   explicit exception to the "internal UI stays English" rule) whenever the customer is already
   over their limit; never blocks the send. Wired into `quotes.html`'s `sendOfferWhatsAppTo` /
   `sendOfferWhatsAppToAll` — shown via `rqShowNotice` right after the WhatsApp offer opens.
4. `sent-offers-mark-won`'s existing softer check (with its `override_credit_check` /
   "Create Anyway" escape hatch) was left as-is, just refactored onto the same shared helper — by
   the time an offer reaches "Won" the exposure was already gated much earlier, at the plant-bid
   step above.

### Known gaps, deferred until asked
- `collections-search`'s own "Owes/Credit Used" column still uses the older, narrower
  invoiced-only formula (a real AR-aging discrepancy vs. the new canonical exposure) — flagged to
  the user, left untouched since changing Collections' own display wasn't asked for.

## 2026-09-12 — Quotes: system-wide tables, product search, "Possible" plants

**File changed:** `quotes.html` only. No Supabase schema/migration/edge-function changes.

### What was wrong
- Ready/Expired only showed plant_products that had been individually searched before (a
  2026-09-04 rule: "solo hasta que alguien lo busque"). Confirmed live: 98 plant_products had a
  real price system-wide (61 fresh, 37 expired) but only 6/0 were showing, because only 43 had
  ever actually been searched.
- Ready/Expired were hidden by default behind a stat-card click; only Updating showed on load.
- Searching a product wrote real data as a side effect (stamped `last_requested_at`, sometimes
  fired a real auto-ask email) just from typing/clicking a search result — no explicit send.
- Every product name in the sweep tables had a dead click (`qOpenProductInRequest`) pointing at a
  "Building" panel that's been permanently hidden since 2026-09-09 — silently wrote data with
  nothing visible to show for it.
- A plant already linked to a product (e.g. from an unrelated price-list import) but never priced
  and never asked was invisible everywhere: not Ready/Expired (no price), not Updating (no
  `last_requested_at`), and not caught by any "never linked" check either.
- The initial page load stopped fetching data entirely after an unrelated fix made the search
  box's empty-state handler non-fetching — all 4 stat cards showed 0 until the 45s background poll
  eventually ran. Fixed same day it was introduced.

### What's live now
1. **Ready / Expired / Updating are real tabs**, each showing the full, unfiltered, system-wide
   list for that status (not just previously-searched products). One visible at a time, via the
   stat cards.
2. **"Products In Progress" is now a 4th tab ("Quote")** — the one place to search a specific
   product. Search (or click any product name in a row) filters Ready/Expired/Updating down to
   just that product, shown together with a "Showing: X ✕ Clear" chip. This filtering is 100%
   read-only — confirmed live via Network tab: zero API calls fired from search/clear.
3. **New "Possible" section**, shown only while filtered to one product: every plant sharing that
   product's category that's genuinely untouched for it (no price, never asked, not declined) —
   whether or not a plant_products row already exists. Each has a real "Ask for Price →" button
   that opens the same preview-before-send email/WhatsApp modal used everywhere else in the app;
   nothing is written or sent until the trader confirms Send inside it.
4. Removed the dead "open Building panel" click on every product name; it now opens the same
   read-only product filter.

### Known side effect from testing
While verifying live against staging, a handful of real `plant_products.last_requested_at`
timestamps were stamped for "Pork Backribs Fresh, VAC" (actor recorded as `unknown`, since testing
bypassed Firebase login). No emails were sent as part of that. Harmless staging data, not reverted.

### Still open / deferred (not built yet)
- Updating/Expired/Ready each having their own **local** search box (scoped to just that table),
  separate from the shared "Quote" tab search — explicitly deferred, next step when asked.
- A confirmed-dead code path (`rqAddVariantToQuote`, `qPopulateProductForSend`,
  `qOpenProductInRequest`, `qSendPendingProductEmail`/`WhatsApp`) has zero remaining callers after
  today's changes. Not deleted — it shares infrastructure (customer list panel, price calculator
  overlay) with code that's still live, and needs its own careful pass to remove safely.

## 2026-09-12 — PO/SO/FO/Invoice: real preview, real send offline, new order numbering

**Files changed:** `offers.html`, `orders.html`, `trading-tool.html`, `scripts/dev-server-local.js`
(new), `scripts/secrets/.env.local.example` (new), `supabase/functions/pickup-docs-emails-poll/index.ts`,
`supabase/migrations/20260912030000_switch_order_number_to_single_consecutive_format.sql` (new).

### What was wrong
- PDFs (PO/SO/FO/Invoice) generated fine, but the trader never actually saw the real document
  before it sent — "Create Order" and every send button went straight from click to a plain
  to/subject/body edit modal (or straight to WhatsApp), with the real rendered PDF only reachable
  through a kebab menu nobody used. No "preview → send → auto-advance to next doc" flow existed
  anywhere despite being asked for repeatedly.
- Automatic email send was failing (confirmed: buentradegroup.com's Netlify site is genuinely
  suspended for usage limits, and local dev had no functions server at all) — every send fell back
  to a "click to finish it in Gmail" link, which can't carry a real PDF attachment. Real orders
  (BT-0019, etc.) had `po_sent_at`/`so_sent_at` set from traders clicking that Gmail fallback link
  (which optimistically marks the doc "sent" on trust), not from a real email ever going out.
  Confirmed with hard evidence: zero sent emails existed in either Resend account tied to this
  domain.
- orders.html had **no PDF preview screen at all** (offers.html had one, buried in a kebab menu);
  no `exportPO`/`exportSO`/`exportFO` functions existed there either — no way to download a PDF
  from that page.
- orders.html's Documents panel cached the list of already-uploaded files once per session and
  never refreshed — a document sent after the panel was first opened would show "Not generated"
  forever even though the real file existed in Storage.
- The order numbering scheme was inconsistent: `order_number` (`BT-0001`...) was the only
  identifier, with no distinct number printed on PO/SO/FO/Invoice documents. User explicitly
  retired this ("olvida BT-0019") in favor of one shared per-order consecutive
  (`2026-1001`), each document just prefixed (`PO-BT-2026-1001`, `SO-BT-...`, `FO-BT-...`,
  `INV-BT-...`) — took 3 rounds to land on the final prefix order after two corrections.
- Several messages had drifted from the frozen approved copy table (see
  `project_approved_email_whatsapp_copy_table.md`): unapproved emoji had crept into offers.html's
  PO/FO/Customs subjects (📄/🚛/📎) and orders.html's pickup-status WhatsApp check-in (📦/🚚); the 3
  customer lifecycle emails (Picked Up/Unloading/Delivered) were sent from the wrong alias
  (`logistics@` instead of `offers@`); resending an Invoice before the customer signed re-sent the
  same PDF with **no way to reach the signature page at all**.

### What's live now
1. **Real local send, no Netlify dependency**: `scripts/dev-server-local.js` serves the static
   site AND runs the real `netlify/functions/*.js` handlers in-process against Resend directly —
   same code that runs once Netlify is reactivated (Sept 15), nothing to change later. Installed as
   a permanent macOS LaunchAgent (`~/Library/LaunchAgents/com.buentrade.devserver.plist`, previously
   pointed at the old no-op Python static server) so it survives restarts. Verified with a real
   send through the actual app UI (200 OK, real PDF attachment, confirmed delivered).
2. **Preview → send → auto-advance, everywhere**: `openDocPreview`/`runDocSendSequence` (ported
   from offers.html into orders.html, plus a URL-based `openInvoicePreview` variant for the
   already-uploaded Invoice file) now sit behind every PO/SO/FO/Invoice entry point — the stepper
   icons, the Documents panel's quick-resend buttons, and the "Create Order"/`runPendingWonDocConfirm`
   chain. Clicking Email or WhatsApp inside the preview sends it and auto-opens the next document;
   Download never advances. trading-tool.html's `createAndShareInvoice` got the same preview
   treatment (its own `openInvoiceDocPreview`, since the Invoice can't reuse `openDocPreview`'s
   rebuild-from-scratch logic once a real signature/customs weight exists).
3. **Documents-panel file-cache bug fixed**: `orderDocsFileCache` is now invalidated right after
   each successful upload, so the download link appears immediately instead of needing a reload.
   A second, related bug found while wiring the preview buttons in: `renderOrderDocsPanel`'s local
   `findFiles()` prefix check still used the pre-numbering-change prefixes and would have silently
   found nothing forever — fixed to match the new `PO-BT-`/`SO-BT-`/`FO-BT-`/`INV-BT-` filenames.
4. **New order numbering, applied everywhere**: `next_order_number()` (already live in Supabase,
   now also captured in migration `20260912030000`) generates `{year}-{consecutive}`, restarted at
   1001. Every PO/SO/FO/Invoice builder across all three HTML files composes `{TYPE}-BT-{orderNumber}`
   for its header/order-number-field/email-subject/WhatsApp-message/filename — filenames included,
   per explicit ask ("a TODO dale el mismo nombre"). `pickup-docs-emails-poll`'s inbound-email
   parser updated to match the new prefixed pattern and strip it before comparing to
   `shipments.order_number`. Existing test orders (`BT-0001`...`BT-0019`) keep their old-format
   `order_number` forever and render as e.g. `PO-BT-BT-0019` — harmless, expected, not migrated.
5. **Copy-table drift fixed**: unapproved emoji stripped from offers.html's PO/FO/Customs subjects
   and orders.html's status check-in WhatsApp text; the 3 lifecycle customer emails now send from
   `offers@` instead of `logistics@`; `resendInvoiceEmail` now checks `shipments.invoice_signed_at`
   — not yet signed, it re-issues a fresh signature token and sends the real signed-link copy; a
   fixed `APP_ORIGIN` constant (matching trading-tool.html's) was added to orders.html so that link
   never bakes in `localhost` or whatever address the trader happens to be testing from.

### Known gaps, deferred until asked
- The RESEND_API_KEY used by the local dev server lives only in `scripts/secrets/.env.local`
  (gitignored) — not committed, has to be set up again on any other machine via the `.example`
  file.
- Three specific wording spots from the user's 2026-09-12 re-dictation of the copy table looked
  like copy/paste slips (Picked Up's subject, Unloading's body, Delivered's WhatsApp word order) —
  flagged explicitly, user delegated the call ("filtralo, que funcione"); kept the original,
  already-working text in all three. See the copy-table memory for the exact conflict recorded.

## 2026-09-12 — Order Detail timeline redesign (Closing = Delivery + Signature as the finish line)

**Files changed:** `orders.html` only.

### What was wrong
The Order Detail modal's timeline (PO → SO → FO → ... → Delivered → Invoice → Signature) had no
visual hierarchy — 13 identical-weight nodes in a row, with Delivery and Signature (explicitly "lo
más importante" per the user) reading as just two more stops among many. First attempt (3 stacked
phase cards, Closing gold-framed) was still structurally the old layout and was rejected live
("no se parece nada con la C"). Second attempt also had "Pick up" with no more visual weight than a
paperwork checkbox despite being a real physical-custody milestone.

### What's live now
- Rebuilt `renderUnifiedTimeline()`'s render step (JS: `renderMapRow()`; CSS: `.lane-map*`,
  `.uring*`, `.u-destination`, `.u-waypoint`) to match the "Milestone Map" mockup the user picked
  from 3 live-published options: one card, a progress ring + "X of Y milestones done / Next: …"
  summary, then every real step as one continuous flat route (dropped the raised/curved connector
  treatment — flat dashed line throughout, matching the mockup) ending in Signature enlarged into a
  glowing gold "destination" pin.
- Added a second, smaller "waypoint" treatment (blue/urgent-glow, sized between a normal stop and
  the destination pin) on Pick Up specifically, per explicit follow-up ask ("darle mas significado
  al pickup").
- Zero business-logic changes: `entries[]` construction, `blinkIdx`, `travelerLineIdx`/`travelerType`
  (walker/truck), click handlers (`openDocPreview`, `advanceLoadStatus`, `signatureInfoClick`, etc.),
  and every done/wait/now state computation are byte-for-byte what they were before — verified live
  via the browser console against synthetic orders in 5+ states (early/in-progress/urgent, awaiting
  invoice, awaiting signature, fully closed) plus a real order (`BT-0019`) rendered through the
  actual `renderOrderCardBody`/`#orderDetailBody` DOM, confirming every button's `onclick` still
  fires (spot-checked `openDocPreview('PO', ...)` — opened the real PDF preview).

### Known gaps, deferred until asked
- User reported PO missing from the row plus a stray truncated digit and background bleed-through
  on a real screenshot; not reproduced despite faithful live testing (real order data, real modal
  DOM, real viewport) — asked the user for one more diagnostic detail (browser zoom, first-open vs.
  after an action, whether dragging the row left brings PO back) to chase it further. If it recurs,
  start there instead of re-guessing.

## 2026-09-12 — FOB region carry-through, Confirm PU rebuild, design-system cleanup (parallel window)

**Files changed:** `plants.html`, `orders.html`, `products.html`, `trading-tool.html`,
`supabase/functions/_shared/matching.ts`, `supabase/functions/plant-locations-create/index.ts`,
`supabase/functions/plant-locations-update/index.ts`, `supabase/functions/shipments-search/index.ts`,
`supabase/functions/shipments-set-pickup-location/index.ts` (new),
`supabase/migrations/20260912000000_add_region_to_plant_locations.sql` (new),
`supabase/migrations/20260912010000_add_pickup_location_to_shipments.sql` (new). 9 confirmed-dead
Edge Functions deleted to stay under the project's 100-function cap (see
`project_supabase_function_cap.md`). Ran in a separate window/session alongside the three entries
above — some early work here (a first pass at Order Detail's timeline layout) was independently
superseded once the other window landed the "Milestone Map" design; noted below rather than left
implicit.

### What was wrong
- `parseCityState` (shared by `plant-locations-create/update` and the price-apply path) never
  validated a trailing 2-letter token against real US state codes — a Smithfield price line ("FOB
  Midwest, LH Sept ship") parsed as city="Midwest", state="LH" and got inserted straight into the
  real `locations` catalog. Confirmed live: a bogus "Midwest LH" row existed, with two real
  Smithfield `plant_products` rows pointing at it as their pickup city.
- Plants whose price lists name a broad region ("FOB Midwest") instead of one city had no way to
  record that, and the client-side scanner (`detectPickupLocations`) swallowed trailing ship-month
  words into its suggestions ("Midwest October", "Midwest, LH Sep").
- Orders' "Confirm Load" (`confirmPickupReadyClick`) was WhatsApp-only, contacted the carrier OR
  the plant but never both on an FOB load, carried no order number in the message, and had no way
  to know which of a plant's several real pickup locations a given load was even shipping from —
  that fact was never carried from the price/quote through to the physical pickup step.
- Supabase's Edge Function count was at the project's hard 100 cap, blocking new deploys.
- Several dark-theme screens (plants/products/trading-tool) still had solid light-color leftovers
  (a filled green match-checkmark, light-blue/pink duplicate-comparison boxes, two `background:#fff`
  modal buttons in trading-tool.html misfiled under "frozen calculator, don't touch") — same root
  mistake as the white-background sweep from an earlier session, just a different set of colors.
- Load Prices review table repeated whatever price a plant re-sent verbatim, refreshing
  `price_date` with no way to tell "confirmed still current" from "actually changed."

### What's live now
1. **Root-cause fix, both layers**: `US_STATE_CODES` validation added to `parseCityState`
   (backend, the real last line of defense for every caller) and mirrored in plants.html's own
   `detectPickupLocations`/`extractLineFobLocation`, which also now recognizes a plant's own
   already-taught `plant_locations.region` values (e.g. "Midwest") as a distinct signal from a
   literal city — never a guessed/fixed enum. Live corruption cleaned up (nulled the bad
   `location_id` on the two affected Smithfield rows; left the historical rejected-location audit
   row in place). Smithfield's 4 real locations tagged `region = 'Midwest'` per explicit ask.
2. **Pickup location carries through automatically when known**: `shipments-search` now resolves
   `pickup_location` live via `sent_offers.us_freight_rate_id -> provider_rates.location_id ->
   plant_locations` (same plant_id) — no new column, so it can never drift from what the deal was
   actually priced on. When no city was ever known, a one-time manual pick (scoped to that plant's
   own real locations only) is asked for at Confirm Load itself — never earlier — and saved to the
   new `shipments.pickup_location_id` so it's asked once per order.
3. **Confirm Load rebuilt**: sends a real email (approved copy, see the copy-table memory) with the
   order number in the numbering format, to the resolved location's own contact (falling back to
   the plant's general email, then to the old WhatsApp-only path if neither has an email at all),
   CCing the carrier's email only when one is actually booked (FOB) — self-delivered loads never
   CC anyone. The old WhatsApp check-in is folded into the same email modal's WhatsApp button
   rather than removed.
4. **Edge Function headroom restored**: deleted 9 confirmed-dead functions (verified zero callers
   across every HTML file, every other Edge Function, and the real `cron.job` schedule before
   deleting any of them) — 100/100 down to 92/100 at the time, giving room for the new
   `shipments-set-pickup-location` function plus future work.
5. **Design-system leftovers fixed**: the match-checkmark badge and duplicate-comparison boxes in
   plants.html/products.html, and trading-tool.html's email-modal buttons, all converted to the
   same translucent-card + real-accent-color treatment already established elsewhere in each file
   (colors reused from each file's own existing tokens, never approximated from a different file).
6. **Load Prices duplicate-price detection**: Apply All now compares each row's incoming price
   against `plantProducts`' current on-file price before saving, and reports the two counts
   separately ("N price(s) updated. M unchanged — these same prices were already published, just
   reconfirmed today.") instead of one indistinguishable total. Still saves (price_date still
   moves to today — a real, useful "reconfirmed" fact), just no longer indistinguishable from a
   genuine change.

### Known gaps / superseded
- An early pass at Order Detail's timeline (grouping the 13-node row into 3 labeled lanes: Paperwork
  & Money / Physical Load / Closing, plus matching the picked mockup's emoji icons and a `.card` +
  `<h2>` wrapper) shipped in this window, but was independently superseded once the other window
  landed the "Milestone Map" redesign (see the entry above) — `renderUnifiedTimeline()` as it
  exists now is that later design, not the 3-lane version. No conflict, just noting it so this
  entry's timeline-related commits aren't mistaken for still-live behavior.
- East Coast region intentionally left untagged on any plant_locations row — no real city known
  yet for it; tag it for real once one is confirmed, never invent a placeholder.
- Region detected from a price line is currently display-only on the Load Prices review screen
  (no `plant_products` column stores it) — the deferred design question is exactly how a detected
  region should attach to a specific price row once that's asked for.

## 2026-09-12 — Packaging catalog: add/remove from the UI, same as Cut Name/Variation (parallel window)

**Files changed:** `products.html`, `supabase/functions/packaging-create/index.ts` (new),
`supabase/functions/packaging-delete/index.ts` (new),
`supabase/migrations/20260912020000_add_idempotency_key_to_packaging.sql` (new). Ran in a
separate window/session alongside the entries above.

### What was wrong
The Packaging dropdown (Add/Edit Product form) was 100% read-only. Cut Name and Variation — the
other two closed-catalog fields on the same form — already had `+`/🗑 UI to add or remove catalog
entries; Packaging had no create/delete API at all, so a new packaging type could only ever be
added by hand via direct SQL.

### What's live now
1. **`packaging-create`**: same near-duplicate discipline as `cut-names-create`/`variations-create`
   (case/typo-insensitive check, `override_duplicate_check` escape hatch, idempotency key). Unlike
   those two, packaging isn't scoped to a category (shared across every species), so the duplicate
   check runs against the whole table, not a category slice.
2. **`packaging-delete`**: unlike Cut Name/Variation (pure suggestion lists, no FK),
   `products.packaging_id` IS a real foreign key with no `ON DELETE` clause — the function checks
   `count(*) from products where packaging_id = id` up front and returns a clear "N products still
   use this" 409 instead of a raw Postgres FK-violation error.
3. `products.html`'s Packaging field now has the same `+`/🗑 buttons as Cut Name, wired to the two
   new functions.
4. Verified live end-to-end against staging before touching the UI: create, blocked-delete when in
   use (tried deleting "Box" — correctly blocked, reporting 52 products still use it), and a clean
   delete when unused all confirmed via direct API calls.

### Data changes (not code)
- Added two packaging catalog rows per explicit user spec: `IWP` (name = name_en = "IWP") and
  name_en `Wax` / name "Caja Encerada".
- Renamed 4 existing packaging `name_en` values per explicit user instruction (display casing only
  — the Spanish `name` column was untouched): Poly Bag → Poly, WAX → Wax, IWP → Iwp, VAC → Vac.

### Still open / deferred (not built yet)
- User asked to delete 5 old `cut_names` suggestion-catalog rows (Bellies #2, Bellies 13/15,
  Bellies 15/17, Backribs #2, 72% Trim) — confirmed zero FK from `products` on any of the five, so
  100% safe to remove. Could not execute the delete directly: Claude's write access is blocked from
  destructive DB operations by design, even with explicit user authorization given in chat. Pointed
  the user to the existing 🗑 "Remove cut names" modal in `products.html` (Cut Name field) to do it
  themselves — takes about 10 seconds. As of this entry, all 5 rows are still present in the live
  catalog.
