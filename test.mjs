// Run: node test.mjs
import assert from "node:assert/strict";
import {
  parseBestBuy,
  parseCoachVariant,
  coachSnapshot,
  shouldAlertNow,
} from "./src/worker.js";

const bb = (shipping, pickup = {}) =>
  parseBestBuy({ shipping, pickup: { status: "NotAvailable", ...pickup } });

assert.equal(bb({ status: "SoldOutOnline", purchasable: false }).signal, "out");
assert.equal(
  bb({ status: "AvailableToOrder", purchasable: true }).signal,
  "in_stock_online"
);
assert.equal(
  bb({ status: "BackOrder", purchasable: false, isBackorderable: true }).signal,
  "backorder"
);
assert.equal(
  bb({ status: "SoldOutOnline", purchasable: false }, { purchasable: true })
    .signal,
  "pickup_only"
);

// Real shape captured from ca.coach.com Product-Variation.
const meta = { sku: "CCY33 B4WBR", color: "Brass/Warm Brown" };
const soldOut = parseCoachVariant(
  {
    available: false,
    availability: { ATS: 0, messages: ["NOTIFY ME"] },
    price: { sales: { formatted: "C$180" } },
  },
  meta
);
const inStock = parseCoachVariant(
  {
    available: true,
    availability: { ATS: 3, messages: ["IN STOCK"] },
    price: { sales: { formatted: "C$180" } },
  },
  meta
);
assert.equal(soldOut.available, false);
assert.equal(inStock.available, true);
assert.equal(inStock.ats, 3);
// available flag alone is enough, even if ATS is missing
assert.equal(parseCoachVariant({ available: true }, meta).available, true);
assert.throws(() => parseCoachVariant(undefined, meta), /No product record/);

assert.equal(coachSnapshot([soldOut, soldOut]).signal, "out");
assert.equal(coachSnapshot([soldOut, inStock]).signal, "in_stock_online");
assert.match(coachSnapshot([soldOut, inStock]).fields[1].value, /IN STOCK/);
assert.equal(coachSnapshot([soldOut, soldOut]).fields.length, 2);

const alert = (signal, prevSignal, hoursSinceAlert = 0) =>
  shouldAlertNow({ signal, prevSignal, hoursSinceAlert });
assert.equal(alert("out", "out"), false);
assert.equal(alert("out", "in_stock_online"), false);
assert.equal(alert("in_stock_online", "out"), true, "restock must alert");
assert.equal(alert("in_stock_online", "in_stock_online", 1), false, "no spam");
assert.equal(alert("in_stock_online", "in_stock_online", 7), true, "6h repeat");
assert.equal(alert("in_stock_online", "pickup_only"), true, "upgrade alerts");

console.log("ok");
