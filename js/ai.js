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
  // Groq free tier rejects requests whose combined token budget exceeds ~4k;
  // cap output tokens at 3000 to ensure the request body stays under the limit.
  const effectiveMax = Math.min(maxTokens, 3000);
  const models = [CONFIG.llm.groq.model, CONFIG.llm.groq.fallbackModel].filter(Boolean);
  for (const model of models) {
    const body = {
      model,
      messages:[{ role:"system", content:"You are a sharp sports analytics AI. Return only valid JSON." }, { role:"user", content: prompt }],
      temperature:0.3, max_tokens: effectiveMax
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


// ─── Ollama (local) ──────────────────────────────────────────────────────────
// Runs on http://localhost:11434 by default — no API key, no rate limits.
// Requires Ollama installed: https://ollama.ai
// HTTPS note: if the app is served over HTTPS, browsers block mixed-content
// HTTP requests to localhost. Fix in Chrome: chrome://flags/#unsafely-treat-insecure-origin-as-secure
async function callOllama(prompt, baseUrl, modelsStr, maxTokens = 2048) {
  const url    = (baseUrl || CONFIG.llm.ollama.defaultUrl).replace(/\/$/, "");
  const models = (modelsStr || CONFIG.llm.ollama.defaultModels).split(",").map(m => m.trim()).filter(Boolean);
  for (const model of models) {
    try {
      const r = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role:"system", content:"You are a sharp sports analytics AI. Return only valid JSON." },
            { role:"user",   content: prompt }
          ],
          stream: false,
          options: { temperature: 0.3, num_predict: maxTokens }
        })
      });
      if (!r.ok) throw new Error(`ollama_${r.status}`);
      const d = await r.json();
      const text = d.message?.content || "";
      if (text.trim()) return text;
    } catch (e) {
      console.warn(`Ollama model ${model} failed:`, e.message);
    }
  }
  throw new Error("ollama_all_models_failed");
}

// ─── Global LLM serializer ────────────────────────────────────────────────────
// Only ONE call is in-flight at a time. Each call waits for the previous to
// finish, then pauses _LLM_GAP ms before starting — keeping all providers well
// under their free-tier rate limits without any per-provider retry juggling.
const _LLM_GAP = 4000; // 4 s gap keeps us at ≤15 req/min — well under all free-tier limits // ms minimum between successive calls
let   _llmChain = Promise.resolve();

function callLLM(prompt, opts = {}) {
  // Chain onto the previous call so requests are always sequential + spaced
  const call = _llmChain.then(() => _callLLMDirect(prompt, opts));
  // Whether this call succeeds or fails, wait _LLM_GAP before the next one
  _llmChain = call
    .then(() => new Promise(r => setTimeout(r, _LLM_GAP)))
    .catch(() => new Promise(r => setTimeout(r, _LLM_GAP)));
  return call;
}

