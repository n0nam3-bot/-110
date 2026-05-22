import { initFirebase, onUserChange, ensureUserDoc, getCurrentUser,
         loginGoogle, loginEmail, registerEmail, logout,
         getUserDoc, saveUserKeys, getUserKeys, syncUserKeysToLocalStorage,
         savePick, unsavePick } from "./firebase.js";
import { loadGamesForSport, getPicksForGame } from "./picks.js";
import { hasKeys } from "./ai.js";
import { renderGameCard, renderBestBetsSidebar, renderSavedSidebar,
         renderSummaryBar, attachSaveHandlers, attachToggleHandlers,
         renderSkeletons, toast, openModal, closeModal, closeAllModals } from "./ui.js";

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  user: null, userDoc: null,
  activeSport:  localStorage.getItem(KEYS.sport) || "nba",
  activeDate:   null,   // null = today, "YYYYMMDD" = selected date
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
      // ── KEY FIX: sync Firebase keys → localStorage on every login/device ──
      await syncUserKeysToLocalStorage(user.uid);
      state.userDoc  = await getUserDoc(user.uid);
      state.savedIds = (state.userDoc?.savedPicks || []).map(p => p.id);
      renderUserUI(user);
      renderSavedSidebar(state.userDoc?.savedPicks || []);
      // Reload picks now that keys are available
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
}

function hideLoadingOverlay() {
  const el = document.getElementById("loading-overlay");
  if (el) { el.classList.add("hidden"); setTimeout(() => el.remove(), 400); }
}

// ─── Sport tabs ───────────────────────────────────────────────────────────────
function setupSportTabs() {
  document.querySelectorAll(".sport-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const sport = tab.dataset.sport;
      if (sport === state.activeSport && !state.activeDate || state.loading) return;
      document.querySelectorAll(".sport-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      state.activeSport = sport;
      localStorage.setItem(KEYS.sport, sport);
      loadSport(sport, state.activeDate);
    });
  });
  document.querySelector(`[data-sport="${state.activeSport}"]`)?.classList.add("active");
}

// ─── Date selector ────────────────────────────────────────────────────────────
function setupDateSelector() {
  const input = document.getElementById("date-selector");
  if (!input) return;

  // Set default value to today
  const today = new Date();
  input.value = today.toISOString().split("T")[0];  // "YYYY-MM-DD"

  input.addEventListener("change", () => {
    const val = input.value; // "YYYY-MM-DD"
    if (!val) {
      state.activeDate = null;
    } else {
      // ESPN wants "YYYYMMDD"
      state.activeDate = val.replace(/-/g, "");
    }
    loadSport(state.activeSport, state.activeDate);
  });

  document.getElementById("btn-today")?.addEventListener("click", () => {
    const today = new Date();
    input.value = today.toISOString().split("T")[0];
    state.activeDate = null;
    loadSport(state.activeSport, null);
  });
}

