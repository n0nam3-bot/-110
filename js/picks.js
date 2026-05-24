import { analyzeGame, analyzeProps, analyzeCombinedBatch } from "./ai.js";
import { getESPNGames, getTeamStats, getTeamSchedule, getSleeperInjuries,
         getOdds, getPlayerProps, getNBAPlayerStats, mergeOddsIntoGames } from "./data.js";
import { getCachedPick, setCachedPick } from "./firebase.js";

function getUserKey(name) { return localStorage.getItem(KEYS[name]) || ""; }

// ─── Game loader (shared by both batch and individual paths) ──────────────────
export async function loadGamesForSport(sportKey, date = null) {
  const oddsKey = getUserKey("oddsApi");
  const [games, oddsData] = await Promise.all([
    getESPNGames(sportKey, date),
    getOdds(sportKey, oddsKey)
  ]);
  return mergeOddsIntoGames(games, oddsData);
}

// ─── PRIMARY: Batch analysis (1 LLM call for all games) ──────────────────────
/**
 * Analyze a full sport card in a single LLM call.
 * onProgress(message, pct) is called at each phase (0.0 – 1.0).
 * Falls back to sequential analysis if the batch parse fails.
 */
export async function getPicksForSport(games, onProgress) {
  // Analyze up to 8 games per batch — 8×450≈3600 tokens, within Gemini/OpenRouter limits;
  // Groq gets the first call so is still within its 3k cap for 8-game prompts
  const upcoming = games.slice(0, 8);
  if (!upcoming.length) return [];

  try {
    return await _batchAnalyze(upcoming, onProgress);
  } catch (e) {
    console.warn("Batch analysis failed, falling back to sequential:", e.message);
    // The batch attempt may have exhausted provider rate limits; cool down
    // before retrying individually so the first sequential call has a clean slate.
    onProgress?.("Cooling down before sequential fallback…", 0.45);
    await new Promise(r => setTimeout(r, 8000));
    onProgress?.("Running sequential analysis…", 0.5);
    return await _sequentialAnalyze(upcoming, onProgress);
  }
}

// Exported for global batch queue — caller handles slicing
export async function getPicksForBatch(games, onProgress) { return _batchAnalyze(games, onProgress); }

async function _batchAnalyze(games, onProgress) {
  onProgress?.("Fetching schedules, stats & props…", 0.15);

  const oddsKey = getUserKey("oddsApi");
  const bdlKey  = getUserKey("balldontlie");

  // Fetch ALL context (team form + props) in parallel for every game at once
  const gamesWithContext = await Promise.all(games.map(async game => {
    const hasTeams = !!(game.homeTeam?.id && game.awayTeam?.id);

    const [injuryData, homeSchedule, awaySchedule, homeStats, awayStats, rawProps] = await Promise.all([
      game.sport === "nfl" ? getSleeperInjuries().catch(() => ({})) : Promise.resolve({}),
      hasTeams ? getTeamSchedule(game.sport, game.homeTeam.id).catch(() => []) : Promise.resolve([]),
      hasTeams ? getTeamSchedule(game.sport, game.awayTeam.id).catch(() => []) : Promise.resolve([]),
      hasTeams ? getTeamStats(game.sport, game.homeTeam.id).catch(() => [])    : Promise.resolve([]),
      hasTeams ? getTeamStats(game.sport, game.awayTeam.id).catch(() => [])    : Promise.resolve([]),
      // Fetch props alongside everything else — folded into the single LLM call
      (oddsKey && game.oddsId) ? getPlayerProps(game.sport, game.oddsId, oddsKey).catch(() => []) : Promise.resolve([]),
    ]);

    // NBA player stats for props context
    let playerStats = {};
    if (game.sport === "nba" && rawProps.length && bdlKey) {
      const names = [...new Set(rawProps.map(p => p.player).filter(Boolean))].slice(0, 6);
      const res   = await Promise.allSettled(names.map(n => getNBAPlayerStats(n, bdlKey)));
      names.forEach((n, i) => { if (res[i].status === "fulfilled" && res[i].value) playerStats[n] = res[i].value; });
    }

    return {
      game,
      teamStatsHome: homeStats, teamStatsAway: awayStats,
      injuryData,
      recentFormHome: homeSchedule, recentFormAway: awaySchedule,
      props: rawProps,       // passed inline to combined prompt
      playerStats,
    };
  }));

  onProgress?.(`Running AI analysis on all ${games.length} games + props…`, 0.45);

  // ONE combined LLM call — game picks AND props together
  const combinedResults = await analyzeCombinedBatch(gamesWithContext);

  // Map results back onto game objects
  const pickData = games.map(game => {
    const result = combinedResults.find(r => String(r.gameId) === String(game.id))
                   || { gameId: game.id, picks: [], props: [], bestBet: null, noValue: true };
    const gamePicks = (result.picks  || []);
    const propPicks = (result.props  || []);
    return {
      gameId:       game.id,
      game,
      gameAnalysis: result,
      propAnalysis: { props: propPicks },
      allPicks:     [...gamePicks, ...propPicks],
      bestBet:      result.bestBet || null,
      analyzedAt:   Date.now(),
    };
  });

  onProgress?.(`Analysis complete — ${games.length} games`, 1.0);
  return pickData;
}

