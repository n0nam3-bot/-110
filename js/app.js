import { initFirebase, onUserChange, ensureUserDoc, getCurrentUser,
         loginGoogle, loginEmail, registerEmail, logout,
         getUserDoc, saveUserKeys, getUserKeys, syncUserKeysToLocalStorage,
         savePick, unsavePick, sendPasswordReset } from "./firebase.js";
import { loadGamesForSport, getPicksForSport } from "./picks.js";
import { hasKeys } from "./ai.js";
import { renderGameCard, renderBestBetsSidebar, renderSavedSidebar,
         renderSummaryBar, attachSaveHandlers, attachToggleHandlers,
         renderSkeletons, toast, openModal, closeModal, closeAllModals } from "./ui.js";

// ─── In-memory sport cache ────────────────────────────────────────────────────
const _sportCache   = {}; // sportKey → { games, pickData, loadedAt }
const _sportLoading = {}; // sportKey → Promise

const ALL_SPORT_KEYS = Object.keys(CONFIG.sports);
const DEFAULT_SPORTS = ["nba", "mlb", "nhl"]; // shown when no prefs saved

let state = {
  user: null, userDoc: null,
  selectedSports: [],   // sport keys toggled ON in the filter bar
  activeDate:     null,
  games:    {},         // { [sportKey]: Game[] }
  pickData: {},         // { [sportKey]: PickResult[] }
  savedIds: [],
  running:  false
};

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  initFirebase();

  onUserChange(async (user) => {
    state.user = user;
    if (user) {
      await ensureUserDoc(user);
      await syncUserKeysToLocalStorage(user.uid);
      state.userDoc  = await getUserDoc(user.uid);
      state.savedIds = (state.userDoc?.savedPicks || []).map(p => p.id);

      // Sync cloud sport prefs → local
      const cloudSports = state.userDoc?.prefs?.selectedSports;
      if (cloudSports?.length) {
        state.selectedSports = cloudSports;
        localStorage.setItem(KEYS.selectedSports, JSON.stringify(cloudSports));
        _refreshChips();
      }
      renderUserUI(user);
      renderSavedSidebar(state.userDoc?.savedPicks || []);
    } else {
      renderGuestUI();
    }
  });

  state.selectedSports = _loadSelectedSports();
  setupSportFilter();
  setupDateSelector();
  setupModals();

  // Show any cached results immediately (no API calls)
  _showCachedResults();

  hideLoadingOverlay();
}

function hideLoadingOverlay() {
  const el = document.getElementById("loading-overlay");
  if (el) { el.classList.add("hidden"); setTimeout(() => el.remove(), 400); }
}

// ─── Sport filter bar ─────────────────────────────────────────────────────────
function _loadSelectedSports() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEYS.selectedSports) || "[]");
    if (Array.isArray(saved) && saved.length) return saved.filter(s => CONFIG.sports[s]);
  } catch {}
  return DEFAULT_SPORTS;
}

function _saveSelectedSports(sports) {
  localStorage.setItem(KEYS.selectedSports, JSON.stringify(sports));
}

function setupSportFilter() {
  document.querySelectorAll(".sport-chip").forEach(chip => {
    const sport = chip.dataset.sport;
    if (state.selectedSports.includes(sport)) chip.classList.add("active");
    chip.addEventListener("click", () => {
      chip.classList.toggle("active");
      const checked = [...document.querySelectorAll(".sport-chip.active")].map(c => c.dataset.sport);
      state.selectedSports = checked;
      _saveSelectedSports(checked);
    });
  });
  document.getElementById("btn-run")?.addEventListener("click", runAnalysis);
}

function _refreshChips() {
  document.querySelectorAll(".sport-chip").forEach(chip => {
    chip.classList.toggle("active", state.selectedSports.includes(chip.dataset.sport));
  });
}

