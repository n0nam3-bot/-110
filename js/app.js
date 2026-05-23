import { initFirebase, onUserChange, ensureUserDoc, getCurrentUser,
         loginGoogle, loginEmail, registerEmail, logout,
         getUserDoc, updateUserDoc, saveUserKeys, getUserKeys,
         syncUserKeysToLocalStorage, savePick, unsavePick,
         sendPasswordReset } from "./firebase.js";
import { loadGamesForSport, getPicksForGame } from "./picks.js";
import { hasKeys } from "./ai.js";
import { renderGameCard, renderBestBetsSidebar, renderSavedSidebar,
         renderSummaryBar, attachSaveHandlers, attachToggleHandlers,
         renderSkeletons, toast, openModal, closeModal, closeAllModals } from "./ui.js";

// ─── In-memory sport cache (avoids re-fetching on tab switch) ─────────────────
// Key: "sport_date"  Value: { games, pickData, loadedAt }
const _sportTabCache = new Map();

function sportCacheKey(sport, date) { return `${sport}_${date || "today"}`; }
function sportCacheGet(sport, date) {
  const e = _sportTabCache.get(sportCacheKey(sport, date));
  return e && Date.now() - e.loadedAt < CONFIG.cache.inMemory ? e : null;
}
function sportCacheSet(sport, date, data) {
  _sportTabCache.set(sportCacheKey(sport, date), { ...data, loadedAt: Date.now() });
}

let _refreshTimer = null;

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  user: null, userDoc: null,
  activeSport:  localStorage.getItem(KEYS.sport) || "nba",
  activeDate:   null,
  games: [], pickData: [], savedIds: [],
  loading: false
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
      const prefSport = state.userDoc?.prefs?.defaultSport;
      if (prefSport && CONFIG.sports[prefSport]) {
        state.activeSport = prefSport;
        localStorage.setItem(KEYS.sport, prefSport);
        setActiveSportTab(prefSport);
      }
      renderUserUI(user);
      renderSavedSidebar(state.userDoc?.savedPicks || []);
      startAutoRefresh();
      await loadSport(state.activeSport, state.activeDate);
    } else {
      stopAutoRefresh();
      renderGuestUI();
    }
  });

  setupSportTabs();
  setupDateSelector();
  setupModals();
  await loadSport(state.activeSport, state.activeDate);
  hideLoadingOverlay();
}

// ─── Auto-refresh every 30 min, only when tab is visible and user is logged in
function startAutoRefresh() {
  stopAutoRefresh();
  _refreshTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!state.user) return;
    // Invalidate cache for active sport and reload silently
    _sportTabCache.delete(sportCacheKey(state.activeSport, state.activeDate));
    loadSport(state.activeSport, state.activeDate, true /* silent */);
  }, CONFIG.autoRefreshMs);
}
function stopAutoRefresh() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

function hideLoadingOverlay() {
  const el = document.getElementById("loading-overlay");
  if (el) { el.classList.add("hidden"); setTimeout(() => el.remove(), 400); }
}

function setActiveSportTab(sport) {
  document.querySelectorAll(".sport-tab").forEach(t => t.classList.remove("active"));
  document.querySelector(`[data-sport="${sport}"]`)?.classList.add("active");
}

function setupSportTabs() {
  document.querySelectorAll(".sport-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const sport = tab.dataset.sport;
      if (state.loading) return;
      setActiveSportTab(sport);
      state.activeSport = sport;
      localStorage.setItem(KEYS.sport, sport);
      loadSport(sport, state.activeDate);
    });
  });
  setActiveSportTab(state.activeSport);
}

function setupDateSelector() {
  const input = document.getElementById("date-selector");
  if (!input) return;
  input.value = new Date().toISOString().split("T")[0];
  input.addEventListener("change", () => {
    state.activeDate = input.value ? input.value.replace(/-/g, "") : null;
    loadSport(state.activeSport, state.activeDate);
  });
  document.getElementById("btn-today")?.addEventListener("click", () => {
    input.value = new Date().toISOString().split("T")[0];
    state.activeDate = null;
    loadSport(state.activeSport, null);
  });
}

