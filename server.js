const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123";
const DB = { readings: [] };

// ── ALLOWED ORIGINS ──────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://hast-rekha.com",
  "https://www.hast-rekha.com",
  "https://samudrik-shastra-server.onrender.com"
];

function cors(res, req) {
  const origin = req && req.headers && req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (!origin) {
    // Direct server-to-server or same-origin — allow
    res.setHeader("Access-Control-Allow-Origin", "https://hast-rekha.com");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
}

// ── RATE LIMITER ──────────────────────────────────────────
// Max 3 readings per IP per 24 hours (prevents bot abuse)
const rateLimitMap = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true; // allowed
  }
  if (entry.count >= RATE_LIMIT) return false; // blocked
  entry.count++;
  return true; // allowed
}

// Clean up old entries every hour to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 60 * 60 * 1000);
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
  const years   = [7,20,6,10,7,18,16,19,17];
  const b = new Date(dob), now = new Date();
  const ageYrs = (now - b) / (1000*60*60*24*365.25);
  const bf = (b.getMonth()*30 + b.getDate()) / 365;
  let cum = (bf*120)%120, idx = 0;
  while (cum > years[idx]) { cum -= years[idx]; idx = (idx+1)%9; }
  let elapsed = ageYrs, ci = idx, rem = years[idx] - cum;
  if (elapsed < rem) {
    const e = new Date(now.getTime() + rem*365.25*24*3600*1000);
    return { maha:planets[ci], antar:planets[(ci+1)%9], mahaEnds:e.toLocaleDateString("en-IN",{month:"short",year:"numeric"}), remaining:Math.round(rem*10)/10 };
  }
  elapsed -= rem; ci = (ci+1)%9;
  while (elapsed > years[ci]) { elapsed -= years[ci]; ci = (ci+1)%9; }
  const remaining = years[ci] - elapsed;
  const mahaEnds = new Date(now.getTime() + remaining*365.25*24*3600*1000);
  return { maha:planets[ci], antar:planets[(ci+1)%9], mahaEnds:mahaEnds.toLocaleDateString("en-IN",{month:"short",year:"numeric"}), remaining:Math.round(remaining*10)/10 };
}
function getStage(age) {
  if (age<=12) return "Child (0-12)";
  if (age<=18) return "Teenager (13-18)";
  if (age<=25) return "Young Adult (19-25)";
  if (age<=45) return "Working Professional (26-45)";
  if (age<=60) return "Middle Age (46-60)";
  return "Senior (60+)";
}

