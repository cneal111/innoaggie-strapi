const express = require("express");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");
const path = require("path");
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

        // Notify first. A completed sale is worth knowing about whether or not
        // the inventory sync below succeeds, so nothing is allowed to run
        // between the payment check and the mail send.
        await sendPurchaseEmail(session, lineItems.data);

        // Inventory sync is best-effort and must never fail the handler. A 500
        // here makes Stripe redeliver the event, which would re-send the email
        // above and can decrement a second time, since the idempotency guards
        // are in-memory and lost on restart. decrementInventoryByName throws
        // when a Stripe product name has no exact match in Strapi, which is the
        // likely failure whenever a new SKU is added on one side only.
        try {
          for (const item of lineItems.data) {
            const productName = item?.description?.trim();
            const qty = Number(item?.quantity ?? 1);
            if (!productName || qty <= 0) {
              console.warn("Skipping item: missing name or non-positive qty", { productName, qty });
              continue;
            }
            await decrementInventoryByName(productName, qty); // uses documentId under the hood
          }
        } catch (inventoryErr) {
          console.error(
            `INVENTORY SYNC FAILED for session ${session.id}. The order email was ` +
              `sent, but stock was not decremented — correct it manually in Strapi. ` +
              `Cause:`,
            inventoryErr
          );
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
/* ---------------------------
   Purchase notification email
---------------------------- */

const mailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
  secure: process.env.SMTP_SECURE === "true",
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
});

/** Stripe amounts are in the currency's minor unit. */
function formatMoney(amount, currency) {
  if (typeof amount !== "number") return "\u2014";
  return (amount / 100).toLocaleString("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Notifies the business that a checkout completed. Stripe sends the customer
 * their own receipt, so this is internal only. Subscription renewals are not
 * covered here - they arrive as invoice.paid and are managed in Stripe.
 *
 * Everything here comes off the session and the line items already fetched for
 * the inventory update - no extra Stripe calls, and no reliance on
 * session.metadata, which is empty for Payment Link checkouts unless set per
 * link.
 */
async function sendPurchaseEmail(session, lineItems) {
  if (!process.env.MAIL_FROM || !process.env.MAIL_TO) {
    console.warn("MAIL_FROM/MAIL_TO not set; skipping purchase notification.");
    return;
  }

  try {
    const customer = session.customer_details || {};
    const rows = (lineItems || [])
      .map(
        (li) =>
          `<tr>
             <td style="padding:8px;border-bottom:1px solid #eee;">${escapeHtml(li.description)}</td>
             <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${escapeHtml(li.quantity)}</td>
             <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${formatMoney(li.amount_total, li.currency || session.currency)}</td>
           </tr>`
      )
      .join("");

    const total = formatMoney(session.amount_total, session.currency);
    const kind = session.mode === "subscription" ? "Subscription started" : "One-time purchase";

    await mailTransporter.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      replyTo: customer.email || undefined,
      subject: `New order - ${total}`,
      html: `
        <!DOCTYPE html>
        <html>
        <body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;">
          <div style="max-width:600px;margin:0 auto;padding:20px;">
            <div style="text-align:center;margin-bottom:24px;">
              <img src="cid:logo" alt="Inno Aggie" style="width:140px;height:auto;" />
            </div>
            <h1 style="color:#2E7D32;font-size:24px;">New Order</h1>

            <p><strong>Type:</strong> ${escapeHtml(kind)}</p>
            <p><strong>Customer:</strong> ${escapeHtml(customer.name || "\u2014")}</p>
            <p><strong>Email:</strong> ${escapeHtml(customer.email || "\u2014")}</p>
            <p><strong>Phone:</strong> ${escapeHtml(customer.phone || "\u2014")}</p>

            <table style="width:100%;border-collapse:collapse;margin-top:20px;">
              <thead>
                <tr>
                  <th style="padding:8px;text-align:left;border-bottom:2px solid #333;">Item</th>
                  <th style="padding:8px;text-align:center;border-bottom:2px solid #333;">Qty</th>
                  <th style="padding:8px;text-align:right;border-bottom:2px solid #333;">Amount</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
              <tfoot>
                <tr>
                  <td colspan="2" style="padding:8px;text-align:right;font-weight:bold;">Total</td>
                  <td style="padding:8px;text-align:right;font-weight:bold;">${total}</td>
                </tr>
              </tfoot>
            </table>

            <p style="margin-top:30px;padding-top:20px;border-top:1px solid #ddd;color:#666;font-size:12px;">
              Stripe session ${escapeHtml(session.id)}. The customer receipt is sent by Stripe.
            </p>
          </div>
        </body>
        </html>
      `,
      attachments: [
        {
          filename: "inno_logo.png",
          // Resolved from this file, not the cwd: the container starts with
          // `node webhook/server.js` from /app, so a relative path would break.
          path: path.join(__dirname, "assets", "inno_logo_email.png"),
          cid: "logo",
        },
      ],
    });

    console.log(`Purchase notification sent for session ${session.id}`);
  } catch (err) {
    // Swallowed on purpose: a mail outage must not 500 the handler and trigger
    // a Stripe redelivery of an event that was otherwise handled fine.
    console.error("Failed to send purchase notification email:", err);
  }
}
