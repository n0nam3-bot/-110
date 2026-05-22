import { initFirebase, onUserChange, ensureUserDoc, getCurrentUser,
         loginGoogle, loginEmail, registerEmail, logout,
         getUserDoc, saveUserKeys, getUserKeys, syncUserKeysToLocalStorage,
         savePick, unsavePick, sendPasswordReset } from "./firebase.js";
import { loadGamesForSport, getPicksForGame } from "./picks.js";
import { hasKeys } from "./ai.js";
import { renderGameCard, renderBestBetsSidebar, renderSavedSidebar,
         renderSummaryBar, attachSaveHandlers, attachToggleHandlers,
         renderSkeletons, toast, openModal, closeModal, closeAllModals } from "./ui.js";

// ─── Per-sport result cache (survives tab switches) ───────────────────────────
// { [sportKey]: { games: [], pickData: [], loadedAt: number | null } }
const _sportCache = {};
// Tracks in-flight load promises so switching tabs mid-load doesn't double-fire
const _sportLoading = {};

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
      }
      renderUserUI(user);
      renderSavedSidebar(state.userDoc?.savedPicks || []);
      await loadSport(state.activeSport, state.activeDate);
    } else {
      renderGuestUI();
    }
  });

  setupSportTabs();
  setupDateSelector();
  setupModals();
  await loadSport(state.activeSport, state.activeDate);
  hideLoadingOverlay();
  startAutoRefresh();
}

function hideLoadingOverlay() {
  const el = document.getElementById("loading-overlay");
  if (el) { el.classList.add("hidden"); setTimeout(() => el.remove(), 400); }
}

// ─── Sport tabs ───────────────────────────────────────────────────────────────
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

// ─── Date selector ────────────────────────────────────────────────────────────
function setupDateSelector() {
  const input = document.getElementById("date-selector");
  if (!input) return;
  input.value = new Date().toISOString().split("T")[0];
  input.addEventListener("change", () => {
    // Changing the date invalidates the entire cache
    Object.keys(_sportCache).forEach(k => delete _sportCache[k]);
    state.activeDate = input.value ? input.value.replace(/-/g, "") : null;
    loadSport(state.activeSport, state.activeDate);
  });
  document.getElementById("btn-today")?.addEventListener("click", () => {
    Object.keys(_sportCache).forEach(k => delete _sportCache[k]);
    input.value = new Date().toISOString().split("T")[0];
    state.activeDate = null;
    loadSport(state.activeSport, null);
  });
}

// ─── Core load / cache logic ──────────────────────────────────────────────────

