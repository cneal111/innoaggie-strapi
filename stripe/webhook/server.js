const express = require("express");
const Stripe = require("stripe");
require("dotenv").config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_API_KEY);

// ---- DEV idempotency (in-memory). Use Redis/DB in production. ----
const processedEventIds = new Set();
const processedSessionIds = new Set();
const alreadyProcessedEvent = (id) => processedEventIds.has(id);
const markProcessedEvent = (id) => processedEventIds.add(id);
const alreadyProcessedSession = (id) => processedSessionIds.has(id);
const markProcessedSession = (id) => processedSessionIds.add(id);

// Webhook: raw body only
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency guard #1
  if (alreadyProcessedEvent(event.id)) {
    console.log(`Duplicate delivery for event ${event.id}; skipping.`);
    return res.sendStatus(200);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        // Idempotency guard #2
        if (alreadyProcessedSession(session.id)) {
          console.log(`Session ${session.id} already processed; skipping.`);
          break;
        }

        if (session.payment_status && session.payment_status !== "paid") {
          console.log(`Payment status = ${session.payment_status}; skipping inventory update.`);
          break;
        }

        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
        console.log("Line items:", lineItems.data.map(li => ({
          id: li.id,
          description: li.description, // Stripe Product name
          quantity: li.quantity,
          priceId: li.price?.id,
        })));

        for (const item of lineItems.data) {
          const productName = item?.description?.trim();
          const qty = Number(item?.quantity ?? 1);
          if (!productName || qty <= 0) {
            console.warn("Skipping item: missing name or non-positive qty", { productName, qty });
            continue;
          }
          await decrementInventoryByName(productName, qty); // uses documentId under the hood
        }

        markProcessedSession(session.id);
        break;
      }
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    markProcessedEvent(event.id);
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).send("Webhook handler error");
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));
app.listen(process.env.STRIPE_PORT || 8084, () => console.log(`Listening on ${process.env.STRIPE_PORT || 8084}`));

/* ---------------------------
   Strapi helpers (documentId)
---------------------------- */

const fetch = global.fetch || ((...args) => import("node-fetch").then(m => m.default(...args)));
const STRAPI_URL = process.env.STRAPI_API_URL; // e.g., https://cms.example.com
const STRAPI_TOKEN = process.env.STRAPI_TOKEN || process.env.STRAPI_API_TOKEN;

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${STRAPI_TOKEN}`, ...extra };
}

/**
 * Fetch a single product by exact name and return { documentId, name, inventory }.
 */
async function fetchStrapiProductByName(name) {
  const url = new URL(`${STRAPI_URL}/api/products`);
  url.searchParams.set("filters[name][$eq]", name);
  url.searchParams.append("fields[0]", "name");
  url.searchParams.append("fields[1]", "inventory");
  url.searchParams.append("fields[2]", "documentId");
  url.searchParams.append("pagination[pageSize]", "1");

  const resp = await fetch(url.toString(), { headers: authHeaders() });
  if (resp.status === 403) throw new Error("Strapi 403: enable 'find' on products for the role.");
  if (!resp.ok) throw new Error(`Strapi fetch-by-name failed: ${resp.status} ${await safeText(resp)}`);

  const json = await resp.json();
  const p = json?.data?.[0];
  if (!p) return null;

  // normalize (flattened or attributes)
  const documentId = p.documentId ?? p?.attributes?.documentId;
  const nameOut    = p.name ?? p?.attributes?.name;
  const inventory  = p.inventory ?? p?.attributes?.inventory;

  return { documentId, name: nameOut, inventory };
}

/**
 * Update inventory via documentId in the URL.
 */
async function updateStrapiInventoryByDocumentId(documentId, newInventory) {
  const url = `${STRAPI_URL}/api/products/${documentId}`;
  const payload = { data: { inventory: newInventory } };

  const resp = await fetch(url, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });

  if (resp.status === 403) throw new Error("Strapi 403: enable 'update' on products for the role.");
  if (resp.status === 404) throw new Error(`Strapi 404: product documentId ${documentId} not found.`);
  if (!resp.ok) throw new Error(`Strapi update failed: ${resp.status} ${await safeText(resp)}`);

  return resp.json();
}

/**
 * Decrement inventory by product name (uses documentId update), floor at 0.
 */
async function decrementInventoryByName(productName, qty = 1) {
  const p = await fetchStrapiProductByName(productName);
  if (!p) throw new Error(`Product "${productName}" not found in Strapi.`);

  const { documentId, inventory } = p;
  if (typeof inventory !== "number") {
    throw new Error(`Product "${productName}" has invalid inventory: ${inventory}`);
  }
  if (inventory <= 0) {
    console.warn(`Inventory for "${productName}" already 0. Skipping update.`);
    return;
  }

  const newInventory = Math.max(0, inventory - qty);
  console.log(`Updating "${productName}" (documentId=${documentId}) inventory: ${inventory} -> ${newInventory}`);
  await updateStrapiInventoryByDocumentId(documentId, newInventory);
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return "<no body>"; }
}