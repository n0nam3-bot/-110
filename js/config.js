const CONFIG = {
  firebase: {
    apiKey: "AIzaSyA8oe82ST31XfyEJ3dqmNF5FthK_FEyT-8",
    authDomain: "project-4868291462124176670.firebaseapp.com",
    projectId: "project-4868291462124176670",
    storageBucket: "project-4868291462124176670.firebasestorage.app",
    messagingSenderId: "828639177624",
    appId: "1:828639177624:web:cff22a16ad5ea85608d9ed",
    measurementId: "G-LY4FSHLL3W"
  },
  app: {
    name: "-110", tagline: "Sharp picks. No noise.",
    baseUrl: "https://n0nam3-bot.github.io/-110", version: "1.2.0"
  },
  cache: {
    odds: 15*60*1000, picks: 30*60*1000,
    espn: 5*60*1000, injuries: 60*60*1000, stats: 30*60*1000
  },
  sports: {
    nba:   { label:"NBA",   emoji:"🏀", espnSport:"basketball", espnLeague:"nba",                    oddsKey:"basketball_nba",              props:["player_points","player_rebounds","player_assists","player_threes","player_blocks","player_steals","player_points_rebounds_assists"] },
    nfl:   { label:"NFL",   emoji:"🏈", espnSport:"football",   espnLeague:"nfl",                    oddsKey:"americanfootball_nfl",         props:["player_pass_tds","player_pass_yds","player_rush_yds","player_reception_yds","player_receptions","player_anytime_td"] },
    mlb:   { label:"MLB",   emoji:"⚾", espnSport:"baseball",   espnLeague:"mlb",                    oddsKey:"baseball_mlb",                props:["batter_home_runs","batter_hits","batter_rbis","pitcher_strikeouts","pitcher_outs"] },
    nhl:   { label:"NHL",   emoji:"🏒", espnSport:"hockey",     espnLeague:"nhl",                    oddsKey:"icehockey_nhl",               props:["player_goals","player_assists","player_shots_on_goal","player_points"] },
    mma:   { label:"MMA",   emoji:"🥊", espnSport:"mma",        espnLeague:"ufc",                    oddsKey:"mma_mixed_martial_arts",       props:["fighter_method_of_victory","fighter_win_in_round"] },
    ncaab: { label:"NCAAB", emoji:"🏀", espnSport:"basketball", espnLeague:"mens-college-basketball",oddsKey:"basketball_ncaab",            props:[] },
    ncaaf: { label:"NCAAF", emoji:"🏈", espnSport:"football",   espnLeague:"college-football",       oddsKey:"americanfootball_ncaaf",      props:[] },
    mls:   { label:"MLS",   emoji:"⚽", espnSport:"soccer",     espnLeague:"usa.1",                  oddsKey:"soccer_usa_mls",              props:["player_goal_scorer_anytime","player_shots_on_target"] }
  },
  espn: {
    scoreboard:   (s,l,date) => `https://site.api.espn.com/apis/site/v2/sports/${s}/${l}/scoreboard${date ? `?dates=${date}` : ""}`,
    teamStats:    (s,l,id)   => `https://site.api.espn.com/apis/site/v2/sports/${s}/${l}/teams/${id}/statistics`,
    teamSchedule: (s,l,id)   => `https://site.api.espn.com/apis/site/v2/sports/${s}/${l}/teams/${id}/schedule`
  },
  oddsApi:     { base:"https://api.the-odds-api.com/v4", regions:"us", markets:"h2h,spreads,totals", format:"american" },
  sleeper:     { players:"https://api.sleeper.app/v1/players/nfl" },
  balldontlie: { base:"https://api.balldontlie.io/v1" },
  llm: {
    gemini:     { endpoint:(k)=>`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${k}`, model:"gemini-2.0-flash-lite" },
    groq:       { endpoint:"https://api.groq.com/openai/v1/chat/completions", model:"llama-3.3-70b-versatile", fallbackModel:"llama-3.1-8b-instant" },
    openrouter: { endpoint:"https://openrouter.ai/api/v1/chat/completions",   models:["meta-llama/llama-3.2-3b-instruct:free","qwen/qwen-2.5-7b-instruct:free","google/gemma-3-4b-it:free"] },
    ollama:     { defaultUrl:"http://localhost:11434", defaultModels:"llama3.2:3b,mistral:7b,gemma2:2b" }
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
  ollamaUrl:"_110_ollama_url", ollamaModels:"_110_ollama_models",
  selectedSports:"_110_selected_sports",
  theme:"_110_theme", savedPicks:"_110_saved_picks"
};
