// ── AI engine: Ollama → Gemini → Groq → OpenRouter ──────────────────────────

let _orModelIdx = 0;
function getUserKey(name) { return localStorage.getItem(KEYS[name]) || ""; }

// ─── Usage tracking (for quota display in profile) ───────────────────────────
function _trackUsage(provider) {
  try {
    const key  = `_110_usage_${provider}`;
    const now  = Date.now();
    const s    = JSON.parse(localStorage.getItem(key) || "{}");
    if (!s.dailyReset  || now - s.dailyReset  > 86400000) { s.daily  = 0; s.dailyReset  = now; }
    if (!s.minuteReset || now - s.minuteReset > 60000)     { s.minute = 0; s.minuteReset = now; }
    s.daily = (s.daily || 0) + 1;
    s.minute = (s.minute || 0) + 1;
    s.lastCall = now;
    localStorage.setItem(key, JSON.stringify(s));
  } catch {}
}

export function getAPIUsage() {
  const LIMITS = {
    gemini:     { label:"Gemini",          daily:1500,  minute:15,  key:"gemini" },
    groq:       { label:"Groq",            daily:14400, minute:30,  key:"groq" },
    openrouter: { label:"OpenRouter",      daily:null,  minute:null, key:"openrouter" },
    ollama:     { label:"Ollama (local)",  daily:null,  minute:null, key:"ollamaModels" },
  };
  const now = Date.now();
  return Object.entries(LIMITS).map(([id, lim]) => {
    const s = JSON.parse(localStorage.getItem(`_110_usage_${id}`) || "{}");
    const dailyUsed  = s.dailyReset  && now - s.dailyReset  < 86400000 ? (s.daily  || 0) : 0;
    const minuteUsed = s.minuteReset && now - s.minuteReset < 60000     ? (s.minute || 0) : 0;
    return {
      id, label: lim.label,
      configured: !!localStorage.getItem(KEYS[lim.key]),
      dailyUsed, dailyLimit: lim.daily,
      minuteUsed, minuteLimit: lim.minute,
      dailyPct: lim.daily ? Math.round(dailyUsed / lim.daily * 100) : null,
      oddsRemaining: id === "gemini" ? null : null, // populated externally
    };
  });
}

// ─── Provider functions ───────────────────────────────────────────────────────
async function callGemini(prompt, key, maxTokens = 2048) {
  if (!key) throw new Error("no_key");
  const r = await fetch(CONFIG.llm.gemini.endpoint(key), {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.3, maxOutputTokens:maxTokens} })
  });
  if (!r.ok) throw new Error(`gemini_${r.status}`);
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callGroq(prompt, key, maxTokens = 2048) {
  if (!key) throw new Error("no_key");
  const effectiveMax = Math.min(maxTokens, 4000);
  const models = [CONFIG.llm.groq.model, CONFIG.llm.groq.fallbackModel].filter(Boolean);
  for (const model of models) {
    const r = await fetch(CONFIG.llm.groq.endpoint, {
      method:"POST",
      headers:{"Content-Type":"application/json", Authorization:`Bearer ${key}`},
      body: JSON.stringify({ model, temperature:0.3, max_tokens:effectiveMax,
        messages:[{role:"system",content:"You are a sharp sports analytics AI. Return only valid JSON."},
                  {role:"user",content:prompt}] })
    });
    if (r.status === 429 && model !== models[models.length-1]) continue;
    if (!r.ok) throw new Error(`groq_${r.status}`);
    // Capture remaining quota from headers
    try {
      const rem = r.headers.get("x-ratelimit-remaining-tokens");
      const remReq = r.headers.get("x-ratelimit-remaining-requests");
      if (rem) localStorage.setItem("_110_groq_tokens_rem", rem);
      if (remReq) localStorage.setItem("_110_groq_req_rem", remReq);
    } catch {}
    const d = await r.json();
    return d.choices?.[0]?.message?.content || "";
  }
  throw new Error("groq_exhausted");
}

