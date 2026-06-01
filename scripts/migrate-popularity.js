#!/usr/bin/env node
/**
 * migrate-popularity.js
 *
 * Run this AFTER a fresh seed to apply correct popularity scores to
 * globalLibrary documents based on all users' personal libraries.
 *
 * Scoring:  +1 per user who owns a book (location !== 'Wishlist')
 *           +2 per user who has read it (read === true, not Wishlist)
 *
 * Setup:  serviceAccountKey.json must be in this directory
 * Run:    node migrate-popularity.js
 */

const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });
const db = admin.firestore();
process.stdout._handle && process.stdout._handle.setBlocking(true);

// Must match the app's createGlobalBookId / normalizeBookText exactly.
function normalizeBookText(str = '') {
  return str.toLowerCase().replace(/\bthe\b/g, '').replace(/[^a-z0-9]/g, '').trim();
}
function createGlobalBookId(title = '', author = '') {
  return normalizeBookText(title) + '__' + normalizeBookText(author);
}

async function main() {
  console.log('\nPopularity migration\n' + '─'.repeat(60));

  // Step 1: Query all books across every user via collectionGroup
  // (user docs may not exist — only their books subcollections do)
  console.log('Loading all personal books via collectionGroup…');
  const allBooksSnap = await db.collectionGroup('books').get();
  console.log(`  Found ${allBooksSnap.size} total book entries\n`);

  // Step 2: Accumulate popularity scores
  const scores = new Map(); // globalId → popularity score
  let totalEntries = 0;
  const userCounts = {};

  for (const bookDoc of allBooksSnap.docs) {
    const b = bookDoc.data();
    if (!b.title || !b.author) continue;
    if ((b.location || '') === 'Wishlist') continue;
    const uid = bookDoc.ref.parent.parent.id;
    const id = createGlobalBookId(b.title, b.author);
    scores.set(id, (scores.get(id) || 0) + 1 + (b.read ? 2 : 0));
    userCounts[uid] = (userCounts[uid] || 0) + 1;
    totalEntries++;
  }

  for (const [uid, count] of Object.entries(userCounts)) {
    console.log(`  ${uid}: ${count} books counted`);
  }

  const nonZero = [...scores.values()].filter(s => s > 0);
  console.log(`\nTallied ${scores.size} unique titles across ${totalEntries} personal entries`);
  console.log(`  Score range: ${nonZero.length ? Math.min(...nonZero) : 0}–${nonZero.length ? Math.max(...nonZero) : 0}\n`);

  // Step 3: Update globalLibrary documents
  const entries = [...scores.entries()].filter(([, s]) => s > 0);
  console.log(`Updating ${entries.length} globalLibrary documents…`);

  let updated = 0, notFound = 0, errCount = 0;
  for (const [globalId, score] of entries) {
    try {
      await db.collection('globalLibrary').doc(globalId).update({ popularity: score });
      updated++;
    } catch(e) {
      // Error code 5 = NOT_FOUND in gRPC; message fallback for older SDK versions
      if (e.code === 5 || (e.message || '').includes('NOT_FOUND')) {
        notFound++;
        // Book is in a personal library but failed Google Books validation —
        // it was never written to globalLibrary, so skip it.
      } else {
        console.error(`  Error updating ${globalId}:`, e.message);
        errCount++;
      }
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Done.`);
  console.log(`  Updated : ${updated}`);
  console.log(`  Skipped : ${notFound} (not in globalLibrary)`);
  if (errCount) console.log(`  Errors  : ${errCount}`);
  process.exit(0);
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
