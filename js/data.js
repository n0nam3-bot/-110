// ── Data fetching: ESPN, Sleeper, Balldontlie, Odds-API ──

const _memCache = {};
function memGet(k) { const e = _memCache[k]; return e && Date.now() < e.exp ? e.v : null; }
function memSet(k, v, ttl) { _memCache[k] = { v, exp: Date.now() + ttl }; }

async function fetchJSON(url, opts = {}) {
  try {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(r.status);
    return r.json();
  } catch (e) {
    console.warn("fetchJSON failed:", url, e.message);
    return null;
  }
}

// ─── ESPN ────────────────────────────────────────────────────────────────────
// MMA/UFC on ESPN uses a different scoreboard path — no league segment
// Standard:  /sports/{sport}/{league}/scoreboard
// MMA:       /sports/mma/scoreboard  (league = "ufc" is NOT a valid path segment)
// We also try the leagueSchedule endpoint as fallback for future UFC events

export async function getESPNGames(sportKey, date = null) {
  const s  = CONFIG.sports[sportKey];
  if (!s) return [];
  const ck = `espn_${sportKey}_${date || "today"}`;
  const cached = memGet(ck);
  if (cached) return cached;

  let data = null;

  if (sportKey === "mma") {
    // ESPN MMA scoreboard — no league in path, date filter applied differently
    const base = `https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard`;
    const url  = date ? `${base}?dates=${date}` : base;
    data = await fetchJSON(url);

    // If no events on scoreboard, try the schedule endpoint for upcoming cards
    if (!data?.events?.length) {
      const sched = await fetchJSON(
        `https://site.api.espn.com/apis/site/v2/sports/mma/ufc/schedule${date ? `?dates=${date}` : ""}`
      );
      if (sched?.events?.length) data = sched;
    }
  } else {
    const url = CONFIG.espn.scoreboard(s.espnSport, s.espnLeague, date);
    data = await fetchJSON(url);
  }

  if (!data?.events) return [];

  const games = data.events.map(ev => {
    const comp   = ev.competitions?.[0];
    const home   = comp?.competitors?.find(c => c.homeAway === "home");
    const away   = comp?.competitors?.find(c => c.homeAway === "away");
    const status = ev.status?.type;
    const state  = status?.state; // "pre" | "in" | "post"

    // MMA: fighters listed as competitors without homeAway distinction — treat first as "away" (challenger)
    const fighterA = comp?.competitors?.[0];
    const fighterB = comp?.competitors?.[1];

    const isMMA = sportKey === "mma";

    return {
      id:        ev.id,
      sport:     sportKey,
      name:      ev.name,
      shortName: ev.shortName,
      date:      ev.date,
      status:    status?.name || "scheduled",
      completed: status?.completed || false,
      live:      state === "in",
      pre:       state === "pre",
      homeTeam: isMMA ? {
        id:   fighterB?.id,
        name: fighterB?.athlete?.displayName || fighterB?.team?.displayName || "Fighter B",
        abbr: fighterB?.athlete?.lastName    || "B",
        logo: fighterB?.athlete?.headshot?.href || fighterB?.team?.logo,
        record: fighterB?.records?.[0]?.summary
      } : {
        id: home?.id, name: home?.team?.displayName, abbr: home?.team?.abbreviation,
        logo: home?.team?.logo, score: home?.score, record: home?.records?.[0]?.summary
      },
      awayTeam: isMMA ? {
        id:   fighterA?.id,
        name: fighterA?.athlete?.displayName || fighterA?.team?.displayName || "Fighter A",
        abbr: fighterA?.athlete?.lastName    || "A",
        logo: fighterA?.athlete?.headshot?.href || fighterA?.team?.logo,
        record: fighterA?.records?.[0]?.summary
      } : {
        id: away?.id, name: away?.team?.displayName, abbr: away?.team?.abbreviation,
        logo: away?.team?.logo, score: away?.score, record: away?.records?.[0]?.summary
      },
      venue:     comp?.venue?.fullName,
      broadcast: comp?.broadcasts?.[0]?.names?.join(", "),
    };
  });

  // Pre-game only — live games skew odds against bettors
  const pregame = games.filter(g => !g.completed && !g.live);
  memSet(ck, pregame, CONFIG.cache.espn);
  return pregame;
}

