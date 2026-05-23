// ── AI engine: Gemini → Groq → OpenRouter rotation ──

let _orModelIdx = 0;
function getUserKey(name) { return localStorage.getItem(KEYS[name]) || ""; }

// ─── LLM callers ──────────────────────────────────────────────────────────────

async function callGemini(prompt, key, maxTokens = 2048) {
  if (!key) throw new Error("no_key");
  const url  = CONFIG.llm.gemini.endpoint(key);
  const body = { contents:[{ parts:[{ text: prompt }] }], generationConfig:{ temperature:0.3, maxOutputTokens: maxTokens } };
  const r    = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`gemini_${r.status}`);
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callGroq(prompt, key, maxTokens = 2048) {
  if (!key) throw new Error("no_key");
  const models = [CONFIG.llm.groq.model, CONFIG.llm.groq.fallbackModel].filter(Boolean);
  for (const model of models) {
    const body = {
      model,
      messages:[{ role:"system", content:"You are a sharp sports analytics AI. Return only valid JSON." }, { role:"user", content: prompt }],
      temperature:0.3, max_tokens: maxTokens
    };
    const r = await fetch(CONFIG.llm.groq.endpoint, { method:"POST", headers:{"Content-Type":"application/json", Authorization:`Bearer ${key}`}, body: JSON.stringify(body) });
    if (r.status === 429 && model !== models[models.length-1]) continue;
    if (!r.ok) throw new Error(`groq_${r.status}`);
    const d = await r.json();
    return d.choices?.[0]?.message?.content || "";
  }
  throw new Error("groq_rate_limited");
}

async function callOpenRouter(prompt, key, maxTokens = 2048) {
  if (!key) throw new Error("no_key");
  const models = CONFIG.llm.openrouter.models;
  const model  = models[_orModelIdx % models.length];
  const body   = {
    model, max_tokens: maxTokens,
    messages:[{ role:"system", content:"You are a sharp sports analytics AI. Return only valid JSON." }, { role:"user", content: prompt }],
    temperature:0.3
  };
  const r = await fetch(CONFIG.llm.openrouter.endpoint, {
    method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:`Bearer ${key}`, "HTTP-Referer":"https://n0nam3-bot.github.io/-110", "X-Title":"-110 Sports" },
    body: JSON.stringify(body)
  });
  if (!r.ok) { _orModelIdx++; throw new Error(`openrouter_${r.status}`); }
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "";
}

// ─── Retry-aware LLM dispatcher ───────────────────────────────────────────────
const _RETRY_DELAYS = [8000, 20000]; // 8 s, then 20 s before giving up on a provider

async function callLLM(prompt, { maxTokens = 2048 } = {}) {
  const geminiKey     = getUserKey("gemini");
  const groqKey       = getUserKey("groq");
  const openrouterKey = getUserKey("openrouter");
  const providers = [
    { name:"gemini",     fn:() => callGemini(prompt, geminiKey, maxTokens),         available:!!geminiKey },
    { name:"groq",       fn:() => callGroq(prompt, groqKey, maxTokens),             available:!!groqKey },
    { name:"openrouter", fn:() => callOpenRouter(prompt, openrouterKey, maxTokens), available:!!openrouterKey }
  ].filter(p => p.available);
  if (!providers.length) throw new Error("NO_KEYS");

  for (const p of providers) {
    for (let attempt = 0; attempt <= _RETRY_DELAYS.length; attempt++) {
      try {
        const text = await p.fn();
        if (text?.trim()) return { text, provider: p.name };
        break;
      } catch (e) {
        const is429 = e.message.includes("429") || e.message.includes("rate");
        if (is429 && attempt < _RETRY_DELAYS.length) {
          const wait = _RETRY_DELAYS[attempt];
          console.log(`LLM ${p.name} rate-limited, retrying in ${wait/1000}s…`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        console.warn(`LLM ${p.name} failed:`, e.message);
        break;
      }
    }
  }
  throw new Error("ALL_PROVIDERS_FAILED");
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch {}
  const obj = clean.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch {} }
  const arr = clean.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch {} }
  return null;
}

