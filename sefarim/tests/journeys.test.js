// End-to-end checks for the Sefer prototype.
// Run: node sefarim/tests/journeys.test.js   (needs the `playwright` package and Chromium)
// The published page has no doctype of its own (the Artifact host adds one), so the
// test wraps it the same way before loading it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const SRC = path.join(__dirname, '..', 'index.html');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sefer-')), 'page.html');
fs.writeFileSync(tmp, '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + fs.readFileSync(SRC, 'utf8') + '</body></html>');
const URL = 'file://' + tmp;

let failures = 0;
function check(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text())) errors.push(m.text()); });
  await page.goto(URL + '#campaign');
  await page.waitForSelector('#item-chumash');

  const text = async sel => (await page.locator(sel).innerText()).replace(/\s+/g, ' ');
  const chumashFull = async () => Number(await page.locator('#item-chumash .counts div:nth-child(2) b').innerText());

  // Seeded state
  check((await text('#item-chumash')).includes('Chumash copy #25 · 50% sponsored — $20 remaining'), 'Seeded $40 Chumash with $20 shows "50% sponsored — $20 remaining"');
  const before = await chumashFull();
  check(before === 44, `Seeded Chumash fully funded = 44 (got ${before})`);
  const raisedBefore = await page.evaluate(() => campaignStats().raised);

  // Journey 1: Sponsor 10 Chumashim in memory of my grandfather
  await page.click('#item-chumash button[data-kind="whole"]');
  await page.waitForSelector('#sponsor-form');
  await page.fill('#f-qty', '10');
  await page.fill('#f-donor', 'Test Grandson');
  check(await page.isChecked('#ded-memory'), 'Dedication defaults to "In memory of"');
  await page.click('[data-action="memorial-example"]');
  const preview = await text('#preview-box');
  check(preview.includes('Shimon ben Avraham Ezriel') && preview.includes('שמעון בן אברהם עזריאל') && preview.includes('לעילוי נשמת'), 'Preview shows the exact memorial names in English and Hebrew');
  check((await page.inputValue('#f-honoree-he')) === 'שמעון בן אברהם עזריאל', 'Hebrew field holds the exact Hebrew name');
  check((await page.getAttribute('#f-honoree-he', 'dir')) === 'rtl', 'Hebrew input is right-to-left');
  check((await text('#summary-box')).includes('$400'), 'Summary total is $400 for 10 × $40');
  await page.click('#sponsor-form button[type="submit"]');
  await page.waitForSelector('[data-action="place"]');
  await page.click('[data-action="place"]');
  check(await page.locator('#review-errors li').count() === 1 && (await text('#review-errors')).includes('spelling'), 'Order is blocked until spelling is verified');
  await page.check('#f-verified');
  await page.click('[data-action="place"]');
  await page.waitForSelector('.test-stamp');
  const conf = await text('#app');
  check(/test confirmation/i.test(conf) && conf.includes('No payment was taken'), 'Confirmation is clearly labeled as a test with no charge');
  check(conf.includes('10 Chumash copies (#47–56)'), 'Confirmation lists the 10 allocated copies');
  check(conf.includes('Shimon ben Avraham Ezriel') && conf.includes('שמעון בן אברהם עזריאל'), 'Confirmation shows the dedication');
  check(conf.includes('Congregation Beis Avraham') && conf.includes('What happens next'), 'Confirmation shows destination and next steps');
  await page.goto(URL + '#campaign');
  check(await chumashFull() === 54, 'Campaign now shows 54 fully funded Chumashim');

  // Journey 2: complete the partially funded copy #25
  await page.click('#item-chumash .partial-row:has-text("#25") button');
  await page.waitForSelector('#f-amount');
  check((await page.inputValue('#f-amount')) === '20', 'Complete-this-copy pre-fills the $20 remaining');
  await page.fill('#f-amount', '25');
  await page.fill('#f-donor', 'Copy Completer');
  await page.click('#sponsor-form button[type="submit"]');
  check((await text('#flow-errors')).includes('needs only $20 more'), 'Overpaying a copy is rejected');
  await page.click('[data-action="fill-copy"]');
  check((await text('#summary-box')).includes('fully funded'), 'Summary shows the copy becoming fully funded');
  await page.click('#sponsor-form button[type="submit"]');
  await page.waitForSelector('[data-action="place"]');
  await page.click('[data-action="place"]');
  await page.waitForSelector('.test-stamp');
  check((await text('#app')).includes('Chumash copy #25 now fully funded'), 'Confirmation says copy #25 is now fully funded');
  check((await text('#app')).includes('does not receive an individual named sticker'), 'Partial contributor gets no named sticker');
  await page.goto(URL + '#campaign');
  check(await chumashFull() === 55, 'Fully funded Chumashim = 55 after completing copy #25');
  check(!(await text('#item-chumash')).includes('copy #25'), 'Copy #25 no longer listed as partial');
  const raisedAfter = await page.evaluate(() => campaignStats().raised);
  check(raisedAfter - raisedBefore === 42000, 'Money raised increased by exactly $420');

  // Limits
  const unfunded = await page.evaluate(() => lineStats('chumash').unfunded);
  await page.click('#item-chumash button[data-kind="whole"]');
  await page.fill('#f-qty', String(unfunded + 1));
  await page.fill('#f-donor', 'Too Many');
  await page.click('#sponsor-form button[type="submit"]');
  check((await text('#flow-errors')).includes(`Only ${unfunded} Chumash copies still need a sponsor`), 'Quantity above remaining need is rejected');
  const dup = await page.evaluate(() => { const d = newDraft('copy', 'chumash'); d.copyNo = 25; d.amountStr = '5'; d.donorName = 'Dup'; return placeOrder(d); });
  check(!dup.ok && dup.errors.join(' ').includes('already fully sponsored'), 'A fully funded copy cannot be funded again');
  const general = await page.evaluate(() => { const d = newDraft('general'); d.amountStr = String(campaignStats().remainingNeed / 100 + 1); d.donorName = 'Big'; return placeOrder(d); });
  check(!general.ok, 'Unrestricted gift above remaining need is rejected');

  // Totals agree across screens
  const totals = await page.evaluate(() => { const s = campaignStats(); return { raised: s.raised, sumLedger: S.contributions.reduce((a, c) => a + c.amount, 0), parts: s.lineFunded + s.general, req: s.requested }; });
  check(totals.raised === totals.sumLedger && totals.raised === totals.parts, 'Raised = ledger sum = item funding + unrestricted');
  check(totals.req === 300, 'Sample campaign requests 300 sefarim');
  const supSum = await page.evaluate(() => S.supporters.reduce((a, s) => a + supporterStats(s.id).raised, 0) <= campaignStats().raised);
  check(supSum, 'Supporter page totals are a subset of the campaign total (no double counting)');

  // Closing
  await page.goto(URL + '#organizer');
  await page.click('[data-tab="campaign"]');
  await page.click('[data-action="close-campaign"]');
  const cl = await page.evaluate(() => S.campaign.closing);
  check(cl.finalFull + cl.unfunded === cl.requested, 'Closing: funded + unfunded = requested');
  check((await text('#app')).includes('Requires a final policy'), 'Closing shows leftover balance as requiring a final policy');
  await page.goto(URL + '#campaign');
  check(await page.locator('#item-chumash button[data-kind="whole"]').isDisabled(), 'Sponsor buttons disabled after closing');

  // Every route renders; nothing scrolls sideways on a phone
  await page.setViewportSize({ width: 390, height: 844 });
  for (const r of ['home', 'campaign', 'institution-beis-avraham', 'institution-darchei-noam', 'supporter-rivka', 'sponsor', 'review', 'confirmation', 'start-campaign', 'register', 'organizer', 'operations', 'roadmap']) {
    await page.goto(URL + '#' + r);
    await page.waitForTimeout(50);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(over <= 0, `#${r} has no horizontal scroll at 390px (overflow ${over}px)`);
  }
  await page.screenshot({ path: path.join(path.dirname(tmp), 'mobile-roadmap.png') });

  check(errors.length === 0, 'No script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