// ─── Date selector ────────────────────────────────────────────────────────────
function setupDateSelector() {
  const input = document.getElementById("date-selector");
  if (!input) return;
  input.value = new Date().toISOString().split("T")[0];
  input.addEventListener("change", () => {
    _invalidateAllCaches();
    state.activeDate = input.value ? input.value.replace(/-/g, "") : null;
    _clearResults();
  });
  document.getElementById("btn-today")?.addEventListener("click", () => {
    _invalidateAllCaches();
    input.value = new Date().toISOString().split("T")[0];
    state.activeDate = null;
    _clearResults();
  });
}

function _invalidateAllCaches() {
  Object.keys(_sportCache).forEach(k => delete _sportCache[k]);
  Object.keys(localStorage).filter(k => k.startsWith("_110_picks_")).forEach(k => localStorage.removeItem(k));
}

// ─── localStorage persistence ────────────────────────────────────────────────
const _LS_PREFIX = "_110_picks_";
const _LS_TTL    = 30 * 60 * 1000;
function _lsKey(sk, date) { return `${_LS_PREFIX}${sk}_${date || "today"}`; }
function _lsGet(sk, date) {
  try {
    const e = JSON.parse(localStorage.getItem(_lsKey(sk, date)) || "null");
    if (!e?.loadedAt || (Date.now() - e.loadedAt) > _LS_TTL) return null;
    return e;
  } catch { return null; }
}
function _lsSet(sk, date, games, pickData) {
  try {
    localStorage.setItem(_lsKey(sk, date), JSON.stringify({ games, pickData, loadedAt: Date.now() }));
  } catch {
    Object.keys(localStorage).filter(k => k.startsWith(_LS_PREFIX)).forEach(k => localStorage.removeItem(k));
    try { localStorage.setItem(_lsKey(sk, date), JSON.stringify({ games, pickData, loadedAt: Date.now() })); } catch {}
  }
}

// ─── Master progress bar ─────────────────────────────────────────────────────
function _showMasterProgress(msg, pct) {
  let bar = document.getElementById("master-progress");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "master-progress";
    bar.className = "master-progress";
    const feed = document.getElementById("feed");
    feed?.insertAdjacentElement("afterbegin", bar);
  }
  const pctInt = Math.round(pct * 100);
  bar.innerHTML = `
    <div class="mp-row">
      <span class="mp-label">${msg}</span>
      <span class="mp-pct">${pctInt}%</span>
    </div>
    <div class="mp-track"><div class="mp-fill" style="width:${pctInt}%"></div></div>`;
}
function _clearMasterProgress() {
  document.getElementById("master-progress")?.remove();
}

// ─── Results rendering ────────────────────────────────────────────────────────
function _clearResults() {
  document.getElementById("results-area").innerHTML = "";
  document.getElementById("master-progress")?.remove();
  renderBestBetsSidebar([]);
  renderSummaryBar([], []);
  const btn = document.getElementById("btn-run");
  if (btn) { btn.textContent = "▶ Run Analysis"; btn.disabled = false; }
}

function _showCachedResults() {
  const sportsWithCache = state.selectedSports.filter(sk => _lsGet(sk, state.activeDate));
  if (!sportsWithCache.length) {
    _renderLandingHint();
    return;
  }
  const area = document.getElementById("results-area");
  area.innerHTML = "";
  for (const sk of state.selectedSports) {
    const cached = _lsGet(sk, state.activeDate);
    if (!cached) continue;
    _sportCache[sk] = { ...cached };
    state.games[sk]    = cached.games;
    state.pickData[sk] = cached.pickData;
    _renderSportSection(sk, cached.games, cached.pickData);
  }
  _updateAggregateSidebar();
  const btn = document.getElementById("btn-run");
  if (btn) btn.textContent = "↻ Refresh Analysis";
}

function _renderLandingHint() {
  document.getElementById("results-area").innerHTML = `
    <div class="landing-hint">
      <div class="landing-icon">📊</div>
      <div class="landing-title">Ready to analyze</div>
      <div class="landing-desc">
        Toggle the sports you care about above, then click
        <strong>Run Analysis</strong> to fetch today's matchups
        and generate AI-powered picks.
      </div>
    </div>`;
}

