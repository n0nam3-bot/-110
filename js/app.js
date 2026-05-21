// ── Main app controller ──
import { initFirebase, onUserChange, ensureUserDoc, getCurrentUser,
         loginGoogle, loginEmail, registerEmail, logout,
         getUserDoc, updateUserDoc, saveUserKeys, getUserKeys } from "./firebase.js";
import { loadGamesForSport, getAllPicksForSport } from "./picks.js";
import { hasKeys } from "./ai.js";
import { renderGameCard, renderBestBetsSidebar, renderSavedSidebar,
         renderSummaryBar, attachSaveHandlers, attachToggleHandlers,
         renderSkeletons, toast, openModal, closeModal, closeAllModals } from "./ui.js";

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  user:          null,
  userDoc:       null,
  activeSport:   localStorage.getItem(KEYS.sport) || "nba",
  games:         [],
  pickData:      [],
  savedIds:      [],
  loading:       false
};

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  initFirebase();

  onUserChange(async (user) => {
    state.user = user;
    if (user) {
      await ensureUserDoc(user);
      state.userDoc = await getUserDoc(user.uid);
      state.savedIds = (state.userDoc?.savedPicks || []).map(p => p.id);
      renderUserUI(user);
      renderSavedSidebar(state.userDoc?.savedPicks || []);
    } else {
      renderGuestUI();
    }
  });

  setupSportTabs();
  setupModals();
  await loadSport(state.activeSport);
  hideLoadingOverlay();
}

// ─── Loading overlay ──────────────────────────────────────────────────────────
function hideLoadingOverlay() {
  const el = document.getElementById("loading-overlay");
  if (el) { el.classList.add("hidden"); setTimeout(() => el.remove(), 400); }
}

// ─── Sport tabs ───────────────────────────────────────────────────────────────
function setupSportTabs() {
  document.querySelectorAll(".sport-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const sport = tab.dataset.sport;
      if (sport === state.activeSport || state.loading) return;
      document.querySelectorAll(".sport-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      state.activeSport = sport;
      localStorage.setItem(KEYS.sport, sport);
      loadSport(sport);
    });
  });
  // Set initial active tab
  document.querySelector(`[data-sport="${state.activeSport}"]`)?.classList.add("active");
}

