const CONFIG = {
  firebase: {
    apiKey:            "FIREBASE_API_KEY",
    authDomain:        "FIREBASE_AUTH_DOMAIN",
    projectId:         "FIREBASE_PROJECT_ID",
    storageBucket:     "FIREBASE_STORAGE_BUCKET",
    messagingSenderId: "FIREBASE_MESSAGING_SENDER_ID",
    appId:             "FIREBASE_APP_ID"
  },
  app: {
    name: "-110", tagline: "Sharp picks. No noise.",
    baseUrl: "https://n0nam3-bot.github.io/-110", version: "1.0.0"
  },
  cache: {
    odds: 15*60*1000, picks: 30*60*1000,
    espn: 5*60*1000, injuries: 60*60*1000, stats: 30*60*1000
  },
  sports: {
    nba:   { label:"NBA",   emoji:"🏀", espnSport:"basketball", espnLeague:"nba",                    oddsKey:"basketball_nba",          props:["player_points","player_rebounds","player_assists","player_threes","player_blocks","player_steals","player_points_rebounds_assists"] },
    nfl:   { label:"NFL",   emoji:"🏈", espnSport:"football",   espnLeague:"nfl",                    oddsKey:"americanfootball_nfl",     props:["player_pass_tds","player_pass_yds","player_rush_yds","player_reception_yds","player_receptions","player_anytime_td"] },
    mlb:   { label:"MLB",   emoji:"⚾", espnSport:"baseball",   espnLeague:"mlb",                    oddsKey:"baseball_mlb",            props:["batter_home_runs","batter_hits","batter_rbis","pitcher_strikeouts","pitcher_outs"] },
    nhl:   { label:"NHL",   emoji:"🏒", espnSport:"hockey",     espnLeague:"nhl",                    oddsKey:"icehockey_nhl",           props:["player_goals","player_assists","player_shots_on_goal","player_points"] },
    ncaab: { label:"NCAAB", emoji:"🏀", espnSport:"basketball", espnLeague:"mens-college-basketball",oddsKey:"basketball_ncaab",        props:[] },
    ncaaf: { label:"NCAAF", emoji:"🏈", espnSport:"football",   espnLeague:"college-football",       oddsKey:"americanfootball_ncaaf",  props:[] },
    mls:   { label:"MLS",   emoji:"⚽", espnSport:"soccer",     espnLeague:"usa.1",                  oddsKey:"soccer_usa_mls",          props:["player_goal_scorer_anytime","player_shots_on_target"] }
  },
  espn: {
    scoreboard:   (s,l)    => `https://site.api.espn.com/apis/site/v2/sports/${s}/${l}/scoreboard`,
    teamStats:    (s,l,id) => `https://site.api.espn.com/apis/site/v2/sports/${s}/${l}/teams/${id}/statistics`,
    teamSchedule: (s,l,id) => `https://site.api.espn.com/apis/site/v2/sports/${s}/${l}/teams/${id}/schedule`
  },
  oddsApi:  { base:"https://api.the-odds-api.com/v4", regions:"us", markets:"h2h,spreads,totals", format:"american" },
  sleeper:  { players:"https://api.sleeper.app/v1/players/nfl" },
  balldontlie:{ base:"https://api.balldontlie.io/v1" },
  llm: {
    gemini:     { endpoint:(k)=>`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${k}`, model:"gemini-1.5-flash" },
    groq:       { endpoint:"https://api.groq.com/openai/v1/chat/completions", model:"llama-3.3-70b-versatile" },
    openrouter: { endpoint:"https://openrouter.ai/api/v1/chat/completions",   models:["google/gemma-2-9b-it:free","meta-llama/llama-3.1-8b-instruct:free","mistralai/mistral-7b-instruct:free"] }
  },
  grades: {
    S:{ minConfidence:8.5, minEdge:7.0, label:"S", color:"#b5f23d" },
    A:{ minConfidence:7.0, minEdge:5.0, label:"A", color:"#3dffc0" },
    B:{ minConfidence:5.5, minEdge:3.0, label:"B", color:"#ffd93d" },
    C:{ minConfidence:0,   minEdge:0,   label:"C", color:"#ff9f43" }
  },
  bestBet:{ minGrade:"A", maxPerGame:3, minConfidence:7.0, minEdge:5.0 }
};
const KEYS = {
  oddsApi:"_110_odds_api_key", gemini:"_110_gemini_key",
  groq:"_110_groq_key", openrouter:"_110_openrouter_key",
  balldontlie:"_110_balldontlie_key", sport:"_110_active_sport",
  theme:"_110_theme", savedPicks:"_110_saved_picks"
};
