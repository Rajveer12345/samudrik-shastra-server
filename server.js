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

// ── Helpers ───────────────────────────────────────────────────────────────────
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
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Response serialization failed" }));
  }
}
function authAdmin(req) {
  return (req.headers["authorization"] || "") === "Bearer " + ADMIN_PASS;
}
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

// ── Age calculation ───────────────────────────────────────────────────────────
function calcAge(dob) {
  const b = new Date(dob);
  const n = new Date();
  let y = n.getFullYear() - b.getFullYear();
  const m = n.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < b.getDate())) y--;
  return y;
}

// ── Vimshottari Dasha calculator ──────────────────────────────────────────────
function calcDasha(dob) {
  const planets = ["Ketu","Venus","Sun","Moon","Mars","Rahu","Jupiter","Saturn","Mercury"];
  const years   = [7, 20, 6, 10, 7, 18, 16, 19, 17];
  const b = new Date(dob);
  const now = new Date();
  const ageYears = (now - b) / (1000 * 60 * 60 * 24 * 365.25);
  const totalCycle = 120;
  const birthFraction = (b.getMonth() * 30 + b.getDate()) / 365;
  const startOffset = birthFraction * totalCycle;
  let cumulative = startOffset % totalCycle;
  let idx = 0;
  while (cumulative > years[idx]) { cumulative -= years[idx]; idx = (idx + 1) % 9; }
  let elapsed = ageYears;
  let currentIdx = idx;
  let remainingInFirst = years[idx] - cumulative;
  if (elapsed < remainingInFirst) {
    const mahaEnds = new Date(now.getTime() + remainingInFirst * 365.25 * 24 * 3600 * 1000);
    return {
      maha: planets[currentIdx],
      antar: planets[(currentIdx + 1) % 9],
      mahaEnds: mahaEnds.toLocaleDateString("en-IN", { month: "short", year: "numeric" }),
      mahaRemainingYears: Math.round(remainingInFirst * 10) / 10
    };
  }
  elapsed -= remainingInFirst;
  currentIdx = (currentIdx + 1) % 9;
  while (elapsed > years[currentIdx]) {
    elapsed -= years[currentIdx];
    currentIdx = (currentIdx + 1) % 9;
  }
  const remaining = years[currentIdx] - elapsed;
  const mahaEnds = new Date(now.getTime() + remaining * 365.25 * 24 * 3600 * 1000);
  return {
    maha: planets[currentIdx],
    antar: planets[(currentIdx + 1) % 9],
    mahaEnds: mahaEnds.toLocaleDateString("en-IN", { month: "short", year: "numeric" }),
    mahaRemainingYears: Math.round(remaining * 10) / 10
  };
}