async function callOpenRouter(prompt, key, maxTokens = 2048) {
  if (!key) throw new Error("no_key");
  const models = CONFIG.llm.openrouter.models;
  const model  = models[_orModelIdx % models.length];
  const r = await fetch(CONFIG.llm.openrouter.endpoint, {
    method:"POST",
    headers:{"Content-Type":"application/json", Authorization:`Bearer ${key}`,
             "HTTP-Referer":"https://n0nam3-bot.github.io/-110", "X-Title":"-110 Sports"},
    body: JSON.stringify({ model, max_tokens:maxTokens, temperature:0.3,
      messages:[{role:"system",content:"You are a sharp sports analytics AI. Return only valid JSON."},
                {role:"user",content:prompt}] })
  });
  if (!r.ok) { _orModelIdx++; throw new Error(`openrouter_${r.status}`); }
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "";
}

async function callOllama(prompt, baseUrl, modelsStr, maxTokens = 2048) {
  const url    = (baseUrl || CONFIG.llm.ollama.defaultUrl).replace(/\/$/, "");
  const models = (modelsStr || CONFIG.llm.ollama.defaultModels).split(",").map(m => m.trim()).filter(Boolean);
  for (const model of models) {
    try {
      const r = await fetch(`${url}/api/chat`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ model, stream:false, options:{temperature:0.3, num_predict:maxTokens},
          messages:[{role:"system",content:"You are a sharp sports analytics AI. Return only valid JSON."},
                    {role:"user",content:prompt}] })
      });
      if (!r.ok) throw new Error(`ollama_${r.status}`);
      const d = await r.json();
      const text = d.message?.content || "";
      if (text.trim()) return text;
    } catch (e) { console.warn(`Ollama ${model}:`, e.message); }
  }
  throw new Error("ollama_all_failed");
}

// ─── Global serializer + adaptive retry ──────────────────────────────────────
// One call in-flight at a time. On rate limit, tries all providers before
// waiting — no fixed 25s cooldown. Only waits if EVERY provider is exhausted.
const _LLM_GAP = 3000;
let   _llmChain = Promise.resolve();
export let lastProvider = "";

function callLLM(prompt, opts = {}) {
  const call = _llmChain.then(() => _callLLMDirect(prompt, opts));
  _llmChain = call
    .then(() => new Promise(r => setTimeout(r, _LLM_GAP)))
    .catch(() => new Promise(r => setTimeout(r, _LLM_GAP)));
  return call;
}

async function _callLLMDirect(prompt, { maxTokens = 2048 } = {}) {
  const geminiKey     = getUserKey("gemini");
  const groqKey       = getUserKey("groq");
  const openrouterKey = getUserKey("openrouter");
  const ollamaModels  = getUserKey("ollamaModels");
  const ollamaUrl     = getUserKey("ollamaUrl") || CONFIG.llm.ollama.defaultUrl;

  const providers = [
    { name:"ollama",     fn:() => callOllama(prompt, ollamaUrl, ollamaModels, maxTokens),     available:!!ollamaModels },
    { name:"gemini",     fn:() => callGemini(prompt, geminiKey, maxTokens),                   available:!!geminiKey },
    { name:"groq",       fn:() => callGroq(prompt, groqKey, maxTokens),                       available:!!groqKey },
    { name:"openrouter", fn:() => callOpenRouter(prompt, openrouterKey, maxTokens),            available:!!openrouterKey },
  ].filter(p => p.available);

  if (!providers.length) throw new Error("NO_KEYS");

  // Pass 1 — try every provider; brief pause between 429s (not 25s!)
  for (const p of providers) {
    try {
      const text = await p.fn();
      if (text?.trim()) { lastProvider = p.name; _trackUsage(p.name); return { text, provider:p.name }; }
    } catch (e) {
      const is429 = e.message.includes("429") || e.message.includes("rate");
      console.warn(`LLM ${p.name}:`, e.message);
      if (is429) await new Promise(r => setTimeout(r, 2000)); // 2s pause, then try next
    }
  }

  // Pass 2 — all failed; wait 20s then try once more (not 25s, and only once)
  console.warn("All LLM providers failed — waiting 20s before final retry…");
  await new Promise(r => setTimeout(r, 20000));

  for (const p of providers) {
    try {
      const text = await p.fn();
      if (text?.trim()) { lastProvider = p.name; _trackUsage(p.name); return { text, provider:p.name }; }
    } catch (e) { console.warn(`LLM ${p.name} retry:`, e.message); }
  }

  throw new Error("ALL_PROVIDERS_FAILED");
}

