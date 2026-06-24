/**
 * SaltNet — visitor-country counter (Cloudflare Worker, free, no expiry).
 *
 * Stores one JSON aggregate { "<ISO2>": <count>, ... } in a KV namespace and
 * returns the whole object so the front-end can colour every visited country.
 * Unlike a free TTL service, KV data does not auto-expire.
 *
 *   GET  /            -> current aggregate (JSON)
 *   POST /hit?cc=SA   -> increment country SA, return updated aggregate
 *
 * Deploy (dashboard, ~5 min, free, no credit card):
 *   1. cloudflare.com -> Workers & Pages -> Create -> Worker -> name it
 *      (e.g. saltnet-visits) -> Deploy -> "Edit code" -> paste this file
 *      -> Save and deploy.
 *   2. Storage & Databases -> KV -> Create namespace, name it "VISITS".
 *   3. Worker -> Settings -> Bindings -> Add -> KV namespace:
 *        Variable name = VISITS , Namespace = the one you created -> Save.
 *   4. Copy the Worker URL (https://<name>.<sub>.workers.dev) and paste it into
 *      docs/app.js -> VISITOR_API.
 *
 * Optional: seed historical counts by POSTing /hit repeatedly, or set the KV
 * key "agg" directly in the dashboard to a JSON like {"SA":16,"US":8,...}.
 */
export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const KEY = "agg";

    let agg = {};
    try { agg = JSON.parse((await env.VISITS.get(KEY)) || "{}"); } catch (_) { agg = {}; }

    if (request.method === "POST" && url.pathname === "/hit") {
      const cc = (url.searchParams.get("cc") || "")
        .toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
      if (cc.length === 2) {
        agg[cc] = (agg[cc] || 0) + 1;
        await env.VISITS.put(KEY, JSON.stringify(agg));
      }
    }

    return new Response(JSON.stringify(agg), {
      headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
    });
  },
};
