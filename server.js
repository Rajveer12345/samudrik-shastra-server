const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123";
const FREE_MODE = process.env.FREE_MODE === "true";

const DB = { readings: [] };

// ── Helpers ──────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", d => chunks.push(d));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJSON(res, obj, status) {
  try {
    const str = JSON.stringify(obj);
    res.writeHead(status || 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(str, "utf8")
    });
    res.end(str);
  } catch (e) {
    const err = JSON.stringify({ error: "Response serialization failed" });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(err);
  }
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

// ── Call Claude API ───────────────────────────────────────────────────────────
function callClaude(textPrompt, imageData, imageType) {
  const content = [];
  if (imageData) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: imageType || "image/jpeg", data: imageData }
    });
  }
  content.push({ type: "text", text: textPrompt });

  const reqBody = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1500,
    messages: [{ role: "user", content: content }]
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(reqBody)
      }
    };

    const req = https.request(options, (res) => {
      const parts = [];
      res.on("data", d => parts.push(d));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
          if (parsed.error) return reject(new Error(parsed.error.message));
          const textBlock = (parsed.content || []).find(b => b.type === "text");
          resolve(textBlock ? textBlock.text : "");
        } catch (e) {
          reject(new Error("Failed to parse Anthropic response: " + e.message));
        }
      });
    });

    req.on("error", reject);
    req.write(reqBody);
    req.end();
  });
}

// ── Palm analysis ─────────────────────────────────────────────────────────────
async function analyzePalm(imageData, mediaType) {

  // STEP 1 — Get a plain English reading (no JSON, no special chars)
  const plainReading = await callClaude(
    "You are a Samudrik Shastra palmistry expert. Analyze this palm. " +
    "Write short bullet points only. Use simple English words only. " +
    "No special punctuation, no dashes except hyphens, no quotes inside text. " +
    "Cover: hand type, overall reading, career/job with timing (month year), " +
    "finance, health, marriage/relationships with timing, property, " +
    "foreign travel, business, top 3 problems (mention which palm line), " +
    "3 remedies with timing, 2 gemstones, vastu tips, lifestyle tips, positive signs.",
    imageData, mediaType
  );

  // STEP 2 — Convert to JSON (text only, no image, much faster and more reliable)
  const jsonPrompt = "Convert this palm reading into JSON. " +
    "Rules: ASCII only. No Hindi. No smart quotes. No backslash-n in values. " +
    "Replace any newline inside a value with a space. " +
    "Values must be short sentences under 200 characters each. " +
    "Return ONLY the JSON object starting with { and ending with }.\n\n" +
    "Palm reading:\n" + plainReading.slice(0, 2000) + "\n\n" +
    "JSON template - fill in the VALUE placeholders:\n" +
    '{"hand_type":"VALUE",' +
    '"overall_energy":"VALUE",' +
    '"lucky_period":"VALUE",' +
    '"predictions":[' +
    '{"category":"Career","color":"#E67E22","items":[' +
    '{"label":"Current Status","reading":"VALUE","type":"current","timeline":""},' +
    '{"label":"Best Window","reading":"VALUE","type":"positive","timeline":"VALUE"},' +
    '{"label":"Backup Window","reading":"VALUE","type":"warning","timeline":"VALUE"}]},' +
    '{"category":"Finance","color":"#27AE60","items":[' +
    '{"label":"Reading","reading":"VALUE","type":"current","timeline":""}]},' +
    '{"category":"Marriage and Relationships","color":"#E8294A","items":[' +
    '{"label":"Reading","reading":"VALUE","type":"info","timeline":"VALUE"}]},' +
    '{"category":"Property and House","color":"#8E44AD","items":[' +
    '{"label":"Reading","reading":"VALUE","type":"info","timeline":"VALUE"}]},' +
    '{"category":"Health","color":"#16A085","items":[' +
    '{"label":"Reading","reading":"VALUE","type":"current","timeline":""}]},' +
    '{"category":"Foreign and Travel","color":"#2471A3","items":[' +
    '{"label":"Reading","reading":"VALUE","type":"info","timeline":"VALUE"}]}],' +
    '"problems":[' +
    '{"area":"VALUE","issue":"VALUE","severity":"significant","line":"VALUE","deepDive":"VALUE"},' +
    '{"area":"VALUE","issue":"VALUE","severity":"moderate","line":"VALUE","deepDive":"VALUE"},' +
    '{"area":"VALUE","issue":"VALUE","severity":"mild","line":"VALUE","deepDive":"VALUE"}],' +
    '"remedies":[' +
    '{"for":"VALUE","type":"Mantra","remedy":"VALUE","timing":"VALUE"},' +
    '{"for":"VALUE","type":"Ritual","remedy":"VALUE","timing":"VALUE"},' +
    '{"for":"VALUE","type":"Lifestyle","remedy":"VALUE","timing":"VALUE"},' +
    '{"for":"VALUE","type":"Charity","remedy":"VALUE","timing":"VALUE"}],' +
    '"gemstones":[' +
    '{"stone":"blue_sapphire","reason":"VALUE","weight":"3-5 carats","metal":"Silver","day_to_wear":"Saturday"},' +
    '{"stone":"yellow_sapphire","reason":"VALUE","weight":"4-5 carats","metal":"Gold","day_to_wear":"Thursday"}],' +
    '"vastu":[' +
    '{"direction":"Sleeping Direction","en":"VALUE"},' +
    '{"direction":"Work Desk Direction","en":"VALUE"},' +
    '{"direction":"Prayer Corner","en":"VALUE"},' +
    '{"direction":"Wealth Zone","en":"VALUE"}],' +
    '"lifestyle":[' +
    '{"title":"Morning Routine","en":"VALUE"},' +
    '{"title":"Weekly Practice","en":"VALUE"},' +
    '{"title":"Diet and Health","en":"VALUE"}],' +
    '"positive_signs":[' +
    '{"en":"VALUE"},{"en":"VALUE"},{"en":"VALUE"}]}';

  const jsonText = await callClaude(jsonPrompt, null, null);

  // Extract JSON block
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON found in AI response");
  }

  // Keep only ASCII printable characters (32-126) plus common safe chars
  const raw = jsonText.slice(start, end + 1);
  let safe = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) {
      safe += " "; // tabs and newlines become spaces
    } else if (c >= 32 && c <= 126) {
      safe += raw[i]; // normal ASCII
    }
    // everything else (Hindi, emoji, smart quotes etc.) is dropped
  }

  // Parse it
  return JSON.parse(safe);
}

