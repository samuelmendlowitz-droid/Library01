#!/usr/bin/env node
/**
 * Seed the Firestore globalLibrary collection from Open Library.
 *
 * Setup:
 *   1. npm install firebase-admin node-fetch
 *   2. Download your Firebase service account key:
 *      Firebase Console → Project Settings → Service Accounts → Generate New Private Key
 *      Save as serviceAccountKey.json in this scripts/ directory.
 *   3. node seed-global-library.js
 *
 * Tuning:
 *   TARGET_BOOKS  – how many unique books to write (default 50,000)
 *   BATCH_SIZE    – Firestore write batch size, max 500
 *   REQUEST_DELAY – ms between Open Library API requests (be polite: ≥1000ms)
 */

const admin = require('firebase-admin');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const TARGET_BOOKS  = 50_000;
const BATCH_SIZE    = 500;
const REQUEST_DELAY = 1_200; // ms between API calls
const PAGE_SIZE     = 100;   // Open Library results per request (max 100)

// ── Firebase init ─────────────────────────────────────────────────────────────
const keyPath = path.join(__dirname, 'serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(require(keyPath))
});
const db = admin.firestore();

// ── Helpers (must match app logic exactly) ────────────────────────────────────
function normalizeBookText(str = '') {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function createGlobalBookId(title, author) {
  return normalizeBookText(title) + '__' + normalizeBookText(author);
}

// ── Subjects to query — covers major genres broadly ──────────────────────────
const SUBJECTS = [
  'fiction', 'mystery', 'science_fiction', 'fantasy', 'romance', 'thriller',
  'biography', 'history', 'horror', 'literary_fiction', 'young_adult',
  'historical_fiction', 'science', 'philosophy', 'adventure', 'detective_fiction',
  'psychological_thriller', 'classic_literature', 'poetry', 'drama',
  'crime_fiction', 'dystopian', 'magical_realism', 'war', 'coming_of_age',
  'memoir', 'true_crime', 'economics', 'psychology', 'travel',
  'graphic_novels', 'short_stories', 'mythology', 'folklore',
  'political_science', 'sociology', 'self_help', 'spirituality', 'religion',
  'nature', 'humor', 'satire', 'espionage', 'western', 'gothic_fiction',
  'cyberpunk', 'steampunk', 'urban_fantasy', 'epic_fantasy', 'space_opera',
  'hard_science_fiction', 'alternate_history', 'paranormal', 'cozy_mystery',
  'legal_thriller', 'medical_thriller', 'action', 'survival', 'friendship',
  'family', 'love_stories', 'childrens', 'picture_books', 'middle_grade',
  'new_adult', 'erotica', 'food', 'cooking', 'art', 'music', 'film',
  'business', 'technology', 'mathematics', 'physics', 'biology', 'chemistry',
  'medicine', 'architecture', 'design', 'sports', 'parenting', 'education',
  'animals', 'environment', 'politics', 'law', 'military', 'journalism'
];

// ── Fetch with retry ──────────────────────────────────────────────────────────
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'LibraryApp/1.0 (seed script)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Write a batch of books to Firestore ───────────────────────────────────────
async function writeBooks(queue) {
  let written = 0;
  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const chunk = queue.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    chunk.forEach(book => {
      const ref = db.collection('globalLibrary').doc(book.id);
      batch.set(ref, book.data, { merge: true });
    });
    await batch.commit();
    written += chunk.length;
  }
  return written;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const seen = new Set();
  let totalWritten = 0;
  let queue = [];

  console.log(`Seeding up to ${TARGET_BOOKS.toLocaleString()} books from Open Library…\n`);

  outer:
  for (const subject of SUBJECTS) {
    let offset = 0;
    let subjectCount = 0;
    const maxPerSubject = 2_000; // cap per subject to spread across genres

    while (offset < maxPerSubject) {
      const url = `https://openlibrary.org/search.json?subject=${subject}&limit=${PAGE_SIZE}&offset=${offset}&fields=title,author_name&lang=eng`;

      let data;
      try {
        data = await fetchWithRetry(url);
      } catch (e) {
        console.warn(`  [${subject}] fetch error at offset ${offset}: ${e.message}`);
        break;
      }

      const docs = data.docs || [];
      if (!docs.length) break;

      for (const doc of docs) {
        const title  = (doc.title || '').trim();
        const author = (doc.author_name?.[0] || '').trim();
        if (!title || !author) continue;

        const id = createGlobalBookId(title, author);
        if (!id || id === '__' || seen.has(id)) continue;
        seen.add(id);

        queue.push({
          id,
          data: {
            title,
            normalizedTitle:  normalizeBookText(title),
            author,
            normalizedAuthor: normalizeBookText(author),
            series:           '',
            genres:           [],
            primaryGenre:     '',
            secondaryGenres:  [],
            genreScores:      {},
            updatedAt:        admin.firestore.FieldValue.serverTimestamp()
          }
        });

        if (queue.length >= BATCH_SIZE * 10) {
          totalWritten += await writeBooks(queue);
          queue = [];
          process.stdout.write(`\r  Written: ${totalWritten.toLocaleString()} / ${TARGET_BOOKS.toLocaleString()}   `);
        }

        if (seen.size >= TARGET_BOOKS) break outer;
      }

      subjectCount += docs.length;
      offset += PAGE_SIZE;
      await sleep(REQUEST_DELAY);
    }

    console.log(`  [${subject}] fetched ${subjectCount} — unique so far: ${seen.size.toLocaleString()}`);
    if (seen.size >= TARGET_BOOKS) break;
  }

  // Flush remaining
  if (queue.length) {
    totalWritten += await writeBooks(queue);
  }

  console.log(`\nDone. ${totalWritten.toLocaleString()} books written to Firestore globalLibrary.`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
