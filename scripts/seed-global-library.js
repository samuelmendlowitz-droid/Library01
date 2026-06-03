#!/usr/bin/env node
/**
 * Seed the Firestore globalLibrary collection from Open Library.
 *
 * Setup:
 *   1. npm install firebase-admin node-fetch
 *   2. Save serviceAccountKey.json in this scripts/ directory.
 *   3. node seed-global-library.js
 *
 * Tuning:
 *   TARGET_BOOKS    – unique books to write (default 500,000)
 *   CONCURRENCY     – parallel subject fetches (default 3)
 *   MAX_PER_SUBJECT – max books fetched per subject before moving on
 *   PAGE_SIZE       – Open Library results per request (max 1000)
 *   BATCH_SIZE      – Firestore write batch size (max 500)
 */

const admin = require('firebase-admin');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const path  = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const TARGET_BOOKS    = 500_000;
const CONCURRENCY     = 3;       // parallel subject workers
const MAX_PER_SUBJECT = 5_000;   // cap per subject to spread across genres
const PAGE_SIZE       = 500;     // Open Library supports up to 1000
const BATCH_SIZE      = 500;     // Firestore max per batch

// ── Firebase init ─────────────────────────────────────────────────────────────
const keyPath = path.join(__dirname, 'serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
const db = admin.firestore();

// ── Helpers (must match app logic exactly) ────────────────────────────────────
function normalizeBookText(str = '') {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function createGlobalBookId(title, author) {
  return normalizeBookText(title) + '__' + normalizeBookText(author);
}

// ── Subjects ──────────────────────────────────────────────────────────────────
const SUBJECTS = [
  // Core fiction
  'fiction', 'literary_fiction', 'classic_literature', 'short_stories',
  'mystery', 'detective_fiction', 'cozy_mystery', 'noir',
  'science_fiction', 'hard_science_fiction', 'space_opera', 'cyberpunk', 'steampunk',
  'fantasy', 'epic_fantasy', 'urban_fantasy', 'dark_fantasy',
  'romance', 'historical_romance', 'paranormal_romance', 'contemporary_romance',
  'thriller', 'psychological_thriller', 'legal_thriller', 'medical_thriller',
  'horror', 'gothic_fiction', 'supernatural',
  'historical_fiction', 'alternate_history', 'war',
  'adventure', 'action', 'survival', 'dystopian', 'post_apocalyptic',
  'magical_realism', 'mythology', 'folklore',
  'coming_of_age', 'espionage', 'western', 'crime_fiction',
  'time_travel', 'vampires', 'zombies', 'paranormal',
  // Age categories
  'young_adult', 'middle_grade', 'childrens', 'new_adult',
  // Nonfiction narrative
  'biography', 'autobiography', 'memoir', 'true_crime',
  'history', 'ancient_history', 'medieval_history', 'modern_history',
  'military_history', 'world_war_ii', 'american_history', 'british_history',
  // Social sciences
  'psychology', 'sociology', 'philosophy', 'political_science', 'economics',
  'anthropology', 'archaeology', 'education', 'law',
  // Natural sciences & tech
  'science', 'physics', 'chemistry', 'biology', 'medicine', 'mathematics',
  'astronomy', 'ecology', 'technology', 'computers',
  // Culture & arts
  'art', 'architecture', 'music', 'film', 'photography', 'criticism',
  'journalism', 'poetry', 'drama', 'graphic_novels',
  // Practical & lifestyle
  'self_help', 'business', 'finance', 'management',
  'cooking', 'food', 'travel', 'sports', 'health',
  'parenting', 'relationships', 'spirituality', 'religion',
  'nature', 'environment', 'animals',
  // Misc broad tags
  'humor', 'satire', 'essays',
  'american_literature', 'british_literature', 'world_literature',
  'classics', 'pulp_fiction', 'anthology',
  'love_stories', 'friendship', 'family', 'political',
  'detective', 'police', 'courtroom', 'social',
];

// ── Fetch with retry ──────────────────────────────────────────────────────────
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'LibraryApp/1.0 (book seeding script; contact: admin)' }
      });
      if (res.status === 429) {
        const wait = 10_000 * (i + 1);
        console.warn(`\n  [rate limit] waiting ${wait/1000}s…`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(3_000 * (i + 1));
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Shared state (JS single-threaded — safe for concurrent async workers) ─────
const seen  = new Set();
let queue   = [];
let totalWritten = 0;
let flushLock = false;

async function addBook(title, author) {
  if (seen.size >= TARGET_BOOKS) return false;
  const id = createGlobalBookId(title, author);
  if (!id || id === '__' || seen.has(id)) return false;
  seen.add(id);
  queue.push({
    id,
    data: {
      title,
      normalizedTitle:  normalizeBookText(title),
      author,
      normalizedAuthor: normalizeBookText(author),
      series: '', genres: [], primaryGenre: '', secondaryGenres: [], genreScores: {},
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }
  });
  if (queue.length >= BATCH_SIZE * 4 && !flushLock) await flushQueue();
  return true;
}

async function flushQueue() {
  if (flushLock || !queue.length) return;
  flushLock = true;
  const toWrite = queue.splice(0, Math.floor(queue.length / BATCH_SIZE) * BATCH_SIZE || queue.length);
  try {
    for (let i = 0; i < toWrite.length; i += BATCH_SIZE) {
      const chunk = toWrite.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      chunk.forEach(b => batch.set(db.collection('globalLibrary').doc(b.id), b.data, { merge: true }));
      await batch.commit();
      totalWritten += chunk.length;
    }
    process.stdout.write(`\r  Written: ${totalWritten.toLocaleString()} / ${TARGET_BOOKS.toLocaleString()}   `);
  } catch(e) {
    console.error('\n  Firestore write error:', e.message);
    // Put books back
    queue.unshift(...toWrite);
  }
  flushLock = false;
}

// ── Per-subject worker ────────────────────────────────────────────────────────
async function processSubject(subject) {
  let offset = 0;
  let fetched = 0;
  while (offset < MAX_PER_SUBJECT && seen.size < TARGET_BOOKS) {
    const url = `https://openlibrary.org/search.json?subject=${subject}&limit=${PAGE_SIZE}&offset=${offset}&fields=title,author_name&lang=eng`;
    let data;
    try {
      data = await fetchWithRetry(url);
    } catch(e) {
      console.warn(`\n  [${subject}@${offset}] fetch error: ${e.message}`);
      break;
    }
    const docs = data.docs || [];
    if (!docs.length) break;
    for (const doc of docs) {
      const title  = (doc.title || '').trim();
      const author = (doc.author_name?.[0] || '').trim();
      if (title && author) await addBook(title, author);
    }
    fetched += docs.length;
    offset  += PAGE_SIZE;
  }
  console.log(`\n  [${subject}] fetched ${fetched} — unique total: ${seen.size.toLocaleString()}`);
}

// ── Concurrency pool ──────────────────────────────────────────────────────────
async function runPool(subjects, concurrency) {
  let idx = 0;
  async function worker() {
    while (idx < subjects.length && seen.size < TARGET_BOOKS) {
      const subject = subjects[idx++];
      await processSubject(subject);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Seeding up to ${TARGET_BOOKS.toLocaleString()} books with ${CONCURRENCY} parallel workers…\n`);
  const start = Date.now();
  await runPool(SUBJECTS, CONCURRENCY);
  // Final flush
  await flushQueue();
  if (queue.length) {
    // flush any remainder smaller than BATCH_SIZE
    const batch = db.batch();
    queue.forEach(b => batch.set(db.collection('globalLibrary').doc(b.id), b.data, { merge: true }));
    await batch.commit();
    totalWritten += queue.length;
  }
  const mins = ((Date.now() - start) / 60_000).toFixed(1);
  console.log(`\nDone. ${totalWritten.toLocaleString()} books written in ${mins} min.`);
  process.exit(0);
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
