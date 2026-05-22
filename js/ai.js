// ── AI engine: Gemini → Groq → OpenRouter rotation ──

let _orModelIdx = 0;

function getUserKey(name) {
  return localStorage.getItem(KEYS[name]) || "";
}

// ─── LLM callers ──────────────────────────────────────────────────────────────

async function callGemini(prompt, key) {
  if (!key) throw new Error("no_key");
  const url  = CONFIG.llm.gemini.endpoint(key);
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 2048 } };
  const r    = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`gemini_${r.status}`);
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callGroq(prompt, key) {
  if (!key) throw new Error("no_key");
  const body = {
    model: CONFIG.llm.groq.model,
    messages: [{ role:"system", content:"You are a sharp sports analytics AI. Return only valid JSON." }, { role:"user", content: prompt }],
    temperature: 0.3, max_tokens: 2048
  };
  const r = await fetch(CONFIG.llm.groq.endpoint, { method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${key}` }, body: JSON.stringify(body) });
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
    messages: [{ role:"system", content:"You are a sharp sports analytics AI. Return only valid JSON." }, { role:"user", content: prompt }],
    temperature: 0.3, max_tokens: 2048
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
    try { const text = await p.fn(); if (text?.trim()) return { text, provider: p.name }; }
    catch (e) { console.warn(`LLM ${p.name} failed:`, e.message); }
  }
  throw new Error("ALL_PROVIDERS_FAILED");
}

function parseJSON(text) {
  try { return JSON.parse(text.replace(/```json|```/g, "").trim()); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// ─── Game prompt ──────────────────────────────────────────────────────────────

function buildGamePrompt(game, teamStatsHome, teamStatsAway, injuryData, recentFormHome, recentFormAway) {
  const injuryStr = injuryData && Object.keys(injuryData).length
    ? Object.entries(injuryData).slice(0, 10).map(([n, d]) => `${n} (${d.team}): ${d.status}`).join("; ")
    : "No major injuries reported";

  const formH = recentFormHome?.map(g => `${g.result} vs ${g.opponent}`).join(", ") || "N/A";
  const formA = recentFormAway?.map(g => `${g.result} vs ${g.opponent}`).join(", ") || "N/A";
  const odds  = game.odds;
  const oddsStr = odds ? `
Moneyline: ${game.homeTeam.abbr} ${odds.moneyline?.home?.price || "N/A"} | ${game.awayTeam.abbr} ${odds.moneyline?.away?.price || "N/A"}
Spread: ${game.homeTeam.abbr} ${odds.spread?.home?.point || "N/A"} (${odds.spread?.home?.price || "N/A"}) | ${game.awayTeam.abbr} ${odds.spread?.away?.point || "N/A"}
Total: O/U ${odds.total?.over?.point || "N/A"} (Over ${odds.total?.over?.price || "N/A"} / Under ${odds.total?.under?.price || "N/A"})
` : "Odds: Not available";

  const isMMA = game.sport === "mma";

  return `
You are a sharp sports betting analyst. Analyze this ${isMMA ? "MMA/UFC fight" : "game"} and produce a JSON pick report.

${isMMA ? "FIGHT" : "GAME"}: ${game.awayTeam.name} vs ${game.homeTeam.name}
SPORT: ${game.sport?.toUpperCase()}
DATE: ${new Date(game.date).toLocaleDateString()}

ODDS:
${oddsStr}

${isMMA ? "" : `HOME TEAM RECENT FORM (last 10): ${formH}
AWAY TEAM RECENT FORM (last 10): ${formA}

INJURIES: ${injuryStr}`}

TASK:
1. Analyze ALL available bet types (spread, moneyline, total${isMMA ? ", method of victory, round betting" : ""})
2. Grade EVERY angle: S (confidence 8.5+, edge 7+), A (7+, 5+), B (5.5+, 3+), C (below B)
3. Include ALL grades B and above in the picks array — do not filter any out
4. Select the single best pick as "bestBet" — this MUST be grade A or S
5. If no pick reaches grade A/S, set bestBet to null and noValue to true

IMPORTANT: Always include the FULL player/team name in selection text so bettors know exactly who the pick is on.
For player props include: "[Full First Last] ([Team Abbr]) - [Prop]"
For game lines include the full team name, not just abbreviation.

Return ONLY this JSON (no markdown):
{
  "gameId": "${game.id}",
  "summary": "2-3 sentence sharp analysis",
  "picks": [
    {
      "id": "unique_string",
      "type": "spread|moneyline|total|prop",
      "selection": "Full team or player name with team — exact bet e.g. Oklahoma City Thunder -3.5 or Shai Gilgeous-Alexander (OKC) Over 31.5 Pts",
      "odds": "+110",
      "confidence": 8.2,
      "edge": 6.5,
      "grade": "S",
      "reasoning": "1-2 sentence reasoning"
    }
  ],
  "bestBet": {
    "id": "same id as pick above",
    "type": "spread|moneyline|total|prop",
    "selection": "Full name — exact bet text",
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
You are a sharp sports prop betting analyst. Analyze these player props for ${game.awayTeam.name} vs ${game.homeTeam.name}.

AVAILABLE PROPS:
${propStr}

Grade every prop: S (8.5+ conf, 7%+ edge), A (7+, 5+), B (5.5+, 3+), C (below B).
Include ALL props graded B or above. Always use the player's full name and team abbreviation in selection.

Return ONLY this JSON:
{
  "props": [
    {
      "id": "unique_string",
      "type": "prop",
      "player": "Full Player Name",
      "team": "TEAM_ABBR",
      "market": "player_points",
      "marketLabel": "Points",
      "selection": "Full Player Name (TEAM) Over 24.5 Points",
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

// ─── Exports ──────────────────────────────────────────────────────────────────

export async function analyzeGame(game, context = {}) {
  const { teamStatsHome, teamStatsAway, injuryData, recentFormHome, recentFormAway } = context;
  const prompt = buildGamePrompt(game, teamStatsHome, teamStatsAway, injuryData, recentFormHome, recentFormAway);
  const { text, provider } = await callLLM(prompt);
  const parsed = parseJSON(text);
  if (!parsed) throw new Error("PARSE_FAILED");

  // Keep ALL picks grade B+; cap total at 6 to avoid runaway responses
  parsed.picks = (parsed.picks || []).filter(p => p.confidence >= 5.5 && p.edge >= 3.0).slice(0, 6);

  // bestBet must still be A or S
  if (parsed.bestBet && parsed.bestBet.confidence < CONFIG.bestBet.minConfidence) {
    parsed.bestBet = null;
    parsed.noValue = true;
  }

  return { ...parsed, provider, analyzedAt: Date.now() };
}

export async function analyzeProps(game, props, playerStats = {}) {
  if (!props || !props.length) return { props: [] };
  const prompt = buildPropPrompt(game, props, playerStats);
  const { text, provider } = await callLLM(prompt);
  const parsed = parseJSON(text);
  if (!parsed) return { props: [] };
  // Keep B+ props
  parsed.props = (parsed.props || []).filter(p => p.confidence >= 5.5 && p.edge >= 3.0);
  return { ...parsed, provider };
}

export function gradeColor(grade) {
  return CONFIG.grades[grade]?.color || "#aaa";
}

export function hasKeys() {
  return !!(localStorage.getItem(KEYS.gemini) || localStorage.getItem(KEYS.groq) || localStorage.getItem(KEYS.openrouter));
}
