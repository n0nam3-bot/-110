// ── Pick orchestrator: fetches data → runs AI → caches ──
import { analyzeGame, analyzeProps } from "./ai.js";
import { getESPNGames, getTeamStats, getTeamSchedule, getSleeperInjuries,
         getOdds, getPlayerProps, getNBAPlayerStats, mergeOddsIntoGames } from "./data.js";
import { getCachedPick, setCachedPick } from "./firebase.js";

function getUserKey(name) {
  return localStorage.getItem(KEYS[name]) || "";
}

export async function loadGamesForSport(sportKey) {
  const oddsKey = getUserKey("oddsApi");
  const [games, oddsData] = await Promise.all([
    getESPNGames(sportKey),
    getOdds(sportKey, oddsKey)
  ]);
  return mergeOddsIntoGames(games, oddsData);
}

export async function getPicksForGame(game, forceRefresh = false) {
  // Try Firestore cache first
  if (!forceRefresh) {
    const cached = await getCachedPick(game.id);
    if (cached) return { ...cached, fromCache: true };
  }

  const sportKey    = game.sport;
  const oddsKey     = getUserKey("oddsApi");
  const bdlKey      = getUserKey("balldontlie");

  // Parallel data fetch
  const [injuryData, homeSchedule, awaySchedule, homeStats, awayStats] = await Promise.all([
    getSleeperInjuries().catch(() => ({})),
    getTeamSchedule(sportKey, game.homeTeam.id).catch(() => []),
    getTeamSchedule(sportKey, game.awayTeam.id).catch(() => []),
    getTeamStats(sportKey, game.homeTeam.id).catch(() => []),
    getTeamStats(sportKey, game.awayTeam.id).catch(() => [])
  ]);

  // Game analysis
  const gameAnalysis = await analyzeGame(game, {
    teamStatsHome:   homeStats,
    teamStatsAway:   awayStats,
    injuryData,
    recentFormHome:  homeSchedule,
    recentFormAway:  awaySchedule
  });

  // Prop analysis (requires Odds-API key)
  let propAnalysis = { props: [] };
  if (oddsKey && game.oddsId) {
    try {
      const rawProps   = await getPlayerProps(sportKey, game.oddsId, oddsKey);
      // Fetch NBA player stats for context
      let playerStats = {};
      if (sportKey === "nba" && rawProps.length) {
        const playerNames = [...new Set(rawProps.map(p => p.player).filter(Boolean))].slice(0, 8);
        const statResults = await Promise.allSettled(
          playerNames.map(n => getNBAPlayerStats(n, bdlKey))
        );
        playerNames.forEach((n, i) => {
          if (statResults[i].status === "fulfilled" && statResults[i].value) {
            playerStats[n] = statResults[i].value;
          }
        });
      }
      propAnalysis = await analyzeProps(game, rawProps, playerStats);
    } catch (e) {
      console.warn("Props failed:", e.message);
    }
  }

  const result = {
    gameId:       game.id,
    game,
    gameAnalysis,
    propAnalysis,
    allPicks:     [...(gameAnalysis.picks || []), ...(propAnalysis.props || [])],
    bestBet:      gameAnalysis.bestBet || null,
    analyzedAt:   Date.now()
  };

  // Cache in Firestore
  await setCachedPick(game.id, result).catch(() => {});

  return result;
}

// Batch: analyze all games for a sport (respects cache)
export async function getAllPicksForSport(sportKey, onProgress) {
  const games  = await loadGamesForSport(sportKey);
  const active = games.filter(g => !g.completed).slice(0, 12);
  const results = [];

  for (let i = 0; i < active.length; i++) {
    const g = active[i];
    try {
      onProgress?.({ current: i + 1, total: active.length, game: g });
      const pick = await getPicksForGame(g);
      results.push(pick);
    } catch (e) {
      console.warn(`Pick failed for ${g.id}:`, e.message);
      results.push({ gameId: g.id, game: g, error: e.message, allPicks: [], bestBet: null });
    }
  }
  return results;
}

// Format odds for display
export function formatOdds(price) {
  if (!price && price !== 0) return "N/A";
  const n = Number(price);
  return n > 0 ? `+${n}` : `${n}`;
}

export function impliedProbability(americanOdds) {
  const o = Number(americanOdds);
  if (!o) return 0;
  if (o > 0) return 100 / (o + 100);
  return Math.abs(o) / (Math.abs(o) + 100);
}
