import { analyzeGame, analyzeProps } from "./ai.js";
import { getESPNGames, getTeamStats, getTeamSchedule, getSleeperInjuries,
         getOdds, getPlayerProps, getNBAPlayerStats, mergeOddsIntoGames } from "./data.js";
import { getCachedPick, setCachedPick } from "./firebase.js";

function getUserKey(name) { return localStorage.getItem(KEYS[name]) || ""; }

// date: null = today, "YYYYMMDD" = specific date
export async function loadGamesForSport(sportKey, date = null) {
  const oddsKey = getUserKey("oddsApi");
  const [games, oddsData] = await Promise.all([
    getESPNGames(sportKey, date),
    getOdds(sportKey, oddsKey)   // no-ops if no key (saves requests)
  ]);
  return mergeOddsIntoGames(games, oddsData);
}

export async function getPicksForGame(game, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await getCachedPick(game.id);
    if (cached) return { ...cached, fromCache: true };
  }

  const sportKey = game.sport;
  const oddsKey  = getUserKey("oddsApi");
  const bdlKey   = getUserKey("balldontlie");

  // Only fetch team context for sports where we have team IDs
  const hasTeams = !!(game.homeTeam?.id && game.awayTeam?.id);

  const [injuryData, homeSchedule, awaySchedule, homeStats, awayStats] = await Promise.all([
    sportKey === "nfl" ? getSleeperInjuries().catch(() => ({})) : Promise.resolve({}),
    hasTeams ? getTeamSchedule(sportKey, game.homeTeam.id).catch(() => []) : Promise.resolve([]),
    hasTeams ? getTeamSchedule(sportKey, game.awayTeam.id).catch(() => []) : Promise.resolve([]),
    hasTeams ? getTeamStats(sportKey, game.homeTeam.id).catch(() => [])    : Promise.resolve([]),
    hasTeams ? getTeamStats(sportKey, game.awayTeam.id).catch(() => [])    : Promise.resolve([])
  ]);

  const gameAnalysis = await analyzeGame(game, {
    teamStatsHome: homeStats, teamStatsAway: awayStats,
    injuryData, recentFormHome: homeSchedule, recentFormAway: awaySchedule
  });

  // Props: only if Odds-API key AND game has a matched oddsId (saves requests)
  let propAnalysis = { props: [] };
  if (oddsKey && game.oddsId) {
    try {
      const rawProps = await getPlayerProps(sportKey, game.oddsId, oddsKey);
      let playerStats = {};
      if (sportKey === "nba" && rawProps.length) {
        const names = [...new Set(rawProps.map(p => p.player).filter(Boolean))].slice(0, 6);
        const res   = await Promise.allSettled(names.map(n => getNBAPlayerStats(n, bdlKey)));
        names.forEach((n, i) => { if (res[i].status === "fulfilled" && res[i].value) playerStats[n] = res[i].value; });
      }
      propAnalysis = await analyzeProps(game, rawProps, playerStats);
    } catch (e) { console.warn("Props:", e.message); }
  }

  const result = {
    gameId: game.id, game,
    gameAnalysis, propAnalysis,
    allPicks: [...(gameAnalysis.picks || []), ...(propAnalysis.props || [])],
    bestBet:  gameAnalysis.bestBet || null,
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
