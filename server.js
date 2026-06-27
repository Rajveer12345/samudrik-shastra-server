const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123";

const DB = { readings: [] };

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
  const str = JSON.stringify(obj);
  res.writeHead(status || 200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(str) });
  res.end(str);
}
function makeId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function calcAge(dob) {
  const b = new Date(dob), n = new Date();
  let y = n.getFullYear() - b.getFullYear();
  if (n.getMonth() - b.getMonth() < 0 || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) y--;
  return y;
}
function calcDasha(dob) {
  const planets = ["Ketu","Venus","Sun","Moon","Mars","Rahu","Jupiter","Saturn","Mercury"];
  const years   = [7, 20, 6, 10, 7, 18, 16, 19, 17];
  const b = new Date(dob), now = new Date();
  const ageYrs = (now - b) / (1000 * 60 * 60 * 24 * 365.25);
  const bf = (b.getMonth() * 30 + b.getDate()) / 365;
  let cum = (bf * 120) % 120, idx = 0;
  while (cum > years[idx]) { cum -= years[idx]; idx = (idx + 1) % 9; }
  let elapsed = ageYrs, ci = idx, rem = years[idx] - cum;
  if (elapsed < rem) {
    const e = new Date(now.getTime() + rem * 365.25 * 24 * 3600 * 1000);
    return { maha: planets[ci], antar: planets[(ci+1)%9], mahaEnds: e.toLocaleDateString("en-IN",{month:"short",year:"numeric"}), remaining: Math.round(rem*10)/10 };
  }
  elapsed -= rem; ci = (ci+1)%9;
  while (elapsed > years[ci]) { elapsed -= years[ci]; ci = (ci+1)%9; }
  const remaining = years[ci] - elapsed;
  const mahaEnds = new Date(now.getTime() + remaining * 365.25 * 24 * 3600 * 1000);
  return { maha: planets[ci], antar: planets[(ci+1)%9], mahaEnds: mahaEnds.toLocaleDateString("en-IN",{month:"short",year:"numeric"}), remaining: Math.round(remaining*10)/10 };
}
function getStage(age) {
  if (age <= 12) return "Child (0-12)";
  if (age <= 18) return "Teenager (13-18)";
  if (age <= 25) return "Young Adult (19-25)";
  if (age <= 45) return "Working Professional (26-45)";
  if (age <= 60) return "Middle Age (46-60)";
  return "Senior (60+)";
}

