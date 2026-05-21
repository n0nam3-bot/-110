// ── AI engine: Gemini → Groq → OpenRouter rotation ──

let _orModelIdx = 0;

function getUserKey(name) {
  return localStorage.getItem(KEYS[name]) || "";
}

// ─── LLM callers ─────────────────────────────────────────────────────────────

async function callGemini(prompt, key) {
  if (!key) throw new Error("no_key");
  const url  = CONFIG.llm.gemini.endpoint(key);
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
  };
  const r    = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`gemini_${r.status}`);
  const d    = await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callGroq(prompt, key) {
  if (!key) throw new Error("no_key");
  const body = {
    model:    CONFIG.llm.groq.model,
    messages: [
      { role:"system", content:"You are a sharp sports analytics AI. Return only valid JSON." },
      { role:"user",   content: prompt }
    ],
    temperature: 0.3, max_tokens: 2048
  };
  const r = await fetch(CONFIG.llm.groq.endpoint, {
    method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:`Bearer ${key}` },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`groq_${r.status}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "";
}

async function callOpenRouter(prompt, key) {
  if (!key) throw new Error("no_key");
  const models = CONFIG.llm.openrouter.models;
  const model  = models[_orModelIdx % models.length];
  const body = {
    model,
    messages: [
      { role:"system", content:"You are a sharp sports analytics AI. Return only valid JSON." },
      { role:"user",   content: prompt }
    ],
    temperature: 0.3, max_tokens: 2048
  };
  const r = await fetch(CONFIG.llm.openrouter.endpoint, {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      Authorization:`Bearer ${key}`,
      "HTTP-Referer":"https://n0nam3-bot.github.io/-110",
      "X-Title":"-110 Sports"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    _orModelIdx++;
    throw new Error(`openrouter_${r.status}`);
  }
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "";
}

// ─── Rotation ─────────────────────────────────────────────────────────────────

async function callLLM(prompt) {
  const geminiKey     = getUserKey("gemini");
  const groqKey       = getUserKey("groq");
  const openrouterKey = getUserKey("openrouter");

  const providers = [
    { name:"gemini",     fn: () => callGemini(prompt, geminiKey),         available: !!geminiKey },
    { name:"groq",       fn: () => callGroq(prompt, groqKey),             available: !!groqKey },
    { name:"openrouter", fn: () => callOpenRouter(prompt, openrouterKey), available: !!openrouterKey }
  ].filter(p => p.available);

  if (!providers.length) throw new Error("NO_KEYS");

  for (const p of providers) {
    try {
      const text = await p.fn();
      if (text?.trim()) return { text, provider: p.name };
    } catch (e) {
      console.warn(`LLM ${p.name} failed:`, e.message);
    }
  }
  throw new Error("ALL_PROVIDERS_FAILED");
}

function parseJSON(text) {
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    // Try extracting first {...} block
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch {}
    }
    return null;
  }
}

// ─── Game analysis prompt ─────────────────────────────────────────────────────

function buildGamePrompt(game, teamStatsHome, teamStatsAway, injuryData, recentFormHome, recentFormAway) {
  const injuryStr = injuryData && Object.keys(injuryData).length
    ? Object.entries(injuryData).slice(0, 10).map(([n, d]) => `${n} (${d.team}): ${d.status}`).join("; ")
    : "No major injuries reported";

  const formH = recentFormHome?.map(g => `${g.result} vs ${g.opponent}`).join(", ") || "N/A";
  const formA = recentFormAway?.map(g => `${g.result} vs ${g.opponent}`).join(", ") || "N/A";

  const odds = game.odds;
  const oddsStr = odds ? `
Moneyline: ${game.homeTeam.abbr} ${odds.moneyline?.home?.price || "N/A"} | ${game.awayTeam.abbr} ${odds.moneyline?.away?.price || "N/A"}
Spread: ${game.homeTeam.abbr} ${odds.spread?.home?.point || "N/A"} (${odds.spread?.home?.price || "N/A"}) | ${game.awayTeam.abbr} ${odds.spread?.away?.point || "N/A"}
Total: O/U ${odds.total?.over?.point || "N/A"} (Over ${odds.total?.over?.price || "N/A"} / Under ${odds.total?.under?.price || "N/A"})
` : "Odds: Not available";

  return `
You are a sharp sports betting analyst. Analyze this game and produce a JSON pick report.

GAME: ${game.awayTeam.name} @ ${game.homeTeam.name}
SPORT: ${game.sport?.toUpperCase()}
DATE: ${new Date(game.date).toLocaleDateString()}

ODDS:
${oddsStr}

HOME TEAM RECENT FORM (last 10): ${formH}
AWAY TEAM RECENT FORM (last 10): ${formA}

INJURIES: ${injuryStr}

TASK:
1. Analyze the spread, moneyline, and total
2. Identify the best 1-3 picks ONLY if they qualify (confidence >= 7.0, edge >= 5.0)
3. Grade each: S (confidence 8.5+, edge 7+), A (7+, 5+), B (5.5+, 3+), C (below B)
4. Only include B or above. If nothing qualifies, return empty picks array
5. Pick the single "bestBet" from the qualifiers

Return ONLY this JSON (no markdown):
{
  "gameId": "${game.id}",
  "summary": "2-3 sentence sharp analysis of this matchup",
  "picks": [
    {
      "id": "unique_string",
      "type": "spread|moneyline|total",
      "selection": "exact bet text e.g. Chiefs -3.5",
      "odds": "+110 or -110",
      "confidence": 8.2,
      "edge": 6.5,
      "grade": "S",
      "reasoning": "1-2 sentence reasoning"
    }
  ],
  "bestBet": {
    "id": "same id as pick above",
    "type": "spread|moneyline|total",
    "selection": "exact bet text",
    "odds": "+110",
    "confidence": 8.2,
    "edge": 6.5,
    "grade": "S",
    "reasoning": "why this is the top pick"
  },
  "lean": "home|away|over|under|none",
  "confidence": 7.5,
  "noValue": false
}
`;
}

function buildPropPrompt(game, props, playerStats) {
  const propGroups = {};
  for (const p of props) {
    if (!propGroups[p.player]) propGroups[p.player] = [];
    propGroups[p.player].push(p);
  }

  const propStr = Object.entries(propGroups).slice(0, 20).map(([player, lines]) => {
    const line = lines[0];
    const stat = playerStats?.[player];
    const avg  = stat ? ` (season avg: ${stat.pts ? `${stat.pts}pts` : ""} ${stat.reb ? `${stat.reb}reb` : ""} ${stat.ast ? `${stat.ast}ast` : ""})` : "";
    return `${player}${avg}: ${line.market} ${line.point} (${line.price})`;
  }).join("\n");

  return `
You are a sharp sports prop betting analyst. Analyze these player props.

GAME: ${game.awayTeam.name} @ ${game.homeTeam.name}
SPORT: ${game.sport?.toUpperCase()}

AVAILABLE PROPS:
${propStr}

Identify the best 1-3 props with real edge. Only include if confidence >= 7.0 and edge >= 5.0.

Return ONLY this JSON:
{
  "props": [
    {
      "id": "unique_string",
      "type": "prop",
      "player": "Player Name",
      "market": "player_points",
      "marketLabel": "Points",
      "selection": "Over 24.5 Points",
      "odds": "-115",
      "point": 24.5,
      "direction": "over|under",
      "confidence": 8.0,
      "edge": 6.0,
      "grade": "A",
      "reasoning": "brief reasoning"
    }
  ]
}
`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function analyzeGame(game, context = {}) {
  const { teamStatsHome, teamStatsAway, injuryData, recentFormHome, recentFormAway } = context;
  const prompt = buildGamePrompt(game, teamStatsHome, teamStatsAway, injuryData, recentFormHome, recentFormAway);

  const { text, provider } = await callLLM(prompt);
  const parsed = parseJSON(text);
  if (!parsed) throw new Error("PARSE_FAILED");

  // Filter picks below threshold
  parsed.picks = (parsed.picks || []).filter(p =>
    p.confidence >= CONFIG.bestBet.minConfidence && p.edge >= CONFIG.bestBet.minEdge
  );

  // Cap at 3
  parsed.picks = parsed.picks.slice(0, CONFIG.bestBet.maxPerGame);

  return { ...parsed, provider, analyzedAt: Date.now() };
}

export async function analyzeProps(game, props, playerStats = {}) {
  if (!props || !props.length) return { props: [] };
  const prompt = buildPropPrompt(game, props, playerStats);
  const { text, provider } = await callLLM(prompt);
  const parsed = parseJSON(text);
  if (!parsed) return { props: [] };
  parsed.props = (parsed.props || []).filter(p =>
    p.confidence >= CONFIG.bestBet.minConfidence && p.edge >= CONFIG.bestBet.minEdge
  );
  return { ...parsed, provider };
}

export function gradeColor(grade) {
  return CONFIG.grades[grade]?.color || "#aaa";
}

export function hasKeys() {
  return !!(getUserKey("gemini") || getUserKey("groq") || getUserKey("openrouter"));
}
