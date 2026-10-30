# Sefer: sefarim sponsorship prototype

**Sefer** is a temporary platform name. Tagline: *Give learning a lasting home.*

> Create a campaign to provide sefarim to your shul or school. Invite others to participate. We handle the sefarim, personal dedications, and delivery.

The concept is Abe Mendlowitz's. Samuel Mendlowitz now develops and manages it.

This folder holds a **working demonstration prototype**. It covers the whole journey: institution, campaign, supporter pages, sponsorship with dedication preview, test checkout, organizer dashboard and operations dashboard. It does **not** take payments, issue receipts, register anyone, send email or store records.

## Where it came from

The earlier prototype (`sefarim-giving.dewyhinny15.chatgpt.site`) is behind a ChatGPT sign-in. It returned "401 Log in to access" and could not be inspected. This build is a **recreation from the written brief**, not a copy of that site. If its original source files are found, compare them with this build and carry over wording or layout as needed.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | The whole app: HTML, CSS and JavaScript in one file. No build step. |
| `tests/journeys.test.js` | Playwright end-to-end checks of the required journeys and business rules. |
| `README.md` | This handoff. |

`index.html` has no `<!doctype>`, `<html>`, `<head>` or `<body>` tags. The claude.ai Artifact host adds them when publishing. To host it anywhere else, wrap it the same way `tests/journeys.test.js` does: add `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>` before it and `</body></html>` after it.

## Running and testing

```bash
# open locally: wrap as above, or just run the tests (they wrap it for you)
npm i -D playwright && npx playwright install chromium   # once, if not already installed
node sefarim/tests/journeys.test.js
```

The tests cover:

- **"Sponsor 10 Chumashim in memory of my grandfather."** Uses the exact memorial name *Shimon ben Avraham Ezriel* / *שמעון בן אברהם עזריאל*, checks the right-to-left Hebrew input and the preview, requires spelling verification, and checks that the test confirmation lists the copies, dedication, destination and next steps.
- **Completing a partially funded copy.** Chumash copy #25 starts at "50% sponsored — $20 remaining". The test checks that overpaying it is rejected, and that completing it moves it to fully funded with no named sticker.
- **Business rules.** Quantity can't exceed the remaining need, a funded copy can't be funded twice, unrestricted gifts are capped, totals agree across screens, supporter gifts aren't double counted, and closing gives funded + unfunded = requested.
- **Mobile layout.** No horizontal scrolling at 390 px on any page.

## Pages (hash routes)

| Route | Page |
| --- | --- |
| `#home` | Service explanation, with three actions: Sponsor sefarim, Start a campaign, Register an institution |
| `#institution-beis-avraham`, `#institution-darchei-noam` | Institution profile, location, approved needs, campaigns, and a community request form (needs representative approval) |
| `#campaign` | Campaign title and dedication, institution and destination, dates, progress, requested sefarim with Sponsor buttons, partial copies, supporter pages, then the story, image and policies |
| `#supporter-rivka`, `#supporter-dovid`, `#supporter-yossi` | Supporter fundraising pages |
| `#sponsor` → `#review` → `#confirmation` | Sponsorship flow, order review, test confirmation |
| `#start-campaign`, `#register` | Demo forms (nothing is saved) |
| `#organizer` | Profile, needs and approvals, dates and goals, closing, supporters and invitations, funding, dedication approvals, delivery, sticker referral setting |
| `#operations` | Products and costs, orders and allocations, proofing, purchasing, preparation, shipments, revenue and direct costs |
| `#roadmap` | What's demo, what's required before launch, open policies, future features |

## How the code is organized (`index.html` script)