// ─── JSON parser ──────────────────────────────────────────────────────────────
function parseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch {}
  const arr = clean.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch {} }
  const obj = clean.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch {} }
  return null;
}

// ─── Combined batch prompt ───────────────────────────────────────────────────
function buildCombinedBatchPrompt(gamesWithContext) {
  const isMMA = gamesWithContext[0]?.game?.sport === "mma";

  const gameBlocks = gamesWithContext.map((gc, i) => {
    const { game, recentFormHome, recentFormAway, props, playerStats, homeInjuries, awayInjuries } = gc;
    const odds  = game.odds;
    const promo = game.promotion ? ` (${game.promotion})` : "";

    const oddsLine = odds
      ? `ML: ${game.homeTeam.abbr} ${odds.moneyline?.home?.price ?? "N/A"} / ${game.awayTeam.abbr} ${odds.moneyline?.away?.price ?? "N/A"} | Spread: ${odds.spread?.home?.point ?? "N/A"}(${odds.spread?.home?.price ?? "N/A"}) | O/U ${odds.total?.over?.point ?? "N/A"}(O${odds.total?.over?.price ?? "N/A"}/U${odds.total?.under?.price ?? "N/A"})`
      : "No live odds — use records and form for picks";

    const recH = game.homeTeam.record ? ` [${game.homeTeam.record}]` : "";
    const recA = game.awayTeam.record ? ` [${game.awayTeam.record}]` : "";

    let formLine = "";
    if (!isMMA) {
      const fH = recentFormHome?.slice(-5).map(g => g.result).join("") || "";
      const fA = recentFormAway?.slice(-5).map(g => g.result).join("") || "";
      if (fH || fA) {
        const wH = (fH.match(/W/g) || []).length, wA = (fA.match(/W/g) || []).length;
        formLine = `\nFORM: ${game.homeTeam.name} ${fH||"?"} (${wH}W-${fH.length-wH}L last 5) | ${game.awayTeam.name} ${fA||"?"} (${wA}W-${fA.length-wA}L last 5)`;
      }
    }

    // Injuries (ESPN free endpoint — very useful signal)
    const injLines = [];
    if (homeInjuries?.length) injLines.push(`${game.homeTeam.abbr} OUT/DOUBTFUL: ${homeInjuries.slice(0,3).map(x => `${x.player}(${x.status})`).join(", ")}`);
    if (awayInjuries?.length) injLines.push(`${game.awayTeam.abbr} OUT/DOUBTFUL: ${awayInjuries.slice(0,3).map(x => `${x.player}(${x.status})`).join(", ")}`);
    const injLine = injLines.length ? `\nINJURIES: ${injLines.join(" | ")}` : "";

    let propsLine = "";
    if (props?.length) {
      const grouped = props.reduce((a, p) => { (a[p.player] = a[p.player] || []).push(p); return a; }, {});
      const topProps = Object.entries(grouped).slice(0, 8).map(([player, lines]) => {
        const stat = playerStats?.[player];
        const avg  = stat ? `[avg:${[stat.pts && `${stat.pts}pts`, stat.reb && `${stat.reb}reb`, stat.ast && `${stat.ast}ast`].filter(Boolean).join(" ")}]` : "";
        return `${player}${avg} ${lines[0].market} ${lines[0].point}(${lines[0].price})`;
      }).join(", ");
      if (topProps) propsLine = `\nPROPS: ${topProps}`;
    }

    return `[${i}] ID:${game.id} | ${game.awayTeam.name}${recA} @ ${game.homeTeam.name}${recH} | ${game.sport.toUpperCase()}${promo} | ${new Date(game.date).toLocaleDateString()}
${oddsLine}${formLine}${injLine}${propsLine}`;
  }).join("\n\n");

  return `You are a sharp sports betting analyst. Analyze ${gamesWithContext.length} game(s).

⚠ CRITICAL — follow every rule or the output is useless:
1. MINIMUM 3 PICKS PER GAME, no exceptions. Even if edges are weak, give the 3 best options available.
2. ALWAYS include spread, moneyline, AND total for every game (3 base picks).
3. Spread picks MUST include the exact point: "Tampa Bay Rays -1.5" NOT "Tampa Bay Rays spread".
4. Total picks MUST include the number: "Over 7.5" NOT just "Over".
5. Use ONLY provided records, form, and injury data — ignore training data for team performance.
6. Grades: S(conf≥8.5,edge≥7%) A(conf≥7,edge≥5%) B(conf≥5.5,edge≥3%) C(below B — still include if it's among the 3 best).
7. bestBet = single highest-graded pick (S first, then A); null + noValue:true if only B/C picks exist.
8. Reasoning: 1 specific sentence citing actual record, form streak, or odds value.
9. summary: 2 sentences using the provided records/form/injury data.${gamesWithContext.some(gc => gc.props?.length) ? "\n10. Props: include all B+ prop picks using the PROPS data." : ""}${isMMA ? "\n10. MMA: include method/round props." : ""}

GAMES:
${gameBlocks}

Return ONLY a valid JSON array (no markdown):
[{"gameId":"ID","summary":"2 sentences with specific data","picks":[{"id":"g0p1","type":"spread|moneyline|total","selection":"Full Team Name ±X.X or Over/Under X.X","odds":"+110","confidence":8.0,"edge":6.0,"grade":"A","reasoning":"1 specific sentence"}],"bestBet":{"id":"g0p1","type":"...","selection":"Full Team Name ±X.X","odds":"+110","confidence":8.0,"edge":6.0,"grade":"A","reasoning":"..."},"lean":"home|away|over|under|none","confidence":7.5,"noValue":false,"props":[{"id":"pr1","type":"prop","player":"Full Name","team":"ABR","market":"player_points","marketLabel":"Points","selection":"Full Name (ABR) Over 24.5 Points","odds":"-115","point":24.5,"direction":"over","confidence":7.0,"edge":5.0,"grade":"A","reasoning":"..."}]}]`;
}