// ─── Load sport ───────────────────────────────────────────────────────────────
async function loadSport(sportKey) {
  state.loading = true;
  state.pickData = [];
  const container = document.getElementById("games-list");
  renderSkeletons(container, 5);
  document.getElementById("stat-games").textContent     = "–";
  document.getElementById("stat-bestbets").textContent  = "–";
  document.getElementById("stat-picks").textContent     = "–";
  document.getElementById("stat-sgrades").textContent   = "–";

  // Check for keys
  if (!hasKeys()) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">🔑</div>
        <div class="title">API Keys Required</div>
        <div class="desc">Add at least one free AI key (Gemini, Groq, or OpenRouter) in <a href="#" onclick="openModal('modal-settings')">Settings</a> to generate picks.</div>
      </div>
    `;
    state.loading = false;
    return;
  }

  try {
    state.games = await loadGamesForSport(sportKey);
    const upcoming = state.games.filter(g => !g.completed).slice(0, 12);

    if (!upcoming.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">${CONFIG.sports[sportKey]?.emoji || "🏟"}</div>
          <div class="title">No games today</div>
          <div class="desc">Check back when the ${CONFIG.sports[sportKey]?.label} schedule is active.</div>
        </div>
      `;
      state.loading = false;
      return;
    }

    // Render cards with "analyzing" state
    container.innerHTML = upcoming.map(g => renderGameCard(g, null, state.savedIds)).join("");
    attachToggleHandlers();

    // Analyze games one-by-one
    for (let i = 0; i < upcoming.length; i++) {
      const game = upcoming[i];
      try {
        const { getPicksForGame } = await import("./picks.js");
        const pickResult = await getPicksForGame(game);
        state.pickData.push(pickResult);

        // Update just this card
        const card = document.getElementById(`card-${game.id}`);
        if (card) {
          card.outerHTML = renderGameCard(game, pickResult, state.savedIds);
        }
        attachToggleHandlers();
        attachSaveHandlers(state.pickData, state.savedIds, () => {
          renderSavedSidebar(state.userDoc?.savedPicks || []);
        });

        renderBestBetsSidebar(state.pickData);
        renderSummaryBar(upcoming, state.pickData);
      } catch (e) {
        console.warn(`Game ${game.id} failed:`, e.message);
        const card = document.getElementById(`card-${game.id}`);
        if (card) {
          card.outerHTML = renderGameCard(game, { error: e.message, allPicks: [], bestBet: null }, state.savedIds);
        }
      }
    }
  } catch (e) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">⚠</div>
        <div class="title">Failed to load games</div>
        <div class="desc">${e.message}</div>
      </div>
    `;
  }

  state.loading = false;
}

// ─── User UI ──────────────────────────────────────────────────────────────────
function renderUserUI(user) {
  const right = document.getElementById("nav-user-area");
  if (!right) return;
  const initials = (user.displayName || user.email || "U").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  right.innerHTML = `
    <button class="nav-btn" id="btn-settings">⚙ Settings</button>
    <div class="user-pill" id="btn-profile">
      <div class="user-avatar">
        ${user.photoURL ? `<img src="${user.photoURL}" alt="">` : initials}
      </div>
      <span>${user.displayName?.split(" ")[0] || "Profile"}</span>
    </div>
  `;
  document.getElementById("btn-settings")?.addEventListener("click", () => openModal("modal-settings"));
  document.getElementById("btn-profile")?.addEventListener("click",  () => openProfileModal());
}

function renderGuestUI() {
  const right = document.getElementById("nav-user-area");
  if (!right) return;
  right.innerHTML = `
    <button class="nav-btn" id="btn-settings">⚙ Settings</button>
    <button class="nav-btn" id="btn-login">Sign In</button>
    <button class="nav-btn primary" id="btn-signup">Get Started</button>
  `;
  document.getElementById("btn-settings")?.addEventListener("click", () => openModal("modal-settings"));
  document.getElementById("btn-login")?.addEventListener("click",  () => { openModal("modal-auth"); showAuthTab("login"); });
  document.getElementById("btn-signup")?.addEventListener("click", () => { openModal("modal-auth"); showAuthTab("register"); });
}

// ─── Auth modal ───────────────────────────────────────────────────────────────
function showAuthTab(tab) {
  document.getElementById("auth-login-form").style.display    = tab === "login"    ? "block" : "none";
  document.getElementById("auth-register-form").style.display = tab === "register" ? "block" : "none";
}

async function handleGoogleLogin() {
  try {
    await loginGoogle();
    closeModal("modal-auth");
    toast("Welcome back!");
  } catch (e) {
    showAuthError(e.message);
  }
}

function showAuthError(msg) {
  let el = document.getElementById("auth-error");
  if (!el) return;
  el.textContent = msg.replace("Firebase: ", "").replace(/ *\(.*\)/, "");
  el.style.display = "block";
}

// ─── Profile modal ────────────────────────────────────────────────────────────
function openProfileModal() {
  const user = getCurrentUser();
  if (!user) return;
  const doc = state.userDoc;
  const rec = doc?.record || { wins:0, losses:0, pushes:0 };

  document.getElementById("profile-name").textContent  = user.displayName || "Bettor";
  document.getElementById("profile-email").textContent = user.email || "";
  document.getElementById("profile-wins").textContent   = rec.wins;
  document.getElementById("profile-losses").textContent = rec.losses;
  document.getElementById("profile-pushes").textContent = rec.pushes;
  openModal("modal-profile");
}

// ─── Settings modal ───────────────────────────────────────────────────────────
async function openSettingsModal() {
  // Load stored keys
  const user = getCurrentUser();
  if (user) {
    const keys = await getUserKeys(user.uid);
    for (const [k, v] of Object.entries(keys)) {
      const el = document.getElementById(`key-${k}`);
      if (el) el.value = v;
    }
  } else {
    // Load from localStorage
    for (const name of ["oddsApi", "gemini", "groq", "openrouter", "balldontlie"]) {
      const el = document.getElementById(`key-${name}`);
      if (el) el.value = localStorage.getItem(KEYS[name]) || "";
    }
  }
  openModal("modal-settings");
}

async function saveSettings() {
  const keys = {};
  for (const name of ["oddsApi", "gemini", "groq", "openrouter", "balldontlie"]) {
    const el = document.getElementById(`key-${name}`);
    keys[name] = el?.value?.trim() || "";
    localStorage.setItem(KEYS[name], keys[name]);
  }
  const user = getCurrentUser();
  if (user) await saveUserKeys(user.uid, keys);
  closeModal("modal-settings");
  toast("Settings saved");
  // Reload with new keys
  await loadSport(state.activeSport);
}

// ─── Modal setup ─────────────────────────────────────────────────────────────
function setupModals() {
  // Close on overlay click
  document.querySelectorAll(".modal-overlay").forEach(overlay => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeAllModals();
    });
  });
  document.querySelectorAll(".modal-close").forEach(btn => {
    btn.addEventListener("click", () => closeAllModals());
  });

  // Settings tabs
  document.querySelectorAll(".settings-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".settings-section").forEach(s => s.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`settings-${tab.dataset.tab}`)?.classList.add("active");
    });
  });

  // Settings open
  document.getElementById("btn-settings-open")?.addEventListener("click", openSettingsModal);

  // Save settings
  document.getElementById("btn-save-settings")?.addEventListener("click", saveSettings);

  // Auth
  document.getElementById("btn-google-login")?.addEventListener("click",  handleGoogleLogin);
  document.getElementById("btn-google-register")?.addEventListener("click", handleGoogleLogin);

  document.getElementById("auth-login-btn")?.addEventListener("click", async () => {
    const email = document.getElementById("login-email")?.value;
    const pass  = document.getElementById("login-password")?.value;
    try {
      await loginEmail(email, pass);
      closeModal("modal-auth");
      toast("Welcome back!");
    } catch (e) { showAuthError(e.message); }
  });

  document.getElementById("auth-register-btn")?.addEventListener("click", async () => {
    const name  = document.getElementById("register-name")?.value;
    const email = document.getElementById("register-email")?.value;
    const pass  = document.getElementById("register-password")?.value;
    try {
      await registerEmail(email, pass, name);
      closeModal("modal-auth");
      toast("Account created! Welcome to -110");
    } catch (e) { showAuthError(e.message); }
  });

  document.getElementById("link-to-register")?.addEventListener("click", () => showAuthTab("register"));
  document.getElementById("link-to-login")?.addEventListener("click",    () => showAuthTab("login"));

  // Logout
  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    await logout();
    closeModal("modal-profile");
    toast("Signed out");
    renderGuestUI();
  });

  // Key visibility toggles
  document.querySelectorAll(".key-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = btn.previousElementSibling;
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      btn.textContent = input.type === "password" ? "👁" : "🙈";
    });
  });

  // Settings button in nav (will be set dynamically, but add fallback)
  document.getElementById("btn-settings-open-2")?.addEventListener("click", openSettingsModal);

  // Refresh btn
  document.getElementById("btn-refresh")?.addEventListener("click", () => loadSport(state.activeSport));
}

// Make openModal globally accessible for inline onclick
window.openModal = openModal;

// ─── Start ────────────────────────────────────────────────────────────────────
init();