function callClaude(messages, maxTokens, systemPrompt) {
  const body = JSON.stringify({ model:"claude-opus-4-5", max_tokens:maxTokens||8000, system:systemPrompt||undefined, messages });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname:"api.anthropic.com", path:"/v1/messages", method:"POST",
      headers:{ "Content-Type":"application/json","x-api-key":API_KEY,"anthropic-version":"2023-06-01","Content-Length":Buffer.byteLength(body) }
    }, res => {
      const parts = [];
      res.on("data", d => parts.push(d));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(parts).toString("utf8"));
          if (data.error) return reject(new Error(data.error.message));
          const block = (data.content||[]).find(b=>b.type==="text");
          resolve(block ? block.text : "");
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function analyzePalm(imageData, mediaType, name, dob, gender, concerns, engine) {
  const age   = dob ? calcAge(dob) : 35;
  const dasha = dob ? calcDasha(dob) : { maha:"Saturn", antar:"Jupiter", mahaEnds:"2028", remaining:2 };
  const stage = getStage(age);
  const concernsText = concerns && concerns.length > 0 ? `Primary concerns: ${concerns.join(", ")}.` : "";

  console.log("Reading:", name, "| Age:", age, "| Stage:", stage, "| Dasha:", dasha.maha, "-", dasha.antar);

  const bookKnowledge = engine === 'hasta' || engine === 'both' ? `

=== ANCIENT TEXTS — RULES FROM 35 PALMISTRY BOOKS ===
Apply ALL of the following rules from Cheiro, Frith, Jaquin, Saint-Germain, Indian Palmistry (Mrs J.B. Dale 1895), Benham and 29 other books in the collection:

${ANCIENT_TEXTS_KNOWLEDGE}
=== END ANCIENT TEXTS ===
` : `

=== CLASSICAL VEDIC READING ===
Apply standard Samudrik Shastra rules: 7 hand types, all palm lines, all 7 mounts, thumb reading, special markings (fish, lotus, trident, star, square, triangle, cross, island, grille).
Use Vimshottari Dasha correlation for timing all predictions.
`;

  const SYSTEM = `You are a master Vedic palmist combining Samudrik Shastra with Vimshottari Dasha.
${bookKnowledge}
PERSON: ${name||"the person"}, Age: ${age}, DOB: ${dob||"unknown"}, Gender: ${gender||"not specified"}
LIFE STAGE: ${stage}
CURRENT DASHA: ${dasha.maha} Mahadasha (ends ${dasha.mahaEnds}, ${dasha.remaining} years remaining), ${dasha.antar} Antardasha
${concernsText}

LIFE STAGE FOCUS:
${age<=12?"Focus on talents, health, academic path. No career marriage property or finance advice.":
  age<=18?"Focus on education stream, college path, early relationships. No career or property advice.":
  age<=25?"Focus on first job, career direction, financial independence, early relationships.":
  age<=45?"Focus on career progression, property, marriage, children, financial growth, foreign opportunities, business, hidden enemies.":
  age<=60?"Focus on career recovery or peak, property, marriage stability, health, retirement planning, family conflicts, legacy.":
  "Focus on health, family harmony, grandchildren, property distribution, spiritual growth, legacy."}

PALM READING INSTRUCTIONS:
1. Study every visible feature: Life Line, Heart Line, Head Line, Fate Line, Sun Line, Health Line, Marriage Lines, all 7 mounts, hand shape, thumb, fingers, markings
2. Rate each major line quality from 1-10 based on clarity, depth, and length
3. Cross-reference palm events with Dasha timeline — where palm matches Dasha = CONFIRMED prediction
4. Give SPECIFIC month and year predictions — not vague
5. For problems: identify exactly when they started (age and year) and when they will resolve
6. Use ONLY plain ASCII-safe text in JSON string values — NO Hindi/Sanskrit script, NO smart/curly quotes (‘’“”), NO em-dashes (—), NO en-dashes (–). Use straight apostrophes (') and hyphens (-) only. Violating this will break JSON parsing.
7. Respond with ONLY a valid JSON object — nothing before or after
8. All date windows must be in the FUTURE — current year is 2026

JSON structure — include ALL fields exactly as shown:
{
  "hand_type": "detailed hand type description",
  "dominant_mount": "which mount is most developed and what it means",
  "line_quality": {
    "heartLine": 7,
    "headLine": 8,
    "lifeLine": 7,
    "fateLine": 5,
    "sunLine": 4
  },
  "overall_energy": "honest 2-3 sentence overall reading",
  "lucky_period": "Month Year to Month Year",
  "life_stage_reading": "specific reading for this age and stage",
  "dasha_summary": "what current dasha means for this specific person",
  "afflicted_planet": "${dasha.maha}",
  "shubh_lagnas": [
    {"number":1,"window":"Month Year to Month Year","probability":"High","what_will_happen":"specific prediction","remedy_before":"remedy to do before window opens","if_missed":"next window timing"},
    {"number":2,"window":"Month Year to Month Year","probability":"Medium","what_will_happen":"prediction","remedy_before":"remedy","if_missed":"fallback"},
    {"number":3,"window":"Month Year to Month Year","probability":"Certain","what_will_happen":"prediction","remedy_before":"remedy","if_missed":"later window"}
  ],
  "predictions": [
    {"category":"Career Stabilization","icon":"briefcase","current_situation":"current career status from palm","primary_window":"Month Year to Month Year","line_evidence":"which line shows this"},
    {"category":"Financial Recovery","icon":"money","current_situation":"current financial status","primary_window":"Month Year to Month Year","line_evidence":"which line shows this"},
    {"category":"Property Matters","icon":"home","current_situation":"property situation","primary_window":"Month Year to Month Year","line_evidence":"line evidence"},
    {"category":"Relationship Harmony","icon":"heart","current_situation":"relationship status","primary_window":"Month Year to Month Year","line_evidence":"line evidence"},
    {"category":"Health and Vitality","icon":"health","current_situation":"health status","primary_window":"Month Year to Month Year","line_evidence":"line evidence"}
  ],
  "problems": [
    {"area":"Finance","title":"Financial Instability and Cash Flow Stress","issue":"specific problem description","severity":"significant","line_source":"Fate Line, weakened Mercury Mount","deep_dive":"deeper insight connecting palm to dasha","dasha_connection":"how current dasha relates","started_when":"Around age X, approximately YEAR-YEAR","resolution":"When and how this resolves"},
    {"area":"Business","title":"Business Partnership Challenges","issue":"specific problem","severity":"significant","line_source":"palm line","deep_dive":"insight","dasha_connection":"connection","started_when":"approximate start","resolution":"resolution timing"},
    {"area":"Health","title":"Health and Energy Concerns","issue":"specific problem","severity":"moderate","line_source":"line","deep_dive":"insight","dasha_connection":"connection","started_when":"approximate start","resolution":"resolution"},
    {"area":"Relationships","title":"Relationship and Communication Gaps","issue":"specific problem","severity":"moderate","line_source":"Heart Line","deep_dive":"insight","dasha_connection":"connection","started_when":"approximate start","resolution":"resolution"}
  ],
  "remedies": [
    {"for":"finance","type":"Mantra","remedy":"specific mantra text","timing":"Every Friday before 10 AM","planet_target":"Venus"},
    {"for":"protection","type":"Ritual","remedy":"specific ritual","timing":"Every Thursday morning","planet_target":"Jupiter"},
    {"for":"health","type":"Lifestyle","remedy":"specific practice","timing":"Daily morning","planet_target":"Sun"},
    {"for":"prosperity","type":"Charity","remedy":"specific charity action","timing":"Every Sunday and Thursday","planet_target":"Jupiter"}
  ],
  "gemstones": [
    {"stone":"yellow_sapphire","title":"Yellow Sapphire (Pukhraj)","reason":"specific reason connected to dasha and palm","planet":"Jupiter","wear_on":"Index finger, right hand","weight":"4-5 carats","metal":"Gold","day_to_wear":"Thursday morning during Jupiter hora","test_first":"no","mantra":"Om Gram Greem Graum Sah Gurave Namah 108 times before wearing"},
    {"stone":"diamond","title":"Diamond (Heera)","reason":"specific reason","planet":"Venus","wear_on":"Middle finger, right hand","weight":"0.5 to 1 carat","metal":"Platinum or White Gold","day_to_wear":"Friday morning after sunrise","test_first":"yes","mantra":"Om Shum Shukraya Namah 108 times before wearing"}
  ],
  "vastu": [
    {"direction":"Sleeping Direction","compass":"South","en":"specific advice about sleeping direction connected to dasha"},
    {"direction":"Work Desk","compass":"East","en":"specific work desk direction advice"},
    {"direction":"Prayer and Meditation","compass":"Northeast","en":"specific prayer corner advice"},
    {"direction":"Wealth Activation Zone","compass":"North","en":"specific north zone advice"},
    {"direction":"Main Entrance Energy","compass":"North or East","en":"specific entrance advice"}
  ],
  "lifestyle": [
    {"title":"Morning Surya Namaskar","en":"specific morning practice description","frequency":"Daily","best_time":"Sunrise, between 6:00-7:00 AM"},
    {"title":"Saturday Fasting and Service","en":"specific Saturday practice","frequency":"Every Saturday","best_time":"Sunrise to sunset"},
    {"title":"Evening Gratitude Practice","en":"specific evening practice","frequency":"Daily","best_time":"Before 9:00 PM"},
    {"title":"Diet and Health Practice","en":"specific dietary advice","frequency":"Daily","best_time":"With each meal"}
  ],
  "positive_signs": [
    {"en":"first specific positive sign from actual palm observation"},
    {"en":"second positive sign"},
    {"en":"third positive sign"},
    {"en":"fourth positive sign"}
  ]
}

Include ALL sections. All dates must be future dates after June 2026. Keep each text field under 60 words. Do NOT add any fields beyond those specified.`;

  const messages = [{
    role: "user",
    content: [
      { type:"image", source:{ type:"base64", media_type:mediaType||"image/jpeg", data:imageData } },
      { type:"text", text:`Analyze this palm for ${name||"the person"} (age ${age}, ${stage}). Current Dasha: ${dasha.maha} Mahadasha ending ${dasha.mahaEnds}. Return ONLY the JSON object.` }
    ]
  }];

  const raw = await callClaude(messages, 8000, SYSTEM);

  let text = raw.replace(/```json\s*/gi,"").replace(/```\s*/g,"");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start===-1||end===-1) throw new Error("No JSON in AI response: "+raw.slice(0,200));

  let slice = text.slice(start, end+1);

  // Allow ALL Unicode — only strip control characters (except tab/newline/CR which become spaces)
  // This fixes JSON parse failures caused by ₹, —, curly quotes, Sanskrit chars etc.
  let safe = "";
  for (let i=0;i<slice.length;i++) {
    const c = slice.charCodeAt(i);
    if (c===9||c===10||c===13) safe += " ";       // tab/newline → space
    else if (c<32) continue;                       // other control chars → strip
    else safe += slice[i];                         // everything else including Unicode → keep
  }

  // Fix trailing commas, smart quotes, and common JSON issues
  safe = safe
    .replace(/,(\s*[}\]])/g,"$1")               // trailing commas
    .replace(/[\u2018\u2019]/g,"'")              // smart single quotes → straight
    .replace(/[\u201C\u201D]/g,"\"")            // smart double quotes → straight
    .replace(/\u2014/g,"--")                      // em-dash → --
    .replace(/\u2013/g,"-");                      // en-dash → -

  let result;
  try {
    result = JSON.parse(safe);
  } catch(parseErr) {
    // Last resort: try to extract and re-parse with more aggressive cleaning
    console.error("JSON parse failed, attempting recovery. Error at:", parseErr.message);
    const cleaned = safe
      .replace(/[\x00-\x1F\x7F]/g," ")         // strip all remaining control chars
      .replace(/,\s*}/g,"}")                       // trailing commas before }
      .replace(/,\s*]/g,"]");                      // trailing commas before ]
    result = JSON.parse(cleaned);
  }
  result._meta = { name, age, dob, gender, stage, dasha, concerns };
  return result;
}

