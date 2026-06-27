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
- ASCII characters only - no Hindi, no smart quotes, no em-dashes, no apostrophes, no special symbols
- Use simple straight quotes only inside JSON strings
- Every string value must be under 250 characters
- Numbers must be actual numbers not strings
- Respond with ONLY valid JSON - absolutely nothing before or after the JSON object
- Do not add comments or explanations
- Do not use apostrophes in any text - write "do not" not "don't", "person is" not "person's"

Return this exact JSON structure with your reading filled in:
{
  "hand_type": "describe the hand type here",
  "overall_energy": "overall reading paragraph here",
  "lucky_period": "Month Year to Month Year",
  "life_stage_reading": "reading specific to this persons age and stage",
  "dasha_summary": "what the current dasha means for this person",
  "afflicted_planet": "${dasha.maha}",
  "shubh_lagnas": [
    {"number": 1, "window": "Month Year to Month Year", "probability": "High", "what_will_happen": "prediction here", "remedy_before": "remedy here", "if_missed": "next window info"},
    {"number": 2, "window": "Month Year to Month Year", "probability": "Medium", "what_will_happen": "prediction here", "remedy_before": "remedy here", "if_missed": "next window info"},
    {"number": 3, "window": "Month Year to Month Year", "probability": "Certain", "what_will_happen": "prediction here", "remedy_before": "remedy here", "if_missed": "later window"}
  ],
  "problems": [
    {"area": "Career", "issue": "description of career issue", "severity": "significant", "line": "Fate Line", "deepDive": "deeper insight", "dasha_connection": "dasha connection"},
    {"area": "Finance", "issue": "description", "severity": "moderate", "line": "Life Line", "deepDive": "insight", "dasha_connection": "connection"},
    {"area": "Health", "issue": "description", "severity": "mild", "line": "Health Line", "deepDive": "insight", "dasha_connection": "connection"},
    {"area": "Relationships", "issue": "description", "severity": "moderate", "line": "Heart Line", "deepDive": "insight", "dasha_connection": "connection"}
  ],
  "remedies": [
    {"for": "career", "type": "Mantra", "remedy": "mantra text here 108 times", "timing": "Every Thursday morning", "planet_target": "Jupiter"},
    {"for": "protection", "type": "Ritual", "remedy": "ritual description here", "timing": "Every Saturday", "planet_target": "${dasha.maha}"},
    {"for": "health", "type": "Lifestyle", "remedy": "lifestyle practice here", "timing": "Daily morning", "planet_target": "Sun"},
    {"for": "prosperity", "type": "Charity", "remedy": "charity action here", "timing": "Every Thursday", "planet_target": "Jupiter"}
  ],
  "gemstones": [
    {"stone": "yellow_sapphire", "reason": "reason this stone suits this person", "weight": "4-5 carats", "metal": "Gold", "day_to_wear": "Thursday morning", "test_first": "no", "mantra": "Om Brim Brihaspataye Namah"},
    {"stone": "pearl", "reason": "reason this stone suits this person", "weight": "5-6 carats", "metal": "Silver", "day_to_wear": "Monday evening", "test_first": "no", "mantra": "Om Som Somaya Namah"}
  ],
  "vastu": [
    {"direction": "North", "en": "vastu advice for north zone"},
    {"direction": "Sleeping Direction", "en": "head toward south or east never north"},
    {"direction": "Work Desk", "en": "face east or north while working"},
    {"direction": "Prayer Corner", "en": "northeast corner for prayer and meditation"}
  ],
  "lifestyle": [
    {"title": "Morning Routine", "en": "morning practice advice here"},
    {"title": "Exercise", "en": "physical exercise advice here"},
    {"title": "Diet", "en": "dietary advice here"},
    {"title": "Sleep", "en": "sleep advice here"}
  ],
  "positive_signs": [
    {"en": "first positive sign observed in palm"},
    {"en": "second positive sign observed"},
    {"en": "third positive sign observed"},
    {"en": "fourth positive sign observed"}
  ]
}`;
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

  const age = dob ? calcAge(dob) : 35;
  const dasha = dob ? calcDasha(dob) : { maha: "Saturn", antar: "Jupiter", mahaEnds: "2028", mahaRemainingYears: 2 };
  const stage = age <= 12 ? "Child" : age <= 18 ? "Teenager" : age <= 25 ? "Young Adult" : age <= 45 ? "Working Professional" : age <= 60 ? "Middle Age" : "Senior";
  const concernsStr = concerns && concerns.length > 0 ? concerns.join(", ") : "general life reading";

  console.log("Reading for:", name, "| Age:", age, "| Stage:", stage, "| Dasha:", dasha.maha);

  // STEP 1 - Observe the palm (plain text, with image)
  const obs = await callClaude(
    "Study this palm carefully. Person is " + age + " years old (" + stage + " life stage).\n" +
    "Write a short technical report:\n" +
    "HAND: describe hand type\n" +
    "LIFE LINE: length depth breaks islands and at what age\n" +
    "FATE LINE: present or absent breaks at what age islands strength\n" +
    "HEART LINE: length chains forks breaks\n" +
    "HEAD LINE: direction and markings\n" +
    "MOUNTS: which mounts are prominent\n" +
    "SPECIAL: any stars crosses triangles or unusual markings\n" +
    "Plain English only.",
    imageData, mediaType, 800
  );

  // STEP 2 - Generate reading as labeled sections (no JSON needed)
  const stageCtx = stage === "Child" ? "Focus on talents health academic path. No career or marriage advice." :
    stage === "Teenager" ? "Focus on education stream choice college path." :
    stage === "Young Adult" ? "Focus on first job timing career direction financial independence." :
    stage === "Middle Age" ? "Focus on career recovery property marriage stability health." :
    stage === "Senior" ? "Focus on health family harmony legacy spiritual growth." :
    "Focus on career trajectory property marriage finances foreign opportunities.";

  const readingPrompt =
    "You are a Vedic palmist. Palm analysis:\n" + obs.slice(0, 600) + "\n\n" +
    "Person: " + name + ", Age: " + age + ", Stage: " + stage + "\n" +
    "Dasha: " + dasha.maha + " Mahadasha ending " + dasha.mahaEnds + ", " + dasha.antar + " Antardasha\n" +
    "Concerns: " + concernsStr + "\n" +
    stageCtx + "\n\n" +
    "Write EXACTLY these labeled lines. Plain English only. No apostrophes. No special characters.\n\n" +
    "HAND_TYPE: one sentence describing hand type\n" +
    "OVERALL: 2-3 sentence overall reading\n" +
    "LUCKY_PERIOD: Month Year to Month Year\n" +
    "STAGE_READING: one sentence about what this age means\n" +
    "DASHA_MEANING: one sentence about current dasha\n" +
    "LAGNA1_WINDOW: Month Year to Month Year\n" +
    "LAGNA1_WHAT: what will happen\n" +
    "LAGNA1_REMEDY: remedy to do before window\n" +
    "LAGNA1_MISSED: next window if missed\n" +
    "LAGNA2_WINDOW: Month Year to Month Year\n" +
    "LAGNA2_WHAT: prediction\n" +
    "LAGNA2_REMEDY: remedy\n" +
    "LAGNA2_MISSED: fallback\n" +
    "LAGNA3_WINDOW: Month Year to Month Year\n" +
    "LAGNA3_WHAT: prediction\n" +
    "LAGNA3_REMEDY: remedy\n" +
    "LAGNA3_MISSED: later window\n" +
    "PROBLEM1_AREA: area name\n" +
    "PROBLEM1_ISSUE: description\n" +
    "PROBLEM1_SEVERITY: significant or moderate or mild\n" +
    "PROBLEM1_LINE: palm line\n" +
    "PROBLEM1_DIVE: deeper insight\n" +
    "PROBLEM1_DASHA: dasha connection\n" +
    "PROBLEM2_AREA: area name\n" +
    "PROBLEM2_ISSUE: description\n" +
    "PROBLEM2_SEVERITY: significant or moderate or mild\n" +
    "PROBLEM2_LINE: palm line\n" +
    "PROBLEM2_DIVE: insight\n" +
    "PROBLEM2_DASHA: connection\n" +
    "PROBLEM3_AREA: area name\n" +
    "PROBLEM3_ISSUE: description\n" +
    "PROBLEM3_SEVERITY: moderate or mild\n" +
    "PROBLEM3_LINE: line\n" +
    "PROBLEM3_DIVE: insight\n" +
    "PROBLEM3_DASHA: connection\n" +
    "REMEDY1_FOR: purpose\n" +
    "REMEDY1_TYPE: Mantra or Ritual or Lifestyle or Charity\n" +
    "REMEDY1_TEXT: the remedy\n" +
    "REMEDY1_TIMING: when\n" +
    "REMEDY1_PLANET: planet\n" +
    "REMEDY2_FOR: purpose\n" +
    "REMEDY2_TYPE: type\n" +
    "REMEDY2_TEXT: remedy\n" +
    "REMEDY2_TIMING: timing\n" +
    "REMEDY2_PLANET: planet\n" +
    "REMEDY3_FOR: purpose\n" +
    "REMEDY3_TYPE: type\n" +
    "REMEDY3_TEXT: remedy\n" +
    "REMEDY3_TIMING: timing\n" +
    "REMEDY3_PLANET: planet\n" +
    "GEM1_STONE: yellow_sapphire or ruby or pearl or coral or emerald or blue_sapphire or hessonite or cats_eye or diamond\n" +
    "GEM1_REASON: why\n" +
    "GEM1_WEIGHT: weight\n" +
    "GEM1_METAL: Gold or Silver\n" +
    "GEM1_DAY: day to wear\n" +
    "GEM1_TEST: yes or no\n" +
    "GEM1_MANTRA: mantra\n" +
    "GEM2_STONE: stone key\n" +
    "GEM2_REASON: reason\n" +
    "GEM2_WEIGHT: weight\n" +
    "GEM2_METAL: metal\n" +
    "GEM2_DAY: day\n" +
    "GEM2_TEST: yes or no\n" +
    "GEM2_MANTRA: mantra\n" +
    "VASTU1_DIR: direction\n" +
    "VASTU1_ADVICE: advice\n" +
    "VASTU2_DIR: direction\n" +
    "VASTU2_ADVICE: advice\n" +
    "VASTU3_DIR: direction\n" +
    "VASTU3_ADVICE: advice\n" +
    "LIFE1_TITLE: practice name\n" +
    "LIFE1_ADVICE: advice\n" +
    "LIFE2_TITLE: practice\n" +
    "LIFE2_ADVICE: advice\n" +
    "LIFE3_TITLE: practice\n" +
    "LIFE3_ADVICE: advice\n" +
    "POS1: positive sign 1\n" +
    "POS2: positive sign 2\n" +
    "POS3: positive sign 3\n" +
    "POS4: positive sign 4";

  const raw = await callClaude(readingPrompt, null, null, 2500);

  // STEP 3 - Extract labeled values - NO JSON PARSING NEEDED
  function get(label) {
    const re = new RegExp(label + ":\s*(.+?)(?=\n[A-Z0-9_]+:|$)", "si");
    const m = raw.match(re);
    if (!m) return "";
    return m[1].replace(/^\[|\]$/g, "").replace(/[^\x20-\x7E]/g, "").replace(/['"]/g, "").trim();
  }

  const result = {
    hand_type: get("HAND_TYPE") || "Mixed hand",
    overall_energy: get("OVERALL") || "Your palm reveals a life of great potential and resilience.",
    lucky_period: get("LUCKY_PERIOD") || "Aug 2026 to Dec 2026",
    life_stage_reading: get("STAGE_READING") || "",
    dasha_summary: get("DASHA_MEANING") || "",
    afflicted_planet: dasha.maha,
    shubh_lagnas: [
      { number: 1, window: get("LAGNA1_WINDOW")||"Aug 2026 to Oct 2026", probability: "High", what_will_happen: get("LAGNA1_WHAT")||"Favorable opportunities emerge.", remedy_before: get("LAGNA1_REMEDY")||"Chant Jupiter mantra every Thursday.", if_missed: get("LAGNA1_MISSED")||"Next window Feb 2027." },
      { number: 2, window: get("LAGNA2_WINDOW")||"Feb 2027 to Apr 2027", probability: "Medium", what_will_happen: get("LAGNA2_WHAT")||"Secondary opportunity window opens.", remedy_before: get("LAGNA2_REMEDY")||"Saturn remedy every Saturday.", if_missed: get("LAGNA2_MISSED")||"Final window Sep 2027." },
      { number: 3, window: get("LAGNA3_WINDOW")||"Sep 2027 to Nov 2027", probability: "Certain", what_will_happen: get("LAGNA3_WHAT")||"Stability and growth assured by this point.", remedy_before: get("LAGNA3_REMEDY")||"Sun mantra every Sunday.", if_missed: get("LAGNA3_MISSED")||"Cycle repeats with next Jupiter transit." }
    ],
    problems: [
      { area: get("PROBLEM1_AREA")||"Career", issue: get("PROBLEM1_ISSUE")||"Career challenges identified.", severity: get("PROBLEM1_SEVERITY")||"significant", line: get("PROBLEM1_LINE")||"Fate Line", deepDive: get("PROBLEM1_DIVE")||"Deeper analysis shows disruption period.", dasha_connection: get("PROBLEM1_DASHA")||"Current dasha is contributing to this." },
      { area: get("PROBLEM2_AREA")||"Finance", issue: get("PROBLEM2_ISSUE")||"Financial pressure visible in palm.", severity: get("PROBLEM2_SEVERITY")||"moderate", line: get("PROBLEM2_LINE")||"Life Line", deepDive: get("PROBLEM2_DIVE")||"This is a temporary situation.", dasha_connection: get("PROBLEM2_DASHA")||"Dasha related pattern." },
      { area: get("PROBLEM3_AREA")||"Health", issue: get("PROBLEM3_ISSUE")||"Health needs preventive attention.", severity: get("PROBLEM3_SEVERITY")||"mild", line: get("PROBLEM3_LINE")||"Health Line", deepDive: get("PROBLEM3_DIVE")||"Stress-related symptoms visible.", dasha_connection: get("PROBLEM3_DASHA")||"Dasha influence noted." }
    ],
    remedies: [
      { for: get("REMEDY1_FOR")||"Overall", type: get("REMEDY1_TYPE")||"Mantra", remedy: get("REMEDY1_TEXT")||"Chant Om Namah Shivaya 108 times daily.", timing: get("REMEDY1_TIMING")||"Every morning", planet_target: get("REMEDY1_PLANET")||dasha.maha },
      { for: get("REMEDY2_FOR")||"Protection", type: get("REMEDY2_TYPE")||"Ritual", remedy: get("REMEDY2_TEXT")||"Light a ghee lamp every evening before prayer.", timing: get("REMEDY2_TIMING")||"Every evening", planet_target: get("REMEDY2_PLANET")||"Saturn" },
      { for: get("REMEDY3_FOR")||"Health", type: get("REMEDY3_TYPE")||"Lifestyle", remedy: get("REMEDY3_TEXT")||"Wake before sunrise and drink copper vessel water daily.", timing: get("REMEDY3_TIMING")||"Daily morning", planet_target: get("REMEDY3_PLANET")||"Sun" }
    ],
    gemstones: [
      { stone: get("GEM1_STONE")||"yellow_sapphire", reason: get("GEM1_REASON")||"Strengthens Jupiter for career and fortune.", weight: get("GEM1_WEIGHT")||"4-5 carats", metal: get("GEM1_METAL")||"Gold", day_to_wear: get("GEM1_DAY")||"Thursday morning", test_first: get("GEM1_TEST")||"no", mantra: get("GEM1_MANTRA")||"Om Brim Brihaspataye Namah" },
      { stone: get("GEM2_STONE")||"pearl", reason: get("GEM2_REASON")||"Calms the mind and improves emotional balance.", weight: get("GEM2_WEIGHT")||"5-6 carats", metal: get("GEM2_METAL")||"Silver", day_to_wear: get("GEM2_DAY")||"Monday evening", test_first: get("GEM2_TEST")||"no", mantra: get("GEM2_MANTRA")||"Om Som Somaya Namah" }
    ],
    vastu: [
      { direction: get("VASTU1_DIR")||"North", en: get("VASTU1_ADVICE")||"Keep North zone clean and clutter-free for wealth energy." },
      { direction: get("VASTU2_DIR")||"Sleeping Direction", en: get("VASTU2_ADVICE")||"Head toward South or East, never North, for deep restful sleep." },
      { direction: get("VASTU3_DIR")||"Work Desk", en: get("VASTU3_ADVICE")||"Face East or North while working or studying for best results." }
    ],
    lifestyle: [
      { title: get("LIFE1_TITLE")||"Morning Routine", en: get("LIFE1_ADVICE")||"Wake before 6 AM, drink copper water, do 15 minutes pranayama breathing." },
      { title: get("LIFE2_TITLE")||"Exercise", en: get("LIFE2_ADVICE")||"30 minutes vigorous exercise 4 times per week to release stored tension." },
      { title: get("LIFE3_TITLE")||"Evening Practice", en: get("LIFE3_ADVICE")||"Write 3 things that went well each night before sleep." }
    ],
    positive_signs: [
      { en: get("POS1")||"Strong Life Line indicates exceptional vitality and resilience." },
      { en: get("POS2")||"Well-developed Jupiter mount shows natural leadership and ambition." },
      { en: get("POS3")||"Clear Head Line indicates sharp analytical intelligence." },
      { en: get("POS4")||"Firm thumb shows exceptional willpower and determination." }
    ]
  };

  result._meta = { name, age, dob, gender, stage, dasha, concerns };
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
