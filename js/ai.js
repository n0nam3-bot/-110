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
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function parseRecordPct(record) {
  if (!record) return null;
  const m = String(record).match(/(\d+)\s*-\s*(\d+)(?:\s*-\s*(\d+))?/);
  if (!m) return null;
  const wins = safeNum(m[1]);
  const losses = safeNum(m[2]);
  const pushes = safeNum(m[3]);
  const games = wins + losses + pushes;
  return games ? (wins + 0.5 * pushes) / games : null;
}
function recentAvgScore(schedule) {
  const vals = (schedule || []).map(g => safeNum(g.score, NaN)).filter(n => Number.isFinite(n));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function gradeFrom(confidence, edge) {
  if (confidence >= 8.5 && edge >= 7.0) return 'S';
  if (confidence >= 7.0 && edge >= 5.0) return 'A';
  if (confidence >= 5.5 && edge >= 3.0) return 'B';
  return 'C';
}
function pickId(gameId, suffix) {
  return `${String(gameId)}_${suffix}`;
}
function moneylineSelection(teamName, price) {
  return `${teamName} ${price > 0 ? `+${price}` : price}`;
}
function spreadSelection(teamName, point) {
  const p = safeNum(point, 0);
  const sign = p > 0 ? '+' : '';
  return `${teamName} ${sign}${p}`;
}
function totalSelection(direction, point) {
  return `${direction} ${point}`;
}
function buildFreeGameAnalysis(game, context = {}) {
  const { recentFormHome, recentFormAway, props, playerStats } = context;
  const odds = game?.odds || null;
  const gameId = game?.id ?? `${game?.sport || 'game'}_${Date.now()}`;
  if (!odds?.moneyline && !odds?.spread && !odds?.total) {
    return {
      gameId,
      summary: 'No live odds available for this game.',
      picks: [],
      props: [],
      bestBet: null,
      lean: 'none',
      confidence: 0,
      noValue: true,
      provider: 'free',
      analyzedAt: Date.now()
    };
  }
  const homePrice = safeNum(odds.moneyline?.home?.price, 0);
  const awayPrice = safeNum(odds.moneyline?.away?.price, 0);
  const homeImp   = homePrice ? impliedProbability(homePrice) : 0;
  const awayImp   = awayPrice ? impliedProbability(awayPrice) : 0;
  const homeRec = parseRecordPct(game?.homeTeam?.record);
  const awayRec = parseRecordPct(game?.awayTeam?.record);
  const homeRecent = recentAvgScore(recentFormHome);
  const awayRecent = recentAvgScore(recentFormAway);
  const homeValue = (homeRec ?? homeImp) - homeImp + (((homeRecent ?? 0) - (awayRecent ?? 0)) / 100);
  const awayValue = (awayRec ?? awayImp) - awayImp + (((awayRecent ?? 0) - (homeRecent ?? 0)) / 100);
  const mlSide = homeValue === awayValue ? (homeImp >= awayImp ? 'home' : 'away') : (homeValue >= awayValue ? 'home' : 'away');
  const mlTeam = mlSide === 'home' ? game.homeTeam : game.awayTeam;
  const mlPrice = mlSide === 'home' ? homePrice : awayPrice;
  const mlOppRec = mlSide === 'home' ? awayRec : homeRec;
  const mlRec = mlSide === 'home' ? homeRec : awayRec;
  const mlValue = Math.abs(homeValue - awayValue);
  const mlConfidence = clamp(5.6 + mlValue * 18 + Math.abs((homeRecent ?? 0) - (awayRecent ?? 0)) / 25, 5.6, 8.4);
  const mlEdge = clamp(3.0 + mlValue * 18, 3.0, 7.4);
  const picks = [];
  picks.push({
    id: pickId(gameId, 'ml'),
    type: 'moneyline',
    selection: moneylineSelection(mlTeam.name, mlPrice),
    odds: mlPrice > 0 ? `+${mlPrice}` : `${mlPrice}`,
    confidence: Number(mlConfidence.toFixed(1)),
    edge: Number(mlEdge.toFixed(1)),
    grade: gradeFrom(mlConfidence, mlEdge),
    reasoning: `${mlTeam.name} is priced at ${mlPrice > 0 ? `+${mlPrice}` : mlPrice} and the model is using the current record/form data ${mlRec != null ? `(${(mlRec * 100).toFixed(1)}% win rate)` : ''} versus the opponent ${mlOppRec != null ? `(${(mlOppRec * 100).toFixed(1)}% win rate)` : ''}.`
  });
  const spreadHome = odds.spread?.home;
  const spreadAway = odds.spread?.away;
  const spreadSide = mlSide === 'home' ? spreadHome : spreadAway;
  const spreadTeam = mlSide === 'home' ? game.homeTeam : game.awayTeam;
  if (spreadSide?.point !== undefined) {
    const spreadGap = Math.abs(safeNum(spreadSide.point, 0));
    const spreadConfidence = clamp(mlConfidence - 0.3 + spreadGap * 0.2, 5.4, 8.0);
    const spreadEdge = clamp(mlEdge - 0.4 + spreadGap * 0.15, 3.0, 7.0);
    picks.push({
      id: pickId(gameId, 'sp'),
      type: 'spread',
      selection: spreadSelection(spreadTeam.name, safeNum(spreadSide.point, 0)),
      odds: `${safeNum(spreadSide.price, 0) > 0 ? '+' : ''}${safeNum(spreadSide.price, 0)}`,
      confidence: Number(spreadConfidence.toFixed(1)),
      edge: Number(spreadEdge.toFixed(1)),
      grade: gradeFrom(spreadConfidence, spreadEdge),
      reasoning: `${spreadTeam.name} is the side aligned with the moneyline value and the spread is only ${safeNum(spreadSide.point, 0)} at ${safeNum(spreadSide.price, 0) > 0 ? `+${safeNum(spreadSide.price, 0)}` : safeNum(spreadSide.price, 0)}.`
    });
  }
  const totalPoint = safeNum(odds.total?.over?.point, NaN);
  if (Number.isFinite(totalPoint)) {
    const totalBase = ((homeRecent ?? homeRec ?? 0) + (awayRecent ?? awayRec ?? 0)) / 2;
    const direction = totalBase <= totalPoint / 2 ? 'Under' : 'Over';
    const totalPrice = direction === 'Under' ? safeNum(odds.total?.under?.price, 0) : safeNum(odds.total?.over?.price, 0);
    const totalConfidence = clamp(5.4 + Math.abs(totalBase - totalPoint / 2) * 0.35, 5.4, 7.8);
    const totalEdge = clamp(3.0 + Math.abs(totalBase - totalPoint / 2) * 0.5, 3.0, 6.8);
    picks.push({
      id: pickId(gameId, 'tot'),
      type: 'total',
      selection: totalSelection(direction, totalPoint),
      odds: `${totalPrice > 0 ? '+' : ''}${totalPrice}`,
      confidence: Number(totalConfidence.toFixed(1)),
      edge: Number(totalEdge.toFixed(1)),
      grade: gradeFrom(totalConfidence, totalEdge),
      reasoning: `The total is ${totalPoint}, and the recent scoring context points ${direction.toLowerCase()} based on the teams' latest score outputs.`
    });
  }
  const propPicks = [];
  if (Array.isArray(props) && props.length) {
    const seenPlayers = new Set();
    for (const p of props) {
      if (!p?.player || seenPlayers.has(p.player)) continue;
      seenPlayers.add(p.player);
      const stat = playerStats?.[p.player];
      if (!stat) continue;
      const market = String(p.market || '').toLowerCase();
      const point = safeNum(p.point, NaN);
      if (!Number.isFinite(point)) continue;
      let avg = null;
      if (market.includes('points')) avg = safeNum(stat.pts, NaN);
      else if (market.includes('rebounds')) avg = safeNum(stat.reb, NaN);
      else if (market.includes('assists')) avg = safeNum(stat.ast, NaN);
      else if (market.includes('blocks')) avg = safeNum(stat.blk, NaN);
      else if (market.includes('steals')) avg = safeNum(stat.stl, NaN);
      if (!Number.isFinite(avg)) continue;
      const direction = avg >= point ? 'Over' : 'Under';
      const gap = Math.abs(avg - point);
      if (gap < point * 0.08) continue;
      const conf = clamp(5.5 + gap * 0.55, 5.5, 7.5);
      const edge = clamp(3.0 + gap * 0.65, 3.0, 6.5);
      propPicks.push({
        id: pickId(gameId, `prop_${p.player.replace(/\s+/g, '_').slice(0, 18)}`),
        type: 'prop',
        player: p.player,
        team: p.team,
        market: p.market,
        marketLabel: p.marketLabel || p.market,
        selection: `${p.player}${p.team ? ` (${p.team})` : ''} ${direction} ${point} ${p.marketLabel || ''}`.trim(),
        odds: `${safeNum(p.price, 0) > 0 ? '+' : ''}${safeNum(p.price, 0)}`,
        point,
        direction: direction.toLowerCase(),
        confidence: Number(conf.toFixed(1)),
        edge: Number(edge.toFixed(1)),
        grade: gradeFrom(conf, edge),
        reasoning: `The player average ${avg.toFixed(1)} in the matching stat category versus a line of ${point}.`
      });
      if (propPicks.length >= 2) break;
    }
  }
  const allSorted = [...picks, ...propPicks].sort((a, b) => {
    const G = { S: 0, A: 1, B: 2, C: 3 };
    return (G[a.grade] ?? 9) - (G[b.grade] ?? 9) || (b.confidence ?? 0) - (a.confidence ?? 0);
  });
  const bestBet = allSorted.find(p => p.grade === 'S' || p.grade === 'A') || null;
  return {
    gameId,
    summary: `${game?.awayTeam?.name || 'Away'} @ ${game?.homeTeam?.name || 'Home'} using live odds and recent form only.`,
    picks: allSorted.slice(0, 6),
    props: propPicks,
    bestBet,
    lean: mlSide === 'home' ? 'home' : 'away',
    confidence: Number(mlConfidence.toFixed(1)),
    noValue: !bestBet && !allSorted.length,
    provider: 'free',
    analyzedAt: Date.now()
  };
}
function buildFreeBatchResults(gamesWithContext) {
  return (gamesWithContext || []).map(gc => buildFreeGameAnalysis(gc.game, gc));
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
  const fallbackAll = buildFreeBatchResults(gamesWithContext);

  // Free-safe default: batch analysis returns deterministic, source-based picks
  // so the UI never stalls on API quotas, partial JSON, or overlong prompts.
  // Individual game analysis still retains the optional LLM path elsewhere.
  lastProvider = "free";
  return fallbackAll;
  /*
  // Optional remote batch path retained for future local-only experiments.
  // const maxTokens = Math.min(5000, Math.max(2500, gamesWithContext.length * 650));
  // const prompt    = buildCombinedBatchPrompt(gamesWithContext);
  try {
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
        const key = `${(p.selection||"").toLowerCase().trim()}|${p.odds}|${p.type}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
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
    const merged = parsed.map(result => {
      const gc = gamesWithContext.find(g => String(g.game.id) === String(result.gameId));
      if (!gc) return result;
      (result.picks || []).forEach(p => fixSelection(p, gc));
      (result.props || []).forEach(p => fixSelection(p, gc));
      const gamePicks = (result.picks || []).filter(p => (p.confidence ?? 0) >= 5.0 && (p.edge ?? 0) >= 2.5);
      const propPicks = (result.props || []).filter(p => (p.confidence ?? 0) >= 5.0 && (p.edge ?? 0) >= 2.5);
      const allSorted = dedupe([...gamePicks, ...propPicks]).sort(
        (a, b) => (GRADE[a.grade] ?? 9) - (GRADE[b.grade] ?? 9) || (b.confidence ?? 0) - (a.confidence ?? 0)
      );
      const bestCandidate = allSorted.find(p => p.grade === "S" || p.grade === "A") || null;
      return {
        ...result,
        picks: allSorted.slice(0, 12),
        props: propPicks,
        bestBet: bestCandidate,
        noValue: !bestCandidate && !allSorted.length,
        provider,
        analyzedAt: Date.now()
      };
    });
    const byId = new Map(merged.map(r => [String(r.gameId), r]));
    return gamesWithContext.map(gc => byId.get(String(gc.game.id)) || fallbackAll.find(r => String(r.gameId) === String(gc.game.id)));
  } catch (e) {
    console.warn("Combined batch failed; using free fallback:", e.message);
    return fallbackAll;
  }
  */
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
  try {
    const prompt = buildGamePrompt(game, teamStatsHome, teamStatsAway, injuryData, recentFormHome, recentFormAway);
    const { text, provider } = await callLLM(prompt);
    const parsed = parseJSON(text);
    if (!parsed) throw new Error("PARSE_FAILED");
    parsed.picks = (parsed.picks || []).filter(p => p.confidence >= 5.5 && p.edge >= 3.0).slice(0, 6);
    if (parsed.bestBet?.confidence < CONFIG.bestBet.minConfidence) { parsed.bestBet = null; parsed.noValue = true; }
    return { ...parsed, provider, analyzedAt: Date.now() };
  } catch (e) {
    return buildFreeGameAnalysis(game, context);
  }
}
export async function analyzeProps(game, props, playerStats = {}) {
  if (!props?.length) return { props: [] };
  try {
    const grouped = props.reduce((acc, p) => { (acc[p.player] = acc[p.player] || []).push(p); return acc; }, {});
    const propStr = Object.entries(grouped).slice(0, 20).map(([player, lines]) => {
      const stat = playerStats?.[player];
      const avg  = stat ? ` (avg:${stat.pts ? `${stat.pts}pts ` : ""}${stat.reb ? `${stat.reb}reb ` : ""}${stat.ast ? `${stat.ast}ast` : ""})` : "";
      return `${player}${avg}: ${lines[0].market} ${lines[0].point} (${lines[0].price})`;
    }).join("\n");
    const prompt = `Grade player props for ${game.awayTeam.name} @ ${game.homeTeam.name}. Return ONLY JSON.
${propStr}
{"props":[{"id":"p1","type":"prop","player":"Full Name","team":"ABR","market":"player_points","marketLabel":"Points","selection":"Full Name (ABR) Over 24.5 Points","odds":"-115","point":24.5,"direction":"over","confidence":8.0,"edge":6.0,"grade":"A","reasoning":"..."}]}`;
    const { text } = await callLLM(prompt);
    const parsed   = parseJSON(text);
    if (!parsed) return { props: [] };
    parsed.props = (parsed.props || []).filter(p => p.confidence >= 5.5 && p.edge >= 3.0);
    return parsed;
  } catch {
    const free = buildFreeGameAnalysis(game, { props, playerStats });
    return { props: free.props || [] };
  }
}
export function gradeColor(grade) { return CONFIG.grades[grade]?.color || "#aaa"; }
export function hasKeys() { return !!(localStorage.getItem(KEYS.gemini) || localStorage.getItem(KEYS.groq) || localStorage.getItem(KEYS.openrouter) || localStorage.getItem(KEYS.ollamaModels)); }