async function _callLLMDirect(prompt, { maxTokens = 2048 } = {}) {
  const geminiKey     = getUserKey("gemini");
  const groqKey       = getUserKey("groq");
  const openrouterKey = getUserKey("openrouter");
  // Ollama is tried FIRST when configured — local, no rate limits
  const ollamaUrl     = getUserKey("ollamaUrl") || CONFIG.llm.ollama.defaultUrl;
  const ollamaModels  = getUserKey("ollamaModels");
  const providers = [
    { name:"ollama",     fn:() => callOllama(prompt, ollamaUrl, ollamaModels, maxTokens),  available:!!ollamaModels },
    { name:"gemini",     fn:() => callGemini(prompt, geminiKey, maxTokens),                available:!!geminiKey },
    { name:"groq",       fn:() => callGroq(prompt, groqKey, maxTokens),                    available:!!groqKey },
    { name:"openrouter", fn:() => callOpenRouter(prompt, openrouterKey, maxTokens),        available:!!openrouterKey }
  ].filter(p => p.available);
  if (!providers.length) throw new Error("NO_KEYS");

  // Pass 1 — try every provider once
  for (const p of providers) {
    try {
      const text = await p.fn();
      if (text?.trim()) return { text, provider: p.name };
    } catch (e) {
      console.warn(`LLM ${p.name} failed:`, e.message);
      // Brief pause between providers so a 429 on one doesn't immediately
      // slam the next
      if (e.message.includes("429") || e.message.includes("rate")) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  // Pass 2 — all providers failed; cool down then try each once more
  console.warn("All LLM providers failed — cooling down 25 s then retrying…");
  await new Promise(r => setTimeout(r, 25000));

  for (const p of providers) {
    try {
      const text = await p.fn();
      if (text?.trim()) return { text, provider: p.name };
    } catch (e) {
      console.warn(`LLM ${p.name} retry failed:`, e.message);
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
// ─── Single combined batch prompt (games + props in ONE LLM call) ────────────
// Merging both into one call halves the total requests per sport load and
// prevents back-to-back calls that exhaust free-tier rate limits.
function buildCombinedBatchPrompt(gamesWithContext) {
  const isMMA = gamesWithContext[0]?.game?.sport === "mma";

  const gameBlocks = gamesWithContext.map((gc, i) => {
    const { game, recentFormHome, recentFormAway, props, playerStats } = gc;
    const odds  = game.odds;
    const promo = game.promotion ? ` (${game.promotion})` : "";

    // ── Odds line ──
    const oddsLine = odds
      ? `ML:${game.homeTeam.abbr} ${odds.moneyline?.home?.price ?? "N/A"}/` +
        `${game.awayTeam.abbr} ${odds.moneyline?.away?.price ?? "N/A"} | ` +
        `Spread:${odds.spread?.home?.point ?? "N/A"}(${odds.spread?.home?.price ?? "N/A"}) | ` +
        `O/U ${odds.total?.over?.point ?? "N/A"}(O${odds.total?.over?.price ?? "N/A"}/U${odds.total?.under?.price ?? "N/A"})`
      : "No live odds";

    // ── Season records ──
    const recH = game.homeTeam.record ? ` [${game.homeTeam.record}]` : "";
    const recA = game.awayTeam.record ? ` [${game.awayTeam.record}]` : "";

    // ── Recent form — explicit so LLM uses it instead of training data ──
    let formLine = "";
    if (!isMMA) {
      const fH   = recentFormHome?.slice(-5).map(g => g.result).join("") || "";
      const fA   = recentFormAway?.slice(-5).map(g => g.result).join("") || "";
      const wH   = (fH.match(/W/g) || []).length;
      const wA   = (fA.match(/W/g) || []).length;
      const descH = fH ? `${fH} (${wH}W-${5 - wH}L last 5)` : "N/A";
      const descA = fA ? `${fA} (${wA}W-${5 - wA}L last 5)` : "N/A";
      formLine = `\nCURRENT FORM — use this, ignore your training data: ` +
                 `${game.homeTeam.name}: ${descH} | ${game.awayTeam.name}: ${descA}`;
    }

    // ── Props (inline — top 8 per game to stay lean) ──
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
${oddsLine}${formLine}${propsLine}`;
  }).join("\n\n");

  const propNote = gamesWithContext.some(gc => gc.props?.length)
    ? "\n- props: include notable B+ player prop picks using the PROPS lines above (omit if no props data)"
    : "";

  return `Sharp sports betting analyst. Analyze ${gamesWithContext.length} games.
⚠ CRITICAL: Use ONLY the provided odds, records, and CURRENT FORM data. Do NOT rely on your training knowledge for recent team performance, win streaks, or player rosters — that data may be months old.

${gameBlocks}

Rules:
- Grades: S(conf≥8.5,edge≥7%) A(conf≥7,edge≥5%) B(conf≥5.5,edge≥3%)
- picks: all B+ spread/ML/total angles per game
- bestBet: one A or S pick; null+noValue:true if none${isMMA ? "\n- MMA: include method/round props" : ""}${propNote}
- summary: 2 sentences referencing the PROVIDED form/records data, not general team reputation

Return ONLY a JSON array, no markdown:
[{"gameId":"ID","summary":"...","picks":[{"id":"g0p1","type":"spread|moneyline|total","selection":"Full Team Name bet","odds":"+110","confidence":8.0,"edge":6.0,"grade":"A","reasoning":"1 sentence"}],"bestBet":{"id":"g0p1","type":"...","selection":"Full Team Name — exact bet","odds":"+110","confidence":8.0,"edge":6.0,"grade":"A","reasoning":"..."},"lean":"home|away|over|under|none","confidence":7.5,"noValue":false,"props":[{"id":"pr1","type":"prop","player":"Name","team":"ABR","market":"player_points","marketLabel":"Points","selection":"Name (ABR) Over 24.5 Points","odds":"-115","point":24.5,"direction":"over","confidence":7.0,"edge":5.0,"grade":"A","reasoning":"1 sentence"}]}]`;
}

// ─── Single combined export (replaces separate analyzeBatchGames + analyzeBatchProps) ──
export async function analyzeCombinedBatch(gamesWithContext) {
  if (!gamesWithContext.length) return [];
  // 6 games × ~450 tokens each = ~2700 output tokens — fits Groq's 3k cap + has headroom
  const maxTokens = Math.min(4000, Math.max(2048, gamesWithContext.length * 450));
  const prompt    = buildCombinedBatchPrompt(gamesWithContext);
  const { text, provider } = await callLLM(prompt, { maxTokens });

  const clean = text.replace(/```json|```/g, "").trim();
  let parsed  = null;
  try { parsed = JSON.parse(clean); } catch {}
  if (!Array.isArray(parsed)) {
    const m = clean.match(/\[[\s\S]*\]/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!Array.isArray(parsed)) {
    console.warn("Combined batch parse failed — raw:", clean.slice(0, 300));
    throw new Error("BATCH_PARSE_FAILED");
  }

  return parsed.map(result => {
    result.picks = (result.picks || []).filter(p => p.confidence >= 5.5 && p.edge >= 3.0).slice(0, 8);
    result.props = (result.props || []).filter(p => p.confidence >= 5.5 && p.edge >= 3.0);
    if (result.bestBet?.confidence < CONFIG.bestBet.minConfidence) { result.bestBet = null; result.noValue = true; }
    return { ...result, provider, analyzedAt: Date.now() };
  });
}

// Legacy exports kept for the sequential fallback path
export async function analyzeBatchGames(gamesWithContext) { return analyzeCombinedBatch(gamesWithContext); }
export async function analyzeBatchProps(_propsPerGame)     { return []; } // merged into combined call

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
export function hasKeys() { return !!(localStorage.getItem(KEYS.gemini) || localStorage.getItem(KEYS.groq) || localStorage.getItem(KEYS.openrouter) || localStorage.getItem(KEYS.ollamaModels)); }
