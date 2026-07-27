const SKU = "13799023";
const PRODUCT_URL =
  "https://www.bestbuy.ca/en-ca/product/canon-powershot-g7-x-mark-iii-wi-fi-20-1mp-4-2x-optical-zoom-digital-camera-black/13799023";
const PRODUCT_NAME = "Canon PowerShot G7 X Mark III";

const AVAILABILITY_URL =
  `https://www.bestbuy.ca/ecomm-api/availability/products?accept=application%2Fvnd.bestbuy.standardproduct.v1%2Bjson&accept-language=en-CA&skus=${SKU}`;

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

const KV_LAST_STATE = `state:${SKU}`;
const KV_LAST_ALERT = `alert_ts:${SKU}`;
const KV_LAST_ERROR_ALERT = `error_alert_ts:${SKU}`;
const KV_LAST_WEEKLY_PING = `weekly_ping_ts:${SKU}`;
const KV_FIRST_SEEN = `first_seen_ts:${SKU}`;
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
  const a = data?.availabilities?.[0];
  if (!a) throw new Error("No availability record");
  return {
    shippingStatus: a.shipping?.status ?? "Unknown",
    shippingPurchasable: !!a.shipping?.purchasable,
    backorderable: !!a.shipping?.isBackorderable,
    quantityRemaining: a.shipping?.quantityRemaining ?? 0,
    pickupPurchasable: !!a.pickup?.purchasable,
    pickupStatus: a.pickup?.status ?? "Unknown",
    raw: a,
  };
}

function inStockSignal(a) {
  if (a.shippingPurchasable) return "in_stock_online";
  if (a.backorderable) return "backorder";
  if (a.pickupPurchasable) return "pickup_only";
  return "out";
}

function buildDiscordMessage(signal, a) {
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
        title: titles[signal],
        description: `**${PRODUCT_NAME}**\nSKU ${SKU}`,
        url: PRODUCT_URL,
        color: colors[signal],
        fields: [
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

async function check(env, { source }) {
  const a = await fetchAvailability();
  const signal = inStockSignal(a);
  const prevSignal = (await env.STATE.get(KV_LAST_STATE)) || "out";
  const lastAlertTs = parseInt(
    (await env.STATE.get(KV_LAST_ALERT)) || "0",
    10
  );
  const now = Date.now();
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
    await postDiscord(env.DISCORD_WEBHOOK, buildDiscordMessage(signal, a));
    await env.STATE.put(KV_LAST_ALERT, String(now));
  }

  if (signal !== prevSignal) {
    await env.STATE.put(KV_LAST_STATE, signal);
  }

  return {
    source,
    sku: SKU,
    signal,
    prevSignal,
    alerted: shouldAlert,
    snapshot: a,
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

async function maybeWeeklyPing(env, snapshot) {
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
          description: `Weekly check-in.\n**${PRODUCT_NAME}** (SKU ${SKU}) — still ${snapshot.shippingStatus.toLowerCase()}.\nDays monitoring: ${daysMonitoring}.\n\n_If you stop getting these weekly pings, the watcher is down._`,
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
          description: `SKU ${SKU}\n\n\`\`\`${err.message.slice(0, 500)}\`\`\`\n\n_Throttled to one alert per ${ERROR_ALERT_THROTTLE_MINUTES} min. Investigate Cloudflare logs: \`npx wrangler tail\`._`,
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
          const result = await check(env, { source: "cron" });
          await pingHeartbeat(env);
          await maybeWeeklyPing(env, result.snapshot);
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
    }
    if (url.pathname === "/check") {
      try {
        const result = await check(env, { source: "manual" });
        return Response.json(result);
      } catch (err) {
        return new Response(`error: ${err.message}`, { status: 500 });
      }
    }
    if (url.pathname === "/reset") {
      await env.STATE.delete(KV_LAST_STATE);
      await env.STATE.delete(KV_LAST_ALERT);
      return new Response("state cleared");
    }
    if (url.pathname === "/simulate-restock") {
      try {
        if (!env.DISCORD_WEBHOOK)
          return new Response("DISCORD_WEBHOOK not set", { status: 500 });
        const prevState = (await env.STATE.get(KV_LAST_STATE)) || "out";
        const prevAlertTs = (await env.STATE.get(KV_LAST_ALERT)) || "0";
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
        const shouldAlert =
          isInStockNow && (wasOutBefore || signalChanged);
        let alerted = false;
        if (shouldAlert) {
          const msg = buildDiscordMessage(signal, fakeSnapshot);
          msg.embeds[0].title = "[SIMULATION] " + msg.embeds[0].title;
          msg.embeds[0].description +=
            "\n\n_This is a simulated restock running the real alert logic. State has been restored — live monitoring continues._";
          await postDiscord(env.DISCORD_WEBHOOK, msg);
          alerted = true;
        }
        await env.STATE.put(KV_LAST_STATE, prevState);
        await env.STATE.put(KV_LAST_ALERT, prevAlertTs);
        return Response.json({
          ok: true,
          simulated: true,
          decision: {
            simulatedSignal: signal,
            storedStateBefore: prevState,
            isInStockNow,
            wasOutBefore,
            signalChanged,
            shouldAlert,
            alerted,
          },
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
        const a = await fetchAvailability();
        const fakeSignal = "in_stock_online";
        const msg = buildDiscordMessage(fakeSignal, a);
        msg.embeds[0].title = "[TEST] " + msg.embeds[0].title;
        msg.embeds[0].description +=
          "\n\n_This is a test alert. Stored state was NOT modified — live monitoring continues._";
        msg.embeds[0].color = 0x9b59b6;
        await postDiscord(env.DISCORD_WEBHOOK, msg);
        const prevState = (await env.STATE.get(KV_LAST_STATE)) || "out";
        return Response.json({
          ok: true,
          test: true,
          message: "Test alert sent. Stored state untouched.",
          storedState: prevState,
          currentSnapshot: a,
        });
      } catch (err) {
        return new Response(`error: ${err.message}`, { status: 500 });
      }
    }
    return new Response(
      `BestBuy Watcher\nSKU: ${SKU}\n\nEndpoints:\n  GET /check             - run a real check now\n  GET /test-alert        - send a test Discord message (no state change)\n  GET /simulate-restock  - run real alert logic against a fake in-stock response\n  GET /reset             - clear stored state\n`,
      { headers: { "Content-Type": "text/plain" } }
    );
  },
};
