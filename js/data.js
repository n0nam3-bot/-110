// ── Data fetching: ESPN, Sleeper, Balldontlie, Odds-API ──

const _memCache = {};
function memGet(k) { const e = _memCache[k]; return e && Date.now() < e.exp ? e.v : null; }
function memSet(k, v, ttl) { _memCache[k] = { v, exp: Date.now() + ttl }; }
// Clear all ESPN/odds entries so the next fetch hits the network
export function clearDataCache() { Object.keys(_memCache).forEach(k => delete _memCache[k]); }

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

// ─── MMA Promotion helper ────────────────────────────────────────────────────
function extractMMAPromotion(name) {
  if (!name) return "MMA";
  const n = name.toLowerCase();
  if (n.includes("ufc"))                             return "UFC";
  if (n.includes("pfl"))                             return "PFL";
  if (n.includes("bellator"))                        return "Bellator";
  if (n.includes("one championship") || n.includes("one fc")) return "ONE";
  if (n.includes("rizin"))                           return "RIZIN";
  if (n.includes("bkfc"))                            return "BKFC";
  if (n.includes("glory"))                           return "Glory";
  if (n.includes("mvp"))                             return "MVP";
  return "MMA";
}

// ─── ESPN ────────────────────────────────────────────────────────────────────
export async function getESPNGames(sportKey, date = null) {
  const s  = CONFIG.sports[sportKey];
  if (!s) return [];
  const ck = `espn_${sportKey}_${date || "today"}`;
  const cached = memGet(ck);
  if (cached) return cached;

  let data = null;

  if (sportKey === "mma") {
    const base = `https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard`;
    const url  = date ? `${base}?dates=${date}` : base;
    data = await fetchJSON(url);

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

  const games = [];

  for (const ev of data.events) {
    const isMMA = sportKey === "mma";

    if (isMMA) {
      // ── Explode every competition (fight) in the event into its own entry ──
      const promotion = extractMMAPromotion(ev.name);
      const comps = ev.competitions || [];

      for (const comp of comps) {
        const fighterA = comp?.competitors?.[0];
        const fighterB = comp?.competitors?.[1];
        // Use competition-level status if present, fall back to event status
        const compStatus = comp?.status?.type;
        const evStatus   = ev.status?.type;
        const statusType = compStatus || evStatus;
        const state      = statusType?.state;

        games.push({
          id:        comp?.id || `${ev.id}_${games.length}`,
          sport:     sportKey,
          promotion,                      // "UFC", "PFL", etc.
          eventName: ev.name,             // Full card name e.g. "UFC 315: …"
          name:      comp?.name || ev.name,
          shortName: comp?.shortName || ev.shortName,
          date:      ev.date,             // Use parent event date so all fights share the same calendar day
          status:    statusType?.name || "Scheduled",
          completed: compStatus?.completed || evStatus?.completed || false,
          live:      state === "in",
          pre:       state === "pre",
          homeTeam: {
            id:     fighterB?.id,
            name:   fighterB?.athlete?.displayName || fighterB?.team?.displayName || "Fighter B",
            abbr:   fighterB?.athlete?.lastName    || "B",
            logo:   fighterB?.athlete?.headshot?.href || fighterB?.team?.logo,
            record: fighterB?.records?.[0]?.summary
          },
          awayTeam: {
            id:     fighterA?.id,
            name:   fighterA?.athlete?.displayName || fighterA?.team?.displayName || "Fighter A",
            abbr:   fighterA?.athlete?.lastName    || "A",
            logo:   fighterA?.athlete?.headshot?.href || fighterA?.team?.logo,
            record: fighterA?.records?.[0]?.summary
          },
          venue:     comp?.venue?.fullName || ev.competitions?.[0]?.venue?.fullName,
          broadcast: comp?.broadcasts?.[0]?.names?.join(", ") || ev.competitions?.[0]?.broadcasts?.[0]?.names?.join(", "),
        });
      }

    } else {
      // ── Standard team sports ──
      const comp   = ev.competitions?.[0];
      const home   = comp?.competitors?.find(c => c.homeAway === "home");
      const away   = comp?.competitors?.find(c => c.homeAway === "away");
      const status = ev.status?.type;
      const state  = status?.state;

      games.push({
        id:        ev.id,
        sport:     sportKey,
        name:      ev.name,
        shortName: ev.shortName,
        date:      ev.date,
        status:    status?.name || "scheduled",
        completed: status?.completed || false,
        live:      state === "in",
        pre:       state === "pre",
        homeTeam: {
          id: home?.id, name: home?.team?.displayName, abbr: home?.team?.abbreviation,
          logo: home?.team?.logo, score: home?.score, record: home?.records?.[0]?.summary
        },
        awayTeam: {
          id: away?.id, name: away?.team?.displayName, abbr: away?.team?.abbreviation,
          logo: away?.team?.logo, score: away?.score, record: away?.records?.[0]?.summary
        },
        venue:     comp?.venue?.fullName,
        broadcast: comp?.broadcasts?.[0]?.names?.join(", "),
      });
    }
  }

  // Pre-game only — live games skew odds against bettors
  let pregame = games.filter(g => !g.completed && !g.live);

  // ── Date validation — always runs, UTC-window based ──────────────────────
  // Problems with the old local-timezone approach:
  //   1. Skipped entirely when date=null (today), letting postponed games bleed in
  //   2. Local timezone varies per machine — a 9 PM ET game is 1 AM UTC (next day),
  //      so non-ET browsers saw it as tomorrow and dropped it
  //
  // Fix: use a 30-hour UTC window centred on the target date.
  //   Window start = midnight UTC of target date − 6 h  (catches early UTC offset)
  //   Window end   = midnight UTC of target date + 30 h (catches 9 PM ET = 1 AM UTC)
  //   Off-season games (weeks away) are always outside the window.
  //   Postponed games still carrying yesterday's original date fall before the window.
  {
    // Default to today when no explicit date was passed
    const raw = date || new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const y = parseInt(raw.slice(0, 4), 10);
    const m = parseInt(raw.slice(4, 6), 10) - 1;  // 0-indexed
    const d = parseInt(raw.slice(6, 8), 10);
    const midnightUTC = Date.UTC(y, m, d);
    const windowStart = midnightUTC - 6  * 3_600_000; // 6 h before
    const windowEnd   = midnightUTC + 30 * 3_600_000; // 30 h after

    pregame = pregame.filter(g => {
      if (!g.date) return false;
      const gMs = new Date(g.date).getTime();
      return gMs >= windowStart && gMs < windowEnd;
    });
  }

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