// ── Routes ────────────────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const pathname = new URL("http://x" + req.url).pathname;

  // Serve frontend
  if (req.method === "GET" && pathname === "/") {
    const f = path.join(__dirname, "index.html");
    if (fs.existsSync(f)) {
      const html = fs.readFileSync(f);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length });
      res.end(html);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Samudrik Shastra running. index.html not found.</h1>");
    }
    return;
  }

  // Health check
  if (req.method === "GET" && pathname === "/health") {
    sendJSON(res, { status: "ok", hasKey: !!API_KEY, freeMode: FREE_MODE });
    return;
  }

  // Palm reading
  if (req.method === "POST" && pathname === "/read-palm") {
    if (!API_KEY) { sendJSON(res, { error: "API key not set on server" }, 500); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJSON(res, { error: "Invalid request body" }, 400); return; }

    if (!body.imageData) { sendJSON(res, { error: "imageData is required" }, 400); return; }

    try {
      const reading = await analyzePalm(body.imageData, body.mediaType);
      const record = {
        id: makeId(), name: body.name || "Anonymous", phone: body.phone || "",
        paymentId: body.paymentId || "free", status: "completed",
        createdAt: new Date().toISOString(), readingData: reading
      };
      DB.readings.push(record);
      sendJSON(res, { reading: reading, recordId: record.id });
    } catch (e) {
      console.error("Reading error:", e.message);
      sendJSON(res, { error: "Reading failed: " + e.message }, 500);
    }
    return;
  }

  // Admin stats
  if (req.method === "GET" && pathname === "/admin/stats") {
    if (!authAdmin(req)) { sendJSON(res, { error: "Unauthorized" }, 401); return; }
    const today = new Date().toDateString();
    sendJSON(res, {
      totalReadings: DB.readings.length,
      todayReadings: DB.readings.filter(r => new Date(r.createdAt).toDateString() === today).length,
      totalRevenue: 0, paidReadings: 0, freeReadings: DB.readings.length,
      priceINR: 499, freeMode: FREE_MODE
    });
    return;
  }

  // Admin readings list
  if (req.method === "GET" && pathname === "/admin/readings") {
    if (!authAdmin(req)) { sendJSON(res, { error: "Unauthorized" }, 401); return; }
    sendJSON(res, {
      readings: DB.readings.map(r => ({
        id: r.id, name: r.name, phone: r.phone, paymentId: r.paymentId,
        status: r.status, createdAt: r.createdAt,
        handType: (r.readingData || {}).hand_type || "",
        problemCount: ((r.readingData || {}).problems || []).length
      })).reverse()
    });
    return;
  }

  // Admin single reading
  if (req.method === "GET" && pathname === "/admin/reading") {
    if (!authAdmin(req)) { sendJSON(res, { error: "Unauthorized" }, 401); return; }
    const id = new URL("http://x" + req.url).searchParams.get("id");
    const record = DB.readings.find(r => r.id === id);
    if (!record) { sendJSON(res, { error: "Not found" }, 404); return; }
    sendJSON(res, record);
    return;
  }

  // Admin orders
  if (req.method === "GET" && pathname === "/admin/orders") {
    if (!authAdmin(req)) { sendJSON(res, { error: "Unauthorized" }, 401); return; }
    sendJSON(res, { orders: [] });
    return;
  }

  sendJSON(res, { error: "Not found" }, 404);
}

// ── Start server ──────────────────────────────────────────────────────────────
http.createServer((req, res) => {
  handleRequest(req, res).catch(e => {
    console.error("Unhandled error:", e.message);
    try { sendJSON(res, { error: "Internal server error" }, 500); } catch (_) {}
  });
}).listen(PORT, () => {
  console.log("Samudrik Shastra server on port " + PORT);
  console.log("API Key: " + (API_KEY ? "OK" : "MISSING - set ANTHROPIC_API_KEY"));
  console.log("Free Mode: " + FREE_MODE);
  console.log("Admin: " + ADMIN_PASS);
});
