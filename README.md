# -110 | Sharp Sports Picks

AI-powered sports analytics app with best bets, props, and grades — 100% free to run.

## Live App
**https://n0nam3-bot.github.io/-110**

## Setup

### 1. Firebase (required for auth + pick caching)
1. Go to [firebase.google.com](https://firebase.google.com) → New project (free)
2. Enable **Authentication** → Google + Email/Password providers
3. Enable **Firestore Database** → Start in production mode
4. Add these Firestore Security Rules:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /pick_cache/{gameId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}
```
5. In Project Settings → Your Apps → Web → copy the config
6. Replace the `FIREBASE_*` placeholders in `js/config.js`

### 2. GitHub Pages
1. Push this repo to `https://github.com/n0nam3-bot/-110`
2. Go to repo Settings → Pages → Source: `main` branch, `/ (root)`
3. Your app is live at `https://n0nam3-bot.github.io/-110`

### 3. Free API Keys (add in app Settings)
| Key | Get it | Free limit |
|-----|--------|------------|
| Gemini | [aistudio.google.com](https://aistudio.google.com/app/apikey) | 1M tokens/day |
| Groq | [console.groq.com](https://console.groq.com) | 14,400 req/day |
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | Free model tier |
| The Odds-API | [the-odds-api.com](https://the-odds-api.com) | 500 req/month |
| Balldontlie | [balldontlie.io](https://www.balldontlie.io) | Unlimited |

Users add their own keys in the app's Settings panel — stored encrypted in their Firebase account.

## File Structure
```
/
├── index.html          ← Full app (single page)
├── css/
│   └── style.css       ← Dark minimalist theme
├── js/
│   ├── config.js       ← All config + API endpoints
│   ├── firebase.js     ← Auth + Firestore + caching
│   ├── data.js         ← ESPN, Sleeper, Balldontlie, Odds-API
│   ├── ai.js           ← Gemini → Groq → OpenRouter rotation
│   ├── picks.js        ← Pick orchestrator
│   ├── ui.js           ← Render + UI helpers
│   └── app.js          ← Main controller
└── README.md
```

## Pick Grading
| Grade | Confidence | Edge |
|-------|-----------|------|
| S | 8.5+ | 7%+ |
| A | 7.0+ | 5%+ |
| B | 5.5+ | 3%+ |
| C | Below B | Below B |

Only **A and S grade picks** qualify as Best Bets. Maximum 3 picks per game. If nothing qualifies, the game shows "No value detected."

## Data Sources
- **ESPN** — schedules, scores, team stats, records
- **Sleeper** — NFL injury reports
- **Balldontlie** — NBA season averages
- **The Odds-API** — live lines, spreads, totals, props
- **TheSportsDB** — team info fallback

## Disclaimer
-110 is for informational and entertainment purposes only. Always bet responsibly.
