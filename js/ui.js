// ── UI helpers ──
import { formatOdds } from "./picks.js";
import { gradeColor } from "./ai.js";
import { savePick, unsavePick, getCurrentUser } from "./firebase.js";

export function toast(msg, type = "success", duration = 3000) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type === "success" ? "✓" : type === "error" ? "✕" : "ℹ"}</span> ${msg}`;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 300); }, duration);
}

export function openModal(id)    { const el = document.getElementById(id); if (el) el.classList.add("open"); }
export function closeModal(id)   { const el = document.getElementById(id); if (el) el.classList.remove("open"); }
export function closeAllModals() { document.querySelectorAll(".modal-overlay").forEach(m => m.classList.remove("open")); }

export function renderSkeletons(container, count = 4) {
  container.innerHTML = Array(count).fill(0).map(() => `
    <div class="skeleton-card">
      <div class="skeleton skeleton-line" style="width:70%"></div>
      <div class="skeleton skeleton-line-sm"></div>
      <div class="skeleton skeleton-line" style="width:90%"></div>
      <div class="skeleton skeleton-line-sm" style="width:50%"></div>
    </div>`).join("");
}

export function gradeBadge(grade) {
  return `<span class="badge grade-${grade?.toLowerCase()}">${grade || "?"}</span>`;
}

export function formatGameTime(dateStr) {
  if (!dateStr) return "";
  const d   = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit", hour12:true });
  return d.toLocaleDateString("en-US", { month:"short", day:"numeric" }) + " " +
         d.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit", hour12:true });
}

export function teamLogoHtml(team) {
  if (team?.logo) return `<img class="team-logo" src="${team.logo}" alt="${team.abbr}" onerror="this.outerHTML='<div class=team-logo-placeholder>${team.abbr||"?"}</div>'">`;
  return `<div class="team-logo-placeholder">${team?.abbr || "?"}</div>`;
}

function oddsStripHtml(game) {
  const o = game.odds;
  if (!o) return `<div class="odds-strip"><div class="odds-cell" style="width:100%;text-align:center"><span class="odds-label">Add Odds-API key in Settings for live lines</span></div></div>`;
  return `
    <div class="odds-strip">
      <div class="odds-cell">
        <div class="odds-label">Spread</div>
        <div class="odds-val">${o.spread?.home?.point > 0 ? "+" : ""}${o.spread?.home?.point ?? "N/A"}</div>
        <div class="odds-sub">${formatOdds(o.spread?.home?.price)}</div>
      </div>
      <div class="odds-cell">
        <div class="odds-label">Total</div>
        <div class="odds-val">${o.total?.over?.point ?? "N/A"}</div>
        <div class="odds-sub">O ${formatOdds(o.total?.over?.price)}</div>
      </div>
      <div class="odds-cell">
        <div class="odds-label">${game.homeTeam.abbr} ML</div>
        <div class="odds-val">${formatOdds(o.moneyline?.home?.price)}</div>
      </div>
      <div class="odds-cell">
        <div class="odds-label">${game.awayTeam.abbr} ML</div>
        <div class="odds-val">${formatOdds(o.moneyline?.away?.price)}</div>
      </div>
    </div>`;
}

export function pickRowHtml(pick, savedIds = [], isBestBet = false) {
  const gc      = gradeColor(pick.grade);
  const isSaved = savedIds.includes(pick.id);
  const typeLabel = pick.type === "prop"
    ? (pick.marketLabel || "Prop")
    : (pick.type?.replace(/_/g," ") || "Pick").toUpperCase();

  return `
    <div class="pick-row ${isBestBet ? "pick-row-best" : ""}" data-pick-id="${pick.id}">
      <div class="pick-grade" style="background:${gc};color:#0a0a0a">${pick.grade}</div>
      <div class="pick-body">
        <div class="pick-selection">${pick.selection}</div>
        <div class="pick-reasoning">${pick.reasoning || ""}</div>
      </div>
      <div class="pick-right">
        <div class="pick-odds">${formatOdds(pick.odds)}</div>
        <div class="pick-conf">${pick.confidence?.toFixed(1)} conf · ${pick.edge?.toFixed(1)}% edge</div>
        <span class="badge badge-type">${typeLabel}</span>
      </div>
      <button class="save-btn ${isSaved ? "saved" : ""}" data-pick-id="${pick.id}" title="${isSaved ? "Unsave" : "Save pick"}">
        ${isSaved ? "★" : "☆"}
      </button>
    </div>`;
}

export function renderGameCard(game, pickResult, savedIds = []) {
  const hasBestBet = !!pickResult?.bestBet;
  const allPicks   = pickResult?.allPicks || [];
  const analyzing  = !pickResult;
  const hasError   = pickResult?.error;
  const bestBetId  = pickResult?.bestBet?.id;

  // Sort picks: S first, then A, then B, then C
  const gradeOrder = { S:0, A:1, B:2, C:3 };
  const sortedPicks = [...allPicks].sort((a,b) => (gradeOrder[a.grade]??9) - (gradeOrder[b.grade]??9));

  return `
    <div class="game-card ${hasBestBet ? "has-best-bet" : ""}" id="card-${game.id}">
      <div class="game-card-header">
        <div class="game-teams">
          <div class="teams-col">
            <div class="team-row">
              ${teamLogoHtml(game.awayTeam)}
              <span class="team-name">${game.awayTeam.name}</span>
              <span class="team-record">${game.awayTeam.record || ""}</span>
            </div>
            <div class="team-row">
              ${teamLogoHtml(game.homeTeam)}
              <span class="team-name">${game.homeTeam.name}</span>
              <span class="team-record">${game.homeTeam.record || ""}</span>
            </div>
          </div>
        </div>
        <div class="game-meta">
          ${game.live
            ? `<span class="game-status-live">LIVE</span>`
            : `<span class="game-time">${formatGameTime(game.date)}</span>`}
          ${game.promotion ? `<span class="mma-promotion-badge">${game.promotion}</span>` : ""}
          ${game.eventName && game.sport === "mma" ? `<span style="font-size:.60rem;color:var(--text3);display:block;max-width:90px;text-align:right;line-height:1.2">${game.eventName}</span>` : ""}
          ${game.broadcast ? `<span style="font-size:.62rem;color:var(--text3)">${game.broadcast}</span>` : ""}
        </div>
      </div>

      ${oddsStripHtml(game)}

      <div class="pick-section" id="picks-${game.id}">
        ${analyzing ? `
          <div class="analyzing-row"><div class="spinner"></div><span>Analyzing matchup…</span></div>
        ` : pickResult?.noAnalysis ? `
          <div class="no-value-row" style="color:var(--text3,#555);font-size:.72rem">Odds only — select fewer sports to run AI analysis on this game</div>
        ` : hasError ? `
          <div class="no-value-row">⚠ Analysis unavailable — check API keys in Settings</div>
        ` : sortedPicks.length > 0 ? `
          ${hasBestBet ? `
            <div class="best-bet-banner">
              <span class="best-bet-label">🔥 Best Bet</span>
              <div class="best-bet-content">
                <div class="best-bet-selection">${pickResult.bestBet.selection}</div>
                <div class="best-bet-meta">
                  <span class="best-bet-odds">${formatOdds(pickResult.bestBet.odds)}</span>
                  ${gradeBadge(pickResult.bestBet.grade)}
                  <span class="badge badge-conf">${pickResult.bestBet.confidence?.toFixed(1)} conf · ${pickResult.bestBet.edge?.toFixed(1)}% edge</span>
                </div>
                <div class="best-bet-reasoning">${pickResult.bestBet.reasoning || ""}</div>
              </div>
            </div>` : ""}
          <div class="all-picks-header">
            <span>All Picks (${sortedPicks.length})</span>
          </div>
          <div class="picks-list">
            ${sortedPicks.map(p => pickRowHtml(p, savedIds, p.id === bestBetId)).join("")}
          </div>
        ` : `
          <div class="no-value-row">No qualifying picks found for this game — no edge detected.</div>
        `}
      </div>

      ${pickResult?.gameAnalysis?.summary ? `
        <button class="card-toggle" data-card="${game.id}">
          <span>Analysis</span> <span class="arrow">▼</span>
        </button>
        <div class="game-summary-text" id="summary-${game.id}" style="display:none">
          ${pickResult.gameAnalysis.summary}
        </div>` : ""}
    </div>`;
}

export function attachSaveHandlers(allPickData, savedIds, onSaveChange) {
  document.querySelectorAll(".save-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const pickId = btn.dataset.pickId;
      const user   = getCurrentUser();
      if (!user) { toast("Sign in to save picks", "error"); return; }

      let foundPick = null;
      for (const pd of allPickData) {
        const match = (pd.allPicks || []).find(p => p.id === pickId);
        if (match) { foundPick = { ...match, gameId: pd.gameId, gameLabel: pd.game?.shortName }; break; }
        if (pd.bestBet?.id === pickId) { foundPick = { ...pd.bestBet, gameId: pd.gameId, gameLabel: pd.game?.shortName }; break; }
      }
      if (!foundPick) return;

      const isSaved = savedIds.includes(pickId);
      if (isSaved) {
        await unsavePick(user.uid, pickId);
        savedIds.splice(savedIds.indexOf(pickId), 1);
        btn.textContent = "☆"; btn.classList.remove("saved");
        toast("Pick removed");
      } else {
        await savePick(user.uid, foundPick);
        savedIds.push(pickId);
        btn.textContent = "★"; btn.classList.add("saved");
        toast("Pick saved ★");
      }
      onSaveChange?.();
    });
  });
}

export function attachToggleHandlers() {
  document.querySelectorAll(".card-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const id   = btn.dataset.card;
      const body = document.getElementById(`summary-${id}`);
      if (!body) return;
      const isOpen = body.style.display !== "none";
      body.style.display = isOpen ? "none" : "block";
      btn.classList.toggle("open", !isOpen);
    });
  });
}

export function renderBestBetsSidebar(allPickData) {
  const list = document.getElementById("best-bets-list");
  if (!list) return;
  const bets = allPickData.filter(pd => pd.bestBet);
  if (!bets.length) { list.innerHTML = `<div class="saved-empty">Best bets load as games are analyzed</div>`; return; }
  list.innerHTML = bets.map(pd => `
    <div class="bb-item" onclick="document.getElementById('card-${pd.gameId}')?.scrollIntoView({behavior:'smooth',block:'center'})">
      <div class="bb-game">${pd.game?.shortName || pd.gameId}</div>
      <div class="bb-selection">${pd.bestBet.selection}</div>
      <div class="bb-meta">
        <span class="bb-odds">${formatOdds(pd.bestBet.odds)}</span>
        ${gradeBadge(pd.bestBet.grade)}
        <span class="badge badge-conf">${pd.bestBet.confidence?.toFixed(1)}</span>
      </div>
    </div>`).join("");
}

export function renderSummaryBar(games, allPickData) {
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setVal("stat-games",    games.length);
  setVal("stat-bestbets", allPickData.filter(pd => pd.bestBet).length);
  setVal("stat-picks",    allPickData.reduce((a, pd) => a + (pd.allPicks?.length || 0), 0));
  setVal("stat-sgrades",  allPickData.reduce((a, pd) => a + (pd.allPicks || []).filter(p => p.grade === "S").length, 0));
}

export function renderSavedSidebar(savedPicks) {
  const list = document.getElementById("saved-list");
  if (!list) return;
  if (!savedPicks?.length) { list.innerHTML = `<div class="saved-empty">No saved picks yet — star a pick to save it</div>`; return; }
  list.innerHTML = savedPicks.map(p => `
    <div class="bb-item">
      <div class="bb-game">${p.gameLabel || "Game"}</div>
      <div class="bb-selection">${p.selection}</div>
      <div class="bb-meta">
        <span class="bb-odds">${formatOdds(p.odds)}</span>
        ${gradeBadge(p.grade)}
      </div>
    </div>`).join("");
}
