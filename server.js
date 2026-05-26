// ═══════════════════════════════════════════════════════════════════════════
//  Samudrik Shastra — Full Server
//  Features: Palm reading proxy, SQLite DB, Razorpay payments, Admin API
//  Deploy: Render.com / Railway.app
//  Env vars needed:
//    ANTHROPIC_API_KEY   — your Anthropic key
//    ADMIN_PASSWORD      — password to access admin panel (e.g. "mypassword123")
//    RAZORPAY_KEY_ID     — from Razorpay dashboard (optional, for payments)
//    RAZORPAY_KEY_SECRET — from Razorpay dashboard (optional)
//    PRICE_INR           — price per reading in paise (e.g. 49900 = ₹499)
//    FREE_MODE           — set to "true" to disable payments during testing
// ═══════════════════════════════════════════════════════════════════════════

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123";
const RZP_ID = process.env.RAZORPAY_KEY_ID || "";
const RZP_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const PRICE_PAISE = parseInt(process.env.PRICE_INR || "49900");
const FREE_MODE = process.env.FREE_MODE === "true";

// ── In-memory DB (persists while server runs; swap for SQLite/Postgres later) 
const DB = {
  readings: [],   // { id, name, phone, paymentId, status, createdAt, readingData }
  orders: [],     // { id, orderId, amount, status, createdAt }
  nextId: 1,
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function body(req) {
  return new Promise((resolve, reject) => {
    const c = []; req.on("data", d => c.push(d));
    req.on("end", () => resolve(Buffer.concat(c).toString()));
    req.on("error", reject);
  });
}
function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
function authAdmin(req) {
  const auth = req.headers["authorization"] || "";
  return auth === `Bearer ${ADMIN_PASS}`;
}
function makeId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── Razorpay helpers ─────────────────────────────────────────────────────────
function razorpayRequest(path, method, payload) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${RZP_ID}:${RZP_SECRET}`).toString("base64");
    const body = payload ? JSON.stringify(payload) : null;
    const opts = {
      hostname: "api.razorpay.com", path, method,
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {})
      }
    };
    const req = https.request(opts, res => {
      const c = []; res.on("data", d => c.push(d));
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Palm reading via Anthropic ───────────────────────────────────────────────
const PALM_SYSTEM = `You are a master Samudrik Shastra (Vedic palmistry) expert. Analyze this palm image with extreme precision, deep empathy, and specific life predictions.

Study: Life Line, Heart Line, Head Line, Fate Line, Sun Line, Health Line, Marriage Lines, Money Lines, all 7 mounts (Venus Jupiter Saturn Apollo Mercury Moon Mars), hand shape, thumb, fingers, fine lines, crosses, islands, breaks, chains, stars.

Be SPECIFIC. Give EXACT timing windows (month + year). Identify real problems. Cover: job/career/job loss, property/house, marriage/relationships, foreign travel/abroad job, business, promotion, health, finances.

For each major prediction give 3 windows: primary, backup, final fallback.

Respond ONLY with raw JSON. No text before or after. No markdown. Start with { end with }.

Required JSON structure:
{"hand_type":"...","hand_typeHi":"...","overall_energy":"...","overall_energyHi":"...","lucky_period":"...","predictions":[{"category":"emoji Name","categoryHi":"हिंदी","color":"#hex","items":[{"label":"...","labelHi":"...","reading":"...","readingHi":"...","type":"current|positive|warning|info","timeline":"Mon Year – Mon Year","timelineHi":"..."}]}],"problems":[{"area":"...","areaHi":"...","issue":"...","issueHi":"...","severity":"mild|moderate|significant","line":"...","deepDive":"..."}],"remedies":[{"for":"...","forHi":"...","type":"Mantra|Ritual|Lifestyle|Charity|Vastu","typeHi":"...","remedy":"...","remedyHi":"...","timing":"...","timingHi":"..."}],"gemstones":[{"stone":"ruby|pearl|coral|emerald|yellow_sapphire|diamond|blue_sapphire|hessonite|cats_eye","reason":"...","reasonHi":"...","weight":"...","metal":"...","day_to_wear":"..."}],"vastu":[{"direction":"...","en":"...","hi":"..."}],"lifestyle":[{"title":"...","titleHi":"...","en":"...","hi":"..."}],"positive_signs":[{"en":"...","hi":"..."}]}

Include 5-7 prediction categories, 4-6 problems, 5-7 remedies, 2-3 gemstones, 5 vastu, 5 lifestyle, 4-5 positive signs.`;

async function analyzePalm(imageData, mediaType) {
  const payload = JSON.stringify({
    model: "claude-opus-4-5",
    max_tokens: 4000,
    system: PALM_SYSTEM,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageData } },
      { type: "text", text: "Analyze this palm using Samudrik Shastra. Return only the JSON." }
    ]}]
  });
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(payload) }
    };
    const req = https.request(opts, res => {
      const c = []; res.on("data", d => c.push(d));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(c).toString());
          if (data.error) return reject(new Error(data.error.message));
          const text = data.content?.find(b => b.type === "text")?.text || "";
          const s = text.indexOf("{"); const e = text.lastIndexOf("}");
          if (s === -1 || e === -1) return reject(new Error("No JSON in AI response"));
          resolve(JSON.parse(text.slice(s, e + 1)));
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(payload); req.end();
  });
}

// ── Route handlers ───────────────────────────────────────────────────────────
const routes = {

  // Health
  "GET /": async (req, res) => {
    const filePath = path.join(__dirname, "index.html");
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>🔮 Samudrik Shastra is running!</h1><p>Upload index.html to this directory.</p>");
    }
  },

  "GET /health": async (req, res) => {
    json(res, { status: "ok", freeMode: FREE_MODE, hasApiKey: !!API_KEY, hasRazorpay: !!(RZP_ID && RZP_SECRET), readings: DB.readings.length });
  },

  // Create Razorpay order (step 1 of payment)
  "POST /create-order": async (req, res, b) => {
    if (FREE_MODE) return json(res, { freeMode: true, orderId: "free_" + makeId() });
    if (!RZP_ID || !RZP_SECRET) return json(res, { error: "Payment not configured" }, 500);
    const { name, phone } = JSON.parse(b);
    try {
      const order = await razorpayRequest("/v1/orders", "POST", {
        amount: PRICE_PAISE, currency: "INR",
        receipt: "rcpt_" + makeId(),
        notes: { name, phone }
      });
      DB.orders.push({ id: order.id, amount: PRICE_PAISE, status: "created", createdAt: new Date().toISOString(), name, phone });
      json(res, { orderId: order.id, amount: PRICE_PAISE, keyId: RZP_ID });
    } catch(e) { json(res, { error: e.message }, 500); }
  },

  // Read palm (main endpoint — verifies payment first)
  "POST /read-palm": async (req, res, b) => {
    const { imageData, mediaType, name, phone, paymentId, orderId } = JSON.parse(b);
    if (!imageData) return json(res, { error: "imageData required" }, 400);
    if (!API_KEY) return json(res, { error: "Server API key not configured" }, 500);

    // Payment verification
    if (!FREE_MODE) {
      if (!paymentId || !orderId) return json(res, { error: "Payment required", code: "PAYMENT_REQUIRED" }, 402);
      // Verify with Razorpay
      try {
        const payment = await razorpayRequest(`/v1/payments/${paymentId}`, "GET", null);
        if (payment.status !== "captured" && payment.status !== "authorized") {
          return json(res, { error: "Payment not verified" }, 402);
        }
        // Mark order paid
        const ord = DB.orders.find(o => o.id === orderId);
        if (ord) ord.status = "paid";
      } catch(e) { return json(res, { error: "Payment verification failed: " + e.message }, 402); }
    }

    // Do the reading
    try {
      const reading = await analyzePalm(imageData, mediaType);
      const record = {
        id: makeId(), name: name || "Anonymous", phone: phone || "",
        paymentId: paymentId || "free", orderId: orderId || "free",
        status: "completed", createdAt: new Date().toISOString(),
        readingData: reading
      };
      DB.readings.push(record);
      json(res, { reading, recordId: record.id });
    } catch(e) { json(res, { error: e.message }, 500); }
  },

  // ── Admin endpoints (all require Authorization: Bearer <ADMIN_PASSWORD>) ──

  "GET /admin/stats": async (req, res) => {
    if (!authAdmin(req)) return json(res, { error: "Unauthorized" }, 401);
    const today = new Date().toDateString();
    const todayReadings = DB.readings.filter(r => new Date(r.createdAt).toDateString() === today);
    const totalRevenue = DB.orders.filter(o => o.status === "paid").reduce((s, o) => s + o.amount, 0);
    json(res, {
      totalReadings: DB.readings.length,
      todayReadings: todayReadings.length,
      totalRevenue: totalRevenue / 100,
      paidReadings: DB.readings.filter(r => r.paymentId !== "free").length,
      freeReadings: DB.readings.filter(r => r.paymentId === "free").length,
      priceINR: PRICE_PAISE / 100,
      freeMode: FREE_MODE,
    });
  },

  "GET /admin/readings": async (req, res) => {
    if (!authAdmin(req)) return json(res, { error: "Unauthorized" }, 401);
    // Return list without full reading data (summary only)
    const list = DB.readings.map(r => ({
      id: r.id, name: r.name, phone: r.phone,
      paymentId: r.paymentId, status: r.status,
      createdAt: r.createdAt,
      handType: r.readingData?.hand_type || "",
      problemCount: r.readingData?.problems?.length || 0,
    })).reverse();
    json(res, { readings: list });
  },

  "GET /admin/reading": async (req, res) => {
    if (!authAdmin(req)) return json(res, { error: "Unauthorized" }, 401);
    const url = new URL("http://x" + req.url);
    const id = url.searchParams.get("id");
    const record = DB.readings.find(r => r.id === id);
    if (!record) return json(res, { error: "Not found" }, 404);
    json(res, record);
  },

  "GET /admin/orders": async (req, res) => {
    if (!authAdmin(req)) return json(res, { error: "Unauthorized" }, 401);
    json(res, { orders: [...DB.orders].reverse() });
  },
};

// ── Server ───────────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const pathname = new URL("http://x" + req.url).pathname;
  const key = `${req.method} ${pathname}`;
  const handler = routes[key];
  if (!handler) { json(res, { error: "Not found" }, 404); return; }
  try {
    const b = req.method === "POST" ? await body(req) : null;
    await handler(req, res, b);
  } catch(e) { json(res, { error: e.message }, 500); }
}).listen(PORT, () => {
  console.log(`✅ Samudrik Shastra server on port ${PORT}`);
  console.log(`   API Key: ${API_KEY ? "✓" : "✗ MISSING"}`);
  console.log(`   Razorpay: ${RZP_ID ? "✓" : "✗ not configured"}`);
  console.log(`   Free Mode: ${FREE_MODE}`);
  console.log(`   Price: ₹${PRICE_PAISE/100}`);
  console.log(`   Admin password: ${ADMIN_PASS}`);
});
