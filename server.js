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

const DB = { readings: [], orders: [], nextId: 1 };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const c = []; req.on("data", d => c.push(d));
    req.on("end", () => resolve(Buffer.concat(c).toString()));
    req.on("error", reject);
  });
}
function json(res, data, status) {
  res.writeHead(status || 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
function authAdmin(req) {
  return (req.headers["authorization"] || "") === "Bearer " + ADMIN_PASS;
}
function makeId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

async function callAnthropic(messages, maxTokens) {
  const payload = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: maxTokens || 2000,
    messages: messages
  });
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(payload)
      }
    };
    const req = https.request(opts, res => {
      const c = []; res.on("data", d => c.push(d));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(c).toString());
          if (data.error) return reject(new Error(data.error.message));
          const text = (data.content || []).find(b => b.type === "text");
          resolve(text ? text.text : "");
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function analyzePalm(imageData, mediaType) {
  // Step 1: Get raw palm analysis as plain text first
  const step1 = await callAnthropic([{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageData } },
      { type: "text", text: "You are a Samudrik Shastra Vedic palmistry expert. Analyze this palm image thoroughly. Study all lines (Life, Heart, Head, Fate, Sun), all mounts, hand shape, fingers. Write a detailed analysis covering: hand type, overall reading, career/job situation and timeline predictions, financial situation, health, relationships/marriage, property/house prospects, foreign travel possibilities, business potential, key problems identified, remedies, gemstone recommendations, vastu directions, lifestyle practices, and positive signs. Be specific about timing (month and year). Write in plain English paragraphs, no special formatting." }
    ]
  }], 1500);

  // Step 2: Convert that analysis into clean JSON
  const step2prompt = "Convert this palm reading into a JSON object. Use ONLY basic ASCII characters. No smart quotes, no em-dashes, no special punctuation. Every string value must use only regular letters, numbers, spaces, commas, periods, hyphens, and regular apostrophes.\n\nPalm reading to convert:\n" + step1 + "\n\nReturn ONLY this JSON structure, nothing else:\n{\"hand_type\":\"value\",\"hand_typeHi\":\"value\",\"overall_energy\":\"value\",\"overall_energyHi\":\"value\",\"lucky_period\":\"value\",\"predictions\":[{\"category\":\"Career and Job\",\"categoryHi\":\"karriar\",\"color\":\"#E67E22\",\"items\":[{\"label\":\"Current Status\",\"labelHi\":\"value\",\"reading\":\"value\",\"readingHi\":\"value\",\"type\":\"current\",\"timeline\":\"Month Year to Month Year\",\"timelineHi\":\"value\"},{\"label\":\"Primary Window\",\"labelHi\":\"value\",\"reading\":\"value\",\"readingHi\":\"value\",\"type\":\"positive\",\"timeline\":\"Month Year\",\"timelineHi\":\"value\"},{\"label\":\"Backup Window\",\"labelHi\":\"value\",\"reading\":\"value\",\"readingHi\":\"value\",\"type\":\"warning\",\"timeline\":\"Month Year\",\"timelineHi\":\"value\"}]},{\"category\":\"Finance and Money\",\"categoryHi\":\"value\",\"color\":\"#27AE60\",\"items\":[{\"label\":\"Current Status\",\"labelHi\":\"value\",\"reading\":\"value\",\"readingHi\":\"value\",\"type\":\"current\",\"timeline\":\"\",\"timelineHi\":\"\"}]},{\"category\":\"Relationships and Marriage\",\"categoryHi\":\"value\",\"color\":\"#E8294A\",\"items\":[{\"label\":\"Reading\",\"labelHi\":\"value\",\"reading\":\"value\",\"readingHi\":\"value\",\"type\":\"info\",\"timeline\":\"\",\"timelineHi\":\"\"}]},{\"category\":\"Property and House\",\"categoryHi\":\"value\",\"color\":\"#8E44AD\",\"items\":[{\"label\":\"Reading\",\"labelHi\":\"value\",\"reading\":\"value\",\"readingHi\":\"value\",\"type\":\"info\",\"timeline\":\"\",\"timelineHi\":\"\"}]},{\"category\":\"Health\",\"categoryHi\":\"value\",\"color\":\"#16A085\",\"items\":[{\"label\":\"Reading\",\"labelHi\":\"value\",\"reading\":\"value\",\"readingHi\":\"value\",\"type\":\"current\",\"timeline\":\"\",\"timelineHi\":\"\"}]}],\"problems\":[{\"area\":\"value\",\"areaHi\":\"value\",\"issue\":\"value\",\"issueHi\":\"value\",\"severity\":\"significant\",\"line\":\"value\",\"deepDive\":\"value\"},{\"area\":\"value\",\"areaHi\":\"value\",\"issue\":\"value\",\"issueHi\":\"value\",\"severity\":\"moderate\",\"line\":\"value\",\"deepDive\":\"value\"},{\"area\":\"value\",\"areaHi\":\"value\",\"issue\":\"value\",\"issueHi\":\"value\",\"severity\":\"mild\",\"line\":\"value\",\"deepDive\":\"value\"}],\"remedies\":[{\"for\":\"value\",\"forHi\":\"value\",\"type\":\"Mantra\",\"typeHi\":\"Mantra\",\"remedy\":\"value\",\"remedyHi\":\"value\",\"timing\":\"value\",\"timingHi\":\"value\"},{\"for\":\"value\",\"forHi\":\"value\",\"type\":\"Ritual\",\"typeHi\":\"Puja\",\"remedy\":\"value\",\"remedyHi\":\"value\",\"timing\":\"value\",\"timingHi\":\"value\"},{\"for\":\"value\",\"forHi\":\"value\",\"type\":\"Lifestyle\",\"typeHi\":\"Jeevan\",\"remedy\":\"value\",\"remedyHi\":\"value\",\"timing\":\"value\",\"timingHi\":\"value\"},{\"for\":\"value\",\"forHi\":\"value\",\"type\":\"Charity\",\"typeHi\":\"Daan\",\"remedy\":\"value\",\"remedyHi\":\"value\",\"timing\":\"value\",\"timingHi\":\"value\"}],\"gemstones\":[{\"stone\":\"blue_sapphire\",\"reason\":\"value\",\"reasonHi\":\"value\",\"weight\":\"3-5 carats\",\"metal\":\"Silver\",\"day_to_wear\":\"Saturday\"},{\"stone\":\"yellow_sapphire\",\"reason\":\"value\",\"reasonHi\":\"value\",\"weight\":\"4-5 carats\",\"metal\":\"Gold\",\"day_to_wear\":\"Thursday\"}],\"vastu\":[{\"direction\":\"Sleeping Direction\",\"en\":\"value\",\"hi\":\"value\"},{\"direction\":\"Work Desk\",\"en\":\"value\",\"hi\":\"value\"},{\"direction\":\"Prayer Corner\",\"en\":\"value\",\"hi\":\"value\"},{\"direction\":\"Wealth Zone\",\"en\":\"value\",\"hi\":\"value\"}],\"lifestyle\":[{\"title\":\"Morning Routine\",\"titleHi\":\"Subah\",\"en\":\"value\",\"hi\":\"value\"},{\"title\":\"Weekly Practice\",\"titleHi\":\"Saptah\",\"en\":\"value\",\"hi\":\"value\"},{\"title\":\"Diet and Health\",\"titleHi\":\"Swasthya\",\"en\":\"value\",\"hi\":\"value\"}],\"positive_signs\":[{\"en\":\"value\",\"hi\":\"value\"},{\"en\":\"value\",\"hi\":\"value\"},{\"en\":\"value\",\"hi\":\"value\"}]}";

  const step2 = await callAnthropic([{
    role: "user",
    content: [{ type: "text", text: step2prompt }]
  }], 2500);

  // Extract JSON from response
  const start = step2.indexOf("{");
  const end = step2.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in conversion response");

  let jsonStr = step2.slice(start, end + 1);

  // Aggressively clean the string before parsing
  // Remove all non-ASCII characters that could break JSON
  let cleaned = "";
  for (let i = 0; i < jsonStr.length; i++) {
    const code = jsonStr.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      cleaned += " ";
    } else if (code > 126 && code < 160) {
      cleaned += " ";
    } else if (code === 8216 || code === 8217) {
      cleaned += "'";
    } else if (code === 8220 || code === 8221) {
      cleaned += '"';
    } else if (code === 8211 || code === 8212) {
      cleaned += "-";
    } else if (code === 8230) {
      cleaned += "...";
    } else {
      cleaned += jsonStr[i];
    }
  }

  // Fix newlines inside string values
  cleaned = cleaned.replace(/([^\\])\n/g, "$1 ").replace(/([^\\])\r/g, "$1 ").replace(/([^\\])\t/g, "$1 ");

  return JSON.parse(cleaned);
}

