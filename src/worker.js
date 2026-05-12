const SKU = "13799023";
const PRODUCT_URL =
  "https://www.bestbuy.ca/en-ca/product/canon-powershot-g7-x-mark-iii-wi-fi-20-1mp-4-2x-optical-zoom-digital-camera-black/13799023";
const PRODUCT_NAME = "Canon PowerShot G7 X Mark III";

const AVAILABILITY_URL =
  `https://www.bestbuy.ca/ecomm-api/availability/products?accept=application%2Fvnd.bestbuy.standardproduct.v1%2Bjson&accept-language=en-CA&skus=${SKU}`;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const KV_LAST_STATE = `state:${SKU}`;
const KV_LAST_ALERT = `alert_ts:${SKU}`;
const KV_LAST_ERROR_ALERT = `error_alert_ts:${SKU}`;
const REPEAT_ALERT_HOURS = 6;
const ERROR_ALERT_THROTTLE_MINUTES = 30;

async function fetchAvailability() {
  const res = await fetch(AVAILABILITY_URL, {
    headers: {
      "User-Agent": UA,
      Accept: "application/vnd.bestbuy.standardproduct.v1+json",
      "Accept-Language": "en-CA,en;q=0.9",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
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

  await env.STATE.put(KV_LAST_STATE, signal);

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
    await fetch(env.HEALTHCHECK_URL + suffix, { method: "GET" });
  } catch (e) {
    console.error("heartbeat ping failed:", e.message);
  }
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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await check(env, { source: "cron" });
          await pingHeartbeat(env);
        } catch (err) {
          await pingHeartbeat(env, "/fail");
          await notifyError(env, err);
        }
      })()
    );
  },

  async fetch(req, env) {
    const url = new URL(req.url);
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