// ── Claude API call ───────────────────────────────────────────
function callClaude(messages, maxTokens, systemPrompt) {
  const body = JSON.stringify({
    model: "claude-opus-4-5",
    max_tokens: maxTokens || 4000,
    system: systemPrompt || undefined,
    messages
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
      const parts = [];
      res.on("data", d => parts.push(d));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(parts).toString("utf8"));
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

// ── Main palm analysis ────────────────────────────────────────
async function analyzePalm(imageData, mediaType, name, dob, gender, concerns, engine) {
  const age   = dob ? calcAge(dob) : 35;
  const dasha = dob ? calcDasha(dob) : { maha:"Saturn", antar:"Jupiter", mahaEnds:"2028", remaining:2 };
  const stage = getStage(age);
  const concernsText = concerns && concerns.length > 0
    ? `Primary concerns: ${concerns.join(", ")}.` : "";

  console.log("Reading:", name, "| Age:", age, "| Stage:", stage, "| Dasha:", dasha.maha, "-", dasha.antar);

  // Build the system prompt — this is what made the white PDF excellent
  const SYSTEM = `You are a master Vedic palmist combining Samudrik Shastra with Vimshottari Dasha calculation.

PERSON: ${name || "the person"}, Age: ${age}, DOB: ${dob || "unknown"}, Gender: ${gender || "not specified"}
LIFE STAGE: ${stage}
CURRENT DASHA: ${dasha.maha} Mahadasha (ends ${dasha.mahaEnds}, ${dasha.remaining} years remaining), ${dasha.antar} Antardasha
${concernsText}

LIFE STAGE FOCUS:
${age <= 12 ? "Focus on talents, health, academic path. Do NOT mention career, marriage, property or finances." :
  age <= 18 ? "Focus on education stream, college path, early relationships. No career or property advice." :
  age <= 25 ? "Focus on first job, career direction, financial independence, early relationships." :
  age <= 45 ? "Focus on career progression, property, marriage, children, financial growth, foreign opportunities, business potential, hidden enemies." :
  age <= 60 ? "Focus on career recovery or peak, property, marriage stability, health, retirement planning, family conflicts, legacy." :
  "Focus primarily on health, family harmony, grandchildren, property distribution, spiritual growth, legacy."}

INSTRUCTIONS:
1. Study every palm feature in the image — Life Line, Heart Line, Head Line, Fate Line, Sun Line, Health Line, Marriage Lines, all 7 mounts, hand shape, thumb, fingers, special markings
2. Cross-reference palm events with the Dasha timeline above
3. Where palm line events MATCH the Dasha planet = CONFIRMED high-accuracy prediction
4. Give SPECIFIC month and year predictions — not vague
5. Address the person's stated concerns
6. Be honest about problems — people come here for real answers
7. Use ONLY plain ASCII text — no Hindi, no smart quotes, no special characters, no apostrophes
8. Respond with ONLY a valid JSON object — nothing before or after

JSON structure:
{
  "hand_type": "detailed hand type",
  "overall_energy": "honest 2-3 sentence overall reading",
  "lucky_period": "Month Year to Month Year",
  "life_stage_reading": "specific reading for this age and stage",
  "dasha_summary": "what current dasha means for this specific person",
  "afflicted_planet": "${dasha.maha}",
  "shubh_lagnas": [
    {"number": 1, "window": "Month Year to Month Year", "probability": "High", "what_will_happen": "specific prediction", "remedy_before": "remedy to do before window opens", "if_missed": "next window timing"},
    {"number": 2, "window": "Month Year to Month Year", "probability": "Medium", "what_will_happen": "prediction", "remedy_before": "remedy", "if_missed": "fallback"},
    {"number": 3, "window": "Month Year to Month Year", "probability": "Certain", "what_will_happen": "prediction", "remedy_before": "remedy", "if_missed": "later window"}
  ],
  "problems": [
    {"area": "Career", "issue": "specific problem", "severity": "significant", "line": "Fate Line break at age X", "deepDive": "deeper insight", "dasha_connection": "how dasha relates"},
    {"area": "Finance", "issue": "specific problem", "severity": "moderate", "line": "palm line", "deepDive": "insight", "dasha_connection": "connection"},
    {"area": "Health", "issue": "specific problem", "severity": "mild", "line": "line", "deepDive": "insight", "dasha_connection": "connection"},
    {"area": "Relationships", "issue": "specific problem", "severity": "moderate", "line": "Heart Line", "deepDive": "insight", "dasha_connection": "connection"}
  ],
  "remedies": [
    {"for": "career", "type": "Mantra", "remedy": "specific mantra and practice", "timing": "Every Thursday morning", "planet_target": "Jupiter"},
    {"for": "protection", "type": "Ritual", "remedy": "specific ritual", "timing": "Every Saturday", "planet_target": "${dasha.maha}"},
    {"for": "health", "type": "Lifestyle", "remedy": "specific practice", "timing": "Daily morning", "planet_target": "Sun"},
    {"for": "prosperity", "type": "Charity", "remedy": "specific charity action", "timing": "Every Thursday", "planet_target": "Jupiter"}
  ],
  "gemstones": [
    {"stone": "yellow_sapphire", "reason": "specific reason for this person", "weight": "4-5 carats", "metal": "Gold", "day_to_wear": "Thursday morning", "test_first": "no", "mantra": "Om Brim Brihaspataye Namah"},
    {"stone": "pearl", "reason": "specific reason", "weight": "5-6 carats", "metal": "Silver", "day_to_wear": "Monday evening", "test_first": "no", "mantra": "Om Som Somaya Namah"}
  ],
  "vastu": [
    {"direction": "Sleeping Direction", "en": "head toward South or East, never North"},
    {"direction": "Work Desk", "en": "face East or North while working"},
    {"direction": "Wealth Zone", "en": "keep North zone clean and clutter-free"},
    {"direction": "Prayer Corner", "en": "Northeast corner for puja and meditation"}
  ],
  "lifestyle": [
    {"title": "Morning Routine", "en": "specific morning practice"},
    {"title": "Physical Exercise", "en": "specific exercise advice"},
    {"title": "Diet Practice", "en": "specific dietary advice"},
    {"title": "Evening Practice", "en": "specific evening practice"}
  ],
  "positive_signs": [
    {"en": "first specific positive sign from palm"},
    {"en": "second positive sign"},
    {"en": "third positive sign"},
    {"en": "fourth positive sign"}
  ]
}

Include 3 shubh lagnas, 4 problems, 4 remedies, 2 gemstones, 4 vastu, 4 lifestyle, 4 positive signs.
All future dates. Current year is 2026.`;

  // Single call with image — same approach as June 24th working version
  const messages = [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageData } },
      { type: "text", text: `Analyze this palm for ${name || "the person"} (age ${age}, ${stage}). Current Dasha: ${dasha.maha} Mahadasha. Return ONLY the JSON object.` }
    ]
  }];

  const raw = await callClaude(messages, 4000, SYSTEM);

  // Clean and parse JSON
  let text = raw;
  // Strip markdown fences if present
  text = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in AI response — raw: " + raw.slice(0, 200));

  let safe = "";
  const slice = text.slice(start, end + 1);
  for (let i = 0; i < slice.length; i++) {
    const c = slice.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) safe += " ";
    else if (c >= 32 && c <= 126) safe += slice[i];
  }
  // Fix trailing commas
  safe = safe.replace(/,(\s*[}\]])/g, "$1");

  const result = JSON.parse(safe);
  result._meta = { name, age, dob, gender, stage, dasha, concerns };
  return result;
}

