#!/usr/bin/env node
/**
 * Seed Firestore globalLibrary from Open Library bulk data dumps.
 *
 * Downloads authors (~500 MB) and works (~2.5 GB) dumps to /tmp/ol_seed/,
 * then processes them locally. Cached files are reused on restart unless
 * --redownload is passed.
 *
 * Setup:  serviceAccountKey.json must be in this directory
 * Run:    node --max-old-space-size=4096 seed-from-dump.js
 *
 * Flags:  --target=N      override book target (default 5000000)
 *         --test          dry-run: process books, write nothing to Firestore
 *         --resume        skip books already in Firestore and continue
 *         --skip=N        manually skip first N valid works
 *         --redownload    force re-download even if cached files exist
 *
 * Books are written without genres (Open Library subjects are too noisy).
 * User-verified genres come from personal library syncs in the app.
 * Each book gets popularity: 0; run migrate-popularity.js afterwards to
 * apply correct scores from existing user libraries.
 */

const admin  = require('firebase-admin');
const zlib   = require('zlib');
const rl_mod = require('readline');
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

// Force line-buffered stdout so every log line hits disk immediately.
process.stdout._handle && process.stdout._handle.setBlocking(true);

// ── Config ────────────────────────────────────────────────────────────────────
const args        = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/,'').split('=')));
const TARGET      = parseInt(args.target || '5000000');
const DRY_RUN     = 'test' in args;
const RESUME      = 'resume' in args;
const REDOWNLOAD  = 'redownload' in args;
const SKIP        = args.skip ? parseInt(args.skip) : 0;
const BATCH_SIZE  = 100;
const CONCURRENCY = 10;
const FLUSH_AT    = 2000;
const LOG_EVERY   = 50000;

const CACHE_DIR  = '/tmp/ol_seed';
const AUTHOR_GZ  = path.join(CACHE_DIR, 'authors.txt.gz');
const WORKS_GZ   = path.join(CACHE_DIR, 'works.txt.gz');
const AUTHOR_URL = 'https://openlibrary.org/data/ol_dump_authors_latest.txt.gz';
const WORKS_URL  = 'https://openlibrary.org/data/ol_dump_works_latest.txt.gz';

if (DRY_RUN) console.log('[DRY RUN — nothing will be written to Firestore]\n');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ── Firebase ──────────────────────────────────────────────────────────────────
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });
const db = admin.firestore();

// ── Helpers ───────────────────────────────────────────────────────────────────
function norm(s = '')         { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function bookId(title, author){ return norm(title) + '__' + norm(author); }

function isBad(title, author) {
  const t = title.toLowerCase(), a = (author||'').toLowerCase();
  const junk = ['test','untitled','unknown','n/a','none','anonymous','asdf','foo','bar'];
  if (junk.includes(t) || junk.includes(a)) return true;
  if (t.length < 2 || a.length < 2) return true;
  return false;
}

function isMostlyNonLatin(s) {
  const hi = [...s].filter(c => c.charCodeAt(0) > 591).length;
  return hi > s.length * 0.35;
}

// ── HTTP download to file ─────────────────────────────────────────────────────
function getStream(url, hops = 8) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'LibraryApp/1.0 (OL bulk seed; mailto:admin@example.com)' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (!hops) return reject(new Error('Too many redirects'));
        resolve(getStream(res.headers.location, hops - 1));
      } else if (res.statusCode === 200) {
        resolve(res);
      } else {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
    });
    req.on('error', reject);
  });
}

async function downloadToFile(url, destPath, label) {
  if (!REDOWNLOAD && fs.existsSync(destPath)) {
    const mb = Math.round(fs.statSync(destPath).size / 1024 / 1024);
    console.log(`  Using cached ${label} (${mb} MB) — pass --redownload to refresh`);
    return;
  }
  console.log(`  Downloading ${label}…`);
  const t   = Date.now();
  const res = await getStream(url);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    let bytes = 0;
    res.on('data', chunk => { bytes += chunk.length; });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => {
      const mb   = Math.round(bytes / 1024 / 1024);
      const secs = ((Date.now() - t) / 1000).toFixed(1);
      console.log(`  Downloaded ${mb} MB in ${secs}s`);
      resolve();
    });
    res.pipe(out);
  });
}

// ── Read lines from a local .gz file ─────────────────────────────────────────
function openGzLines(filePath) {
  const gunzip = zlib.createGunzip();
  const input  = fs.createReadStream(filePath);
  input.on('error', e => gunzip.destroy(e));
  return rl_mod.createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity });
}

// ── Firestore write ───────────────────────────────────────────────────────────
let totalWritten = 0;

async function flush(queue) {
  if (DRY_RUN || !queue.length) return;
  const batches = [];
  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const chunk = queue.slice(i, i + BATCH_SIZE);
    const b = db.batch();
    chunk.forEach(doc => b.set(db.collection('globalLibrary').doc(doc.id), doc.data));
    batches.push(b.commit().catch(e =>
      new Promise(r => setTimeout(r, 2000))
        .then(() => b.commit())
        .catch(e2 => console.error('  [batch error]', e2.message))
    ));
    if (batches.length >= CONCURRENCY) await Promise.all(batches.splice(0));
  }
  await Promise.all(batches);
  totalWritten += queue.length;
}