async function handleRequest(req, res) {
  cors(res, req);
  if (req.method==="OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL("http://x"+req.url).pathname;

  if (req.method==="GET" && url==="/") {
    const f = path.join(__dirname,"index.html");
    if (fs.existsSync(f)) { const h=fs.readFileSync(f); res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"}); res.end(h); }
    else { res.writeHead(200,{"Content-Type":"text/html"}); res.end("<h1>HastRekha running.</h1>"); }
    return;
  }
  if (req.method==="GET" && url==="/health") { sendJSON(res,{status:"ok",hasKey:!!API_KEY}); return; }

  if (req.method==="GET" && url==="/terms.html") {
    const f = path.join(__dirname,"terms.html");
    if (fs.existsSync(f)) { const h=fs.readFileSync(f); res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"}); res.end(h); }
    else { res.writeHead(404,{"Content-Type":"text/plain"}); res.end("Terms page not found"); }
    return;
  }

  if (req.method==="POST" && url==="/read-palm") {
    // ── ORIGIN GUARD ──
    const origin = req.headers.origin || "";
    const referer = req.headers.referer || "";
    const originOk = ALLOWED_ORIGINS.some(o => origin.startsWith(o) || referer.startsWith(o));
    if (origin && !originOk) {
      sendJSON(res,{error:"Unauthorised origin"},403); return;
    }
    // ── RATE LIMIT GUARD ──
    const clientIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (!checkRateLimit(clientIp)) {
      sendJSON(res,{error:"Too many requests. Maximum 3 readings per day per user. Please try again tomorrow."},429); return;
    }
    if (!API_KEY) { sendJSON(res,{error:"API key not set"},500); return; }
    let body;
    try { body=JSON.parse(await readBody(req)); } catch(e) { sendJSON(res,{error:"Invalid body"},400); return; }
    const {imageData,mediaType,name,dob,gender,concerns,engine}=body;
    if (!imageData) { sendJSON(res,{error:"No image"},400); return; }
    try {
      const reading = await analyzePalm(imageData,mediaType,name,dob,gender,concerns,engine);
      const record = { id:makeId(),name:name||"Anonymous",dob:dob||"",age:dob?calcAge(dob):0,gender:gender||"",concerns:concerns||[],status:"completed",createdAt:new Date().toISOString(),readingData:reading };
      DB.readings.push(record);
      sendJSON(res,{reading,recordId:record.id});
    } catch(e) {
      console.error("Error:",e.message);
      sendJSON(res,{error:e.message},500);
    }
    return;
  }

  if (req.method==="POST" && url==="/ask-jyotishi") {
    let body;
    try { body=JSON.parse(await readBody(req)); } catch(e) { sendJSON(res,{error:"Invalid body"},400); return; }
    const {name,email,question,readingContext}=body;
    if(!name||!email||!question){ sendJSON(res,{error:"Missing fields"},400); return; }

    // Send email via Anthropic API (use Claude to draft + send via SMTP if configured)
    // For now: log it and return success — add SMTP_USER/SMTP_PASS env vars to enable real sending
    console.log("=== JYOTISHI QUESTION ===");
    console.log("From:", name, "<"+email+">");
    console.log("Question:", question);
    console.log("Context:", readingContext);
    console.log("========================");

    // If SMTP configured, send email
    const SMTP_USER = process.env.SMTP_USER||"";
    const SMTP_PASS = process.env.SMTP_PASS||"";
    const TO_EMAIL  = "jyotish@hast-rekha.com";

    if(SMTP_USER && SMTP_PASS) {
      try {
        const emailBody = [
          "From: "+SMTP_USER,
          "To: "+TO_EMAIL,
          "Reply-To: "+email,
          "Subject: HastRekha Consultation — "+name,
          "Content-Type: text/plain; charset=utf-8",
          "",
          "NEW CONSULTATION REQUEST",
          "========================",
          "Name: "+name,
          "Email: "+email,
          "",
          "QUESTION:",
          question,
          "",
          "READING CONTEXT:",
          readingContext||"No reading done yet",
          "",
          "--- Sent from HastRekha App ---"
        ].join("\r\n");

        // Use Gmail SMTP via TLS
        await new Promise((resolve,reject)=>{
          const tls=require("tls");
          const sock=tls.connect(465,{host:"smtp.gmail.com"},()=>{
            let step=0;
            const cmds=["EHLO hast-rekha.com\r\n","AUTH LOGIN\r\n",Buffer.from(SMTP_USER).toString("base64")+"\r\n",Buffer.from(SMTP_PASS).toString("base64")+"\r\n","MAIL FROM:<"+SMTP_USER+">\r\n","RCPT TO:<"+TO_EMAIL+">\r\n","DATA\r\n",emailBody+"\r\n.\r\n","QUIT\r\n"];
            sock.on("data",d=>{
              const r=d.toString();
              if(r.startsWith("2")||r.startsWith("3")){if(step<cmds.length){sock.write(cmds[step++]);}}
              if(r.startsWith("221")){sock.destroy();resolve();}
              if(r.startsWith("5")){sock.destroy();reject(new Error(r));}
            });
            sock.on("error",reject);
          });
        });
        console.log("Email sent to",TO_EMAIL);
      } catch(emailErr) {
        console.error("Email send failed:",emailErr.message);
      }
    }

    sendJSON(res,{success:true,message:"Question received"});
    return;
  }

  if (req.method==="GET" && url==="/admin/stats") {
    if ((req.headers["authorization"]||"")!==`Bearer ${ADMIN_PASS}`) { sendJSON(res,{error:"Unauthorized"},401); return; }
    const today=new Date().toDateString();
    const byStage={},byEngine={samudrik:0,hasta:0,both:0};
    DB.readings.forEach(r=>{
      const s=r.age<=12?"Child":r.age<=18?"Teenager":r.age<=25?"Young Adult":r.age<=45?"Working Professional":r.age<=60?"Middle Age":"Senior";
      byStage[s]=(byStage[s]||0)+1;
    });
    sendJSON(res,{totalReadings:DB.readings.length,todayReadings:DB.readings.filter(r=>new Date(r.createdAt).toDateString()===today).length,completedReadings:DB.readings.filter(r=>r.status==="completed").length,byLifeStage:byStage});
    return;
  }

  if (req.method==="GET" && url==="/admin/readings") {
    if ((req.headers["authorization"]||"")!==`Bearer ${ADMIN_PASS}`) { sendJSON(res,{error:"Unauthorized"},401); return; }
    sendJSON(res,{readings:DB.readings.map(r=>({id:r.id,name:r.name,dob:r.dob,age:r.age,gender:r.gender,concerns:r.concerns,status:r.status,createdAt:r.createdAt,handType:r.readingData?.hand_type||"",problemCount:(r.readingData?.problems||[]).length})).reverse()});
    return;
  }

  if (req.method==="GET" && url.startsWith("/admin/reading")) {
    if ((req.headers["authorization"]||"")!==`Bearer ${ADMIN_PASS}`) { sendJSON(res,{error:"Unauthorized"},401); return; }
    const id=new URL("http://x"+req.url).searchParams.get("id");
    const record=DB.readings.find(r=>r.id===id);
    if (!record) { sendJSON(res,{error:"Not found"},404); return; }
    sendJSON(res,record);
    return;
  }

  sendJSON(res,{error:"Not found"},404);
}

http.createServer(handleRequest).listen(PORT,()=>{
  console.log(`HastRekha server on port ${PORT} | Model: claude-opus-4-5 | Key: ${API_KEY?"OK":"MISSING"}`);
});

// ── ANCIENT TEXTS KNOWLEDGE BASE ─────────────────────────────
// Extracted from 35 palmistry books in your Google Drive collection
// Sources: Cheiro (Palmistry for All), Practical Palmistry (Frith),
// Scientific Palmistry (Jaquin), Study of Palmistry (Saint-Germain),
// Indian Palmistry (Mrs J.B. Dale 1895), Benham, and others

const ANCIENT_TEXTS_KNOWLEDGE = `
=== HAND TYPES — FROM CHEIRO AND FRITH ===
ELEMENTARY HAND: Short thick fingers, heavy palm, little or no Fate Line. Materialistic nature, low imagination. In Indian tradition: indicates a life of physical labour and struggle.
SQUARE HAND (Earth): Square-tipped fingers, practical nature. Love of order, punctuality, respect for authority. Most common in businessmen and government servants. Fate Line usually clear and straight.
SPATULATE HAND (Fire): Splay-tipped fingers, active and energetic, self-reliant. Always must be doing something. Good for entrepreneurs and builders. Fate Line often broken — career changes.
CONIC HAND (Water): Rounded artistic fingers, impulsive, imaginative, love of beauty. Easily influenced by surroundings. In Indian tradition: artistic, emotional, prone to multiple relationships.
PHILOSOPHIC HAND (Air): Knotted joints, long fingers, analytical mind. Questions everything. Independent thinker. Rare but produces scholars, judges, philosophers.
PSYCHIC HAND: Very long pointed fingers, small delicate palm. Idealistic, spiritual, impractical in business. In Vedic tradition: indicates past life merit and spiritual gifts.
MIXED HAND: Combination of types. Most common. Read dominant features only.

THUMB — CHEIRO RULE: Thumb reading = 30% of total reading weight. Never skip thumb.
- Large strong thumb: Strong will, determination, leadership. Career success through persistence.
- Small weak thumb: Led by others, difficulty completing projects, emotional decisions over rational.
- Clubbed thumb: Violent temper when provoked. Exercise caution in predictions about anger.
- Supple-jointed thumb bending back: Extravagant, generous to fault, adaptable. Financial leakage.
- Firm-jointed thumb straight: Stubborn, careful with money, reliable in commitments.
- First phalange (nail joint) long: Strong willpower, determination, can overcome obstacles.
- Second phalange (logic joint) long: Excellent reasoning, diplomatic, good advisor.
- Mount of Venus (ball of thumb) full and developed: Strong vitality, family devotion, passionate nature, love of music and beauty. In Indian tradition: strong life force, protective ancestors.
- Mount of Venus flat or absent: Cold nature, selfish, difficulty giving or receiving love.

=== LINE OF LIFE — PRECISE RULES ===
FROM CHEIRO: Line of Life runs over the great Palmer Arch blood vessel — directly connected to heart, stomach, vital organs.
- Long, clear, deep: Long life, good constitution, recovery from illness. In Indian tradition: strong ancestral blessings.
- Chained or linked: Poor health, weak digestion, low vitality throughout life.
- Broad and shallow: More muscular strength than willpower. Robust but not resilient under mental strain.
- Fine and deep: Strong nervous energy, willpower, mental resilience. Brain workers.
- Starts high near Jupiter: Ambitious, driven, great control over oneself.
- Starts low from Mars: Quarrelsome, rebellious in youth, quick temper.
- Curves widely into palm: Strong vitality, passionate nature, good health, longevity.
- Hugs thumb tightly, narrow Venus: Delicate constitution, cold nature, less life force.
- Break in Life Line — key rule: Break where one side begins before other ends = major change in life circumstances, not death. If break is clean with square protective mark nearby = danger but survival.
- Island on Life Line: Period of illness or serious difficulty. Duration shown by length of island.
- Ascending lines from Life Line toward Jupiter: Periods of ambition fulfilled, advancement.
- Ascending lines from Life Line toward Saturn: Periods of hardship turned to wisdom.
- Ascending lines from Life Line toward Apollo: Creative success, recognition, financial gain.
- Lines descending from Life Line: Losses, setbacks, energy drain at that age.
TIMING ON LIFE LINE: Start at thumb base. Age 35 is roughly middle of the arc. Age 70 is near wrist.

=== LINE OF HEAD — MOST IMPORTANT LINE, CHEIRO ===
"The Line of Head is like the needle in the compass — without it you cannot read the direction of the subject."
- Clear, deep, fine: Excellent mental clarity, concentration. Academic and professional success.
- Broad and pale: Vacillating nature, lack of concentration, easily distracted.
- Starts inside Life Line (close to thumb): Over-sensitive, nervous, quarrelsome over trifles.
- Starts joined to Life Line: Cautious, undervalues own abilities, needs encouragement. Artists and creative people.
- Starts separated from Life Line (open gap): Quick judgment, mental independence, excellent for leadership and public life.
- Runs straight across palm: Practical, materialistic, business-minded, money-conscious.
- Slopes toward Luna mount: Imaginative, creative, romantic, literary talent. Writers, artists.
- Slopes steeply to wrist: Extreme imagination, morbid tendencies, risk of mental health challenges.
- Forked ending: Diplomacy, ability to see both sides. Excellent for negotiators and lawyers.
- Islands on Head Line: Mental strain, headaches at the age those islands appear.
- Island under Saturn finger: Severe headaches, melancholy tendencies at that age.
- Island under Apollo finger: Eye weakness, vision problems at that period.
- Break in Head Line: Mental crisis, change of thinking, sometimes recovery leads to new career.
- Head Line curves up to Mercury at end: Growing desire for money in later years.
- Head and Heart Lines merged into one line: Simian line — extreme intensity of purpose, great focus, sometimes difficulty distinguishing emotion from logic.

=== LINE OF HEART — EMOTIONAL AND HEALTH ===
- Long, clear, curves to Jupiter: Strong capacity for love, faithful, idealistic in relationships. Marriage lasting.
- Ends between Jupiter and Saturn: Hard-working in love, must earn affection, love through service.
- Short Heart Line: Practical about relationships, less emotional, not cold-hearted.
- Chained Heart Line: Inconstancy, multiple attractions, emotional instability. IN INDIAN TRADITION: many relationships across lifetimes, karmic debts in love.
- Breaks in Heart Line: Heartbreak at age of break. Under Saturn = fatalistic ending. Under Apollo = romantic disappointment with artistic or creative person.
- Heart Line droops to Head Line: Mind controls heart, makes logical decisions in love, sometimes cold.
- No Heart Line: Selfishness, difficulty with lasting relationships. Rare sign.
- Lines rising from Heart Line: Good friendships, liked by many, popular socially.
- Lines falling from Heart Line: Disappointments in love, emotional drain.
PHYSICAL: Heart Line also shows physical heart condition. Indentations = minor heart weakness, not disease. Breaks = palpitations or emotional shock.

=== LINE OF FATE (SATURN LINE) — DESTINY ===
FROM CHEIRO: "The Fate Line undoubtedly appears to indicate at least the main events of one's career."
- Rises from wrist clearly to Saturn with Sun Line present: Outstanding luck, brilliance, success — the best combination.
- Rises from Life Line: Success by personal merit, no help from family or luck. Hard early life.
- Rises from Luna Mount: Career influenced heavily by others, especially opposite sex. Changeable destiny.
- Rises from center of palm late: Difficult early life, self-made success from middle age onward.
- Faint or barely visible: Materialistic person who rebels against the idea of Fate. Success only through own effort.
- No Fate Line: Colourless life, nothing very particular, drifts without clear purpose.
- Break in Fate Line where new line begins before old ends: Complete change of career or life path — usually positive if new line is strong.
- Island on Fate Line: Loss, difficulty, scandal at age of island. In Plain of Mars = financial loss.
- Fate Line stopped by Heart Line: Career ruined by affections placed badly, love over career.
- Fate Line stopped by Head Line: Career damaged by own stupidity or poor judgment.
- Fate Line sends branch to Jupiter: Power, command, authority. High position from that age.
- Fate Line sends branch to Apollo: Wealth, fame, recognition from that age.
- Fate Line sends branch to Mercury: Business success, scientific achievement from that age.
- Double Fate Line: Two parallel careers, double life, or inherited wealth alongside earned career.

=== SUN LINE (APOLLO LINE) — SUCCESS AND RECOGNITION ===
- Present and clear: Public recognition, fame, artistic success, financial comfort through talent.
- Absent: Success possible but without fame or recognition. Ordinary life even with hard work.
- Short Sun Line appearing late in palm: Recognition comes late in life, after 50.
- Rising from Luna Mount: Success through public appeal, arts, entertainment.
- Rising from Fate Line: Success connected directly to career path.
- Rising from Head Line: Success through intelligence and mental effort.
- Rising from Heart Line: Success through social connections and emotional intelligence.
- Star on Sun Line: Sudden fame, brilliant success. One of the best marks.
- Island on Sun Line: Scandal, loss of reputation at age of island.

=== MARRIAGE AND RELATIONSHIP LINES ===
FROM CHEIRO (confirmed by Indian tradition):
- Marriage lines on Mercury edge: Each deep line = significant relationship.
- Long clear line: Long lasting committed relationship.
- Short faint line: Brief relationship or attraction only.
- Line curves downward: Partner may die before subject.
- Fork at beginning: Separation or delay before marriage.
- Fork at end: Divorce or permanent separation.
- Island on marriage line: Unhappy period in marriage, separation, infidelity.
- Cross on marriage line: Serious obstacle to marriage.
- Marriage line touches or cuts Heart Line: Marriage causes emotional pain.
INDIAN TRADITION — ADDITIONAL: Lines on Luna mount rising toward Mercury = foreign marriage or partner from different culture or religion.

=== SPECIAL MARKINGS — INDIAN AND VEDIC TRADITION ===
STAR: Brilliant success in whichever mount or line it appears. On Jupiter = powerful leadership position. On Apollo = sudden fame. On Luna = psychic gifts. On Saturn = fatalistic event.
SQUARE: Protection and preservation. A square surrounding a break in any line = escape from danger. Square on Life Line = protection during illness. Square on Fate Line = protection in career crisis.
TRIANGLE: Mental gift, special talent. Triangle on Jupiter = political skill. Triangle on Apollo = artistic genius. Triangle on Mercury = scientific ability.
CROSS: Always externally caused, never self-created (Cheiro rule). On Jupiter = lucky cross, fortunate love. On Saturn = fatalistic cross, danger. On Apollo = disappointment in art or love. On Mercury = dishonesty or deceit.
ISLAND: Weakness, difficulty, or scandal wherever found. Always read the duration by the length.
CIRCLE: Very rare. On Sun mount = brilliant success. On other mounts = unfortunate.
GRILLE: Excess of negative qualities of that mount. On Venus = excessive passion. On Jupiter = excessive pride. On Moon = excessive fantasy.
FISH MARK (Indian tradition): Exceptional fortune in business, spiritual protection. Usually found near Luna mount or wrist.
LOTUS MARK (Indian tradition): Spiritual attainment, divine protection, exceptional wisdom.
TRIDENT (Indian tradition): Triple blessing — one branch to Jupiter, one to Apollo, one to Saturn = simultaneous success in power, art and wisdom.
BRACELET LINES (Rascettes): Three clear bracelets = long life (70+ years), good fortune overall. First bracelet chained = health challenges. First bracelet rises into palm = difficult childbirth for women.

=== MOUNTS — DETAILED INTERPRETATIONS ===
MOUNT OF VENUS (base of thumb): Vitality, family love, passion, music, sensuality.
- Full and firm: Strong life force, warm-hearted, protective of family, musical.
- Flat: Cold, selfish, difficulty with intimacy.
- Excessive, soft, rayed: Uncontrolled passion, sensuality, jealousy.
IN VEDIC CORRELATION: Venus mount = Venus planet. Strong Venus mount + Venus Mahadasha = period of material abundance, relationships, luxury.

MOUNT OF JUPITER (under index finger): Ambition, leadership, religion, authority.
- Well-developed: Leadership qualities, ambition to rise, religious inclination, commanding presence.
- Flat: Careless of duties, lacks ambition, poor social manners.
- Excessive: Arrogance, tyranny, ostentatious display.
VEDIC: Jupiter mount + Jupiter Mahadasha = expansion, wisdom, marriage timing.

MOUNT OF SATURN (under middle finger): Fate, wisdom through suffering, solitude, agriculture.
- Prominent: Melancholy, love of solitude, wisdom through hardship, taste for mining or agriculture.
- Absent: Careless nature, no sense of fatality, sometimes fortunate as Saturn does not burden them.
- Excessive: Morbid depression, fear of death, tendency to suicide.
VEDIC: Saturn mount + Saturn Mahadasha = period of karmic clearing, discipline, delayed rewards.

MOUNT OF APOLLO/SUN (under ring finger): Art, wealth, beauty, fame, happiness.
- Developed: Sunny temperament, artistic taste, charitable, desire to shine socially.
- Absent: Aimless life, no artistic appreciation, insignificant existence.
- Excessive: Vanity, extravagance, boastfulness.
VEDIC: Sun mount + Sun Antardasha = period of authority, government dealings, health of father.

MOUNT OF MERCURY (under little finger): Business, intellect, medicine, communication.
- Developed: Quick mind, business aptitude, eloquence, intelligence.
- Absent: Failure in business, negative existence.
- Excessive: Dishonesty, cunning, fraud.
VEDIC: Mercury mount + Mercury Mahadasha = period of communication, business, younger siblings.

MOUNT OF MARS (side of hand): Courage, resistance, military virtue.
- Upper Mars (under Mercury): Mental courage, moral bravery, calm in danger.
- Lower Mars (under Jupiter): Physical courage, aggression, fighting spirit.
- Both well-developed: True hero quality, excellent soldier, police, security.
- Absent: Timidity, nervousness, lack of presence.

MOUNT OF MOON/LUNA (lower outer palm): Imagination, romance, travel, instinct.
- Developed: Romantic, loves travel, psychic sensitivity, good writer.
- Absent: Unsympathetic, hard, no imagination.
- Excessive: Fantasist, moody, superstitious, restless.
VEDIC: Moon mount + Moon Mahadasha = period of emotions, mother's influence, mind, travel.

=== GEMSTONE RULES — VEDIC JYOTISH PRECISE ===
RUBY (Manik) — Sun stone:
- Wear ONLY if Sun is strong or Sun Antardasha is active
- NEVER wear if Sun is debilitated (in Libra) or combust in chart
- Palm indicators for Ruby: Strong Sun Line, good Mount of Apollo, good heart health
- Caution: Test first always. Can cause heat, skin issues, anger if wrong placement.
- Correct finger: Ring finger, right hand. Day: Sunday. Metal: Gold.
- Mantra: Om Suryaya Namah 108 times before wearing.

PEARL (Moti) — Moon stone:
- Wear if Moon is weak, afflicted, or during Moon Mahadasha/Antardasha
- Palm indicators: Chained Heart Line (emotional instability), weak or small Luna mount
- Safe for most people. Very rarely causes issues.
- Correct finger: Little finger, right hand. Day: Monday evening. Metal: Silver.
- Mantra: Om Som Somaya Namah 108 times before wearing.

RED CORAL (Moonga) — Mars stone:
- Wear during Mars Mahadasha/Antardasha, or if Mars is weak
- Palm indicators: Broken Life Line, weak Mars mount, health issues, low courage
- CAUTION: Never wear if Mars is in Cancer or afflicted by Saturn in chart
- Correct finger: Ring finger, right hand. Day: Tuesday morning. Metal: Gold or Copper.
- Mantra: Om Kram Kreem Kraum Sah Bhaumaya Namah 108 times.

EMERALD (Panna) — Mercury stone:
- Wear during Mercury Mahadasha/Antardasha, or for business communication issues
- Palm indicators: Weak or absent Mercury mount, poor little finger, communication struggles
- Test before wearing (Cheiro rule: Mercury stones need testing). 
- Correct finger: Little finger, right hand. Day: Wednesday. Metal: Gold or Panchdhatu.
- Mantra: Om Bram Breem Braum Sah Budhaya Namah 108 times.

YELLOW SAPPHIRE (Pukhraj) — Jupiter stone:
- MOST BENEFICIAL of all stones for most people. Jupiter = wisdom and protection.
- Wear during Jupiter Mahadasha/Antardasha, or if Jupiter is weak
- Palm indicators: Weak Jupiter mount, poor ambition, absent or weak Sun Line
- Extremely safe — rarely causes harm. One of few stones that can be worn without testing.
- Correct finger: Index finger, right hand. Day: Thursday morning. Metal: Gold.
- Mantra: Om Gram Greem Graum Sah Gurave Namah 108 times.

DIAMOND (Heera) — Venus stone:
- Wear during Venus Mahadasha/Antardasha (20-year period!)
- Palm indicators: Strong Venus mount, artistic temperament, relationship issues
- CAUTION: Must test before wearing. Can amplify both good and bad Venus qualities.
- White Sapphire or White Topaz as alternative if Diamond unaffordable.
- Correct finger: Middle finger, right hand. Day: Friday morning. Metal: White Gold or Platinum.
- Mantra: Om Shum Shukraya Namah 108 times.

BLUE SAPPHIRE (Neelam) — Saturn stone:
- MOST POWERFUL and MOST DANGEROUS stone. Must test without exception.
- Wear ONLY during Saturn Mahadasha (19 years) if Saturn is strong in chart
- Palm indicators: Very prominent Saturn mount, Fate Line running to Saturn mount, life of hardship
- Testing: Wear one night under pillow. If bad dream or incident, do not wear. If good feeling, proceed.
- NEVER wear without proper Jyotish consultation for individual chart.
- Correct finger: Middle finger, right hand. Day: Saturday morning Shani Hora. Metal: Silver.
- Mantra: Om Pram Preem Praum Sah Shanaischaraya Namah 108 times.

HESSONITE (Gomed) — Rahu stone:
- Wear during Rahu Mahadasha (18 years) — very important
- Palm indicators: Unusual Fate Line, sudden career changes, unconventional life path
- Must test: 3 days trial first.
- Correct finger: Middle finger, right hand. Day: Saturday. Metal: Silver or Panchdhatu.
- Mantra: Om Raam Raahave Namah 108 times.

CAT'S EYE (Lahsuniya) — Ketu stone:
- Wear during Ketu Mahadasha (7 years) — spiritual and detachment period
- Palm indicators: Mystical markings on Luna mount, intuition lines, spiritual seeking
- CAUTION: Must test 3 days. Ketu stones are powerful and unpredictable.
- Correct finger: Middle finger, right hand. Day: Saturday. Metal: Silver.
- Mantra: Om Kem Ketve Namah 108 times.

=== VEDIC DASHA CORRELATION WITH PALM ===
SATURN MAHADASHA (19 years): Look for — faint or broken Fate Line in mid-palm, islands on Life Line, heavy Saturn mount. Person faces delays, hardship, karmic clearing. Remedies: Saturn mantra, oil donation, service to elderly.
VENUS MAHADASHA (20 years): Look for — strong Venus mount, Heart Line with chains, relationship lines active. Person experiences luxury, relationships, creative pursuits. Risk: overspending, love complications.
RAHU MAHADASHA (18 years): Look for — unusual life path, sudden breaks and new beginnings in Fate Line. Person experiences sudden changes, foreign travel, unconventional career.
JUPITER MAHADASHA (16 years): Look for — strong Jupiter mount, ascending Fate Line. Expansion, wisdom, marriage, children, spiritual growth.
SUN MAHADASHA (6 years): Look for — strong Sun Line appearing, good Apollo mount. Authority, government, father's health, career recognition.
MOON MAHADASHA (10 years): Look for — developed Luna mount, emotional Heart Line. Emotions, travel, mother, public life, mind fluctuations.
MARS MAHADASHA (7 years): Look for — strong Mars mount, breaks in Life Line healed by Mars line. Energy, courage, health challenges, property disputes.
KETU MAHADASHA (7 years): Look for — spiritual markings on palm, detachment lines. Spiritual seeking, separation, mystical experiences, letting go.
MERCURY MAHADASHA (17 years): Look for — developed Mercury mount, business lines. Communication, business, siblings, intellect, writing.

=== TIMING METHODS — CHEIRO AND INDIAN COMBINED ===
LIFE LINE TIMING: Start at base of Jupiter finger going down. Each centimeter roughly 5-7 years. Midpoint = age 35. Near wrist = age 70-75.
FATE LINE TIMING: Start at wrist = birth. Where it crosses Head Line = approximately age 35. Where it crosses Heart Line = approximately age 50.
7-YEAR CYCLES (Cheiro): Major life events tend to occur in 7-year cycles. Ages 7, 14, 21, 28, 35, 42, 49, 56, 63, 70 are critical transition points. Look for line changes at these ages.
SUN LINE TIMING: Position on palm shows when recognition or success arrives. Near wrist = early 20s. Near Heart Line = 40s-50s.

=== INDIAN TRADITION SPECIFIC RULES ===
1. Bracelet lines (Rascettes) should always be read: First bracelet clear = health and longevity. Three clear bracelets = long prosperous life.
2. Thumb in Indian tradition: Broad well-set thumb = person who achieves things. Weak thin thumb = dominated by circumstances.
3. Right hand always for destiny reading in Indian tradition. Left hand = past karma and what was given.
4. A palm with very few lines = simple straightforward destiny, no major complications.
5. A palm with many fine lines = sensitive nervous person, multiple influences, complex destiny.
6. Lines that appear to glow or are deeply carved = very strong influence of that planet or quality.
7. Soft pink palm = good blood circulation, health, warmth. Pale palm = anaemia, low vitality, cold nature.
8. Color of palm: Reddish = passionate, energetic, sometimes angry. Yellowish = liver issues, bitterness. Pale = health concerns, weakness.
`;

module.exports = { ANCIENT_TEXTS_KNOWLEDGE };
