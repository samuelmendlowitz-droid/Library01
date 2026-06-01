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
const TARGET_BOOKS  = 500_000;
const BATCH_SIZE    = 500;
const REQUEST_DELAY = 1_000; // ms between Open Library API requests
const PAGE_SIZE     = 500;   // Open Library supports up to 1000 per request

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

// ── Subjects to query — broad coverage for large-scale seeding ───────────────
const SUBJECTS = [
  // Core fiction genres
  'fiction', 'literary_fiction', 'classic_literature', 'short_stories',
  'mystery', 'detective_fiction', 'cozy_mystery', 'noir',
  'science_fiction', 'hard_science_fiction', 'space_opera', 'cyberpunk', 'steampunk',
  'fantasy', 'epic_fantasy', 'urban_fantasy', 'dark_fantasy', 'fairy_tales',
  'romance', 'historical_romance', 'paranormal_romance', 'contemporary_romance',
  'thriller', 'psychological_thriller', 'legal_thriller', 'medical_thriller', 'spy',
  'horror', 'gothic_fiction', 'supernatural', 'occult',
  'historical_fiction', 'alternate_history', 'war',
  'adventure', 'action', 'survival', 'dystopian', 'post_apocalyptic',
  'magical_realism', 'mythology', 'folklore', 'fairy_tales',
  'coming_of_age', 'bildungsroman',
  // Age categories
  'young_adult', 'middle_grade', 'childrens', 'picture_books', 'new_adult',
  // Narrative nonfiction
  'biography', 'autobiography', 'memoir', 'true_crime',
  'history', 'ancient_history', 'medieval_history', 'modern_history',
  'military_history', 'world_war_ii', 'american_history', 'british_history',
  // Social sciences
  'psychology', 'sociology', 'philosophy', 'political_science', 'economics',
  'anthropology', 'archaeology', 'linguistics', 'education', 'law',
  // Natural sciences & tech
  'science', 'physics', 'chemistry', 'biology', 'medicine', 'mathematics',
  'astronomy', 'geology', 'ecology', 'technology', 'computers', 'artificial_intelligence',
  // Culture & arts
  'art', 'architecture', 'music', 'film', 'theater', 'photography',
  'literature', 'criticism', 'journalism', 'media',
  // Lifestyle & practical
  'self_help', 'personal_development', 'business', 'management', 'finance',
  'cooking', 'food', 'travel', 'sports', 'fitness', 'health',
  'parenting', 'family', 'relationships', 'spirituality', 'religion',
  'nature', 'environment', 'gardening', 'animals', 'pets',
  // Other creative forms
  'poetry', 'drama', 'graphic_novels', 'comics',
  'humor', 'satire', 'essays',
  // Misc broad tags that catch stragglers
  'love_stories', 'friendship', 'espionage', 'western', 'crime_fiction',
  'supernatural_fiction', 'time_travel', 'vampires', 'zombies', 'dragons',
  'pirates', 'witches', 'magic', 'detective', 'police', 'courtroom',
  'medical', 'political', 'social', 'cultural', 'literary',
  'american_literature', 'british_literature', 'world_literature',
  'african_american', 'latino', 'asian_american',
  'classics', 'pulp_fiction', 'noir_fiction',
  'novella', 'anthology', 'collection'
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
    const maxPerSubject = 10_000; // up to 10k per subject; OL caps at 10k offset

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