// ─── Batch game prompt ────────────────────────────────────────────────────────
function buildBatchGamePrompt(gamesWithContext) {
  const gameBlocks = gamesWithContext.map((gc, i) => {
    const { game, recentFormHome, recentFormAway } = gc;
    const odds     = game.odds;
    const isMMA    = game.sport === "mma";
    const promo    = game.promotion ? ` (${game.promotion})` : "";
    const oddsLine = odds
      ? `ML:${game.homeTeam.abbr} ${odds.moneyline?.home?.price ?? "N/A"}/` +
        `${game.awayTeam.abbr} ${odds.moneyline?.away?.price ?? "N/A"} | ` +
        `Spread:${odds.spread?.home?.point ?? "N/A"}(${odds.spread?.home?.price ?? "N/A"}) | ` +
        `O/U ${odds.total?.over?.point ?? "N/A"}(O${odds.total?.over?.price ?? "N/A"}/U${odds.total?.under?.price ?? "N/A"})`
      : "No odds available";
    const formH = recentFormHome?.slice(-5).map(g => g.result).join("") || "";
    const formA = recentFormAway?.slice(-5).map(g => g.result).join("") || "";
    const formLine = !isMMA && (formH || formA) ? ` | Form: ${game.homeTeam.abbr} ${formH||"?"} vs ${game.awayTeam.abbr} ${formA||"?"}` : "";
    return `[${i}] ID:${game.id} | ${game.awayTeam.name} @ ${game.homeTeam.name} | ${game.sport.toUpperCase()}${promo} | ${new Date(game.date).toLocaleDateString()}\n${oddsLine}${formLine}`;
  }).join("\n\n");

  return `You are a sharp sports betting analyst. Analyze ALL ${gamesWithContext.length} games and return a JSON array — one object per game in the EXACT same order.

GAMES:
${gameBlocks}

RULES:
- Grade every angle: S(conf≥8.5,edge≥7%) A(conf≥7,edge≥5%) B(conf≥5.5,edge≥3%) C(below B)
- picks array: include ALL grades B and above (spread, moneyline, total${gamesWithContext[0]?.game?.sport === "mma" ? ", method, round" : ""})
- bestBet: single best pick, must be grade A or S; set null + noValue:true if no value
- Use FULL team name in selection (never abbreviation alone)
- summary: 2 sharp sentences per game

Return ONLY a JSON array, no markdown:
[{"gameId":"ID","summary":"...","picks":[{"id":"g0p1","type":"spread|moneyline|total","selection":"Full Team Name Over/Under/ML/Spread","odds":"+110","confidence":8.0,"edge":6.0,"grade":"A","reasoning":"brief"}],"bestBet":{"id":"g0p1","type":"...","selection":"Full Team Name — exact bet","odds":"+110","confidence":8.0,"edge":6.0,"grade":"A","reasoning":"..."},"lean":"home|away|over|under|none","confidence":7.5,"noValue":false}]`;
}

