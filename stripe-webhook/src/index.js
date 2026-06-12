/**
 * Library01 – Stripe Webhook Handler (Cloudflare Worker)
 *
 * Handles:
 *  - checkout.session.completed  → links Stripe customer ID to Firebase UID in Firestore
 *  - customer.subscription.created / updated / deleted  → writes subscription doc to
 *    Firestore at customers/{uid}/subscriptions/{subId}  (same path the Firebase
 *    Stripe Extension uses, so the app reads it identically)
 *
 * Required secrets (set via: npx wrangler secret put <NAME>)
 *  STRIPE_WEBHOOK_SECRET   – Stripe webhook signing secret (whsec_...)
 *  FIREBASE_PROJECT_ID     – Firebase project ID
 *  FIREBASE_CLIENT_EMAIL   – Service account client_email
 *  FIREBASE_PRIVATE_KEY    – Service account private_key (full PEM string)
 */

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects';

// ── Stripe signature verification ────────────────────────────────────────────

async function verifyStripeSignature(body, sigHeader, secret) {
  const parts = {};
  for (const chunk of sigHeader.split(',')) {
    const eq = chunk.indexOf('=');
    if (eq > 0) parts[chunk.slice(0, eq)] = chunk.slice(eq + 1);
  }
  if (!parts.t || !parts.v1) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(parts.t)) > 300) return false; // 5-min replay window

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const raw = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${parts.t}.${body}`)
  );
  const computed = [...new Uint8Array(raw)].map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === parts.v1;
}

// ── Firebase auth (service-account JWT → OAuth2 access token) ────────────────

async function getFirebaseToken(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const enc = obj =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const header  = enc({ alg: 'RS256', typ: 'JWT' });
  const payload = enc({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });

  const pem = privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n|\r/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const rawSig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(`${header}.${payload}`)
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(rawSig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${header}.${payload}.${sig}`,
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Firebase token exchange failed: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Firestore helpers ─────────────────────────────────────────────────────────

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean')        return { booleanValue: v };
  if (v instanceof Date)             return { timestampValue: v.toISOString() };
  if (typeof v === 'number' && Number.isInteger(v)) return { integerValue: String(v) };
  if (typeof v === 'number')         return { doubleValue: v };
  if (typeof v === 'string')         return { stringValue: v };
  if (typeof v === 'object')         return { mapValue: { fields: toFirestoreFields(v) } };
  return { stringValue: String(v) };
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFirestoreValue(v);
  return fields;
}

// PATCH (merge) a Firestore document
async function firestoreSet(projectId, docPath, data, token) {
  const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const url   = `${FIRESTORE_BASE}/${projectId}/databases/(default)/documents/${docPath}?${mask}`;
  const resp  = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(data) }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Firestore PATCH ${docPath} failed ${resp.status}: ${err}`);
  }
}

// Query customers collection to find Firebase UID for a given Stripe customer ID
async function findUidByStripeId(projectId, stripeId, token) {
  const url  = `${FIRESTORE_BASE}/${projectId}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'customers' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'stripeId' },
          op: 'EQUAL',
          value: { stringValue: stripeId },
        },
      },
      limit: 1,
    },
  };
  const resp    = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const results = await resp.json();
  const doc     = results[0]?.document;
  if (!doc) return null;
  // Document name: .../documents/customers/{uid}
  const parts = doc.name.split('/');
  return parts[parts.length - 1];
}

// ── Subscription data builder ─────────────────────────────────────────────────

function buildSubDoc(sub) {
  return {
    status:               sub.status,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    current_period_start: new Date((sub.current_period_start || 0) * 1000),
    current_period_end:   new Date((sub.current_period_end   || 0) * 1000),
    created:              new Date((sub.created              || 0) * 1000),
    price: { id: sub.items?.data?.[0]?.price?.id || '' },
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const body = await request.text();
    const sig  = request.headers.get('stripe-signature') || '';

    if (!await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET)) {
      return new Response('Invalid signature', { status: 400 });
    }

    let event;
    try { event = JSON.parse(body); }
    catch { return new Response('Bad JSON', { status: 400 }); }

    try {
      const token     = await getFirebaseToken(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);
      const projectId = env.FIREBASE_PROJECT_ID;

      // ── checkout.session.completed ──────────────────────────────────────────
      if (event.type === 'checkout.session.completed') {
        const session    = event.data.object;
        const uid        = session.client_reference_id;
        const customerId = session.customer;
        if (uid && customerId) {
          await firestoreSet(projectId, `customers/${uid}`, {
            stripeId: customerId,
            email:    session.customer_details?.email || session.customer_email || '',
          }, token);
          console.log(`checkout.session.completed: linked ${customerId} → ${uid}`);
        }
      }

      // ── customer.subscription.* ─────────────────────────────────────────────
      const SUB_EVENTS = new Set([
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
      ]);
      if (SUB_EVENTS.has(event.type)) {
        const sub        = event.data.object;
        const customerId = sub.customer;

        const uid = await findUidByStripeId(projectId, customerId, token);
        if (!uid) {
          // Unknown customer — can't map to a Firebase user
          console.warn(`${event.type}: no Firebase UID for Stripe customer ${customerId}`);
          return new Response('OK', { status: 200 });
        }

        const subDoc = buildSubDoc(sub);
        await firestoreSet(projectId, `customers/${uid}/subscriptions/${sub.id}`, subDoc, token);
        console.log(`${event.type}: wrote sub ${sub.id} for uid ${uid} (status=${sub.status} cancel_at_period_end=${sub.cancel_at_period_end})`);
      }

    } catch (err) {
      console.error('Webhook handler error:', err);
      // Return 200 so Stripe doesn't retry endlessly for internal errors
      return new Response('OK', { status: 200 });
    }

    return new Response('OK', { status: 200 });
  },
};
