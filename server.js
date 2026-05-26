const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123";
const PRICE_PAISE = parseInt(process.env.PRICE_INR || "49900");
const FREE_MODE = process.env.FREE_MODE === "true";

const DB = { readings: [], orders: [] };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const c = [];
    req.on("data", d => c.push(d));
    req.on("end", () => resolve(Buffer.concat(c).toString()));
    req.on("error", reject);
  });
}
function sendJson(res, data, status) {
  res.writeHead(status || 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
function authAdmin(req) {
  return (req.headers["authorization"] || "") === "Bearer " + ADMIN_PASS;
}
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function callClaude(userText, imageData, mediaType) {
  const content = [];
  if (imageData) {
    content.push({ type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageData } });
  }
  content.push({ type: "text", text: userText });

  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    messages: [{ role: "user", content: content }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body)
      }
    }, res => {
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (data.error) return reject(new Error(data.error.message));
          const block = (data.content || []).find(b => b.type === "text");
          resolve(block ? block.text : "");
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function analyzePalm(imageData, mediaType) {
  // STEP 1: Get plain English analysis (no JSON, no Hindi, no special chars)
  const analysis = await callClaude(
    "You are a Samudrik Shastra Vedic palmistry expert. Analyze this palm image. " +
    "Write a detailed reading covering: 1) Hand type 2) Overall energy 3) Career and job situation with specific month and year predictions " +
    "4) Financial situation 5) Health 6) Relationships and marriage with timing " +
    "7) Property and house prospects 8) Foreign travel possibilities 9) Business potential " +
    "10) Top 4 problems with which palm line shows them " +
    "11) 4 specific remedies with timing 12) 2 gemstone recommendations " +
    "13) 4 Vastu direction tips 14) 3 lifestyle practices 15) 3 positive signs found in palm. " +
    "Be specific. Use only simple English words. No special punctuation. Write in clear paragraphs.",
    imageData, mediaType
  );

  // STEP 2: Convert to JSON using only ASCII - NO Hindi in this step
  const jsonPrompt =
    "Convert this palm reading into a JSON object. " +
    "CRITICAL RULES: Use ONLY plain ASCII English characters. No Hindi. No Devanagari script. No smart quotes. No em dashes. No special symbols. " +
    "Use only: letters A-Z a-z, numbers 0-9, spaces, commas, periods, hyphens, regular apostrophes, colons, brackets. " +
    "Palm reading text:\n" + analysis + "\n\n" +
    "Return ONLY valid JSON, nothing else. Use this exact structure:\n" +
    '{"hand_type":"value",' +
    '"overall_energy":"value",' +
    '"lucky_period":"Month Year to Month Year",' +
    '"predictions":[' +
      '{"category":"Career and Job","color":"#E67E22","items":[' +
        '{"label":"Current Status","reading":"value","type":"current","timeline":""},' +
        '{"label":"Primary Job Window","reading":"value","type":"positive","timeline":"Month Year"},' +
        '{"label":"Backup Window","reading":"value","type":"warning","timeline":"Month Year"}' +
      ']},' +
      '{"category":"Finance","color":"#27AE60","items":[' +
        '{"label":"Current","reading":"value","type":"current","timeline":""}' +
      ']},' +
      '{"category":"Relationships and Marriage","color":"#E8294A","items":[' +
        '{"label":"Reading","reading":"value","type":"info","timeline":""}' +
      ']},' +
      '{"category":"Property and House","color":"#8E44AD","items":[' +
        '{"label":"Reading","reading":"value","type":"info","timeline":""}' +
      ']},' +
      '{"category":"Health","color":"#16A085","items":[' +
        '{"label":"Reading","reading":"value","type":"current","timeline":""}' +
      ']},' +
      '{"category":"Foreign Travel and Abroad","color":"#2471A3","items":[' +
        '{"label":"Reading","reading":"value","type":"info","timeline":""}' +
      ']}' +
    '],' +
    '"problems":[' +
      '{"area":"value","issue":"value","severity":"significant","line":"value","deepDive":"value"},' +
      '{"area":"value","issue":"value","severity":"moderate","line":"value","deepDive":"value"},' +
      '{"area":"value","issue":"value","severity":"moderate","line":"value","deepDive":"value"},' +
      '{"area":"value","issue":"value","severity":"mild","line":"value","deepDive":"value"}' +
    '],' +
    '"remedies":[' +
      '{"for":"value","type":"Mantra","remedy":"value","timing":"value"},' +
      '{"for":"value","type":"Ritual","remedy":"value","timing":"value"},' +
      '{"for":"value","type":"Lifestyle","remedy":"value","timing":"value"},' +
      '{"for":"value","type":"Charity","remedy":"value","timing":"value"}' +
    '],' +
    '"gemstones":[' +
      '{"stone":"blue_sapphire","reason":"value","weight":"3-5 carats","metal":"Silver","day_to_wear":"Saturday"},' +
      '{"stone":"yellow_sapphire","reason":"value","weight":"4-5 carats","metal":"Gold","day_to_wear":"Thursday"}' +
    '],' +
    '"vastu":[' +
      '{"direction":"Sleeping Direction","en":"value"},' +
      '{"direction":"Work Desk","en":"value"},' +
      '{"direction":"Prayer Corner","en":"value"},' +
      '{"direction":"Wealth Zone North","en":"value"}' +
    '],' +
    '"lifestyle":[' +
      '{"title":"Morning Routine","en":"value"},' +
      '{"title":"Physical Exercise","en":"value"},' +
      '{"title":"Saturday Fasting","en":"value"}' +
    '],' +
    '"positive_signs":[' +
      '{"en":"value"},' +
      '{"en":"value"},' +
      '{"en":"value"}' +
    ']}';

  const jsonResponse = await callClaude(jsonPrompt, null, null);

  // Find the JSON block
  const start = jsonResponse.indexOf("{");
  const end = jsonResponse.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("Could not find JSON in AI response");
  }

  // Extract only ASCII characters from the JSON string
  const raw = jsonResponse.slice(start, end + 1);
  let safe = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 127) {
      safe += raw[i];
    } else {
      safe += " ";
    }
  }

  // Fix common JSON issues
  safe = safe
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ");

  const result = JSON.parse(safe);

  // Add Hindi placeholders so the frontend does not break
  function addHi(obj) {
    if (Array.isArray(obj)) return obj.map(addHi);
    if (obj && typeof obj === "object") {
      const out = {};
      Object.keys(obj).forEach(k => {
        out[k] = addHi(obj[k]);
        if (typeof obj[k] === "string" && !k.endsWith("Hi") && k !== "color" && k !== "stone" && k !== "type" && k !== "severity" && k !== "metal") {
          out[k + "Hi"] = obj[k];
        }
      });
      return out;
    }
    return obj;
  }

  return addHi(result);
}

