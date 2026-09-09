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

// ponytail: PDF generation must finish (or time out) BEFORE the webhook
// fires, otherwise the webhook goes out with no pdf_url to email/SMS to the
// client. This is a deliberate await, not a fire-and-forget — but it's
// wrapped so a slow/broken PDF service degrades to "no pdf_url" rather than
// failing the whole lead submission.
var PDF_TIMEOUT_MS = 60000; // PHP+Dompdf on shared hosting can be slow under real load; give it a full minute before giving up.

async function generatePdf(payload) {
  if (!process.env.PDF_SERVICE_URL) {
    console.error("[pdf] skipped: PDF_SERVICE_URL is not set");
    return null;
  }

  var controller = new AbortController();
  var timeout = setTimeout(function() { controller.abort(); }, PDF_TIMEOUT_MS);
  var started = Date.now();

  try {
    var response = await fetch(process.env.PDF_SERVICE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": process.env.PDF_SERVICE_API_KEY
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      var bodyText = await response.text().catch(function() { return "<unreadable>"; });
      console.error("[pdf] failed: non-OK response", response.status, response.statusText, "after", Date.now() - started, "ms - body:", bodyText.slice(0, 500));
      return null;
    }

    var data = await response.json();
    if (!data || !data.url) {
      console.error("[pdf] failed: OK response but no url in body -", JSON.stringify(data).slice(0, 500));
      return null;
    }
    console.log("[pdf] ok - generated in", Date.now() - started, "ms:", data.url);
    return data.url;
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("[pdf] failed: timed out after", Date.now() - started, "ms (cap is", PDF_TIMEOUT_MS, "ms)");
    } else {
      console.error("[pdf] failed: request error after", Date.now() - started, "ms -", err.message || err);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function handler(req, res) {
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
    // Brisbane is UTC+10 year-round - matches what Meta Ads Manager shows for
    // an AU ad account, so overnight leads land on the same calendar day there
    // as they do here. Only used if the client didn't already send one.
    created_at: body.created_at || new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().replace("Z", "+10:00")
  };

  if (!EMAIL_RE.test(contact.email)) {
    res.status(400).json({ error: "Invalid email" });
    return;
  }

  var answers = (body.answers && typeof body.answers === "object") ? body.answers : {};

  // 1. Generate the PDF first and wait for the result (or null on failure/timeout).
  var pdfUrl = await generatePdf({
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    answers: answers
  });

  // Supabase columns are fixed as q1..q6; the webhook gets the same answers
  // keyed by their question heading instead, for human-readable payloads.
  var supabasePayload = Object.assign({}, contact, {
    q1: body.q1, q2: body.q2, q3: body.q3, q4: body.q4, q5: body.q5, q6: body.q6,
    pdf_url: pdfUrl
  });
  var webhookPayload = Object.assign({}, contact, {
    answers: answers,
    pdf_url: pdfUrl,
    lead_source: clip(body.lead_source, 100),
    campaign: clip(body.campaign, 200),
    ad_name: clip(body.ad_name, 200),
    adset: clip(body.adset, 200),
    utm_source: clip(body.utm_source, 100),
    utm_medium: clip(body.utm_medium, 100),
    utm_campaign: clip(body.utm_campaign, 200),
    utm_content: clip(body.utm_content, 200),
    utm_adset: clip(body.utm_adset, 200),
    utm_ad: clip(body.utm_ad, 200),
    page_url: clip(body.page_url, 500)
  });

  // 2. NOW fan out to Supabase + webhook(s) — pdf_url is already resolved
  //    (or null) by this point, so nothing downstream is racing the PDF.
  // Each request is labeled so the logs say exactly which destination
  // succeeded/failed, instead of an unattributed "Lead submission error".
  var requests = [];
  var labels = [];

  if (process.env.SUPABASE_URL) {
    requests.push(fetch(process.env.SUPABASE_URL + "/rest/v1/leads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": process.env.SUPABASE_SERVICE_KEY,
        "Authorization": "Bearer " + process.env.SUPABASE_SERVICE_KEY,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(supabasePayload)
    }));
    labels.push("supabase");
  } else {
    console.log("[lead] skipped supabase: SUPABASE_URL is not set");
  }

  // WEBHOOK_URL can be a single URL or a comma-separated list to fan the lead out to multiple webhooks.
  var webhookUrls = (process.env.WEBHOOK_URL || "").split(",").map(function(u) { return u.trim(); }).filter(Boolean);
  if (!webhookUrls.length) { console.error("[lead] no WEBHOOK_URL configured - nowhere to send this lead"); }
  webhookUrls.forEach(function(url) {
    requests.push(fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload)
    }));
    labels.push("webhook:" + url);
  });

  if (!requests.length) {
    console.error("[lead] no destinations configured at all - lead was not sent anywhere");
    res.status(502).json({ error: "No lead destinations configured" });
    return;
  }

  var results = await Promise.allSettled(requests);
  var anyOk = results.some(function(r) { return r.status === "fulfilled" && r.value.ok; });

  results.forEach(function(r, i) {
    if (r.status === "rejected") { console.error("[lead] failed (" + labels[i] + "):", (r.reason && r.reason.message) || r.reason); }
    else if (!r.value.ok) { console.error("[lead] non-OK response (" + labels[i] + "):", r.value.status); }
    else { console.log("[lead] ok (" + labels[i] + ")"); }
  });

  if (anyOk) {
    res.status(200).json({ ok: true, pdf_url: pdfUrl });
  } else {
    res.status(502).json({ error: "Failed to save lead" });
  }
}

module.exports = handler;
// Vercel kills a function at its own platform timeout regardless of our own
// AbortController - without this, a 60s PDF wait could get cut off by a
// shorter default before it ever gets the chance to time out gracefully.
module.exports.config = { maxDuration: 70 };