// ─── Load sport (with in-memory cache) ───────────────────────────────────────
async function loadSport(sportKey, date = null, silent = false) {
  // Check in-memory cache first — instant render, no API calls
  const cached = sportCacheGet(sportKey, date);
  if (cached && !silent) {
    state.games    = cached.games;
    state.pickData = cached.pickData;
    renderFromState(sportKey, cached.games, cached.pickData);
    return;
  }

  state.loading  = true;
  state.pickData = [];

  const container = document.getElementById("games-list");
  if (!silent) renderSkeletons(container, 5);
  ["stat-games","stat-bestbets","stat-picks","stat-sgrades"].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = "–";
  });

  if (!hasKeys()) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">🔑</div>
        <div class="title">API Keys Required</div>
        <div class="desc">Add at least one free AI key (Gemini, Groq, or OpenRouter) in <a href="#" onclick="openModal('modal-settings')">Settings</a> to generate picks.</div>
      </div>`;
    state.loading = false;
    return;
  }

  try {
    state.games = await loadGamesForSport(sportKey, date);
    const upcoming = state.games.slice(0, 15);

    if (!upcoming.length) {
      const s = CONFIG.sports[sportKey];
      const dateLabel = date
        ? new Date(date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")).toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric" })
        : "today";
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">${s?.emoji || "🏟"}</div>
          <div class="title">No games scheduled</div>
          <div class="desc">${s?.label} has no pre-game events for ${dateLabel}.<br>
          The season may not be active — try another date or sport.</div>
        </div>`;
      state.loading = false;
      return;
    }

    container.innerHTML = upcoming.map(g => renderGameCard(g, null, state.savedIds)).join("");
    attachToggleHandlers();

    for (let i = 0; i < upcoming.length; i++) {
      const game = upcoming[i];
      try {
        const pickResult = await getPicksForGame(game);
        state.pickData.push(pickResult);
        const card = document.getElementById(`card-${game.id}`);
        if (card) card.outerHTML = renderGameCard(game, pickResult, state.savedIds);
        attachToggleHandlers();
        attachSaveHandlers(state.pickData, state.savedIds, onSaveChange);
        renderBestBetsSidebar(state.pickData);
        renderSummaryBar(upcoming, state.pickData);
      } catch (e) {
        console.warn(`Game ${game.id}:`, e.message);
        const card = document.getElementById(`card-${game.id}`);
        if (card) card.outerHTML = renderGameCard(game, { error: e.message, allPicks:[], bestBet:null }, state.savedIds);
      }
    }

    // Store in memory so tab switches are instant
    sportCacheSet(sportKey, date, { games: state.games, pickData: state.pickData });

  } catch (e) {
    container.innerHTML = `<div class="empty-state"><div class="icon">⚠</div><div class="title">Failed to load</div><div class="desc">${e.message}</div></div>`;
  }
  state.loading = false;
}