// ─── Batch prop prompt ────────────────────────────────────────────────────────
function buildBatchPropPrompt(propsPerGame) {
  const blocks = propsPerGame.map((pg, i) => {
    const { game, props, playerStats } = pg;
    const grouped = props.reduce((acc, p) => { (acc[p.player] = acc[p.player] || []).push(p); return acc; }, {});
    const lines = Object.entries(grouped).slice(0, 15).map(([player, ps]) => {
      const stat = playerStats?.[player];
      const avg  = stat ? ` [avg:${[stat.pts && `${stat.pts}pts`, stat.reb && `${stat.reb}reb`, stat.ast && `${stat.ast}ast`].filter(Boolean).join(" ")}]` : "";
      return `  ${player}${avg}: ${ps[0].market} ${ps[0].point} (${ps[0].price})`;
    }).join("\n");
    return `[${i}] ID:${game.id} | ${game.awayTeam.name} @ ${game.homeTeam.name}\n${lines}`;
  }).join("\n\n");

  return `Grade player props for ${propsPerGame.length} games. Include ALL B+ props (conf≥5.5, edge≥3%). Full player name + team abbr in selection.

${blocks}

Return ONLY JSON array:
[{"gameId":"ID","props":[{"id":"p0_1","type":"prop","player":"Full Name","team":"ABR","market":"player_points","marketLabel":"Points","selection":"Full Name (ABR) Over 24.5 Points","odds":"-115","point":24.5,"direction":"over","confidence":8.0,"edge":6.0,"grade":"A","reasoning":"brief"}]}]`;
}