// ── Request handler ───────────────────────────────────────────
async function handleRequest(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL("http://x" + req.url).pathname;

  // Serve frontend
  if (req.method === "GET" && url === "/") {
    const f = path.join(__dirname, "index.html");
    if (fs.existsSync(f)) {
      const html = fs.readFileSync(f);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>HastRekha running. Upload index.html.</h1>");
    }
    return;
  }

  // Health check
  if (req.method === "GET" && url === "/health") {
    sendJSON(res, { status: "ok", hasKey: !!API_KEY });
    return;
  }

  // Palm reading
  if (req.method === "POST" && url === "/read-palm") {
    if (!API_KEY) { sendJSON(res, { error: "API key not set on server" }, 500); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch(e) { sendJSON(res, { error: "Invalid JSON body" }, 400); return; }
    const { imageData, mediaType, name, dob, gender, concerns, engine } = body;
    if (!imageData) { sendJSON(res, { error: "No image provided" }, 400); return; }
    try {
      const reading = await analyzePalm(imageData, mediaType, name, dob, gender, concerns, engine);
      const record = {
        id: makeId(), name: name||"Anonymous", dob: dob||"", age: dob ? calcAge(dob) : 0,
        gender: gender||"", concerns: concerns||[], engine: engine||"samudrik",
        status: "completed", createdAt: new Date().toISOString(), readingData: reading
      };
      DB.readings.push(record);
      sendJSON(res, { reading, recordId: record.id });
    } catch(e) {
      console.error("Reading error:", e.message);
      DB.readings.push({ id: makeId(), name: name||"", status: "failed", createdAt: new Date().toISOString(), error: e.message, readingData: {} });
      sendJSON(res, { error: e.message }, 500);
    }
    return;
  }

  // Admin stats
  if (req.method === "GET" && url === "/admin/stats") {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${ADMIN_PASS}`) { sendJSON(res, { error: "Unauthorized" }, 401); return; }
    const today = new Date().toDateString();
    const byStage = {}, byEngine = { samudrik:0, hasta:0, both:0 };
    DB.readings.forEach(r => {
      const s = r.age <= 12 ? "Child" : r.age <= 18 ? "Teenager" : r.age <= 25 ? "Young Adult" : r.age <= 45 ? "Working Professional" : r.age <= 60 ? "Middle Age" : "Senior";
      byStage[s] = (byStage[s]||0) + 1;
      if (r.engine) byEngine[r.engine] = (byEngine[r.engine]||0) + 1;
    });
    sendJSON(res, {
      totalReadings: DB.readings.length,
      todayReadings: DB.readings.filter(r => new Date(r.createdAt).toDateString() === today).length,
      completedReadings: DB.readings.filter(r => r.status === "completed").length,
      byLifeStage: byStage, byEngine
    });
    return;
  }

  // Admin readings list
  if (req.method === "GET" && url === "/admin/readings") {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${ADMIN_PASS}`) { sendJSON(res, { error: "Unauthorized" }, 401); return; }
    sendJSON(res, {
      readings: DB.readings.map(r => ({
        id: r.id, name: r.name, dob: r.dob, age: r.age, gender: r.gender,
        concerns: r.concerns, engine: r.engine, status: r.status,
        createdAt: r.createdAt, handType: r.readingData?.hand_type||"",
        problemCount: (r.readingData?.problems||[]).length
      })).reverse()
    });
    return;
  }

  // Admin single reading
  if (req.method === "GET" && url.startsWith("/admin/reading")) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${ADMIN_PASS}`) { sendJSON(res, { error: "Unauthorized" }, 401); return; }
    const params = new URL("http://x" + req.url).searchParams;
    const id = params.get("id");
    const record = DB.readings.find(r => r.id === id);
    if (!record) { sendJSON(res, { error: "Not found" }, 404); return; }
    sendJSON(res, record);
    return;
  }

  sendJSON(res, { error: "Not found" }, 404);
}

http.createServer(handleRequest).listen(PORT, () => {
  console.log(`✦ HastRekha server running on port ${PORT}`);
  console.log(`   Model: claude-opus-4-5 (same as June 24th)`);
  console.log(`   API key: ${API_KEY ? "OK" : "MISSING — set ANTHROPIC_API_KEY"}`);
});
