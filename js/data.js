// ── Data fetching ──
const _memCache = {};
function memGet(k) { const e = _memCache[k]; return e && Date.now() < e.exp ? e.v : null; }
function memSet(k, v, ttl) { _memCache[k] = { v, exp: Date.now() + ttl }; }

async function fetchJSON(url, opts = {}) {
  try {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(r.status);
    return r.json();
  } catch (e) { console.warn("fetchJSON failed:", url, e.message); return null; }
}

// Shift a YYYYMMDD string by N days
function shiftDate(yyyymmdd, days) {
  const d = new Date(`${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10).replace(/-/g,"");
}

// ─── ESPN general ─────────────────────────────────────────────────────────────
function mapEvent(ev, sportKey, isMMA = false) {
  const comp   = ev.competitions?.[0];
  const status = ev.status?.type;
  const state  = status?.state;

  let homeTeam, awayTeam, promotion = null;

  if (isMMA) {
    const f0 = comp?.competitors?.[0];
    const f1 = comp?.competitors?.[1];
    // Detect promotion from league/season name
    const leagueName = (ev.season?.type?.name || ev.league?.name || ev.name || "").toUpperCase();
    if      (leagueName.includes("UFC"))      promotion = "UFC";
    else if (leagueName.includes("PFL"))      promotion = "PFL";
    else if (leagueName.includes("BELLATOR")) promotion = "Bellator";
    else if (leagueName.includes("ONE"))      promotion = "ONE Championship";
    else if (leagueName.includes("MVP"))      promotion = "MVP";
    else                                       promotion = "MMA";

    awayTeam = {
      id:     f0?.id,
      name:   f0?.athlete?.displayName || f0?.team?.displayName || "Fighter A",
      abbr:   f0?.athlete?.lastName    || f0?.athlete?.shortName || "A",
      logo:   f0?.athlete?.headshot?.href || f0?.team?.logo || null,
      record: f0?.records?.[0]?.summary || f0?.athlete?.record || ""
    };
    homeTeam = {
      id:     f1?.id,
      name:   f1?.athlete?.displayName || f1?.team?.displayName || "Fighter B",
      abbr:   f1?.athlete?.lastName    || f1?.athlete?.shortName || "B",
      logo:   f1?.athlete?.headshot?.href || f1?.team?.logo || null,
      record: f1?.records?.[0]?.summary || f1?.athlete?.record || ""
    };
  } else {
    const home = comp?.competitors?.find(c => c.homeAway === "home");
    const away = comp?.competitors?.find(c => c.homeAway === "away");
    homeTeam = { id: home?.id, name: home?.team?.displayName, abbr: home?.team?.abbreviation, logo: home?.team?.logo, score: home?.score, record: home?.records?.[0]?.summary };
    awayTeam = { id: away?.id, name: away?.team?.displayName, abbr: away?.team?.abbreviation, logo: away?.team?.logo, score: away?.score, record: away?.records?.[0]?.summary };
  }

  return {
    id: ev.id, sport: sportKey, name: ev.name, shortName: ev.shortName,
    date: ev.date, status: status?.name || "scheduled",
    completed: status?.completed || false,
    live: state === "in", pre: state === "pre",
    homeTeam, awayTeam, promotion,
    venue:     comp?.venue?.fullName,
    broadcast: comp?.broadcasts?.[0]?.names?.join(", "),
    eventName: ev.season?.slug || ev.name    // used to group MMA card fights
  };
}

// ─── MMA: fetch full card across a 3-day window to catch midnight fights ─────
async function getMMAGames(date) {
  const today = date || new Date().toISOString().slice(0,10).replace(/-/g,"");
  // Fetch yesterday, today, tomorrow to capture cards that span midnight
  const dates = [shiftDate(today,-1), today, shiftDate(today,1)];

  const allEvents = [];
  for (const d of dates) {
    const url  = `https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=${d}`;
    const data = await fetchJSON(url);
    if (data?.events?.length) {
      data.events.forEach(ev => allEvents.push(ev));
    }
  }

  if (!allEvents.length) return [];

  const fights = allEvents.map(ev => mapEvent(ev, "mma", true));
  const pregame = fights.filter(g => !g.completed && !g.live);

  // ── Group by event/card and keep only the card(s) that best match the selected date ──
  // Each UFC event has fights across multiple dates; find which event has most fights on our date
  const targetDate = today; // YYYYMMDD

  // Score each fight by how close its date is to the target
  const scored = pregame.map(g => {
    const fightDate = g.date ? g.date.slice(0,10).replace(/-/g,"") : "";
    const diff = Math.abs(parseInt(fightDate) - parseInt(targetDate));
    return { ...g, _dateDiff: diff };
  });

  // If any fights are exactly on the target date, keep all fights within ±1 day
  // (handles early prelims on night before + main card on event date)
  const hasExactMatch = scored.some(g => g._dateDiff === 0);
  const threshold = hasExactMatch ? 1 : 2;
  const filtered = scored.filter(g => g._dateDiff <= threshold);

  // Group by event name to ensure we show the full card
  const eventGroups = {};
  filtered.forEach(g => {
    const key = g.eventName || g.name;
    if (!eventGroups[key]) eventGroups[key] = [];
    eventGroups[key].push(g);
  });

  // Pick the largest group (the full card)
  let bestGroup = [];
  for (const group of Object.values(eventGroups)) {
    if (group.length > bestGroup.length) bestGroup = group;
  }

  // Deduplicate by fight id
  const seen = new Set();
  return bestGroup.filter(g => { if (seen.has(g.id)) return false; seen.add(g.id); return true; });
}

// ─── ESPN scoreboard (non-MMA) ────────────────────────────────────────────────
export async function getESPNGames(sportKey, date = null) {
  const s  = CONFIG.sports[sportKey];
  if (!s) return [];
  const ck = `espn_${sportKey}_${date || "today"}`;
  const cached = memGet(ck);
  if (cached) return cached;

  // MMA uses special multi-day fetch
  if (sportKey === "mma") {
    const result = await getMMAGames(date);
    memSet(ck, result, CONFIG.cache.espn);
    return result;
  }

  const url  = CONFIG.espn.scoreboard(s.espnSport, s.espnLeague, date);
  const data = await fetchJSON(url);
  if (!data?.events?.length) { memSet(ck, [], CONFIG.cache.espn); return []; }

  const games   = data.events.map(ev => mapEvent(ev, sportKey, false));
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
  const data   = await fetchJSON(CONFIG.espn.teamStats(s.espnSport, s.espnLeague, teamId));
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
  const search  = await fetchJSON(`${CONFIG.balldontlie.base}/players?search=${encodeURIComponent(playerName)}&per_page=1`, { headers });
  const player  = search?.data?.[0];
  if (!player) return null;
  const stats   = await fetchJSON(`${CONFIG.balldontlie.base}/season_averages?season=2024&player_ids[]=${player.id}`, { headers });
  const avg     = stats?.data?.[0];
  if (!avg) return null;
  const result  = { name:`${player.first_name} ${player.last_name}`, team:player.team?.abbreviation, pts:avg.pts, reb:avg.reb, ast:avg.ast, stl:avg.stl, blk:avg.blk, fg_pct:avg.fg_pct, fg3_pct:avg.fg3_pct, games:avg.games_played };
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
  const result = data.filter(g => new Date(g.commence_time) > new Date()).map(game => ({
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
        props.push({ bookmaker:bk.title, market:mkt.key, player:out.description, name:out.name, point:out.point, price:out.price });
      }
    }
  }
  memSet(ck, props, CONFIG.cache.odds);
  return props;
}

// ─── Merge odds ───────────────────────────────────────────────────────────────
export function mergeOddsIntoGames(games, oddsData) {
  return games.map(g => {
    const hName = (g.homeTeam.name || "").toLowerCase();
    const aName = (g.awayTeam.name || "").toLowerCase();
    const match = oddsData.find(o => {
      const oh = o.homeTeam.toLowerCase(), oa = o.awayTeam.toLowerCase();
      return oh.includes(hName.split(" ").pop() || "___") ||
             oa.includes(aName.split(" ").pop() || "___") ||
             oh.includes(g.homeTeam.abbr?.toLowerCase() || "___") ||
             oa.includes(g.awayTeam.abbr?.toLowerCase() || "___");
    });
    if (!match) return g;
    const allM   = match.bookmakers.flatMap(b => b.markets);
    const spread = allM.find(m => m.key === "spreads");
    const total  = allM.find(m => m.key === "totals");
    const h2h    = allM.find(m => m.key === "h2h");
    return {
      ...g, oddsId: match.id,
      odds: {
        spread:    spread ? { home: spread.outcomes?.find(o=>o.name===match.homeTeam), away: spread.outcomes?.find(o=>o.name===match.awayTeam) } : null,
        total:     total  ? { over: total.outcomes?.find(o=>o.name==="Over"),           under: total.outcomes?.find(o=>o.name==="Under") }           : null,
        moneyline: h2h    ? { home: h2h.outcomes?.find(o=>o.name===match.homeTeam),    away: h2h.outcomes?.find(o=>o.name===match.awayTeam) }        : null
      }
    };
  });
}