// ── Life-stage-specific prompt builder ───────────────────────────────────────
// This is the CORE of the system — each life stage gets a completely
// different set of concerns, predictions, and Shubh Lagna focus
function buildPrompt(name, age, dob, gender, concerns, dasha) {
  const stage =
    age <= 12  ? "Child (0-12)" :
    age <= 18  ? "Teenager (13-18)" :
    age <= 25  ? "Young Adult / Fresher (19-25)" :
    age <= 45  ? "Working Professional (26-45)" :
    age <= 60  ? "Middle Age Professional (46-60)" :
                 "Senior (60+)";

  // ── What each life stage should focus on ──────────────────────────────────
  const stageFocus = {

    "Child (0-12)": `
This is a CHILD aged ${age} years. The reading must be completely different from an adult reading.
Focus ONLY on:
1. Natural talents and aptitudes visible in the palm - what subjects will they excel in
2. Health patterns - what to watch for in this child's health
3. Personality - introvert/extrovert, creative/analytical, leadership/supportive
4. Academic path - which stream suits them (arts/science/commerce/vocational)
5. Relationship with parents and family - any tension or strong bonds visible
6. Special gifts or abilities that should be nurtured
7. Challenges the child may face in school or socially
8. Shubh Lagna for education milestones (not career or marriage - too early)
DO NOT mention job, marriage, property, or financial concerns - these are irrelevant for a child.
The parent is reading this for their child - speak to the parent about their child.`,

    "Teenager (13-18)": `
This is a TEENAGER aged ${age} years. They are in school or finishing school.
Focus ONLY on:
1. Academic ability and which stream/subjects suit them best
2. Which colleges or fields of study are indicated by the palm
3. Career direction that aligns with their natural gifts (not immediate job - future direction)
4. Friendship patterns - are they a leader or follower, any negative influences visible
5. First romantic feelings - any emotional sensitivity or heartbreak vulnerability
6. Relationship with parents - rebellion, independence, or close bond
7. Physical health - energy levels, any weaknesses
8. Shubh Lagna for exam success, college admission, and the right career choice
9. If applicable: foreign education possibility
DO NOT give marriage timing, property, or retirement advice - wrong age entirely.
Speak directly to the teenager AND to their parents.`,

    "Young Adult / Fresher (19-25)": `
This is a YOUNG ADULT / FRESHER aged ${age} years. They are either finishing education or in their first job.
Focus ONLY on:
1. First job timing - when will they get their first stable employment
2. Which industry or field is indicated by their palm
3. Whether they should do further education (Masters, MBA etc.) or start working
4. Foreign opportunity - study abroad or work abroad possibility
5. Entrepreneurship potential - should they consider starting something
6. First serious relationship and marriage timeline (early indicators)
7. Financial independence - when does it begin
8. Skill development - what should they learn or develop
9. Shubh Lagnas: First job window, First salary milestone, Career direction clarity
10. Relationship with family - financial dependence stress, independence conflict
If concerns include career: give specific month/year for first job, first promotion.
If concerns include marriage: give timeline for when serious relationship begins.`,

    "Working Professional (26-45)": `
This is a WORKING PROFESSIONAL aged ${age} years. They are in active career phase.
Focus ONLY on:
1. Career trajectory - promotion timing, career change, business possibility
2. Financial situation - savings, investments, wealth building
3. Marriage and relationship status - stability, children timing if not yet
4. Property/house - when to buy, current situation
5. Foreign opportunity - job abroad, business abroad
6. Workplace conflicts or hidden enemies blocking progress
7. Health - stress-related issues, preventive advice
8. Business potential - should they leave job and start own venture
9. Shubh Lagnas: Next promotion window, Business launch window, Property purchase window
10. Family responsibilities - parents, children, spouse balance`,

    "Middle Age Professional (46-60)": `
This is a MIDDLE-AGED PROFESSIONAL aged ${age} years. They are in the peak responsibility phase.
Focus ONLY on:
1. Career - stability, job loss recovery, second career, consultancy possibility
2. Financial security - retirement planning, wealth consolidation, debt resolution
3. Marriage - relationship maturity, any long-standing unresolved issues
4. Property - current property situation, next property possibility
5. Children - their career and marriage as parents
6. Health - age-related concerns, chronic issues, preventive care
7. Enemies and family conflicts - often more active at this age
8. Legacy - what will they be remembered for, spiritual turn
9. Foreign connection - last window for foreign work/travel
10. Shubh Lagnas: Career recovery window, Financial stability window, Property window
This person has lived a full life - acknowledge past achievements AND current struggles.`,

    "Senior (60+)": `
This is a SENIOR aged ${age} years. They are in retirement or approaching it.
Focus ONLY on:
1. Health - this is primary concern at this age, specific health indicators
2. Financial security - will savings last, any financial threats from family
3. Family harmony - children, grandchildren, relationship with spouse
4. Spiritual growth - what is the soul's purpose in remaining years
5. Legacy and property - property distribution, will, family disputes
6. Travel - pilgrimage, visiting family, any health-related travel
7. Longevity indicators - honest but compassionate reading of life line
8. Mental peace - anxiety, depression, loneliness indicators
9. Shubh Lagnas: Health improvement window, Family harmony window, Spiritual milestone
DO NOT give career, job search, or business start advice - this is not the priority.
Speak with deep respect for the life lived. This person deserves wisdom, not ambition.`
  };

  const focusInstructions = stageFocus[stage] || stageFocus["Working Professional (26-45)"];

  // ── Concerns-specific additions ───────────────────────────────────────────
  const concernsText = concerns && concerns.length > 0
    ? `\nThe person has specifically mentioned these concerns: ${concerns.join(", ")}. Make sure these are addressed with specific timing in the Shubh Lagna windows.`
    : "";

  // ── The full prompt ───────────────────────────────────────────────────────
  return `You are a master Vedic palmist combining Samudrik Shastra palm reading with Vimshottari Dasha calculation.

PERSON DETAILS:
- Name: ${name}
- Date of Birth: ${dob}
- Age: ${age} years
- Life Stage: ${stage}
- Gender: ${gender || "not specified"}
- Current Mahadasha: ${dasha.maha} Mahadasha (ends ${dasha.mahaEnds}, ${dasha.mahaRemainingYears} years remaining)
- Current Antardasha: ${dasha.antar} Antardasha
- Afflicting planet from Dasha: ${dasha.maha}
${concernsText}

LIFE STAGE SPECIFIC INSTRUCTIONS:
${focusInstructions}

PALM READING INSTRUCTIONS:
1. Study ALL visible palm features carefully: Life Line, Heart Line, Head Line, Fate Line, Sun Line, Health Line, Marriage Lines, all 7 mounts (Venus Jupiter Saturn Apollo Mercury Moon Mars), hand shape, thumb, finger lengths
2. Map palm line events to AGES using standard palmistry age mapping:
   - Life Line: starts at index finger base (birth), curves to wrist (age 70+)
   - Fate Line: wrist = birth, middle finger base = age 35, breaks map to specific years
   - Heart Line: events read from Mercury side (youth) to Jupiter side (maturity)
3. Cross-reference what you see on the palm with the Dasha period above
4. Where palm line event MATCHES Dasha planet = CONFIRMED prediction with high accuracy
5. Give SPECIFIC month and year predictions based on this cross-referencing
6. For each Shubh Lagna window: calculate using current Dasha + palm upswing timing

CRITICAL OUTPUT RULES:
- Use ONLY plain ASCII characters (a-z A-Z 0-9 spaces hyphens periods commas)
- No Hindi text, no smart quotes, no em-dashes, no special symbols
- Keep each string value under 300 characters
- Respond with ONLY the JSON object, nothing before or after

JSON structure to return:
{"hand_type":"value","overall_energy":"value","lucky_period":"value","life_stage_reading":"specific reading for ${stage} - what does this palm say specifically for someone at this age and stage","dasha_summary":"what does ${dasha.maha} Mahadasha and ${dasha.antar} Antardasha mean for this specific ${stage} person","afflicted_planet":"${dasha.maha}","shubh_lagnas":[{"number":1,"window":"Month Year to Month Year","probability":"High","what_will_happen":"specific prediction relevant to ${stage}","remedy_before":"exact remedy to activate this window","if_missed":"what happens if missed and when is next window"},{"number":2,"window":"Month Year to Month Year","probability":"Medium","what_will_happen":"specific prediction","remedy_before":"exact remedy","if_missed":"value"},{"number":3,"window":"Month Year to Month Year","probability":"Certain","what_will_happen":"specific prediction","remedy_before":"exact remedy","if_missed":"value"}],"problems":[{"area":"value","issue":"value relevant to ${stage}","severity":"significant OR moderate OR mild","line":"which palm line shows this","deepDive":"deeper insight","dasha_connection":"how current ${dasha.maha} Dasha relates"}],"remedies":[{"for":"value","type":"Mantra OR Ritual OR Lifestyle OR Charity","remedy":"value","timing":"value","planet_target":"which planet"}],"gemstones":[{"stone":"ruby OR pearl OR coral OR emerald OR yellow_sapphire OR diamond OR blue_sapphire OR hessonite OR cats_eye","reason":"why this stone for this person at this age","weight":"value","metal":"Gold OR Silver OR Copper","day_to_wear":"value","test_first":"yes OR no","mantra":"mantra before wearing"}],"vastu":[{"direction":"value","en":"specific vastu advice for ${stage}"}],"lifestyle":[{"title":"value","en":"specific lifestyle advice for ${stage}"}],"positive_signs":[{"en":"value"}]}

Include: 3 shubh lagnas, 4-5 problems relevant to ${stage}, 4-5 remedies, 2 gemstones, 4 vastu tips, 4 lifestyle practices, 4 positive signs.`;
}

