// ponytail: in-memory Map is single-instance only — fine for low/medium
// traffic. Swap for Upstash Redis (or similar shared store) if this needs
// to rate-limit across multiple serverless instances at scale.
var rateLimitMap = new Map();
var RATE_LIMIT_WINDOW_MS = 60 * 1000;
var RATE_LIMIT_MAX = 5;

function isRateLimited(ip) {
  var now = Date.now();
  var recent = (rateLimitMap.get(ip) || []).filter(function(t) { return now - t < RATE_LIMIT_WINDOW_MS; });
  recent.push(now);
  rateLimitMap.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clip(val, max) {
  return String(val || "").trim().slice(0, max);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  var ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  if (isRateLimited(ip)) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  var body = req.body || {};

  if (body.honeypot) {
    res.status(200).json({ ok: true });
    return;
  }

  var contact = {
    name: clip(body.name, 100),
    phone: clip(body.phone, 20),
    email: clip(body.email, 200),
    suburb: clip(body.suburb, 100),
    created_at: body.created_at || new Date().toISOString()
  };

  if (!EMAIL_RE.test(contact.email)) {
    res.status(400).json({ error: "Invalid email" });
    return;
  }

  // Supabase columns are fixed as q1..q6; the webhook gets the same answers
  // keyed by their question heading instead, for human-readable payloads.
  var supabasePayload = Object.assign({}, contact, {
    q1: body.q1, q2: body.q2, q3: body.q3, q4: body.q4, q5: body.q5, q6: body.q6
  });
  var webhookPayload = Object.assign({}, contact, {
    answers: (body.answers && typeof body.answers === "object") ? body.answers : {}
  });

  var requests = [
    fetch(process.env.SUPABASE_URL + "/rest/v1/leads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": process.env.SUPABASE_SERVICE_KEY,
        "Authorization": "Bearer " + process.env.SUPABASE_SERVICE_KEY,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(supabasePayload)
    })
  ];

  if (process.env.WEBHOOK_URL) {
    requests.push(fetch(process.env.WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload)
    }));
  }

  var results = await Promise.allSettled(requests);
  var anyOk = results.some(function(r) { return r.status === "fulfilled" && r.value.ok; });

  results.forEach(function(r) {
    if (r.status === "rejected") { console.error("Lead submission error:", r.reason); }
    else if (!r.value.ok) { console.error("Lead submission non-OK response:", r.value.status); }
  });

  if (anyOk) {
    res.status(200).json({ ok: true });
  } else {
    res.status(502).json({ error: "Failed to save lead" });
  }
};