// Restore UI from cached state (no API calls)
function renderFromState(sportKey, games, pickData) {
  const upcoming  = games.slice(0, 15);
  const container = document.getElementById("games-list");
  container.innerHTML = upcoming.map(g => {
    const pd = pickData.find(p => p.gameId === g.id);
    return renderGameCard(g, pd || null, state.savedIds);
  }).join("");
  attachToggleHandlers();
  attachSaveHandlers(pickData, state.savedIds, onSaveChange);
  renderBestBetsSidebar(pickData);
  renderSummaryBar(upcoming, pickData);
}

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
  // Use display name or email prefix — never the word "Bettor"
  const label    = user.displayName?.split(" ")[0] || user.email?.split("@")[0] || "Account";
  const initials = label.slice(0,2).toUpperCase();
  right.innerHTML = `
    <button class="nav-btn" id="btn-settings">⚙ Settings</button>
    <div class="user-pill" id="btn-profile">
      <div class="user-avatar">${user.photoURL ? `<img src="${user.photoURL}" alt="">` : initials}</div>
      <span>${label}</span>
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

// ─── Auth ─────────────────────────────────────────────────────────────────────
function showAuthTab(tab) {
  ["login","register","reset"].forEach(t => {
    const el = document.getElementById(`auth-${t}-form`);
    if (el) el.style.display = t === tab ? "block" : "none";
  });
  document.getElementById("auth-error").style.display   = "none";
  document.getElementById("auth-success").style.display = "none";
}

function showAuthError(raw) {
  const el = document.getElementById("auth-error");
  if (!el) return;
  const codes = {
    "auth/invalid-email":          "Invalid email address.",
    "auth/user-not-found":         "No account found with that email.",
    "auth/wrong-password":         "Incorrect password.",
    "auth/invalid-credential":     "Incorrect email or password.",
    "auth/email-already-in-use":   "An account with that email already exists.",
    "auth/weak-password":          "Password must be at least 6 characters.",
    "auth/too-many-requests":      "Too many attempts. Try again in a few minutes.",
    "auth/network-request-failed": "Network error — check your connection.",
    "auth/popup-closed-by-user":   "Sign-in popup was closed.",
    "auth/invalid-api-key":        "Firebase API key is invalid. Check js/config.js.",
  };
  const match = Object.keys(codes).find(c => raw.includes(c));
  el.textContent = match ? codes[match] : raw.replace("Firebase: ","").replace(/ *\(.*\)/,"") || "Authentication failed.";
  el.style.display = "block";
}

function showAuthSuccess(msg) {
  const el = document.getElementById("auth-success");
  if (el) { el.textContent = msg; el.style.display = "block"; }
  document.getElementById("auth-error").style.display = "none";
}

async function handleGoogleLogin() {
  try { await loginGoogle(); closeModal("modal-auth"); toast("Welcome!"); }
  catch (e) { showAuthError(e.message); }
}

// ─── Profile modal ────────────────────────────────────────────────────────────
function openProfileModal() {
  const user = getCurrentUser();
  if (!user) return;
  const rec   = state.userDoc?.record || { wins:0, losses:0, pushes:0 };
  const label = user.displayName || user.email?.split("@")[0] || "Account";
  document.getElementById("profile-name").textContent   = label;
  document.getElementById("profile-email").textContent  = user.email || "";
  document.getElementById("profile-wins").textContent   = rec.wins;
  document.getElementById("profile-losses").textContent = rec.losses;
  document.getElementById("profile-pushes").textContent = rec.pushes;
  const resetEmailEl = document.getElementById("reset-email");
  if (resetEmailEl) resetEmailEl.value = user.email || "";
  openModal("modal-profile");
}

// ─── Settings modal ───────────────────────────────────────────────────────────
async function openSettingsModal() {
  const user = getCurrentUser();
  if (user) {
    const keys = await getUserKeys(user.uid);
    for (const [k, v] of Object.entries(keys)) {
      const el = document.getElementById(`key-${k}`); if (el) el.value = v;
    }
    const sel = document.getElementById("pref-sport");
    if (sel) sel.value = state.userDoc?.prefs?.defaultSport || state.activeSport;
  } else {
    for (const name of ["oddsApi","gemini","groq","openrouter","balldontlie"]) {
      const el = document.getElementById(`key-${name}`);
      if (el) el.value = localStorage.getItem(KEYS[name]) || "";
    }
  }
  openModal("modal-settings");
}

async function saveSettings() {
  const keys = {};
  for (const name of ["oddsApi","gemini","groq","openrouter","balldontlie"]) {
    const el = document.getElementById(`key-${name}`);
    keys[name] = el?.value?.trim() || "";
    localStorage.setItem(KEYS[name], keys[name]);
  }
  const user = getCurrentUser();
  if (user) {
    await saveUserKeys(user.uid, keys);
    const prefSport = document.getElementById("pref-sport")?.value;
    if (prefSport && CONFIG.sports[prefSport]) {
      await updateUserDoc(user.uid, { "prefs.defaultSport": prefSport });
      if (state.userDoc) state.userDoc.prefs = { ...state.userDoc.prefs, defaultSport: prefSport };
    }
  }
  closeModal("modal-settings");
  toast("Settings saved");
  // Clear in-memory cache so next load uses new keys
  _sportTabCache.clear();
  await loadSport(state.activeSport, state.activeDate);
}

// ─── Modals ───────────────────────────────────────────────────────────────────
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
    try {
      await loginEmail(document.getElementById("login-email")?.value, document.getElementById("login-password")?.value);
      closeModal("modal-auth"); toast("Welcome back!");
    } catch (e) { showAuthError(e.message); }
  });

  document.getElementById("auth-register-btn")?.addEventListener("click", async () => {
    try {
      await registerEmail(
        document.getElementById("register-email")?.value,
        document.getElementById("register-password")?.value,
        document.getElementById("register-name")?.value
      );
      closeModal("modal-auth"); toast("Account created!");
    } catch (e) { showAuthError(e.message); }
  });

  // Password reset from login screen
  document.getElementById("link-forgot-password")?.addEventListener("click", () => {
    const email = document.getElementById("login-email")?.value;
    const el    = document.getElementById("reset-email");
    if (el && email) el.value = email;
    showAuthTab("reset");
  });

  document.getElementById("auth-reset-btn")?.addEventListener("click", async () => {
    const email = document.getElementById("reset-email")?.value?.trim();
    if (!email) { showAuthError("Please enter your email address."); return; }
    try { await sendPasswordReset(email); showAuthSuccess("Reset link sent — check your inbox."); }
    catch (e) { showAuthError(e.message); }
  });

  // Password reset from profile (already signed in)
  document.getElementById("btn-profile-reset-password")?.addEventListener("click", async () => {
    const user = getCurrentUser();
    if (!user?.email) return;
    try { await sendPasswordReset(user.email); toast("Password reset email sent to " + user.email); }
    catch (e) { toast(e.message, "error"); }
  });

  document.getElementById("link-to-register")?.addEventListener("click",    () => showAuthTab("register"));
  document.getElementById("link-to-login")?.addEventListener("click",        () => showAuthTab("login"));
  document.getElementById("link-back-to-login")?.addEventListener("click",   () => showAuthTab("login"));

  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    await logout(); closeModal("modal-profile");
    toast("Signed out"); state.user = null; state.userDoc = null;
    renderGuestUI();
  });

  document.querySelectorAll(".key-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = btn.previousElementSibling; if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      btn.textContent = input.type === "password" ? "👁" : "🙈";
    });
  });

  document.getElementById("btn-refresh")?.addEventListener("click", () => {
    _sportTabCache.delete(sportCacheKey(state.activeSport, state.activeDate));
    loadSport(state.activeSport, state.activeDate);
  });
}

window.openModal      = openModal;
window.closeAllModals = closeAllModals;

init();
