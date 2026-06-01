#!/usr/bin/env node
/**
 * Seed Firestore globalLibrary from Open Library bulk data dumps.
 *
 * Downloads ~500 MB (authors) + ~2.5 GB (works) — streamed, not saved to disk.
 * Writes titles, authors, and any subjects/genres available in the works data.
 *
 * Setup:  serviceAccountKey.json must be in this directory
 * Run:    node --max-old-space-size=4096 seed-from-dump.js
 *
 * Flags:  --target=N   override book target (default 5000000)
 *         --test       dry-run: process 2000 books, write nothing to Firestore
 */

const admin  = require('firebase-admin');
const zlib   = require('zlib');
const rl_mod = require('readline');
const https  = require('https');
const http   = require('http');
const path   = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const args        = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/,'').split('=')));
const TARGET      = parseInt(args.target || '5000000');
const DRY_RUN     = 'test' in args;
const BATCH_SIZE  = 100;   // docs per Firestore batch commit
const CONCURRENCY = 10;    // parallel batch commits during flush
const FLUSH_AT    = 2000;  // flush queue when it reaches this size
const LOG_EVERY   = 50000; // progress log interval

const AUTHOR_URL = 'https://openlibrary.org/data/ol_dump_authors_latest.txt.gz';
const WORKS_URL  = 'https://openlibrary.org/data/ol_dump_works_latest.txt.gz';

if (DRY_RUN) console.log('[DRY RUN — nothing will be written to Firestore]\n');

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

// ── HTTP with redirect following ──────────────────────────────────────────────
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

async function streamLines(url, label) {
  console.log(`Downloading ${label}…`);
  const stream = await getStream(url);
  const gunzip = zlib.createGunzip();
  const rl = rl_mod.createInterface({ input: stream.pipe(gunzip), crlfDelay: Infinity });
  return rl;
}

// ── Firestore write ───────────────────────────────────────────────────────────
let totalWritten = 0;

async function flush(queue) {
  if (DRY_RUN || !queue.length) return;
  const batches = [];
  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const chunk = queue.slice(i, i + BATCH_SIZE);
    const b = db.batch();
    chunk.forEach(doc => b.set(db.collection('globalLibrary').doc(doc.id), doc.data, { merge: true }));
    batches.push(b.commit().catch(e => {
      // On transient error, retry once after 2s
      return new Promise(r => setTimeout(r, 2000))
        .then(() => b.commit())
        .catch(e2 => console.error('  [batch error]', e2.message));
    }));
    // Limit concurrency
    if (batches.length >= CONCURRENCY) {
      await Promise.all(batches.splice(0));
    }
  }
  await Promise.all(batches);
  totalWritten += queue.length;
}

// ── Phase 1: Build author key → name map ─────────────────────────────────────
async function buildAuthorMap() {
  const t = Date.now();
  const rl = await streamLines(AUTHOR_URL, 'authors dump (~500 MB)');
  const map = new Map();

  for await (const line of rl) {
    if (!line.startsWith('/type/author\t')) continue;
    // format: /type/author \t key \t revision \t date \t json
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    try {
      const data = JSON.parse(parts.slice(4).join('\t')); // rejoin in case JSON has tabs
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
async function processWorks(authorMap) {
  const t   = Date.now();
  const rl  = await streamLines(WORKS_URL, 'works dump (~2.5 GB)');
  const seen = new Set();
  let queue  = [];
  let skipped = 0;

  for await (const line of rl) {
    if (seen.size >= TARGET) break;
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

      const rawGenres = (data.subjects || [])
        .filter(s => typeof s === 'string' && s.length <= 40)
        .slice(0, 5);

      queue.push({
        id,
        data: {
          title,
          normalizedTitle:  norm(title),
          author,
          normalizedAuthor: norm(author),
          series:           '',
          genres:           rawGenres,
          primaryGenre:     rawGenres[0] || '',
          secondaryGenres:  rawGenres.slice(1, 3),
          genreScores:      {},
          updatedAt:        admin.firestore.FieldValue.serverTimestamp()
        }
      });

      if (queue.length >= FLUSH_AT) {
        await flush(queue.splice(0));
        const n = DRY_RUN ? seen.size : totalWritten;
        if (n % LOG_EVERY < FLUSH_AT) {
          const elapsed = ((Date.now() - t) / 60000).toFixed(1);
          const rate    = Math.round((DRY_RUN ? seen.size : totalWritten) / ((Date.now() - t) / 1000));
          const eta     = rate ? Math.round((TARGET - n) / rate / 60) : '?';
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
  const target = DRY_RUN ? 2000 : TARGET;
  console.log(`\nOpen Library bulk seed — target: ${target.toLocaleString()} books\n${'─'.repeat(60)}`);
  const start = Date.now();

  const authorMap = await buildAuthorMap();
  await processWorks(authorMap);

  const mins = ((Date.now() - start) / 60000).toFixed(1);
  const n = DRY_RUN ? '(dry run)' : totalWritten.toLocaleString();
  console.log(`\n${'─'.repeat(60)}\nDone. ${n} books written in ${mins} minutes.`);
  process.exit(0);
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