export async function getTeamStats(sportKey, teamId) {
  if (!teamId || sportKey === "mma") return [];
  const s  = CONFIG.sports[sportKey];
  const ck = `teamstats_${sportKey}_${teamId}`;
  const cached = memGet(ck);
  if (cached) return cached;
  const data = await fetchJSON(CONFIG.espn.teamStats(s.espnSport, s.espnLeague, teamId));
  const result = data?.results?.stats?.categories || [];
  memSet(ck, result, CONFIG.cache.stats);
  return result;
}

export async function getTeamSchedule(sportKey, teamId) {
  if (!teamId || sportKey === "mma") return [];
  const s  = CONFIG.sports[sportKey];
  const ck = `schedule_${sportKey}_${teamId}`;
  const cached = memGet(ck);
  if (cached) return cached;
  const data   = await fetchJSON(CONFIG.espn.teamSchedule(s.espnSport, s.espnLeague, teamId));
  const events = data?.events || [];
  const result = events.slice(-10).map(e => ({
    date:     e.date,
    opponent: e.competitions?.[0]?.competitors?.find(c => c.id !== teamId)?.team?.displayName,
    homeAway: e.competitions?.[0]?.competitors?.find(c => c.id === teamId)?.homeAway,
    result:   e.competitions?.[0]?.competitors?.find(c => c.id === teamId)?.winner ? "W" : "L",
    score:    e.competitions?.[0]?.competitors?.find(c => c.id === teamId)?.score
  }));
  memSet(ck, result, CONFIG.cache.stats);
  return result;
}

// ─── Sleeper ──────────────────────────────────────────────────────────────────
let _sleeperPlayers = null;
export async function getSleeperInjuries() {
  const ck = "sleeper_injuries";
  const cached = memGet(ck);
  if (cached) return cached;
  if (!_sleeperPlayers) _sleeperPlayers = await fetchJSON(CONFIG.sleeper.players);
  if (!_sleeperPlayers) return {};
  const injured = {};
  for (const [, p] of Object.entries(_sleeperPlayers)) {
    if (p.injury_status && p.injury_status !== "Active") {
      injured[p.full_name] = { status: p.injury_status, position: p.position, team: p.team };
    }
  }
  memSet(ck, injured, CONFIG.cache.injuries);
  return injured;
}

// ─── Balldontlie ──────────────────────────────────────────────────────────────
export async function getNBAPlayerStats(playerName, apiKey) {
  const ck = `bdl_${playerName}`;
  const cached = memGet(ck);
  if (cached) return cached;
  const headers = apiKey ? { Authorization: apiKey } : {};
  const search  = await fetchJSON(
    `${CONFIG.balldontlie.base}/players?search=${encodeURIComponent(playerName)}&per_page=1`,
    { headers }
  );
  const player = search?.data?.[0];
  if (!player) return null;
  const stats = await fetchJSON(
    `${CONFIG.balldontlie.base}/season_averages?season=2024&player_ids[]=${player.id}`,
    { headers }
  );
  const avg = stats?.data?.[0];
  if (!avg) return null;
  const result = {
    name: `${player.first_name} ${player.last_name}`, team: player.team?.abbreviation,
    pts: avg.pts, reb: avg.reb, ast: avg.ast, stl: avg.stl, blk: avg.blk,
    fg_pct: avg.fg_pct, fg3_pct: avg.fg3_pct, games: avg.games_played
  };
  memSet(ck, result, CONFIG.cache.stats);
  return result;
}