/** Render the games-list from the in-memory cache for a sport. */
function renderFromCache(sportKey) {
  const cached = _sportCache[sportKey];
  if (!cached) return;

  const container = document.getElementById("games-list");
  const upcoming  = cached.games.slice(0, 12);

  // Reset sidebar stats
  ["stat-games","stat-bestbets","stat-picks","stat-sgrades"].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = "–";
  });

  if (!upcoming.length) {
    const s = CONFIG.sports[sportKey];
    const dateLabel = state.activeDate
      ? new Date(state.activeDate.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"))
          .toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric" })
      : "today";
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">${s?.emoji || "🏟"}</div>
        <div class="title">No pre-game events</div>
        <div class="desc">No upcoming ${s?.label} games found for ${dateLabel}.<br>Live and completed games are excluded — try another date.</div>
      </div>`;
    return;
  }

  container.innerHTML = upcoming.map(g => {
    const pickResult = cached.pickData.find(pd => pd.gameId === g.id) || null;
    return renderGameCard(g, pickResult, state.savedIds);
  }).join("");

  attachToggleHandlers();
  attachSaveHandlers(cached.pickData, state.savedIds, onSaveChange);
  renderBestBetsSidebar(cached.pickData);
  renderSummaryBar(upcoming, cached.pickData);

  // Keep global state in sync
  state.games    = cached.games;
  state.pickData = cached.pickData;
}

/**
 * Primary load function.
 * - If fresh cache exists (< 30 min) → renders instantly, no new requests.
 * - If a load is already in-flight for this sport → shows skeletons and waits.
 * - Otherwise → fetches fresh data, analyzes games, populates cache, updates UI live.
 */
async function loadSport(sportKey, date = null) {
  state.activeSport = sportKey;

  // ── Cache hit ──
  const cached = _sportCache[sportKey];
  if (cached && cached.loadedAt && (Date.now() - cached.loadedAt) < CONFIG.cache.picks) {
    renderFromCache(sportKey);
    return;
  }

  // ── Already in-flight ──
  if (_sportLoading[sportKey]) {
    // Show what we have so far (may be partial) then re-render when done
    if (cached) renderFromCache(sportKey);
    else renderSkeletons(document.getElementById("games-list"), 5);
    _sportLoading[sportKey].then(() => {
      if (state.activeSport === sportKey) renderFromCache(sportKey);
    });
    return;
  }

  // ── Fresh fetch ──
  state.loading = true;
  const container = document.getElementById("games-list");
  renderSkeletons(container, 5);
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

  const promise = _fetchAndAnalyze(sportKey, date);
  _sportLoading[sportKey] = promise;
  promise.finally(() => { delete _sportLoading[sportKey]; });

  await promise;
  state.loading = false;

  // ── Background-preload the other sports once the active one is done ──
  _preloadOtherSports(date);
}

async function _fetchAndAnalyze(sportKey, date) {
  try {
    const games    = await loadGamesForSport(sportKey, date);
    const upcoming = games.slice(0, 12);

    // Initialise cache slot so partial renders work while analysis runs
    _sportCache[sportKey] = { games, pickData: [], loadedAt: null };

    // Render initial cards (no picks yet) if this is the visible sport
    if (sportKey === state.activeSport) {
      const container = document.getElementById("games-list");
      if (!upcoming.length) {
        renderFromCache(sportKey); // empty-state render
        _sportCache[sportKey].loadedAt = Date.now();
        return;
      }
      container.innerHTML = upcoming.map(g => renderGameCard(g, null, state.savedIds)).join("");
      attachToggleHandlers();
    }

    // Analyse each game, streaming results into the UI
    for (const game of upcoming) {
      try {
        const pickResult = await getPicksForGame(game);
        _sportCache[sportKey].pickData.push(pickResult);

        if (sportKey === state.activeSport) {
          const card = document.getElementById(`card-${game.id}`);
          if (card) card.outerHTML = renderGameCard(game, pickResult, state.savedIds);
          attachToggleHandlers();
          attachSaveHandlers(_sportCache[sportKey].pickData, state.savedIds, onSaveChange);
          renderBestBetsSidebar(_sportCache[sportKey].pickData);
          renderSummaryBar(upcoming, _sportCache[sportKey].pickData);
        }
      } catch (e) {
        console.warn(`Game ${game.id}:`, e.message);
        if (sportKey === state.activeSport) {
          const card = document.getElementById(`card-${game.id}`);
          if (card) card.outerHTML = renderGameCard(game, { error: e.message, allPicks:[], bestBet:null }, state.savedIds);
        }
      }
    }

    _sportCache[sportKey].loadedAt = Date.now();

    if (sportKey === state.activeSport) {
      state.games    = games;
      state.pickData = _sportCache[sportKey].pickData;
    }

  } catch (e) {
    if (sportKey === state.activeSport) {
      document.getElementById("games-list").innerHTML =
        `<div class="empty-state"><div class="icon">⚠</div><div class="title">Failed to load</div><div class="desc">${e.message}</div></div>`;
    }
  }
}

/** Silently pre-populate the cache for all sports the user hasn't visited yet. */
function _preloadOtherSports(date) {
  const others = Object.keys(CONFIG.sports).filter(sk => sk !== state.activeSport);
  let delay = 1500; // stagger requests so they don't hammer APIs simultaneously
  for (const sk of others) {
    if (_sportCache[sk] || _sportLoading[sk]) continue; // already done or in-flight
    setTimeout(() => {
      if (!_sportLoading[sk] && !_sportCache[sk]) {
        const p = _fetchAndAnalyze(sk, date);
        _sportLoading[sk] = p;
        p.finally(() => { delete _sportLoading[sk]; });
      }
    }, delay);
    delay += 2000;
  }
}

// ─── 30-minute auto-refresh (only while tab is visible) ──────────────────────
function startAutoRefresh() {
  setInterval(() => {
    if (document.visibilityState !== "visible") return;

    // Stale-invalidate every cached sport
    Object.keys(_sportCache).forEach(sk => {
      const entry = _sportCache[sk];
      if (entry?.loadedAt && (Date.now() - entry.loadedAt) >= CONFIG.cache.picks) {
        delete _sportCache[sk];
      }
    });

    // Reload the active sport immediately; others will lazy-reload on tab switch
    if (!_sportLoading[state.activeSport]) {
      loadSport(state.activeSport, state.activeDate);
    }
  }, CONFIG.cache.picks); // fires every 30 min
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
  document.getElementById("auth-login-form").style.display    = tab === "login"    ? "block" : "none";
  document.getElementById("auth-register-form").style.display = tab === "register" ? "block" : "none";
  document.getElementById("auth-reset-form").style.display    = tab === "reset"    ? "block" : "none";
  document.getElementById("auth-error").style.display  = "none";
  document.getElementById("auth-success").style.display = "none";
}

function showAuthError(raw) {
  const el = document.getElementById("auth-error");
  if (!el) return;
  const codes = {
    "auth/invalid-email":           "Invalid email address.",
    "auth/user-not-found":          "No account found with that email.",
    "auth/wrong-password":          "Incorrect password.",
    "auth/invalid-credential":      "Incorrect email or password.",
    "auth/email-already-in-use":    "An account with that email already exists.",
    "auth/weak-password":           "Password must be at least 6 characters.",
    "auth/too-many-requests":       "Too many attempts. Try again in a few minutes.",
    "auth/network-request-failed":  "Network error — check your connection.",
    "auth/popup-closed-by-user":    "Sign-in popup was closed.",
    "auth/invalid-api-key":         "Firebase API key is invalid. Check js/config.js.",
    "auth/configuration-not-found": "Firebase not configured. Replace FIREBASE_* in js/config.js.",
  };
  const match = Object.keys(codes).find(c => raw.includes(c));
  el.textContent = match ? codes[match] : raw.replace("Firebase: ","").replace(/ *\(.*\)/,"") || "Authentication failed.";
  el.style.display = "block";
}

function showAuthSuccess(msg) {
  const el = document.getElementById("auth-success");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
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
  const rec = state.userDoc?.record || { wins:0, losses:0, pushes:0 };
  document.getElementById("profile-name").textContent   = user.displayName || "Analyst";
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
      const el = document.getElementById(`key-${k}`);
      if (el) el.value = v;
    }
    const prefSport = state.userDoc?.prefs?.defaultSport || state.activeSport;
    const sel = document.getElementById("pref-sport");
    if (sel) sel.value = prefSport;
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
      const { updateUserDoc } = await import("./firebase.js");
      await updateUserDoc(user.uid, { "prefs.defaultSport": prefSport });
      if (state.userDoc) state.userDoc.prefs = { ...state.userDoc.prefs, defaultSport: prefSport };
    }
  }
  closeModal("modal-settings");
  toast("Settings saved");
  // Invalidate cache so new keys take effect
  Object.keys(_sportCache).forEach(k => delete _sportCache[k]);
  await loadSport(state.activeSport, state.activeDate);
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
      closeModal("modal-auth"); toast("Account created! Welcome to -110");
    } catch (e) { showAuthError(e.message); }
  });

  document.getElementById("link-forgot-password")?.addEventListener("click", () => {
    const loginEmail = document.getElementById("login-email")?.value;
    const resetEl    = document.getElementById("reset-email");
    if (resetEl && loginEmail) resetEl.value = loginEmail;
    showAuthTab("reset");
  });

  document.getElementById("auth-reset-btn")?.addEventListener("click", async () => {
    const email = document.getElementById("reset-email")?.value?.trim();
    if (!email) { showAuthError("Please enter your email address."); return; }
    try {
      await sendPasswordReset(email);
      showAuthSuccess("Reset email sent! Check your inbox.");
    } catch (e) { showAuthError(e.message); }
  });

  document.getElementById("btn-profile-reset-password")?.addEventListener("click", async () => {
    const user = getCurrentUser();
    if (!user?.email) return;
    try {
      await sendPasswordReset(user.email);
      toast("Password reset email sent to " + user.email);
    } catch (e) { toast(e.message, "error"); }
  });

  document.getElementById("link-to-register")?.addEventListener("click", () => showAuthTab("register"));
  document.getElementById("link-to-login")?.addEventListener("click",    () => showAuthTab("login"));
  document.getElementById("link-back-to-login")?.addEventListener("click", () => showAuthTab("login"));

  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    await logout();
    closeModal("modal-profile");
    toast("Signed out");
    state.user = null; state.userDoc = null;
    renderGuestUI();
  });

  document.querySelectorAll(".key-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = btn.previousElementSibling;
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      btn.textContent = input.type === "password" ? "👁" : "🙈";
    });
  });

  document.getElementById("btn-refresh")?.addEventListener("click", () => {
    // Force-clear cache for active sport then reload
    delete _sportCache[state.activeSport];
    loadSport(state.activeSport, state.activeDate);
  });
}

window.openModal      = openModal;
window.closeAllModals = closeAllModals;

init();