const routes = {
  "GET /": async (req, res) => {
    const f = path.join(__dirname, "index.html");
    if (fs.existsSync(f)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(f));
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Samudrik Shastra running</h1><p>index.html not found</p>");
    }
  },

  "GET /health": async (req, res) => {
    json(res, { status: "ok", freeMode: FREE_MODE, hasKey: !!API_KEY });
  },

  "POST /read-palm": async (req, res, body) => {
    if (!API_KEY) return json(res, { error: "Server API key not set" }, 500);
    let parsed;
    try { parsed = JSON.parse(body); } catch(e) { return json(res, { error: "Bad request body" }, 400); }

    const { imageData, mediaType } = parsed;
    if (!imageData) return json(res, { error: "imageData required" }, 400);

    if (!FREE_MODE && RZP_ID) {
      const { paymentId } = parsed;
      if (!paymentId) return json(res, { error: "Payment required", code: "PAYMENT_REQUIRED" }, 402);
    }

    try {
      const reading = await analyzePalm(imageData, mediaType);
      const record = {
        id: makeId(),
        name: parsed.name || "Anonymous",
        phone: parsed.phone || "",
        paymentId: parsed.paymentId || "free",
        status: "completed",
        createdAt: new Date().toISOString(),
        readingData: reading
      };
      DB.readings.push(record);
      json(res, { reading, recordId: record.id });
    } catch(e) {
      console.error("Palm reading error:", e.message);
      json(res, { error: e.message }, 500);
    }
  },

  "GET /admin/stats": async (req, res) => {
    if (!authAdmin(req)) return json(res, { error: "Unauthorized" }, 401);
    const today = new Date().toDateString();
    json(res, {
      totalReadings: DB.readings.length,
      todayReadings: DB.readings.filter(r => new Date(r.createdAt).toDateString() === today).length,
      totalRevenue: DB.orders.filter(o => o.status === "paid").reduce((s, o) => s + (o.amount || 0), 0) / 100,
      paidReadings: DB.readings.filter(r => r.paymentId !== "free").length,
      freeReadings: DB.readings.filter(r => r.paymentId === "free").length,
      priceINR: PRICE_PAISE / 100,
      freeMode: FREE_MODE
    });
  },

  "GET /admin/readings": async (req, res) => {
    if (!authAdmin(req)) return json(res, { error: "Unauthorized" }, 401);
    json(res, { readings: DB.readings.map(r => ({
      id: r.id, name: r.name, phone: r.phone,
      paymentId: r.paymentId, status: r.status, createdAt: r.createdAt,
      handType: (r.readingData || {}).hand_type || "",
      problemCount: ((r.readingData || {}).problems || []).length
    })).reverse() });
  },

  "GET /admin/reading": async (req, res) => {
    if (!authAdmin(req)) return json(res, { error: "Unauthorized" }, 401);
    const id = new URL("http://x" + req.url).searchParams.get("id");
    const r = DB.readings.find(r => r.id === id);
    if (!r) return json(res, { error: "Not found" }, 404);
    json(res, r);
  },

  "GET /admin/orders": async (req, res) => {
    if (!authAdmin(req)) return json(res, { error: "Unauthorized" }, 401);
    json(res, { orders: [...DB.orders].reverse() });
  }
};

http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const pathname = new URL("http://x" + req.url).pathname;
  const handler = routes[req.method + " " + pathname];
  if (!handler) { json(res, { error: "Not found" }, 404); return; }
  try {
    const body = req.method === "POST" ? await readBody(req) : null;
    await handler(req, res, body);
  } catch(e) {
    console.error("Route error:", e.message);
    json(res, { error: e.message }, 500);
  }
}).listen(PORT, () => {
  console.log("Samudrik Shastra server on port " + PORT);
  console.log("   API Key: " + (API_KEY ? "OK" : "MISSING"));
  console.log("   Free Mode: " + FREE_MODE);
  console.log("   Price: Rs." + (PRICE_PAISE / 100));
  console.log("   Admin password: " + ADMIN_PASS);
});