function _renderSportSection(sportKey, games, pickData) {
  const s        = CONFIG.sports[sportKey];
  const displayGames = (games || []);
  let   section  = document.getElementById(`sport-section-${sportKey}`);
  if (!section) {
    section = document.createElement("div");
    section.id = `sport-section-${sportKey}`;
    section.className = "sport-section";
    document.getElementById("results-area").appendChild(section);
  }

  if (!displayGames.length) {
    section.innerHTML = `
      <div class="sport-section-header">
        <span class="sport-section-title">${s.emoji} ${s.label}</span>
        <span class="sport-section-badge empty">No games today</span>
      </div>`;
    return;
  }

  const RENDER_CAP = 8; // only AI picks available for the first 8
  const cards = displayGames.map((g, idx) => {
    const pd       = (pickData || []).find(pd => pd.gameId === g.id) || null;
    const fallback = idx >= RENDER_CAP ? { allPicks:[], bestBet:null, noAnalysis:true } : null;
    return renderGameCard(g, pd || fallback, state.savedIds);
  }).join("");

  section.innerHTML = `
    <div class="sport-section-header" id="anchor-${sportKey}">
      <span class="sport-section-title">${s.emoji} ${s.label}</span>
      <span class="sport-section-badge">${displayGames.length} game${displayGames.length !== 1 ? "s" : ""}</span>
    </div>
    <div class="sport-section-games" id="sport-games-${sportKey}">${cards}</div>`;

  attachToggleHandlers();
  attachSaveHandlers(pickData || [], state.savedIds, onSaveChange);
}

function _updateAggregateSidebar() {
  const allPicks = Object.values(state.pickData).flat();
  const allGames = Object.values(state.games).flat();
  renderBestBetsSidebar(allPicks);
  renderSummaryBar(allGames, allPicks);
  _renderJumpNav();
}

