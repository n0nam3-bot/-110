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
  const effectiveMax = Math.min(maxTokens, 4000); // raised from 3000 — batch prompts need room
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
export let lastProvider = ""; // tracks which provider succeeded last call

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
      if (text?.trim()) { lastProvider = p.name; return { text, provider: p.name }; }
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
      if (text?.trim()) { lastProvider = p.name; return { text, provider: p.name }; }
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

  const hasProps  = gamesWithContext.some(gc => gc.props?.length);

  return `You are a sharp sports betting analyst. Analyze ALL ${gamesWithContext.length} game(s) below.

⚠ CRITICAL RULES — violating these makes the output useless:
1. Use ONLY the provided odds, records, and CURRENT FORM data. Ignore your training knowledge for team performance and rosters.
2. Every game MUST have ALL THREE base picks: Spread, Moneyline, AND Total (Over/Under).
3. SPREAD picks: ALWAYS write the exact point value — "Tampa Bay Rays -1.5" NOT "Tampa Bay Rays spread".
4. TOTAL picks: ALWAYS write the number — "Over 7.5" or "Under 7.5" NOT just "Over".
5. Include every B+ angle. Minimum 3 picks per game; target 5–7 including props when available.
6. Grade hierarchy (strictly follow): S=conf≥8.5,edge≥7% | A=conf≥7,edge≥5% | B=conf≥5.5,edge≥3%
7. bestBet MUST be your single highest-graded pick (S first, then A). If best grade is B, set bestBet=null and noValue=true.
8. Reasoning: 1 specific sentence referencing a concrete data point (mention actual record, exact odds line, or head-to-head context). No vague phrases like 'better record' or 'slight edge'.${hasProps ? "\n9. Props: rate every PROPS line listed — include all B+ prop picks." : ""}${isMMA ? "\n9. MMA: also grade method (KO/Sub/Dec) and round props." : ""}

${gameBlocks}

Return ONLY a valid JSON array — no markdown, no preamble, no trailing text:
[{"gameId":"ID","summary":"2 sentences — cite EXACT records (e.g. 34-16 vs 23-30) and specific odds; no generic phrases","picks":[{"id":"g0p1","type":"spread|moneyline|total","selection":"Full Team Name ±X.X or Over/Under X.X","odds":"+110","confidence":8.0,"edge":6.0,"grade":"A","reasoning":"1 specific sentence with data reference"}],"bestBet":{"id":"g0p1","type":"...","selection":"Full Team Name ±X.X — exact bet","odds":"+110","confidence":8.0,"edge":6.0,"grade":"A","reasoning":"1 specific sentence with data reference"},"lean":"home|away|over|under|none","confidence":7.5,"noValue":false,"props":[{"id":"pr1","type":"prop","player":"Full Name","team":"ABR","market":"player_points","marketLabel":"Points","selection":"Full Name (ABR) Over 24.5 Points","odds":"-115","point":24.5,"direction":"over","confidence":7.0,"edge":5.0,"grade":"A","reasoning":"1 specific sentence with data reference"}]}]`;
}

// ─── Single combined export (replaces separate analyzeBatchGames + analyzeBatchProps) ──
export async function analyzeCombinedBatch(gamesWithContext) {
  if (!gamesWithContext.length) return [];
  // 6 games × ~450 tokens each = ~2700 output tokens — fits Groq's 3k cap + has headroom
  // 650 tokens/game covers 5–7 picks + props per game without truncation
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
  if (!Array.isArray(parsed)) {
    console.warn("Combined batch parse failed — raw:", clean.slice(0, 300));
    throw new Error("BATCH_PARSE_FAILED");
  }

  // Grade sort order (lower number = higher priority)
  const GRADE = { S:0, A:1, B:2, C:3 };

  // Deduplicate picks: same selection + same odds = exact duplicate (prop in both picks[] and props[])
  function dedupe(picks) {
    const seen = new Set();
    return picks.filter(p => {
      const key = `${(p.selection||"").toLowerCase().trim()}|${p.odds}|${p.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Fix spread/total selections that are missing the point value
  function fixSelection(pick, gc) {
    if (!gc?.game?.odds || !pick?.selection) return pick;
    const odds = gc.game.odds;
    if (pick.type === "spread" && !/[+-]?\d+\.?\d/.test(pick.selection)) {
      const nameWords = pick.selection.toLowerCase().split(" ");
      const homeLast  = gc.game.homeTeam.name.toLowerCase().split(" ").pop();
      const isHome    = nameWords.some(w => w.startsWith(homeLast.slice(0, 4)));
      const sp        = isHome ? odds.spread?.home : odds.spread?.away;
      if (sp?.point !== undefined) {
        const sign = sp.point >= 0 ? "+" : "";
        pick.selection = `${pick.selection.trim()} ${sign}${sp.point}`;
      }
    }
    if (pick.type === "total" && !/\d+\.?\d/.test(pick.selection)) {
      const pt = odds.total?.over?.point;
      if (pt !== undefined) {
        const dir = /under/i.test(pick.selection) ? "Under" : "Over";
        pick.selection = `${dir} ${pt}`;
      }
    }
    return pick;
  }

  return parsed.map(result => {
    // Find matching game context for spread/total fixes
    const gc = gamesWithContext.find(g => String(g.game.id) === String(result.gameId));

    // Fix any missing point values before filtering
    (result.picks || []).forEach(p => fixSelection(p, gc));
    (result.props || []).forEach(p => fixSelection(p, gc));

    // Sanitize odds: LLM returns "NaN" / null / "" when no live lines available
    const cleanOdds = p => {
      if (!p.odds || p.odds === "NaN" || p.odds === "null") p.odds = "N/A";
      return p;
    };
    (result.picks || []).forEach(cleanOdds);
    (result.props || []).forEach(cleanOdds);

    // Adaptive threshold: relax when no live odds (LLM works from records/form only)
    const hasOdds   = gc?.game?.odds != null;
    const confFloor = hasOdds ? 5.0 : 4.5;
    const edgeFloor = hasOdds ? 2.5 : 2.0;
    const gamePicks = (result.picks || []).filter(p => (p.confidence ?? 0) >= confFloor && (p.edge ?? 0) >= edgeFloor);
    const propPicks = (result.props || []).filter(p => (p.confidence ?? 0) >= confFloor && (p.edge ?? 0) >= edgeFloor);

    // Merge, deduplicate, then sort S → A → B → C (then by confidence within same grade)
    const allSorted = dedupe([...gamePicks, ...propPicks]).sort(
      (a, b) => (GRADE[a.grade] ?? 9) - (GRADE[b.grade] ?? 9) || (b.confidence ?? 0) - (a.confidence ?? 0)
    );

    result.picks = allSorted.slice(0, 12); // top 12 deduplicated picks across game + props
    result.props = propPicks;              // keep props separately for compatibility

    // Force bestBet = highest-graded pick (must be S or A — never B)
    // This overrides whatever the LLM chose to guarantee grade accuracy
    const bestCandidate = allSorted.find(p => p.grade === "S" || p.grade === "A");
    result.bestBet = bestCandidate || null;
    if (!result.bestBet) { result.noValue = true; }

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
