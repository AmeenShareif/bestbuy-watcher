const PRODUCTS = [
  {
    sku: "13799023",
    name: "Canon PowerShot G7 X Mark III",
    condition: "NEW",
    url: "https://www.bestbuy.ca/en-ca/product/canon-powershot-g7-x-mark-iii-wi-fi-20-1mp-4-2x-optical-zoom-digital-camera-black/13799023",
  },
  {
    sku: "14350718",
    name: "Canon PowerShot G7 X Mark III",
    condition: "OPEN BOX",
    url: "https://www.bestbuy.ca/en-CA/product/open-box-canon-powershot-g7-x-mark-iii-wi-fi-20-1mp-4-2x-optical-zoom-digital-camera-black/14350718",
  },
];

// One request covers every SKU — the API takes a "|"-separated list (%7C).
// A comma is rejected with HTTP 412.
const AVAILABILITY_URL =
  `https://www.bestbuy.ca/ecomm-api/availability/products?accept=application%2Fvnd.bestbuy.standardproduct.v1%2Bjson&accept-language=en-CA&skus=${PRODUCTS.map(
    (p) => p.sku
  ).join("%7C")}`;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Coach (ca.coach.com) sits behind Akamai, which 403s Cloudflare Workers on
// client fingerprint no matter what headers are sent — verified against both
// the product page and the JSON API. So the Coach stock check has to run on a
// GitHub runner, and this Worker's job is to keep that runner firing: GitHub's
// own cron is late or skips entirely, and it disables scheduled workflows
// after 60 days of repo inactivity. coach.yml keeps its own cron entries, so
// if this Worker dies GitHub still runs it, and if GitHub's scheduler dies
// this Worker still triggers it.
const GH_REPO = "AmeenShareif/bestbuy-watcher";
const COACH_WORKFLOW = "coach.yml";

// Per-product state. Same key shape as before, so 13799023 keeps its history.
const kvKeys = (sku) => ({ state: `state:${sku}`, alert: `alert_ts:${sku}` });

// Worker-wide rather than per product: one liveness ping, one error alert for
// the shared request. Keyed on the first product's existing entries so the
// throttle state and "days monitoring" count carry over from the single-SKU era.
const KV_LAST_ERROR_ALERT = `error_alert_ts:${PRODUCTS[0].sku}`;
const KV_LAST_WEEKLY_PING = `weekly_ping_ts:${PRODUCTS[0].sku}`;
const KV_FIRST_SEEN = `first_seen_ts:${PRODUCTS[0].sku}`;
const KV_LAST_GH_ALERT = "gh_alert_ts";
const REPEAT_ALERT_HOURS = 6;
const ERROR_ALERT_THROTTLE_MINUTES = 30;
const WEEKLY_PING_DAYS = 7;

