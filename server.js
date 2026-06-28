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
  const body = JSON.stringify({ model:"claude-opus-4-5", max_tokens:maxTokens||4000, system:systemPrompt||undefined, messages });
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

async function analyzePalm(imageData, mediaType, name, dob, gender, concerns) {
  const age   = dob ? calcAge(dob) : 35;
  const dasha = dob ? calcDasha(dob) : { maha:"Saturn", antar:"Jupiter", mahaEnds:"2028", remaining:2 };
  const stage = getStage(age);
  const concernsText = concerns && concerns.length > 0 ? `Primary concerns: ${concerns.join(", ")}.` : "";

  console.log("Reading:", name, "| Age:", age, "| Stage:", stage, "| Dasha:", dasha.maha, "-", dasha.antar);

  const SYSTEM = `You are a master Vedic palmist combining Samudrik Shastra with Vimshottari Dasha.

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
6. Use ONLY plain ASCII text — no Hindi, no smart quotes, no em-dashes, no apostrophes
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

Include ALL sections. All dates must be future dates after June 2026.`;

  const messages = [{
    role: "user",
    content: [
      { type:"image", source:{ type:"base64", media_type:mediaType||"image/jpeg", data:imageData } },
      { type:"text", text:`Analyze this palm for ${name||"the person"} (age ${age}, ${stage}). Current Dasha: ${dasha.maha} Mahadasha ending ${dasha.mahaEnds}. Return ONLY the JSON object.` }
    ]
  }];

  const raw = await callClaude(messages, 4500, SYSTEM);

  let text = raw.replace(/```json\s*/gi,"").replace(/```\s*/g,"");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start===-1||end===-1) throw new Error("No JSON in AI response: "+raw.slice(0,200));

  let safe = "";
  const slice = text.slice(start, end+1);
  for (let i=0;i<slice.length;i++) {
    const c = slice.charCodeAt(i);
    if (c===9||c===10||c===13) safe += " ";
    else if (c>=32&&c<=126) safe += slice[i];
  }
  safe = safe.replace(/,(\s*[}\]])/g,"$1");

  const result = JSON.parse(safe);
  result._meta = { name, age, dob, gender, stage, dasha, concerns };
  return result;
}

async function handleRequest(req, res) {
  cors(res);
  if (req.method==="OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL("http://x"+req.url).pathname;

  if (req.method==="GET" && url==="/") {
    const f = path.join(__dirname,"index.html");
    if (fs.existsSync(f)) { const h=fs.readFileSync(f); res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"}); res.end(h); }
    else { res.writeHead(200,{"Content-Type":"text/html"}); res.end("<h1>HastRekha running.</h1>"); }
    return;
  }
  if (req.method==="GET" && url==="/health") { sendJSON(res,{status:"ok",hasKey:!!API_KEY}); return; }

  if (req.method==="POST" && url==="/read-palm") {
    if (!API_KEY) { sendJSON(res,{error:"API key not set"},500); return; }
    let body;
    try { body=JSON.parse(await readBody(req)); } catch(e) { sendJSON(res,{error:"Invalid body"},400); return; }
    const {imageData,mediaType,name,dob,gender,concerns}=body;
    if (!imageData) { sendJSON(res,{error:"No image"},400); return; }
    try {
      const reading = await analyzePalm(imageData,mediaType,name,dob,gender,concerns);
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