// _collectProps removed — props are now fetched inline in _batchAnalyze

// ─── FALLBACK: Sequential analysis (old per-game approach) ───────────────────
async function _sequentialAnalyze(games, onProgress) {
  const pickData = [];
  for (let i = 0; i < games.length; i++) {
    onProgress?.(`Analyzing game ${i + 1} of ${games.length}…`, 0.5 + (i / games.length) * 0.45);
    try {
      const result = await getPicksForGame(games[i]);
      pickData.push(result);
    } catch (e) {
      console.warn(`Sequential fallback — game ${games[i].id}:`, e.message);
      pickData.push({ gameId: games[i].id, game: games[i], allPicks: [], bestBet: null, error: e.message });
    }
    // Small delay to avoid rate-limiting during fallback
    if (i < games.length - 1) await new Promise(r => setTimeout(r, 3000));
  }
  onProgress?.("Done!", 1.0);
  return pickData;
}

// ─── Individual game analysis (used by fallback & Firebase cache check) ───────
export async function getPicksForGame(game, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await getCachedPick(game.id);
    if (cached) return { ...cached, fromCache: true };
  }

  const oddsKey = getUserKey("oddsApi");
  const bdlKey  = getUserKey("balldontlie");
  const hasTeams = !!(game.homeTeam?.id && game.awayTeam?.id);

  const [injuryData, homeSchedule, awaySchedule, homeStats, awayStats] = await Promise.all([
    game.sport === "nfl" ? getSleeperInjuries().catch(() => ({})) : Promise.resolve({}),
    hasTeams ? getTeamSchedule(game.sport, game.homeTeam.id).catch(() => []) : Promise.resolve([]),
    hasTeams ? getTeamSchedule(game.sport, game.awayTeam.id).catch(() => []) : Promise.resolve([]),
    hasTeams ? getTeamStats(game.sport, game.homeTeam.id).catch(() => [])    : Promise.resolve([]),
    hasTeams ? getTeamStats(game.sport, game.awayTeam.id).catch(() => [])    : Promise.resolve([]),
  ]);

  const gameAnalysis = await analyzeGame(game, {
    teamStatsHome: homeStats, teamStatsAway: awayStats,
    injuryData, recentFormHome: homeSchedule, recentFormAway: awaySchedule
  });

  let propAnalysis = { props: [] };
  if (oddsKey && game.oddsId) {
    try {
      const rawProps = await getPlayerProps(game.sport, game.oddsId, oddsKey);
      let playerStats = {};
      if (game.sport === "nba" && rawProps.length) {
        const names = [...new Set(rawProps.map(p => p.player).filter(Boolean))].slice(0, 6);
        const res   = await Promise.allSettled(names.map(n => getNBAPlayerStats(n, bdlKey)));
        names.forEach((n, i) => { if (res[i].status === "fulfilled" && res[i].value) playerStats[n] = res[i].value; });
      }
      propAnalysis = await analyzeProps(game, rawProps, playerStats);
    } catch (e) { console.warn("Props:", e.message); }
  }

  const result = {
    gameId: game.id, game, gameAnalysis, propAnalysis,
    allPicks: [...(gameAnalysis.picks || []), ...(propAnalysis.props || [])],
    bestBet: gameAnalysis.bestBet || null,
    analyzedAt: Date.now()
  };

  await setCachedPick(game.id, result).catch(() => {});
  return result;
}

export function formatOdds(price) {
  if (!price && price !== 0) return "N/A";
  const n = Number(price);
  return n > 0 ? `+${n}` : `${n}`;
}

export function impliedProbability(americanOdds) {
  const o = Number(americanOdds);
  if (!o) return 0;
  return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
}
