const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const REPEAT_ALERT_HOURS = 6;
const ERROR_ALERT_THROTTLE_MINUTES = 30;
const WEEKLY_PING_DAYS = 7;

/* ─────────────────────────── Best Buy ─────────────────────────── */

const BB_SKU = "13799023";
const BB_AVAILABILITY_URL =
  `https://www.bestbuy.ca/ecomm-api/availability/products?accept=application%2Fvnd.bestbuy.standardproduct.v1%2Bjson&accept-language=en-CA&skus=${BB_SKU}`;

export function parseBestBuy(a) {
  if (!a) throw new Error("No availability record");
  const shippingPurchasable = !!a.shipping?.purchasable;
  const backorderable = !!a.shipping?.isBackorderable;
  const pickupPurchasable = !!a.pickup?.purchasable;
  const shippingStatus = a.shipping?.status ?? "Unknown";

  let signal = "out";
  if (shippingPurchasable) signal = "in_stock_online";
  else if (backorderable) signal = "backorder";
  else if (pickupPurchasable) signal = "pickup_only";

  return {
    signal,
    statusText: shippingStatus.toLowerCase(),
    fields: [
      { name: "Shipping", value: shippingStatus, inline: true },
      { name: "Pickup", value: a.pickup?.status ?? "Unknown", inline: true },
      {
        name: "Qty",
        value: String(a.shipping?.quantityRemaining ?? 0),
        inline: true,
      },
      { name: "Backorderable", value: backorderable ? "yes" : "no", inline: true },
    ],
    raw: a,
  };
}