// ── Call Claude API ───────────────────────────────────────────────────────────
function callClaude(textPrompt, imageData, imageType, maxTokens) {
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
    max_tokens: maxTokens || 2500,
    messages: [{ role: "user", content }]
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
        "Content-Length": Buffer.byteLength(reqBody)
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
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(reqBody);
    req.end();
  });
}

// ── Main palm analysis ────────────────────────────────────────────────────────
async function analyzePalm(imageData, mediaType, name, dob, gender, concerns) {

  // Calculate age and Dasha
  const age = dob ? calcAge(dob) : 35;
  const dasha = dob ? calcDasha(dob) : { maha: "Saturn", antar: "Jupiter", mahaEnds: "2028", mahaRemainingYears: 2 };

  // Build the life-stage-aware prompt
  const prompt = buildPrompt(
    name || "the person",
    age,
    dob || "unknown",
    gender || "not specified",
    concerns || [],
    dasha
  );

  console.log("Reading for:", name, "| Age:", age, "| Dasha:", dasha.maha, "-", dasha.antar);

  // Step 1: Get plain English palm reading (with image)
  const plainReading = await callClaude(
    "You are a Samudrik Shastra palmistry expert. Study this palm image very carefully.\n" +
    "Person is " + age + " years old (" + (
      age <= 12 ? "a child" :
      age <= 18 ? "a teenager" :
      age <= 25 ? "a young adult or fresher" :
      age <= 45 ? "a working professional" :
      age <= 60 ? "a middle-aged professional" : "a senior person"
    ) + ").\n" +
    "Write detailed observations about ALL palm lines and mounts. " +
    "Note specifically: where are breaks or islands in the Fate Line, " +
    "what age range do they correspond to, " +
    "what does the Heart Line show, Head Line show, Life Line show. " +
    "Mention specific markings that indicate problems. " +
    "Write in plain English only. No special characters.",
    imageData, mediaType, 1000
  );

  // Step 2: Build full contextual reading with Dasha correlation
  const fullPrompt = prompt + "\n\nPalm observations from image analysis:\n" + plainReading.slice(0, 1500);

  const jsonResponse = await callClaude(fullPrompt, null, null, 2500);

  // Extract and clean JSON
  const start = jsonResponse.indexOf("{");
  const end = jsonResponse.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON found in AI response");

  const raw = jsonResponse.slice(start, end + 1);
  let safe = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) { safe += " "; }
    else if (c >= 32 && c <= 126) { safe += raw[i]; }
  }

  const result = JSON.parse(safe);

  // Attach metadata so frontend can display it
  result._meta = { name, age, dob, gender, stage: result.life_stage_reading ? "detected" : "unknown", dasha, concerns };
  return result;
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
      res.end("<h1>HastRekha is running. index.html not found.</h1>");
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
    if (!API_KEY) { sendJSON(res, { error: "API key not configured on server" }, 500); return; }

    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJSON(res, { error: "Invalid request body" }, 400); return; }

    const { imageData, mediaType, name, dob, gender, concerns } = body;
    if (!imageData) { sendJSON(res, { error: "No image provided" }, 400); return; }

    try {
      const reading = await analyzePalm(imageData, mediaType, name, dob, gender, concerns);
      const record = {
        id: makeId(),
        name: name || "Anonymous",
        dob: dob || "",
        age: dob ? calcAge(dob) : 0,
        gender: gender || "",
        concerns: concerns || [],
        status: "completed",
        createdAt: new Date().toISOString(),
        readingData: reading
      };
      DB.readings.push(record);
      sendJSON(res, { reading, recordId: record.id });
    } catch (e) {
      console.error("Reading error:", e.message);
      sendJSON(res, { error: e.message }, 500);
    }
    return;
  }

  // Admin stats
  if (req.method === "GET" && pathname === "/admin/stats") {
    if (!authAdmin(req)) { sendJSON(res, { error: "Unauthorized" }, 401); return; }
    const today = new Date().toDateString();
    const byStage = {};
    DB.readings.forEach(r => {
      const age = r.age || 0;
      const stage = age <= 12 ? "Child" : age <= 18 ? "Teenager" : age <= 25 ? "Young Adult" : age <= 45 ? "Working Professional" : age <= 60 ? "Middle Age" : "Senior";
      byStage[stage] = (byStage[stage] || 0) + 1;
    });
    sendJSON(res, {
      totalReadings: DB.readings.length,
      todayReadings: DB.readings.filter(r => new Date(r.createdAt).toDateString() === today).length,
      byLifeStage: byStage,
      freeMode: FREE_MODE
    });
    return;
  }

  // Admin readings list
  if (req.method === "GET" && pathname === "/admin/readings") {
    if (!authAdmin(req)) { sendJSON(res, { error: "Unauthorized" }, 401); return; }
    sendJSON(res, {
      readings: DB.readings.map(r => ({
        id: r.id, name: r.name, dob: r.dob, age: r.age,
        gender: r.gender, concerns: r.concerns,
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

  // Pro endpoint - returns both astrologer and client reports
  if (req.method === "POST" && pathname === "/read-palm-pro") {
    if (!API_KEY) { sendJSON(res, { error: "API key not configured on server" }, 500); return; }

    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJSON(res, { error: "Invalid request body" }, 400); return; }

    const { imageData, mediaType, name, dob, gender, concerns } = body;
    if (!imageData) { sendJSON(res, { error: "No image provided" }, 400); return; }

    try {
      const age = dob ? calcAge(dob) : 35;
      const dasha = dob ? calcDasha(dob) : { maha: "Saturn", antar: "Jupiter", mahaEnds: "2028", mahaRemainingYears: 2 };

      // Get plain palm observations first
      const palmObservations = await callClaude(
        "You are a Samudrik Shastra palmistry expert. Study this palm carefully. Person is " + age + " years old. Write a technical report: 1.Hand type. 2.Life Line length depth and breaks with approximate age. 3.Heart Line chains forks breaks. 4.Head Line direction and islands. 5.Fate Line breaks at what age. 6.Sun Line clarity. 7.Each mount level. 8.Marriage lines count. 9.Special markings. ASCII text only.",
      );

      // Build full reading with context
      const prompt = buildPrompt(name || "the person", age, dob || "unknown", gender || "", concerns || [], dasha);
      const fullPrompt = prompt + " Detailed technical palm observations: " + palmObservations.slice(0, 1500);



      const jsonResponse = await callClaude(fullPrompt, null, null, 2500);

      const start = jsonResponse.indexOf("{");
      const end = jsonResponse.lastIndexOf("}");
      if (start === -1 || end === -1) throw new Error("No JSON found");

      const raw = jsonResponse.slice(start, end + 1);
      let safe = "";
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 9 || c === 10 || c === 13) { safe += " "; }
        else if (c >= 32 && c <= 126) { safe += raw[i]; }
      }

      const reading = JSON.parse(safe);
      reading._meta = { name, age, dob, gender, dasha, concerns };
      reading._palmObservations = palmObservations; // Technical observations for astrologer

      const record = {
        id: makeId(), name: name || "Anonymous", dob: dob || "",
        age, gender: gender || "", concerns: concerns || [],
        status: "completed", createdAt: new Date().toISOString(),
        readingData: reading, palmObservations
      };
      DB.readings.push(record);
      sendJSON(res, { reading, palmObservations, recordId: record.id });
    } catch (e) {
      console.error("Pro reading error:", e.message);
      sendJSON(res, { error: e.message }, 500);
    }
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
  console.log("HastRekha server on port " + PORT);
  console.log("API Key: " + (API_KEY ? "OK" : "MISSING"));
  console.log("Free Mode: " + FREE_MODE);
  console.log("Admin: " + ADMIN_PASS);
});