function _renderJumpNav() {
  const loaded = state.selectedSports.filter(sk => state.games[sk]?.length);
  let nav = document.getElementById("sport-jump-nav");
  if (!loaded.length) { nav?.remove(); return; }
  if (!nav) {
    nav = document.createElement("div");
    nav.id = "sport-jump-nav";
    nav.className = "sport-jump-nav";
    document.getElementById("results-area").insertAdjacentElement("beforebegin", nav);
  }
  nav.innerHTML = loaded.map(sk => {
    const s = CONFIG.sports[sk];
    return `<button class="jump-link" data-target="anchor-${sk}" type="button">${s.emoji} ${s.label}</button>`;
  }).join("");
  // Attach scroll handlers after rendering
  nav.querySelectorAll(".jump-link").forEach(btn => {
    btn.addEventListener("click", () => {
      const el = document.getElementById(btn.dataset.target);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

// ─── Main run function ────────────────────────────────────────────────────────
async function runAnalysis() {
  if (state.running) return;
  if (!hasKeys()) {
    toast("Add at least one AI key in Settings first", "error");
    openModal("modal-settings");
    return;
  }

  const sports = state.selectedSports.filter(sk => CONFIG.sports[sk]);
  if (!sports.length) {
    toast("Select at least one sport above", "error");
    return;
  }

  state.running = true;
  const btn = document.getElementById("btn-run");
  if (btn) { btn.textContent = "⏳ Analyzing…"; btn.disabled = true; }

  // Clear previous results and state
  document.getElementById("results-area").innerHTML = "";
  document.getElementById("sport-jump-nav")?.remove();
  state.games    = {};
  state.pickData = {};
  ["stat-games","stat-bestbets","stat-picks","stat-sgrades"].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = "–";
  });

  const total = sports.length;
  let completed = 0;

  _showMasterProgress("Starting…", 0);

  for (const sk of sports) {
    const s = CONFIG.sports[sk];

    // Memory cache hit
    const memCached = _sportCache[sk];
    if (memCached?.loadedAt && (Date.now() - memCached.loadedAt) < CONFIG.cache.picks) {
      state.games[sk]    = memCached.games;
      state.pickData[sk] = memCached.pickData;
      _renderSportSection(sk, memCached.games, memCached.pickData);
      completed++;
      _showMasterProgress(`${s.emoji} ${s.label} — from cache`, completed / total);
      continue;
    }

    // localStorage hit
    const lsCached = _lsGet(sk, state.activeDate);
    if (lsCached) {
      _sportCache[sk]    = { ...lsCached };
      state.games[sk]    = lsCached.games;
      state.pickData[sk] = lsCached.pickData;
      _renderSportSection(sk, lsCached.games, lsCached.pickData);
      completed++;
      _showMasterProgress(`${s.emoji} ${s.label} — from cache`, completed / total);
      continue;
    }

    // Fresh fetch + analysis
    try {
      const promise = _fetchAndAnalyzeSport(sk, state.activeDate, (msg, pct) => {
        _showMasterProgress(
          `${s.emoji} ${s.label} — ${msg}  (${completed + 1} of ${total})`,
          (completed + pct) / total
        );
      });
      _sportLoading[sk] = promise;
      promise.finally(() => { delete _sportLoading[sk]; });
      await promise;
    } catch (e) {
      console.error(`${sk}:`, e.message);
      let section = document.getElementById(`sport-section-${sk}`);
      if (!section) {
        section = document.createElement("div");
        section.id = `sport-section-${sk}`;
        section.className = "sport-section";
        document.getElementById("results-area").appendChild(section);
      }
      section.innerHTML = `
        <div class="sport-section-header">
          <span class="sport-section-title">${s.emoji} ${s.label}</span>
          <span class="sport-section-badge empty">Failed</span>
        </div>
        <div class="empty-state" style="padding:20px">
          <div class="icon">⚠</div>
          <div class="title">Analysis failed</div>
          <div class="desc">${e.message}</div>
        </div>`;
    }

    completed++;
  }

  _showMasterProgress("✓ Analysis complete!", 1.0);
  setTimeout(() => _clearMasterProgress(), 3000);
  _updateAggregateSidebar();

  if (btn) { btn.textContent = "↻ Refresh Analysis"; btn.disabled = false; }
  state.running = false;
}

// ─── Per-sport fetch + analyze ────────────────────────────────────────────────
async function _fetchAndAnalyzeSport(sportKey, date, onProgress) {
  const s = CONFIG.sports[sportKey];

  onProgress?.("Fetching schedules & odds…", 0.05);
  const games = await loadGamesForSport(sportKey, date);

  // Show ALL fetched games; only run AI on the first ANALYSIS_CAP to stay within token limits
  const ANALYSIS_CAP  = 8;
  const analysisGames = games.slice(0, ANALYSIS_CAP);   // LLM analyzes these
  const displayGames  = games;                           // all shown to user

  // Create/update section immediately
  let section = document.getElementById(`sport-section-${sportKey}`);
  if (!section) {
    section = document.createElement("div");
    section.id = `sport-section-${sportKey}`;
    section.className = "sport-section";
    document.getElementById("results-area").appendChild(section);
  }

  if (!displayGames.length) {
    const dateLabel = date
      ? new Date(date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"))
          .toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric" })
      : "today";
    section.innerHTML = `
      <div class="sport-section-header">
        <span class="sport-section-title">${s.emoji} ${s.label}</span>
        <span class="sport-section-badge empty">No games</span>
      </div>
      <div class="empty-state" style="padding:20px">
        <div class="icon">${s.emoji}</div>
        <div class="title">No pre-game events</div>
        <div class="desc">No upcoming ${s.label} games for ${dateLabel}.</div>
      </div>`;
    _sportCache[sportKey] = { games: [], pickData: [], loadedAt: Date.now() };
    state.games[sportKey]    = [];
    state.pickData[sportKey] = [];
    return;
  }

  // Show ALL game cards immediately — games beyond analysis cap show "odds only"
  section.innerHTML = `
    <div class="sport-section-header" id="anchor-${sportKey}">
      <span class="sport-section-title">${s.emoji} ${s.label}</span>
      <span class="sport-section-badge">${displayGames.length} game${displayGames.length !== 1 ? "s" : ""}</span>
    </div>
    <div class="sport-section-games" id="sport-games-${sportKey}">
      ${displayGames.map((g, idx) => {
        const placeholder = idx < ANALYSIS_CAP ? null : { allPicks:[], bestBet:null, noAnalysis:true };
        return renderGameCard(g, placeholder, state.savedIds);
      }).join("")}
    </div>`;
  attachToggleHandlers();

  // Run combined batch analysis on first ANALYSIS_CAP games
  const pickData = await getPicksForSport(analysisGames, (msg, pct) => {
    onProgress?.(msg, 0.12 + pct * 0.83);
  });

  // Re-render all cards: picks for analyzed games, odds-only for the rest
  const gamesEl = document.getElementById(`sport-games-${sportKey}`);
  if (gamesEl) {
    gamesEl.innerHTML = displayGames.map((g, idx) => {
      const pd       = pickData.find(pd => pd.gameId === g.id) || null;
      const fallback = idx >= ANALYSIS_CAP ? { allPicks:[], bestBet:null, noAnalysis:true } : null;
      return renderGameCard(g, pd || fallback, state.savedIds);
    }).join("");
    attachToggleHandlers();
    attachSaveHandlers(pickData, state.savedIds, onSaveChange);
  }

  _sportCache[sportKey] = { games, pickData, loadedAt: Date.now() };
  state.games[sportKey]    = games;
  state.pickData[sportKey] = pickData;

  _lsSet(sportKey, date, games, pickData);
  onProgress?.("Done", 1.0);
}

// ─── 30-min auto-refresh ──────────────────────────────────────────────────────
function startAutoRefresh() {
  setInterval(() => {
    if (document.visibilityState !== "visible" || state.running) return;
    Object.keys(_sportCache).forEach(sk => {
      const e = _sportCache[sk];
      if (e?.loadedAt && (Date.now() - e.loadedAt) >= CONFIG.cache.picks) delete _sportCache[sk];
    });
  }, CONFIG.cache.picks);
}

// ─── Save handler ─────────────────────────────────────────────────────────────
async function onSaveChange() {
  if (state.user) {
    state.userDoc = await getUserDoc(state.user.uid);
    renderSavedSidebar(state.userDoc?.savedPicks || []);
  }
}

// ─── Nav UI ───────────────────────────────────────────────────────────────────
function renderUserUI(user) {
  const right = document.getElementById("nav-user-area");
  if (!right) return;
  const initials = (user.displayName || user.email || "U").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  right.innerHTML = `
    <button class="nav-btn" id="btn-settings">⚙ Settings</button>
    <div class="user-pill" id="btn-profile">
      <div class="user-avatar">${user.photoURL ? `<img src="${user.photoURL}" alt="">` : initials}</div>
      <span>${user.displayName?.split(" ")[0] || "Profile"}</span>
    </div>`;
  document.getElementById("btn-settings")?.addEventListener("click", openSettingsModal);
  document.getElementById("btn-profile")?.addEventListener("click",  openProfileModal);
}

function renderGuestUI() {
  const right = document.getElementById("nav-user-area");
  if (!right) return;
  right.innerHTML = `
    <button class="nav-btn" id="btn-settings">⚙ Settings</button>
    <button class="nav-btn" id="btn-login">Sign In</button>
    <button class="nav-btn primary" id="btn-signup">Get Started</button>`;
  document.getElementById("btn-settings")?.addEventListener("click", openSettingsModal);
  document.getElementById("btn-login")?.addEventListener("click",  () => { openModal("modal-auth"); showAuthTab("login"); });
  document.getElementById("btn-signup")?.addEventListener("click", () => { openModal("modal-auth"); showAuthTab("register"); });
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function showAuthTab(tab) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.style.display = v; };
  set("auth-login-form",    tab === "login"    ? "block" : "none");
  set("auth-register-form", tab === "register" ? "block" : "none");
  set("auth-reset-form",    tab === "reset"    ? "block" : "none");
  set("auth-error",   "none");
  set("auth-success", "none");
}
function showAuthError(raw) {
  const el = document.getElementById("auth-error"); if (!el) return;
  const codes = {
    "auth/invalid-email":"Invalid email address.","auth/user-not-found":"No account found with that email.",
    "auth/wrong-password":"Incorrect password.","auth/invalid-credential":"Incorrect email or password.",
    "auth/email-already-in-use":"An account with that email already exists.",
    "auth/weak-password":"Password must be at least 6 characters.",
    "auth/too-many-requests":"Too many attempts. Try again in a few minutes.",
    "auth/network-request-failed":"Network error — check your connection.",
    "auth/popup-closed-by-user":"Sign-in popup was closed.",
    "auth/invalid-api-key":"Firebase API key is invalid. Check js/config.js.",
    "auth/configuration-not-found":"Firebase not configured. Replace FIREBASE_* in js/config.js.",
  };
  const match = Object.keys(codes).find(c => raw.includes(c));
  el.textContent = match ? codes[match] : raw.replace("Firebase: ","").replace(/ *\(.*\)/,"") || "Authentication failed.";
  el.style.display = "block";
}
function showAuthSuccess(msg) {
  const s = document.getElementById("auth-success"); if (!s) return;
  s.textContent = msg; s.style.display = "block";
  document.getElementById("auth-error").style.display = "none";
}
async function handleGoogleLogin() {
  try { await loginGoogle(); closeModal("modal-auth"); toast("Welcome!"); }
  catch (e) { showAuthError(e.message); }
}

// ─── Profile modal ────────────────────────────────────────────────────────────
function openProfileModal() {
  const user = getCurrentUser(); if (!user) return;
  const rec = state.userDoc?.record || { wins:0, losses:0, pushes:0 };
  document.getElementById("profile-name").textContent   = user.displayName || "Analyst";
  document.getElementById("profile-email").textContent  = user.email || "";
  document.getElementById("profile-wins").textContent   = rec.wins;
  document.getElementById("profile-losses").textContent = rec.losses;
  document.getElementById("profile-pushes").textContent = rec.pushes;
  const re = document.getElementById("reset-email"); if (re) re.value = user.email || "";
  openModal("modal-profile");
}

// ─── Settings modal ───────────────────────────────────────────────────────────
async function openSettingsModal() {
  const user = getCurrentUser();
  const keyNames = ["oddsApi","gemini","groq","openrouter","balldontlie","ollamaUrl","ollamaModels"];
  if (user) {
    const keys = await getUserKeys(user.uid);
    for (const [k, v] of Object.entries(keys)) {
      const el = document.getElementById(`key-${k}`); if (el) el.value = v;
    }
  }
  // Always load from localStorage too (covers guest + any keys not in Firebase)
  for (const name of keyNames) {
    const el = document.getElementById(`key-${name}`);
    if (el && !el.value) el.value = localStorage.getItem(KEYS[name]) || "";
  }

  // Populate sport preference checkboxes
  const saved = _loadSelectedSports();
  document.querySelectorAll(".sport-pref-check").forEach(cb => {
    cb.checked = saved.includes(cb.value);
  });

  openModal("modal-settings");
}

async function saveSettings() {
  const keyNames = ["oddsApi","gemini","groq","openrouter","balldontlie","ollamaUrl","ollamaModels"];
  const keys = {};
  for (const name of keyNames) {
    const el = document.getElementById(`key-${name}`);
    keys[name] = el?.value?.trim() || "";
    localStorage.setItem(KEYS[name], keys[name]);
  }
  // Save sport preferences
  const prefSports = [...document.querySelectorAll(".sport-pref-check:checked")].map(cb => cb.value);
  const sportsToSave = prefSports.length ? prefSports : DEFAULT_SPORTS;
  _saveSelectedSports(sportsToSave);
  state.selectedSports = sportsToSave;
  _refreshChips();

  const user = getCurrentUser();
  if (user) {
    await saveUserKeys(user.uid, keys);
    const { updateUserDoc } = await import("./firebase.js");
    await updateUserDoc(user.uid, { "prefs.selectedSports": sportsToSave });
    if (state.userDoc) state.userDoc.prefs = { ...state.userDoc.prefs, selectedSports: sportsToSave };
  }

  closeModal("modal-settings");
  toast("Settings saved");
  // Invalidate caches so new keys/sports take effect
  _invalidateAllCaches();
  _clearResults();
}

// ─── Modal wiring ─────────────────────────────────────────────────────────────
function setupModals() {
  document.querySelectorAll(".modal-overlay").forEach(o =>
    o.addEventListener("click", e => { if (e.target === o) closeAllModals(); })
  );
  document.querySelectorAll(".modal-close").forEach(b => b.addEventListener("click", closeAllModals));

  document.querySelectorAll(".settings-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".settings-section").forEach(s => s.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`settings-${tab.dataset.tab}`)?.classList.add("active");
    });
  });

  document.getElementById("btn-save-settings")?.addEventListener("click", saveSettings);
  document.getElementById("btn-google-login")?.addEventListener("click",    handleGoogleLogin);
  document.getElementById("btn-google-register")?.addEventListener("click", handleGoogleLogin);

  document.getElementById("auth-login-btn")?.addEventListener("click", async () => {
    try { await loginEmail(document.getElementById("login-email")?.value, document.getElementById("login-password")?.value); closeModal("modal-auth"); toast("Welcome back!"); }
    catch (e) { showAuthError(e.message); }
  });
  document.getElementById("auth-register-btn")?.addEventListener("click", async () => {
    try { await registerEmail(document.getElementById("register-email")?.value, document.getElementById("register-password")?.value, document.getElementById("register-name")?.value); closeModal("modal-auth"); toast("Account created! Welcome to -110"); }
    catch (e) { showAuthError(e.message); }
  });
  document.getElementById("link-forgot-password")?.addEventListener("click", () => {
    const e = document.getElementById("login-email")?.value;
    const r = document.getElementById("reset-email"); if (r && e) r.value = e;
    showAuthTab("reset");
  });
  document.getElementById("auth-reset-btn")?.addEventListener("click", async () => {
    const email = document.getElementById("reset-email")?.value?.trim();
    if (!email) { showAuthError("Please enter your email address."); return; }
    try { await sendPasswordReset(email); showAuthSuccess("Reset email sent! Check your inbox."); }
    catch (e) { showAuthError(e.message); }
  });
  document.getElementById("btn-profile-reset-password")?.addEventListener("click", async () => {
    const user = getCurrentUser(); if (!user?.email) return;
    try { await sendPasswordReset(user.email); toast("Password reset email sent to " + user.email); }
    catch (e) { toast(e.message, "error"); }
  });
  document.getElementById("link-to-register")?.addEventListener("click", () => showAuthTab("register"));
  document.getElementById("link-to-login")?.addEventListener("click",    () => showAuthTab("login"));
  document.getElementById("link-back-to-login")?.addEventListener("click", () => showAuthTab("login"));
  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    await logout(); closeModal("modal-profile"); toast("Signed out");
    state.user = null; state.userDoc = null; renderGuestUI();
  });
  document.querySelectorAll(".key-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = btn.previousElementSibling; if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      btn.textContent = input.type === "password" ? "👁" : "🙈";
    });
  });
  document.getElementById("btn-refresh")?.addEventListener("click", () => {
    _invalidateAllCaches(); runAnalysis();
  });

  // Ollama test connection
  document.getElementById("btn-test-ollama")?.addEventListener("click", async () => {
    const url    = document.getElementById("key-ollamaUrl")?.value?.trim() || "http://localhost:11434";
    const result = document.getElementById("ollama-test-result");
    if (result) result.textContent = "Testing…";
    try {
      const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      const models = d.models?.map(m => m.name).join(", ") || "none";
      if (result) { result.textContent = `✓ Connected! Models available: ${models}`; result.style.color = "var(--accent)"; }
    } catch (e) {
      if (result) { result.textContent = `✗ Could not connect: ${e.message}`; result.style.color = "var(--error, #ff6b6b)"; }
    }
  });
}

window.openModal      = openModal;
window.closeAllModals = closeAllModals;

init();