// ─── Load sport ───────────────────────────────────────────────────────────────
async function loadSport(sportKey, date = null) {
  state.loading  = true;
  state.pickData = [];
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

  try {
    state.games = await loadGamesForSport(sportKey, date);
    const upcoming = state.games.slice(0, 12);

    if (!upcoming.length) {
      const dateLabel = date
        ? new Date(date.replace(/(\d{4})(\d{2})(\d{2})/,"$1-$2-$3")).toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})
        : "today";
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">${CONFIG.sports[sportKey]?.emoji || "🏟"}</div>
          <div class="title">No pre-game events</div>
          <div class="desc">No upcoming ${CONFIG.sports[sportKey]?.label} games found for ${dateLabel}.<br>Live and completed games are excluded — try another date.</div>
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
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><div class="icon">⚠</div><div class="title">Failed to load</div><div class="desc">${e.message}</div></div>`;
  }
  state.loading = false;
}

async function onSaveChange() {
  if (state.user) {
    state.userDoc = await getUserDoc(state.user.uid);
    renderSavedSidebar(state.userDoc?.savedPicks || []);
  }
}

// ─── User UI ──────────────────────────────────────────────────────────────────
function renderUserUI(user) {
  const right = document.getElementById("nav-user-area");
  if (!right) return;
  const initials = (user.displayName || user.email || "U").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
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

// ─── Auth ─────────────────────────────────────────────────────────────────────
function showAuthTab(tab) {
  document.getElementById("auth-login-form").style.display    = tab === "login"    ? "block" : "none";
  document.getElementById("auth-register-form").style.display = tab === "register" ? "block" : "none";
  document.getElementById("auth-error").style.display = "none";
}

function showAuthError(raw) {
  const el = document.getElementById("auth-error");
  if (!el) return;
  // Map Firebase error codes to plain English
  const codes = {
    "auth/invalid-email":            "Invalid email address.",
    "auth/user-not-found":           "No account found with that email.",
    "auth/wrong-password":           "Incorrect password.",
    "auth/email-already-in-use":     "An account with that email already exists.",
    "auth/weak-password":            "Password must be at least 6 characters.",
    "auth/too-many-requests":        "Too many attempts. Try again in a few minutes.",
    "auth/network-request-failed":   "Network error — check your connection.",
    "auth/popup-closed-by-user":     "Sign-in popup was closed. Please try again.",
    "auth/cancelled-popup-request":  "Sign-in cancelled.",
    "auth/invalid-api-key":          "Firebase API key is invalid. Check js/config.js.",
    "auth/configuration-not-found":  "Firebase not configured. Replace FIREBASE_* placeholders in js/config.js.",
  };
  const match = Object.keys(codes).find(c => raw.includes(c));
  el.textContent = match ? codes[match] : raw.replace("Firebase: ","").replace(/ *\(.*\)/,"") || "Authentication failed. Check your Firebase setup in js/config.js.";
  el.style.display = "block";
}

async function handleGoogleLogin() {
  try { await loginGoogle(); closeModal("modal-auth"); toast("Welcome!"); }
  catch (e) { showAuthError(e.message); }
}

// ─── Profile ──────────────────────────────────────────────────────────────────
function openProfileModal() {
  const user = getCurrentUser();
  if (!user) return;
  const rec = state.userDoc?.record || { wins:0, losses:0, pushes:0 };
  document.getElementById("profile-name").textContent   = user.displayName || "Bettor";
  document.getElementById("profile-email").textContent  = user.email || "";
  document.getElementById("profile-wins").textContent   = rec.wins;
  document.getElementById("profile-losses").textContent = rec.losses;
  document.getElementById("profile-pushes").textContent = rec.pushes;
  openModal("modal-profile");
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function openSettingsModal() {
  const user = getCurrentUser();
  if (user) {
    // Always load from Firebase (source of truth)
    const keys = await getUserKeys(user.uid);
    for (const [k, v] of Object.entries(keys)) {
      const el = document.getElementById(`key-${k}`);
      if (el) el.value = v;
    }
  } else {
    // Guest: load from localStorage
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
  if (user) await saveUserKeys(user.uid, keys);  // saves to Firebase + localStorage
  closeModal("modal-settings");
  toast("Settings saved");
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
    try { await loginEmail(document.getElementById("login-email")?.value, document.getElementById("login-password")?.value); closeModal("modal-auth"); toast("Welcome back!"); }
    catch (e) { showAuthError(e.message); }
  });

  document.getElementById("auth-register-btn")?.addEventListener("click", async () => {
    try { await registerEmail(document.getElementById("register-email")?.value, document.getElementById("register-password")?.value, document.getElementById("register-name")?.value); closeModal("modal-auth"); toast("Account created!"); }
    catch (e) { showAuthError(e.message); }
  });

  document.getElementById("link-to-register")?.addEventListener("click", () => showAuthTab("register"));
  document.getElementById("link-to-login")?.addEventListener("click",    () => showAuthTab("login"));

  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    await logout(); closeModal("modal-profile"); toast("Signed out"); state.user = null; state.userDoc = null; renderGuestUI();
  });

  document.querySelectorAll(".key-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = btn.previousElementSibling;
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      btn.textContent = input.type === "password" ? "👁" : "🙈";
    });
  });

  document.getElementById("btn-refresh")?.addEventListener("click", () => loadSport(state.activeSport, state.activeDate));
}

window.openModal      = openModal;
window.closeAllModals = closeAllModals;

init();