// ─── Odds-API ────────────────────────────────────────────────────────────────
export async function getOdds(sportKey, apiKey) {
  if (!apiKey) return [];
  const ck = `odds_${sportKey}`;
  const cached = memGet(ck);
  if (cached) return cached;
  const s   = CONFIG.sports[sportKey];
  const url = `${CONFIG.oddsApi.base}/sports/${s.oddsKey}/odds?apiKey=${apiKey}&regions=${CONFIG.oddsApi.regions}&markets=${CONFIG.oddsApi.markets}&oddsFormat=${CONFIG.oddsApi.format}`;
  const data = await fetchJSON(url);
  if (!data || !Array.isArray(data)) return [];
  const result = data
    .filter(g => new Date(g.commence_time) > new Date())
    .map(game => ({
      id: game.id, homeTeam: game.home_team, awayTeam: game.away_team,
      commence: game.commence_time,
      bookmakers: game.bookmakers?.map(bk => ({ name: bk.title, markets: bk.markets })) || []
    }));
  memSet(ck, result, CONFIG.cache.odds);
  return result;
}

export async function getPlayerProps(sportKey, eventId, apiKey) {
  if (!apiKey || !eventId) return [];
  const s        = CONFIG.sports[sportKey];
  const propList = s.props.join(",");
  if (!propList) return [];
  const ck = `props_${eventId}`;
  const cached = memGet(ck);
  if (cached) return cached;
  const url  = `${CONFIG.oddsApi.base}/sports/${s.oddsKey}/events/${eventId}/odds?apiKey=${apiKey}&regions=${CONFIG.oddsApi.regions}&markets=${propList}&oddsFormat=${CONFIG.oddsApi.format}`;
  const data = await fetchJSON(url);
  if (!data?.bookmakers) return [];
  const props = [];
  for (const bk of data.bookmakers) {
    for (const mkt of bk.markets) {
      for (const out of mkt.outcomes) {
        props.push({ bookmaker: bk.title, market: mkt.key, player: out.description, name: out.name, point: out.point, price: out.price });
      }
    }
  }
  memSet(ck, props, CONFIG.cache.odds);
  return props;
}

// ─── Merge odds into games ────────────────────────────────────────────────────
export function mergeOddsIntoGames(games, oddsData) {
  return games.map(g => {
    const homeName = (g.homeTeam.name || "").toLowerCase();
    const awayName = (g.awayTeam.name || "").toLowerCase();
    const match = oddsData.find(o => {
      const oh = o.homeTeam.toLowerCase();
      const oa = o.awayTeam.toLowerCase();
      return oh.includes(g.homeTeam.abbr?.toLowerCase() || "___") ||
             oh.includes(homeName.split(" ").pop() || "___") ||
             oa.includes(awayName.split(" ").pop() || "___") ||
             // MMA: match fighter last names
             oh.includes(homeName.split(" ").slice(-1)[0] || "___") ||
             oa.includes(awayName.split(" ").slice(-1)[0] || "___");
    });
    if (!match) return g;
    const allMarkets = match.bookmakers.flatMap(b => b.markets);
    const spread     = allMarkets.find(m => m.key === "spreads");
    const total      = allMarkets.find(m => m.key === "totals");
    const h2h        = allMarkets.find(m => m.key === "h2h");
    return {
      ...g, oddsId: match.id,
      odds: {
        spread:    spread ? { home: spread.outcomes?.find(o => o.name === match.homeTeam), away: spread.outcomes?.find(o => o.name === match.awayTeam) } : null,
        total:     total  ? { over: total.outcomes?.find(o => o.name === "Over"), under: total.outcomes?.find(o => o.name === "Under") } : null,
        moneyline: h2h    ? { home: h2h.outcomes?.find(o => o.name === match.homeTeam), away: h2h.outcomes?.find(o => o.name === match.awayTeam) } : null
      }
    };
  });
}