async function fetchAvailability() {
  const res = await fetch(AVAILABILITY_URL, {
    headers: {
      "User-Agent": UA,
      Accept: "application/vnd.bestbuy.standardproduct.v1+json",
      "Accept-Language": "en-CA,en;q=0.9",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const data = await res.json();
  const records = data?.availabilities ?? [];
  if (!records.length) throw new Error("No availability record");
  const bySku = {};
  for (const a of records) {
    bySku[String(a.sku)] = {
      shippingStatus: a.shipping?.status ?? "Unknown",
      shippingPurchasable: !!a.shipping?.purchasable,
      backorderable: !!a.shipping?.isBackorderable,
      quantityRemaining: a.shipping?.quantityRemaining ?? 0,
      pickupPurchasable: !!a.pickup?.purchasable,
      pickupStatus: a.pickup?.status ?? "Unknown",
      raw: a,
    };
  }
  return bySku;
}

function inStockSignal(a) {
  if (a.shippingPurchasable) return "in_stock_online";
  if (a.backorderable) return "backorder";
  if (a.pickupPurchasable) return "pickup_only";
  return "out";
}

function buildDiscordMessage(product, signal, a) {
  const titles = {
    in_stock_online: "BACK IN STOCK — Available Online",
    backorder: "BACKORDER AVAILABLE",
    pickup_only: "IN-STORE PICKUP AVAILABLE",
  };
  const colors = {
    in_stock_online: 0x2ecc71,
    backorder: 0xf1c40f,
    pickup_only: 0x3498db,
  };
  return {
    username: "BestBuy Watcher",
    embeds: [
      {
        // Condition leads the title: two near-identical cameras alert into the
        // same channel, and "which one is this?" must be answerable at a glance.
        title: `[${product.condition}] ${titles[signal]}`,
        description: `**${product.name}**\n${product.condition} · SKU ${product.sku}`,
        url: product.url,
        color: colors[signal],
        fields: [
          { name: "Condition", value: product.condition, inline: true },
          { name: "Shipping", value: a.shippingStatus, inline: true },
          { name: "Pickup", value: a.pickupStatus, inline: true },
          { name: "Qty", value: String(a.quantityRemaining), inline: true },
          {
            name: "Backorderable",
            value: a.backorderable ? "yes" : "no",
            inline: true,
          },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: "bestbuy.ca availability API" },
      },
    ],
  };
}

async function postDiscord(webhook, body) {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Discord HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
}

async function check(env, { source, products = PRODUCTS }) {
  const bySku = await fetchAvailability();
  const now = Date.now();
  const results = [];

  for (const product of products) {
    const a = bySku[product.sku];
    if (!a) {
      // A delisted SKU must not take the other products down with it.
      console.warn(`no availability record for ${product.sku}`);
      results.push({
        source,
        sku: product.sku,
        product: product.name,
        condition: product.condition,
        error: "no availability record",
      });
      continue;
    }

    const k = kvKeys(product.sku);
    const signal = inStockSignal(a);
    const prevSignal = (await env.STATE.get(k.state)) || "out";
    const lastAlertTs = parseInt((await env.STATE.get(k.alert)) || "0", 10);
    const hoursSinceAlert = (now - lastAlertTs) / 3_600_000;

    const isInStockNow = signal !== "out";
    const wasOutBefore = prevSignal === "out";
    const signalChanged = signal !== prevSignal;
    const dueForRepeat =
      isInStockNow && hoursSinceAlert >= REPEAT_ALERT_HOURS;

    const shouldAlert =
      isInStockNow && (wasOutBefore || signalChanged || dueForRepeat);

    if (shouldAlert) {
      if (!env.DISCORD_WEBHOOK) throw new Error("DISCORD_WEBHOOK not set");
      await postDiscord(
        env.DISCORD_WEBHOOK,
        buildDiscordMessage(product, signal, a)
      );
      await env.STATE.put(k.alert, String(now));
    }

    if (signal !== prevSignal) {
      await env.STATE.put(k.state, signal);
    }

    results.push({
      source,
      sku: product.sku,
      product: product.name,
      condition: product.condition,
      signal,
      prevSignal,
      alerted: shouldAlert,
      snapshot: a,
      hoursSinceAlert: Number(hoursSinceAlert.toFixed(2)),
    });
  }

  return results;
}

async function pingHeartbeat(env, suffix = "") {
  if (!env.HEALTHCHECK_URL) return;
  try {
    await fetch(env.HEALTHCHECK_URL + suffix, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error("heartbeat ping failed:", e.message);
  }
}

async function maybeWeeklyPing(env, results) {
  if (!env.DISCORD_WEBHOOK) return;
  const now = Date.now();
  const lastTs = parseInt(
    (await env.STATE.get(KV_LAST_WEEKLY_PING)) || "0",
    10
  );
  const firstSeenTs = parseInt(
    (await env.STATE.get(KV_FIRST_SEEN)) || "0",
    10
  );
  if (!firstSeenTs) {
    await env.STATE.put(KV_FIRST_SEEN, String(now));
  }
  const daysSince = (now - lastTs) / 86_400_000;
  if (lastTs > 0 && daysSince < WEEKLY_PING_DAYS) return;
  const daysMonitoring = firstSeenTs
    ? Math.floor((now - firstSeenTs) / 86_400_000)
    : 0;
  await fetch(env.DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "BestBuy Watcher",
      embeds: [
        {
          title: "[STATUS] Watcher healthy",
          description: `Weekly check-in.\n${results
            .map(
              (r) =>
                `**${r.product}** (${r.condition} · SKU ${r.sku}) — ${
                  r.error ? `⚠ ${r.error}` : `still ${r.snapshot.shippingStatus.toLowerCase()}`
                }`
            )
            .join("\n")}\nDays monitoring: ${daysMonitoring}.\n\n_If you stop getting these weekly pings, the watcher is down._`,
          color: 0x95a5a6,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => {});
  await env.STATE.put(KV_LAST_WEEKLY_PING, String(now));
}

async function notifyError(env, err) {
  console.error("scheduled error:", err.message);
  const target = env.DISCORD_WEBHOOK_ERRORS || env.DISCORD_WEBHOOK;
  if (!target) return;
  const now = Date.now();
  const lastTs = parseInt(
    (await env.STATE.get(KV_LAST_ERROR_ALERT)) || "0",
    10
  );
  const minsSince = (now - lastTs) / 60000;
  if (minsSince < ERROR_ALERT_THROTTLE_MINUTES) {
    console.log(`error alert throttled (${minsSince.toFixed(1)}m since last)`);
    return;
  }
  await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "BestBuy Watcher",
      embeds: [
        {
          title: "[ERROR] Primary watcher failing",
          description: `SKUs ${PRODUCTS.map((p) => p.sku).join(", ")}\n\n\`\`\`${err.message.slice(0, 500)}\`\`\`\n\n_Throttled to one alert per ${ERROR_ALERT_THROTTLE_MINUTES} min. Investigate Cloudflare logs: \`npx wrangler tail\`._`,
          color: 0xe74c3c,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  }).catch(() => {});
  await env.STATE.put(KV_LAST_ERROR_ALERT, String(now));
}

async function notifyGhFailure(env, err) {
  console.error("coach trigger failed:", err.message);
  const target = env.DISCORD_WEBHOOK_ERRORS || env.DISCORD_WEBHOOK;
  if (!target) return;
  const now = Date.now();
  const lastTs = parseInt((await env.STATE.get(KV_LAST_GH_ALERT)) || "0", 10);
  if ((now - lastTs) / 60000 < ERROR_ALERT_THROTTLE_MINUTES) return;
  await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Coach Watcher",
      embeds: [
        {
          title: "[ERROR] Cannot trigger the Coach watcher",
          description: `GitHub Actions is not accepting runs, so the Coach bag may not be being checked. **Check it manually.**\n\n\`\`\`${err.message.slice(0, 400)}\`\`\`\n\n_Throttled to one alert per ${ERROR_ALERT_THROTTLE_MINUTES} min. coach.yml's own cron may still be running it._`,
          color: 0xe74c3c,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  }).catch(() => {});
  await env.STATE.put(KV_LAST_GH_ALERT, String(now));
}

async function triggerCoachWatcher(env) {
  // Empty counts as missing: `wrangler secret put` run without a usable stdin
  // uploads an empty string, and the secret then lists fine but is falsy here.
  if (!env.GH_TOKEN) return { triggered: false, reason: "GH_TOKEN missing or empty" };
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GH_REPO}/actions/workflows/${COACH_WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "bestbuy-watcher",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
        signal: AbortSignal.timeout(10000),
      }
    );
    if (res.status !== 204) {
      const txt = await res.text().catch(() => "");
      throw new Error(`GitHub dispatch HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    return { triggered: true };
  } catch (err) {
    await notifyGhFailure(env, err);
    return { triggered: false, reason: err.message };
  }
}

// ?sku=<id> narrows the admin endpoints to one product; default is all.
function selectProducts(url) {
  const sku = url.searchParams.get("sku");
  return sku ? PRODUCTS.filter((p) => p.sku === sku) : PRODUCTS;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        // First — the transient branch below returns early, and this must not
        // be skipped just because Best Buy had a bad minute.
        // Quiet when it works; loud when it doesn't — a silently skipped
        // trigger is indistinguishable from a healthy run otherwise.
        const gh = await triggerCoachWatcher(env);
        if (!gh.triggered) console.log("coach trigger skipped:", gh.reason);
        try {
          const results = await check(env, { source: "cron" });
          await pingHeartbeat(env);
          await maybeWeeklyPing(env, results);
        } catch (err) {
          const isTransient =
            err.name === "TimeoutError" ||
            err.name === "AbortError" ||
            /aborted due to timeout/i.test(err.message);
          if (isTransient) {
            console.warn("transient error, skipping alert:", err.message);
            await pingHeartbeat(env, "/fail");
            return;
          }
          await pingHeartbeat(env, "/fail");
          await notifyError(env, err);
        }
      })()
    );
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const PROTECTED = new Set(["/check", "/test-alert", "/simulate-restock", "/reset"]);
    if (PROTECTED.has(url.pathname)) {
      const requiredToken = env.ADMIN_TOKEN;
      if (requiredToken) {
        const provided =
          url.searchParams.get("token") ||
          (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        if (provided !== requiredToken) {
          return new Response("unauthorized", { status: 401 });
        }
      }
      // An unknown ?sku= must not silently fall through to "all products".
      if (selectProducts(url).length === 0) {
        return new Response("unknown sku", { status: 404 });
      }
    }
    if (url.pathname === "/check") {
      try {
        const result = await check(env, {
          source: "manual",
          products: selectProducts(url),
        });
        return Response.json(result);
      } catch (err) {
        return new Response(`error: ${err.message}`, { status: 500 });
      }
    }
    if (url.pathname === "/reset") {
      for (const p of selectProducts(url)) {
        const k = kvKeys(p.sku);
        await env.STATE.delete(k.state);
        await env.STATE.delete(k.alert);
      }
      return new Response("state cleared");
    }
    if (url.pathname === "/simulate-restock") {
      try {
        if (!env.DISCORD_WEBHOOK)
          return new Response("DISCORD_WEBHOOK not set", { status: 500 });
        const decisions = [];
        for (const product of selectProducts(url)) {
          const k = kvKeys(product.sku);
          const prevState = (await env.STATE.get(k.state)) || "out";
          const prevAlertTs = (await env.STATE.get(k.alert)) || "0";
          const fakeSnapshot = {
            shippingStatus: "AvailableToOrder",
            shippingPurchasable: true,
            backorderable: false,
            quantityRemaining: 5,
            pickupPurchasable: false,
            pickupStatus: "NotAvailable",
            raw: { simulated: true },
          };
          const signal = inStockSignal(fakeSnapshot);
          const isInStockNow = signal !== "out";
          const wasOutBefore = prevState === "out";
          const signalChanged = signal !== prevState;
          const shouldAlert = isInStockNow && (wasOutBefore || signalChanged);
          let alerted = false;
          if (shouldAlert) {
            const msg = buildDiscordMessage(product, signal, fakeSnapshot);
            msg.embeds[0].title = "[SIMULATION] " + msg.embeds[0].title;
            msg.embeds[0].description +=
              "\n\n_This is a simulated restock running the real alert logic. State has been restored — live monitoring continues._";
            await postDiscord(env.DISCORD_WEBHOOK, msg);
            alerted = true;
          }
          await env.STATE.put(k.state, prevState);
          await env.STATE.put(k.alert, prevAlertTs);
          decisions.push({
            sku: product.sku,
            product: product.name,
            simulatedSignal: signal,
            storedStateBefore: prevState,
            isInStockNow,
            wasOutBefore,
            signalChanged,
            shouldAlert,
            alerted,
          });
        }
        return Response.json({
          ok: true,
          simulated: true,
          decisions,
          note: "Stored state was restored to its original value. Live cron continues monitoring real API.",
        });
      } catch (err) {
        return new Response(`error: ${err.message}`, { status: 500 });
      }
    }
    if (url.pathname === "/test-alert") {
      try {
        if (!env.DISCORD_WEBHOOK)
          return new Response("DISCORD_WEBHOOK not set", { status: 500 });
        const bySku = await fetchAvailability();
        const sent = [];
        for (const product of selectProducts(url)) {
          const a = bySku[product.sku];
          if (!a) continue;
          const msg = buildDiscordMessage(product, "in_stock_online", a);
          msg.embeds[0].title = "[TEST] " + msg.embeds[0].title;
          msg.embeds[0].description +=
            "\n\n_This is a test alert. Stored state was NOT modified — live monitoring continues._";
          msg.embeds[0].color = 0x9b59b6;
          await postDiscord(env.DISCORD_WEBHOOK, msg);
          sent.push({
            sku: product.sku,
            product: product.name,
            storedState: (await env.STATE.get(kvKeys(product.sku).state)) || "out",
            currentSnapshot: a,
          });
        }
        return Response.json({
          ok: true,
          test: true,
          message: "Test alert(s) sent. Stored state untouched.",
          sent,
        });
      } catch (err) {
        return new Response(`error: ${err.message}`, { status: 500 });
      }
    }
    return new Response(
      `BestBuy Watcher\n\nWatching:\n${PRODUCTS.map(
        (p) => `  ${p.sku}  ${p.name}`
      ).join(
        "\n"
      )}\n\nEndpoints (add ?sku=<id> to target one product):\n  GET /check             - run a real check now\n  GET /test-alert        - send a test Discord message (no state change)\n  GET /simulate-restock  - run real alert logic against a fake in-stock response\n  GET /reset             - clear stored state\n`,
      { headers: { "Content-Type": "text/plain" } }
    );
  },
};