// ─── Main batch export ────────────────────────────────────────────────────────
export async function analyzeCombinedBatch(gamesWithContext) {
  if (!gamesWithContext.length) return [];
  const maxTokens = Math.min(5000, Math.max(2500, gamesWithContext.length * 650));
  const prompt    = buildCombinedBatchPrompt(gamesWithContext);
  const { text, provider } = await callLLM(prompt, { maxTokens });

  const clean = text.replace(/```json|```/g, "").trim();
  let parsed  = null;
  try { parsed = JSON.parse(clean); } catch {}
  if (!Array.isArray(parsed)) {
    const m = clean.match(/\[[\s\S]*\]/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!Array.isArray(parsed)) throw new Error("BATCH_PARSE_FAILED");

  const GRADE = { S:0, A:1, B:2, C:3 };

  function dedupe(picks) {
    const seen = new Set();
    return picks.filter(p => {
      const key = `${(p.selection||"").toLowerCase().trim()}|${p.type}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }

  function fixSelection(pick, gc) {
    if (!gc?.game?.odds || !pick?.selection) return pick;
    const odds = gc.game.odds;
    if (pick.type === "spread" && !/[+-]\d/.test(pick.selection)) {
      const homeLast = gc.game.homeTeam.name.toLowerCase().split(" ").pop();
      const isHome   = pick.selection.toLowerCase().includes(homeLast.slice(0, 4));
      const sp = isHome ? odds.spread?.home : odds.spread?.away;
      if (sp?.point !== undefined) pick.selection += ` ${sp.point >= 0 ? "+" : ""}${sp.point}`;
    }
    if (pick.type === "total" && !/\d+\.?\d/.test(pick.selection)) {
      const pt = odds.total?.over?.point;
      if (pt !== undefined) pick.selection = (/under/i.test(pick.selection) ? "Under " : "Over ") + pt;
    }
    return pick;
  }

  function cleanOdds(p) {
    if (!p.odds || p.odds === "NaN" || p.odds === "null" || p.odds === "N/A") p.odds = "N/A";
    return p;
  }

  return parsed.map(result => {
    const gc = gamesWithContext.find(g => String(g.game.id) === String(result.gameId));

    (result.picks || []).forEach(p => { fixSelection(p, gc); cleanOdds(p); });
    (result.props || []).forEach(p => { fixSelection(p, gc); cleanOdds(p); });

    const hasOdds   = gc?.game?.odds != null;
    const confFloor = hasOdds ? 5.0 : 4.5;
    const edgeFloor = hasOdds ? 2.5 : 2.0;

    const allRaw    = dedupe([...(result.picks || []), ...(result.props || [])]);
    const qualified = allRaw.filter(p => (p.confidence??0) >= confFloor && (p.edge??0) >= edgeFloor);

    // GUARANTEE minimum 3 picks — take top by grade+confidence even if below threshold
    const sorted3Plus = qualified.length >= 3
      ? qualified
      : dedupe([...allRaw]).sort((a,b) => (GRADE[a.grade]??9)-(GRADE[b.grade]??9) || (b.confidence??0)-(a.confidence??0));

    const allSorted = sorted3Plus.sort((a,b) => (GRADE[a.grade]??9)-(GRADE[b.grade]??9) || (b.confidence??0)-(a.confidence??0));

    result.picks = allSorted.slice(0, 12);
    result.props = (result.props || []).filter(p => (p.confidence??0) >= confFloor);

    const best = allSorted.find(p => p.grade === "S" || p.grade === "A");
    result.bestBet = best || null;
    if (!result.bestBet) result.noValue = true;

    return { ...result, provider, analyzedAt: Date.now() };
  });
}

// Legacy exports
export async function analyzeBatchGames(g) { return analyzeCombinedBatch(g); }
export async function analyzeBatchProps()  { return []; }

// Individual game fallback
export async function analyzeGame(game, context = {}) {
  const { teamStatsHome, teamStatsAway, injuryData, recentFormHome, recentFormAway } = context;
  const gc = { game, recentFormHome, recentFormAway, teamStatsHome, teamStatsAway };
  const results = await analyzeCombinedBatch([gc]);
  return results[0] || { gameId: game.id, picks:[], bestBet:null, noValue:true };
}

export async function analyzeProps(game, props, playerStats = {}) {
  if (!props?.length) return { props: [] };
  const gc = { game, props, playerStats, recentFormHome:[], recentFormAway:[] };
  const results = await analyzeCombinedBatch([gc]);
  return { props: results[0]?.props || [] };
}

export function gradeColor(grade) { return CONFIG.grades?.[grade]?.color || "#aaa"; }
export function hasKeys() {
  return !!(localStorage.getItem(KEYS.gemini) || localStorage.getItem(KEYS.groq) ||
            localStorage.getItem(KEYS.openrouter) || localStorage.getItem(KEYS.ollamaModels));
}