// ─── Batch analysis exports ───────────────────────────────────────────────────
export async function analyzeBatchGames(gamesWithContext) {
  if (!gamesWithContext.length) return [];
  // Batch calls need more output tokens — 12 games × ~400 tokens each
  const maxTokens = Math.min(8000, Math.max(2048, gamesWithContext.length * 500));
  const prompt    = buildBatchGamePrompt(gamesWithContext);
  const { text, provider } = await callLLM(prompt, { maxTokens });

  // Parse — try full JSON first, then hunt for the array
  const clean = text.replace(/```json|```/g, "").trim();
  let parsed   = null;
  try { parsed = JSON.parse(clean); } catch {}
  if (!Array.isArray(parsed)) {
    const m = clean.match(/\[[\s\S]*\]/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!Array.isArray(parsed)) {
    console.warn("Batch parse failed — raw:", clean.slice(0, 300));
    throw new Error("BATCH_PARSE_FAILED");
  }

  return parsed.map(result => {
    result.picks = (result.picks || []).filter(p => p.confidence >= 5.5 && p.edge >= 3.0).slice(0, 6);
    if (result.bestBet?.confidence < CONFIG.bestBet.minConfidence) { result.bestBet = null; result.noValue = true; }
    return { ...result, provider, analyzedAt: Date.now() };
  });
}

export async function analyzeBatchProps(propsPerGame) {
  if (!propsPerGame.length) return [];
  const maxTokens = Math.min(6000, Math.max(1024, propsPerGame.length * 400));
  const prompt    = buildBatchPropPrompt(propsPerGame);
  const { text }  = await callLLM(prompt, { maxTokens });
  const clean     = text.replace(/```json|```/g, "").trim();
  let parsed      = null;
  try { parsed = JSON.parse(clean); } catch {}
  if (!Array.isArray(parsed)) {
    const m = clean.match(/\[[\s\S]*\]/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(r => ({
    ...r,
    props: (r.props || []).filter(p => p.confidence >= 5.5 && p.edge >= 3.0)
  }));
}

// ─── Individual game analysis (kept as fallback) ──────────────────────────────
function buildGamePrompt(game, teamStatsHome, teamStatsAway, injuryData, recentFormHome, recentFormAway) {
  const injuryStr = injuryData && Object.keys(injuryData).length
    ? Object.entries(injuryData).slice(0, 10).map(([n, d]) => `${n} (${d.team}): ${d.status}`).join("; ")
    : "No major injuries reported";
  const formH  = recentFormHome?.map(g => `${g.result} vs ${g.opponent}`).join(", ") || "N/A";
  const formA  = recentFormAway?.map(g => `${g.result} vs ${g.opponent}`).join(", ") || "N/A";
  const odds   = game.odds;
  const isMMA  = game.sport === "mma";
  const oddsStr = odds ? `\nMoneyline: ${game.homeTeam.abbr} ${odds.moneyline?.home?.price||"N/A"} | ${game.awayTeam.abbr} ${odds.moneyline?.away?.price||"N/A"}\nSpread: ${game.homeTeam.abbr} ${odds.spread?.home?.point||"N/A"} (${odds.spread?.home?.price||"N/A"})\nTotal: O/U ${odds.total?.over?.point||"N/A"} (O${odds.total?.over?.price||"N/A"} / U${odds.total?.under?.price||"N/A"})` : "Odds: Not available";
  return `You are a sharp sports betting analyst. Analyze this ${isMMA?"MMA fight":"game"} and return ONLY JSON.\n\nGAME: ${game.awayTeam.name} @ ${game.homeTeam.name} | ${game.sport.toUpperCase()} | ${new Date(game.date).toLocaleDateString()}\nODDS: ${oddsStr}\n${isMMA?"":(`HOME L10: ${formH}\nAWAY L10: ${formA}\nINJURIES: ${injuryStr}`)}\n\nGrade picks S/A/B/C, include all B+. bestBet must be A or S.\n\nReturn JSON:\n{"gameId":"${game.id}","summary":"...","picks":[{"id":"u1","type":"spread|moneyline|total","selection":"Full Team Name bet","odds":"+110","confidence":8.0,"edge":6.0,"grade":"A","reasoning":"..."}],"bestBet":{"id":"u1","type":"...","selection":"...","odds":"...","confidence":8.0,"edge":6.0,"grade":"A","reasoning":"..."},"lean":"home|away|over|under|none","confidence":7.5,"noValue":false}`;
}

export async function analyzeGame(game, context = {}) {
  const { teamStatsHome, teamStatsAway, injuryData, recentFormHome, recentFormAway } = context;
  const prompt = buildGamePrompt(game, teamStatsHome, teamStatsAway, injuryData, recentFormHome, recentFormAway);
  const { text, provider } = await callLLM(prompt);
  const parsed = parseJSON(text);
  if (!parsed) throw new Error("PARSE_FAILED");
  parsed.picks = (parsed.picks || []).filter(p => p.confidence >= 5.5 && p.edge >= 3.0).slice(0, 6);
  if (parsed.bestBet?.confidence < CONFIG.bestBet.minConfidence) { parsed.bestBet = null; parsed.noValue = true; }
  return { ...parsed, provider, analyzedAt: Date.now() };
}

export async function analyzeProps(game, props, playerStats = {}) {
  if (!props?.length) return { props: [] };
  const grouped = props.reduce((acc, p) => { (acc[p.player] = acc[p.player] || []).push(p); return acc; }, {});
  const propStr = Object.entries(grouped).slice(0, 20).map(([player, lines]) => {
    const stat = playerStats?.[player];
    const avg  = stat ? ` (avg:${stat.pts ? `${stat.pts}pts ` : ""}${stat.reb ? `${stat.reb}reb ` : ""}${stat.ast ? `${stat.ast}ast` : ""})` : "";
    return `${player}${avg}: ${lines[0].market} ${lines[0].point} (${lines[0].price})`;
  }).join("\n");
  const prompt = `Grade player props for ${game.awayTeam.name} @ ${game.homeTeam.name}. Return ONLY JSON.\n\n${propStr}\n\n{"props":[{"id":"p1","type":"prop","player":"Full Name","team":"ABR","market":"player_points","marketLabel":"Points","selection":"Full Name (ABR) Over 24.5 Points","odds":"-115","point":24.5,"direction":"over","confidence":8.0,"edge":6.0,"grade":"A","reasoning":"..."}]}`;
  const { text } = await callLLM(prompt);
  const parsed   = parseJSON(text);
  if (!parsed) return { props: [] };
  parsed.props = (parsed.props || []).filter(p => p.confidence >= 5.5 && p.edge >= 3.0);
  return parsed;
}

export function gradeColor(grade) { return CONFIG.grades[grade]?.color || "#aaa"; }
export function hasKeys() { return !!(localStorage.getItem(KEYS.gemini) || localStorage.getItem(KEYS.groq) || localStorage.getItem(KEYS.openrouter)); }