- **Constants:** `PRODUCTS` (retail and wholesale prices in **cents**), `COST_ASSUMPTIONS`, the status lists, `MEMORIAL_EXAMPLE`.
- **`seed()`:** builds all demonstration data. The sample campaign requests **300 sefarim**: 100 Chumash at $40, 120 Siddur at $20, 50 Tehillim at $15 and 30 Gemara Berachos at $35, for a goal of **$8,200**. Seed gifts go through the same `placeOrder()` path as real test orders.
- **Ledger:** `S.contributions` is the single source of truth. Each contribution records its `allocations`, which say exactly which copy got how many cents. All progress figures (`copiesOf`, `lineStats`, `campaignStats`, `supporterStats`, `stageCounts`) are derived from it. No screen has hardcoded totals.
- **Sponsorship types** (`kind`):
  - `whole`: takes unfunded copies, may have a personal dedication.
  - `type`: an amount toward one sefer. It fills partly funded copies nearest completion first, then new copies.
  - `copy`: an amount toward one specific copy.
  - `general`: unrestricted, allocated at closing.
- **Rules** (`validateDraft`, re-checked inside `placeOrder`):
  - A copy counts as fully funded only at full price.
  - Quantities can't exceed unfunded copies, and amounts can't exceed what remains.
  - The order button disables itself, so a double click can't place an order twice.
- **Closing** (`computeClosing`), the disclosed policy:
  1. Partial gifts within each sefer are combined into complete copies.
  2. Unrestricted money completes remaining partial copies, nearest to completion first.
  3. Leftover unrestricted money buys whole copies in the order the sefarim are listed.
  4. Any balance too small to buy another sefer is flagged **"Requires a final policy"**.
- **Separate status types:**
  - Fundraising: Draft / Scheduled / Open / Closed (campaign).
  - Dedication: Awaiting text / Awaiting approval / Approved / Correction needed (per order).
  - Fulfillment: Funded / Ordered / Prepared / Shipped / Delivered (per order). An order can't be marked Prepared until its dedication is Approved.
- **Rendering:** one `page*()` function per route returns HTML. `render()` swaps it in. Clicks, inputs, changes and form submits are handled by delegated listeners at the bottom of the script. All user text goes through `esc()`.

## Demonstration-only (must not be presented as working)

- Payments and checkout: no card fields, no charges. Confirmations are labeled "Test confirmation · no charge".
- Tax receipts: none. No promise of tax deductibility anywhere.
- Institution registration and verification, organizer, donor and supporter accounts.
- Email: confirmations, proofs, invitations and reminders.
- Persistence: all changes live in the browser tab and reset on reload.
- All institutions, people, addresses, prices, wholesale costs and cost assumptions are sample data.

## Required before accepting real sponsorships

1. **Decide who legally receives payment** (the platform as retailer, the institution, or a fiscal sponsor) and **what receipt is issued**. Get legal and tax advice. Do not promise tax deductibility.
2. Choose a payment processor. Build real checkout, refunds, failed-payment handling and fee treatment.
3. A backend database with accounts and roles (donor, supporter, organizer, institution representative, operations), an audit trail, and **server-side** enforcement of copy-level funding limits inside transactions.
4. Institution verification and representative approval workflows.
5. Transactional email (confirmation, dedication proof and approval, shipping).
6. Real catalog and supplier costs. Final upgrade prices for binding and gold stamping.
7. Terms of service, a privacy policy, and a refund and cancellation policy.

## Open policy decisions

- Leftover balance at closing that is too small for another sefer.
- Shipping: eligible regions, timing, who pays below the proposed $500 free-shipping threshold.
- Upgrade prices.
- Who absorbs processing fees.
- Recognition for partial contributors (they get no individual named stickers).

## Future features (planned, not built)

- Donors pre-fund quantities for institutions to claim, with limits per institution.
- Sefer Torah sponsorships: letters, words, dapim, parshiyos, entire sefarim, accessories and celebration expenses.
- Libraries, furnishings, mikvaos, catering and communal projects.
- Platform-arranged vendors, or vendors the organizer selects.
- A separate marketplace for pre-owned and antique sefarim: fixed-price sales, auctions and free giveaways.
- Paid marketplace sellers allocate 20%–100% of proceeds to a selected eligible organization. The calculation basis and fees are undecided.
- Verified individual assistance requests with privacy protections.

## Suggested path to production

Keep this file as the design and behavior reference. Rebuild it as a small web app, for example Next.js or SvelteKit with Postgres. Port `computeClosing`, `planAllocations` and `validateDraft` into server code with tests, and run allocations inside database transactions. Then add payments only after the legal recipient and receipt questions are settled.