// ── Phase 1: Build author key → name map ─────────────────────────────────────
async function buildAuthorMap() {
  const t  = Date.now();
  const rl = openGzLines(AUTHOR_GZ);
  const map = new Map();

  for await (const line of rl) {
    if (!line.startsWith('/type/author\t')) continue;
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    try {
      const data = JSON.parse(parts.slice(4).join('\t'));
      if (data.key && data.name && typeof data.name === 'string' && data.name.trim()) {
        map.set(data.key, data.name.trim());
      }
    } catch {}
  }

  const secs = ((Date.now() - t) / 1000).toFixed(1);
  const mb   = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  console.log(`  ${map.size.toLocaleString()} authors loaded in ${secs}s  (heap: ${mb} MB)\n`);
  return map;
}

// ── Phase 2: Stream works, join authors, write ────────────────────────────────
async function processWorks(authorMap, skipCount) {
  const t      = Date.now();
  const rl     = openGzLines(WORKS_GZ);
  const seen   = new Set();
  let queue    = [];
  let skipped  = 0;
  let skipping = skipCount;

  if (skipping > 0) {
    console.log(`  Resuming — skipping first ${skipping.toLocaleString()} already-written works…`);
  }

  for await (const line of rl) {
    if (seen.size - skipping >= TARGET - skipCount) break;
    if (!line.startsWith('/type/work\t')) continue;

    const tab4 = (() => {
      let n = 0, i = 0;
      while (i < line.length) { if (line[i] === '\t' && ++n === 4) return i; i++; }
      return -1;
    })();
    if (tab4 < 0) continue;

    try {
      const data = JSON.parse(line.slice(tab4 + 1));
      const title = (data.title || '').trim();
      if (!title || isMostlyNonLatin(title)) { skipped++; continue; }

      const authorKey = data.authors?.[0]?.author?.key;
      if (!authorKey) { skipped++; continue; }
      const author = authorMap.get(authorKey);
      if (!author || isMostlyNonLatin(author)) { skipped++; continue; }

      if (isBad(title, author)) { skipped++; continue; }

      const id = bookId(title, author);
      if (!id || id === '__' || id.length < 4 || seen.has(id)) continue;
      seen.add(id);

      if (skipping > 0) { skipping--; continue; }

      queue.push({
        id,
        data: {
          title,
          normalizedTitle:  norm(title),
          author,
          normalizedAuthor: norm(author),
          series:           '',
          genres:           [],
          primaryGenre:     '',
          secondaryGenres:  [],
          genreScores:      {},
          popularity:       0,
          updatedAt:        admin.firestore.FieldValue.serverTimestamp()
        }
      });

      if (queue.length >= FLUSH_AT) {
        await flush(queue.splice(0));
        const n = skipCount + totalWritten;
        if (n % LOG_EVERY < FLUSH_AT) {
          const elapsed = ((Date.now() - t) / 60000).toFixed(1);
          const rate    = Math.round(totalWritten / ((Date.now() - t) / 1000)) || 1;
          const eta     = Math.round((TARGET - n) / rate / 60);
          console.log(`  ${n.toLocaleString().padStart(9)} / ${TARGET.toLocaleString()}  |  ${elapsed} min  |  ~${eta} min left  |  ${rate} books/s`);
        }
      }
    } catch {}
  }

  if (queue.length) await flush(queue);
  const elapsed = ((Date.now() - t) / 60000).toFixed(1);
  console.log(`\n  Works phase done in ${elapsed} min. Skipped ${skipped.toLocaleString()} (no author/non-Latin/filtered).`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nOpen Library bulk seed — target: ${TARGET.toLocaleString()} books\n${'─'.repeat(60)}`);
  const start = Date.now();

  // Download dumps to disk (skipped if cached files exist)
  console.log('Downloading dump files to disk…');
  await downloadToFile(AUTHOR_URL, AUTHOR_GZ, 'authors (~500 MB)');
  await downloadToFile(WORKS_URL,  WORKS_GZ,  'works (~2.5 GB)');
  console.log();

  // Resume: count existing Firestore docs and skip that many works
  let skipCount = SKIP;
  if (RESUME && !DRY_RUN) {
    console.log('Counting existing Firestore docs…');
    const snap = await db.collection('globalLibrary').count().get();
    skipCount = snap.data().count;
    console.log(`  Found ${skipCount.toLocaleString()} existing books — resuming from there.\n`);
  }

  const authorMap = await buildAuthorMap();
  await processWorks(authorMap, skipCount);

  const mins = ((Date.now() - start) / 60000).toFixed(1);
  const n = DRY_RUN ? '(dry run)' : (skipCount + totalWritten).toLocaleString();
  console.log(`\n${'─'.repeat(60)}\nDone. ${n} books total in ${mins} minutes.`);
  process.exit(0);
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