async function fetchBestBuy() {
  const res = await fetch(BB_AVAILABILITY_URL, {
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
  return parseBestBuy(data?.availabilities?.[0]);
}

/* ───────────────────────────── Coach ──────────────────────────── */

const COACH_STYLE = "CCY33";
const COACH_URL =
  "https://ca.coach.com/en/products/lana-shoulder-bag-19/CCY33.html";
const COACH_API =
  "https://ca.coach.com/on/demandware.store/Sites-coh_ca_one-Site/en_CA/Product-Variation?pid=";

// ponytail: colours hardcoded — the API only reports the variant you ask for,
// so there is no one-shot "any colour" query. If Coach adds a colour, add it
// here; the full list lives in the ProductGroup JSON-LD on COACH_URL.
const COACH_VARIANTS = [
  { sku: "CCY33 B4WBR", color: "Brass/Warm Brown" },
  { sku: "CCY33 B4/AY", color: "Brass/Clay" },
];

export function parseCoachVariant(product, variant) {
  if (!product) throw new Error(`No product record (${variant.color})`);
  const ats = Number(product.availability?.ATS ?? 0);
  return {
    ...variant,
    // OR, not AND: a missed restock costs more than a false alarm.
    available: product.available === true || ats > 0,
    ats,
    price: product.price?.sales?.formatted ?? "?",
    message: product.availability?.messages?.[0] ?? "?",
  };
}

export function coachSnapshot(variants) {
  const inStock = variants.filter((v) => v.available);
  return {
    signal: inStock.length ? "in_stock_online" : "out",
    statusText: inStock.length
      ? `in stock (${inStock.map((v) => v.color).join(", ")})`
      : "sold out",
    fields: variants.map((v) => ({
      name: v.color,
      value: v.available
        ? `**IN STOCK** — ${v.price}${v.ats ? ` · ${v.ats} left` : ""}`
        : `Sold out — ${v.price}`,
      inline: true,
    })),
    raw: variants,
  };
}

async function fetchCoachVariant(variant) {
  const res = await fetch(COACH_API + encodeURIComponent(variant.sku), {
    headers: {
      // Coach 403s anything that doesn't look like a real browser XHR.
      "User-Agent": UA,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "Accept-Language": "en-CA,en;q=0.9",
      Referer: COACH_URL,
      "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Coach HTTP ${res.status} (${variant.color})`);
  const data = await res.json();
  return parseCoachVariant(data?.product, variant);
}

async function fetchCoach() {
  const variants = await Promise.all(
    COACH_VARIANTS.map((v) => fetchCoachVariant(v))
  );
  return coachSnapshot(variants);
}

/* ─────────────────────────── Watchers ─────────────────────────── */

const WATCHERS = [
  {
    id: BB_SKU,
    name: "Canon PowerShot G7 X Mark III",
    subtitle: `SKU ${BB_SKU}`,
    url: "https://www.bestbuy.ca/en-ca/product/canon-powershot-g7-x-mark-iii-wi-fi-20-1mp-4-2x-optical-zoom-digital-camera-black/13799023",
    username: "BestBuy Watcher",
    footer: "bestbuy.ca availability API",
    fetchSnapshot: fetchBestBuy,
  },
  {
    id: COACH_STYLE,
    name: "Coach Lana Shoulder Bag 19",
    subtitle: `Style ${COACH_STYLE} · C$180`,
    url: COACH_URL,
    username: "Coach Watcher",
    footer: "ca.coach.com product API",
    fetchSnapshot: fetchCoach,
  },
];

const keysFor = (id) => ({
  state: `state:${id}`,
  alert: `alert_ts:${id}`,
  errorAlert: `error_alert_ts:${id}`,
  weekly: `weekly_ping_ts:${id}`,
  firstSeen: `first_seen_ts:${id}`,
});

/* ──────────────────────── Alerting logic ──────────────────────── */

export function shouldAlertNow({ signal, prevSignal, hoursSinceAlert }) {
  if (signal === "out") return false;
  return (
    prevSignal === "out" ||
    signal !== prevSignal ||
    hoursSinceAlert >= REPEAT_ALERT_HOURS
  );
}

function buildDiscordMessage(w, signal, snap) {
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
    username: w.username,
    embeds: [
      {
        title: titles[signal],
        description: `**${w.name}**\n${w.subtitle}`,
        url: w.url,
        color: colors[signal],
        fields: snap.fields,
        timestamp: new Date().toISOString(),
        footer: { text: w.footer },
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

async function check(env, w, { source }) {
  const k = keysFor(w.id);
  const snap = await w.fetchSnapshot();
  const prevSignal = (await env.STATE.get(k.state)) || "out";
  const lastAlertTs = parseInt((await env.STATE.get(k.alert)) || "0", 10);
  const now = Date.now();
  const hoursSinceAlert = (now - lastAlertTs) / 3_600_000;

  const alert = shouldAlertNow({
    signal: snap.signal,
    prevSignal,
    hoursSinceAlert,
  });

  if (alert) {
    if (!env.DISCORD_WEBHOOK) throw new Error("DISCORD_WEBHOOK not set");
    await postDiscord(env.DISCORD_WEBHOOK, buildDiscordMessage(w, snap.signal, snap));
    await env.STATE.put(k.alert, String(now));
  }

  if (snap.signal !== prevSignal) {
    await env.STATE.put(k.state, snap.signal);
  }

  return {
    source,
    id: w.id,
    product: w.name,
    signal: snap.signal,
    prevSignal,
    alerted: alert,
    snapshot: snap,
    hoursSinceAlert: Number(hoursSinceAlert.toFixed(2)),
  };
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

async function maybeWeeklyPing(env, w, snapshot) {
  if (!env.DISCORD_WEBHOOK) return;
  const k = keysFor(w.id);
  const now = Date.now();
  const lastTs = parseInt((await env.STATE.get(k.weekly)) || "0", 10);
  const firstSeenTs = parseInt((await env.STATE.get(k.firstSeen)) || "0", 10);
  if (!firstSeenTs) {
    await env.STATE.put(k.firstSeen, String(now));
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
      username: w.username,
      embeds: [
        {
          title: "[STATUS] Watcher healthy",
          description: `Weekly check-in.\n**${w.name}** (${w.subtitle}) — still ${snapshot.statusText}.\nDays monitoring: ${daysMonitoring}.\n\n_If you stop getting these weekly pings, the watcher is down._`,
          color: 0x95a5a6,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => {});
  await env.STATE.put(k.weekly, String(now));
}

async function notifyError(env, w, err) {
  console.error(`scheduled error (${w.id}):`, err.message);
  const target = env.DISCORD_WEBHOOK_ERRORS || env.DISCORD_WEBHOOK;
  if (!target) return;
  const k = keysFor(w.id);
  const now = Date.now();
  const lastTs = parseInt((await env.STATE.get(k.errorAlert)) || "0", 10);
  const minsSince = (now - lastTs) / 60000;
  if (minsSince < ERROR_ALERT_THROTTLE_MINUTES) {
    console.log(`error alert throttled (${minsSince.toFixed(1)}m since last)`);
    return;
  }
  await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: w.username,
      embeds: [
        {
          title: "[ERROR] Primary watcher failing",
          description: `**${w.name}** (${w.subtitle})\n\n\`\`\`${err.message.slice(0, 500)}\`\`\`\n\n_Throttled to one alert per ${ERROR_ALERT_THROTTLE_MINUTES} min. Investigate Cloudflare logs: \`npx wrangler tail\`._`,
          color: 0xe74c3c,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  }).catch(() => {});
  await env.STATE.put(k.errorAlert, String(now));
}

function isTransient(err) {
  return (
    err.name === "TimeoutError" ||
    err.name === "AbortError" ||
    /aborted due to timeout/i.test(err.message)
  );
}

function select(url) {
  const id = url.searchParams.get("id");
  if (!id) return WATCHERS;
  return WATCHERS.filter((w) => w.id.toLowerCase() === id.toLowerCase());
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        // One watcher failing must not stop the others.
        const results = await Promise.all(
          WATCHERS.map(async (w) => {
            try {
              const result = await check(env, w, { source: "cron" });
              await maybeWeeklyPing(env, w, result.snapshot);
              return true;
            } catch (err) {
              if (isTransient(err)) {
                console.warn(
                  `transient error (${w.id}), skipping alert:`,
                  err.message
                );
                return false;
              }
              await notifyError(env, w, err);
              return false;
            }
          })
        );
        await pingHeartbeat(env, results.every(Boolean) ? "" : "/fail");
      })()
    );
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const PROTECTED = new Set([
      "/check",
      "/test-alert",
      "/simulate-restock",
      "/reset",
    ]);
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
      if (select(url).length === 0) {
        return new Response("unknown id", { status: 404 });
      }
    }

    if (url.pathname === "/check") {
      const results = await Promise.all(
        select(url).map(async (w) => {
          try {
            return await check(env, w, { source: "manual" });
          } catch (err) {
            return { id: w.id, product: w.name, error: err.message };
          }
        })
      );
      const failed = results.every((r) => r.error);
      return Response.json(results, { status: failed ? 500 : 200 });
    }

    if (url.pathname === "/reset") {
      for (const w of select(url)) {
        const k = keysFor(w.id);
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
        for (const w of select(url)) {
          const k = keysFor(w.id);
          const prevState = (await env.STATE.get(k.state)) || "out";
          const prevAlertTs = (await env.STATE.get(k.alert)) || "0";
          const fakeSnapshot = {
            signal: "in_stock_online",
            statusText: "in stock",
            fields: [
              { name: "Status", value: "Available (simulated)", inline: true },
            ],
            raw: { simulated: true },
          };
          const shouldAlert = shouldAlertNow({
            signal: fakeSnapshot.signal,
            prevSignal: prevState,
            hoursSinceAlert: 0,
          });
          let alerted = false;
          if (shouldAlert) {
            const msg = buildDiscordMessage(w, fakeSnapshot.signal, fakeSnapshot);
            msg.embeds[0].title = "[SIMULATION] " + msg.embeds[0].title;
            msg.embeds[0].description +=
              "\n\n_This is a simulated restock running the real alert logic. State has been restored — live monitoring continues._";
            await postDiscord(env.DISCORD_WEBHOOK, msg);
            alerted = true;
          }
          await env.STATE.put(k.state, prevState);
          await env.STATE.put(k.alert, prevAlertTs);
          decisions.push({
            id: w.id,
            product: w.name,
            storedStateBefore: prevState,
            shouldAlert,
            alerted,
          });
        }
        return Response.json({
          ok: true,
          simulated: true,
          decisions,
          note: "Stored state was restored to its original value. Live cron continues monitoring real APIs.",
        });
      } catch (err) {
        return new Response(`error: ${err.message}`, { status: 500 });
      }
    }

    if (url.pathname === "/test-alert") {
      try {
        if (!env.DISCORD_WEBHOOK)
          return new Response("DISCORD_WEBHOOK not set", { status: 500 });
        const sent = [];
        for (const w of select(url)) {
          const snap = await w.fetchSnapshot();
          const msg = buildDiscordMessage(w, "in_stock_online", snap);
          msg.embeds[0].title = "[TEST] " + msg.embeds[0].title;
          msg.embeds[0].description +=
            "\n\n_This is a test alert. Stored state was NOT modified — live monitoring continues._";
          msg.embeds[0].color = 0x9b59b6;
          await postDiscord(env.DISCORD_WEBHOOK, msg);
          sent.push({
            id: w.id,
            product: w.name,
            storedState: (await env.STATE.get(keysFor(w.id).state)) || "out",
            currentSnapshot: snap,
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
      `Stock Watcher\n\nWatching:\n${WATCHERS.map(
        (w) => `  ${w.id.padEnd(10)} ${w.name}`
      ).join(
        "\n"
      )}\n\nEndpoints (add ?id=<id> to target one product):\n  GET /check             - run a real check now\n  GET /test-alert        - send a test Discord message (no state change)\n  GET /simulate-restock  - run real alert logic against a fake in-stock response\n  GET /reset             - clear stored state\n`,
      { headers: { "Content-Type": "text/plain" } }
    );
  },
};