const routes = {
  "GET /": async (req, res) => {
    const f = path.join(__dirname, "index.html");
    if (fs.existsSync(f)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(f));
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Samudrik Shastra is running</h1>");
    }
  },

  "GET /health": async (req, res) => {
    sendJson(res, { status: "ok", freeMode: FREE_MODE, hasKey: !!API_KEY });
  },

  "POST /read-palm": async (req, res, body) => {
    if (!API_KEY) return sendJson(res, { error: "API key not configured on server" }, 500);
    let parsed;
    try { parsed = JSON.parse(body); } catch(e) { return sendJson(res, { error: "Invalid request" }, 400); }
    const { imageData, mediaType } = parsed;
    if (!imageData) return sendJson(res, { error: "No image provided" }, 400);
    try {
      const reading = await analyzePalm(imageData, mediaType);
      const record = {
        id: makeId(), name: parsed.name || "Anonymous", phone: parsed.phone || "",
        paymentId: parsed.paymentId || "free", status: "completed",
        createdAt: new Date().toISOString(), readingData: reading
      };
      DB.readings.push(record);
      sendJson(res, { reading, recordId: record.id });
    } catch(e) {
      console.error("Error:", e.message);
      sendJson(res, { error: e.message }, 500);
    }
  },

  "GET /admin/stats": async (req, res) => {
    if (!authAdmin(req)) return sendJson(res, { error: "Unauthorized" }, 401);
    const today = new Date().toDateString();
    sendJson(res, {
      totalReadings: DB.readings.length,
      todayReadings: DB.readings.filter(r => new Date(r.createdAt).toDateString() === today).length,
      totalRevenue: 0, paidReadings: 0,
      freeReadings: DB.readings.length,
      priceINR: PRICE_PAISE / 100, freeMode: FREE_MODE
    });
  },

  "GET /admin/readings": async (req, res) => {
    if (!authAdmin(req)) return sendJson(res, { error: "Unauthorized" }, 401);
    sendJson(res, { readings: DB.readings.map(r => ({
      id: r.id, name: r.name, phone: r.phone, paymentId: r.paymentId,
      status: r.status, createdAt: r.createdAt,
      handType: (r.readingData || {}).hand_type || "",
      problemCount: ((r.readingData || {}).problems || []).length
    })).reverse() });
  },

  "GET /admin/reading": async (req, res) => {
    if (!authAdmin(req)) return sendJson(res, { error: "Unauthorized" }, 401);
    const id = new URL("http://x" + req.url).searchParams.get("id");
    const r = DB.readings.find(x => x.id === id);
    if (!r) return sendJson(res, { error: "Not found" }, 404);
    sendJson(res, r);
  },

  "GET /admin/orders": async (req, res) => {
    if (!authAdmin(req)) return sendJson(res, { error: "Unauthorized" }, 401);
    sendJson(res, { orders: [] });
  }
};

http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const pathname = new URL("http://x" + req.url).pathname;
  const handler = routes[req.method + " " + pathname];
  if (!handler) { sendJson(res, { error: "Not found" }, 404); return; }
  try {
    const body = req.method === "POST" ? await readBody(req) : null;
    await handler(req, res, body);
  } catch(e) {
    console.error("Server error:", e.message);
    sendJson(res, { error: e.message }, 500);
  }
}).listen(PORT, () => {
  console.log("Samudrik Shastra server running on port " + PORT);
  console.log("API Key: " + (API_KEY ? "OK" : "MISSING"));
  console.log("Free Mode: " + FREE_MODE);
  console.log("Admin: " + ADMIN_PASS);
});
