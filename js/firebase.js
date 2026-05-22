import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithPopup, signInWithEmailAndPassword,
         createUserWithEmailAndPassword, signOut, GoogleAuthProvider, updateProfile
       } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp
       } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let app, auth, db;

export function initFirebase() {
  // Detect un-replaced placeholders and bail with a clear message
  if (CONFIG.firebase.apiKey.startsWith("FIREBASE_")) {
    console.error(
      "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      " -110 SETUP REQUIRED\n" +
      " Open js/config.js and replace the\n" +
      " FIREBASE_* placeholders with your real\n" +
      " Firebase project credentials.\n" +
      " Get them free at: console.firebase.google.com\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    );
    showFirebaseSetupBanner();
    return;
  }
  app  = initializeApp(CONFIG.firebase);
  auth = getAuth(app);
  db   = getFirestore(app);
}

function showFirebaseSetupBanner() {
  const existing = document.getElementById("firebase-setup-banner");
  if (existing) return;
  const banner = document.createElement("div");
  banner.id = "firebase-setup-banner";
  banner.style.cssText = [
    "position:fixed","top:0","left:0","right:0","z-index:9999",
    "background:#1a1a00","border-bottom:2px solid #b5f23d",
    "padding:14px 20px","font-family:monospace","font-size:13px",
    "color:#b5f23d","line-height:1.6","text-align:center"
  ].join(";");
  banner.innerHTML = [
    "<strong>⚙ -110 Setup Required</strong><br>",
    "Open <code style='background:#2a2a00;padding:2px 6px;border-radius:3px'>js/config.js</code> and replace the ",
    "<code style='background:#2a2a00;padding:2px 6px;border-radius:3px'>FIREBASE_*</code> placeholders ",
    "with your real Firebase credentials.<br>",
    "<span style='color:#888;font-size:11px'>Get them free at ",
    "<a href='https://console.firebase.google.com' target='_blank' style='color:#b5f23d'>console.firebase.google.com</a>",
    " → Project Settings → Your Apps → Web app config</span>"
  ].join("");
  document.body.prepend(banner);
}

export function getCurrentUser() { return auth?.currentUser || null; }

export function onUserChange(cb) {
  if (!auth) return;
  onAuthStateChanged(auth, cb);
}

export async function loginGoogle() {
  const provider = new GoogleAuthProvider();
  return signInWithPopup(auth, provider);
}

export async function loginEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export async function registerEmail(email, password, displayName) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName });
  await ensureUserDoc(cred.user);
  return cred;
}

export async function logout() { return signOut(auth); }

export async function ensureUserDoc(user) {
  if (!db || !user) return;
  const ref  = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      uid: user.uid, displayName: user.displayName || "Bettor",
      email: user.email, createdAt: serverTimestamp(),
      picks: [], savedPicks: [],
      record: { wins:0, losses:0, pushes:0 },
      keys: {}, prefs: { defaultSport:"nba", notifications:false }
    });
  }
}

export async function getUserDoc(uid) {
  if (!db) return null;
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

export async function updateUserDoc(uid, data) {
  if (!db) return;
  await updateDoc(doc(db, "users", uid), data);
}

// ── Pick cache ──────────────────────────────────────────────────────────────
export async function getCachedPick(gameId) {
  if (!db) return null;
  try {
    const ref  = doc(db, "pick_cache", gameId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const d = snap.data();
    if (Date.now() - d.cachedAt > CONFIG.cache.picks) return null;
    return d;
  } catch { return null; }
}

export async function setCachedPick(gameId, pickData) {
  if (!db) return;
  try { await setDoc(doc(db, "pick_cache", gameId), { ...pickData, cachedAt: Date.now() }); } catch {}
}

// ── Saved picks ─────────────────────────────────────────────────────────────
export async function savePick(uid, pick) {
  if (!db || !uid) return;
  const ref  = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const saved = snap.data().savedPicks || [];
  if (!saved.find(p => p.id === pick.id)) {
    saved.unshift({ ...pick, savedAt: Date.now() });
    await updateDoc(ref, { savedPicks: saved.slice(0, 100) });
  }
}

export async function unsavePick(uid, pickId) {
  if (!db || !uid) return;
  const ref  = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  await updateDoc(ref, { savedPicks: (snap.data().savedPicks || []).filter(p => p.id !== pickId) });
}

// ── Keys: store encrypted in Firestore, sync to localStorage ───────────────
// IMPORTANT: keys are stored per-user in Firebase so they follow the account
// across all devices. On every login we push them to localStorage so the
// rest of the app can read them synchronously without extra async calls.

function _enc(v) { try { return v ? btoa(v) : ""; } catch { return ""; } }
function _dec(v) { try { return v ? atob(v) : ""; } catch { return ""; } }

export async function saveUserKeys(uid, keys) {
  if (!db || !uid) return;
  const enc = {};
  for (const [k, v] of Object.entries(keys)) enc[k] = _enc(v);
  await updateDoc(doc(db, "users", uid), { keys: enc });
  // Also sync to localStorage immediately
  _writeKeysToLocalStorage(keys);
}

export async function getUserKeys(uid) {
  if (!db || !uid) return {};
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return {};
  const enc = snap.data().keys || {};
  const dec = {};
  for (const [k, v] of Object.entries(enc)) dec[k] = _dec(v);
  return dec;
}

// Called on every login — syncs Firebase keys → localStorage so keys
// are immediately available on any device without opening Settings.
export async function syncUserKeysToLocalStorage(uid) {
  try {
    const keys = await getUserKeys(uid);
    _writeKeysToLocalStorage(keys);
  } catch (e) {
    console.warn("Key sync failed:", e.message);
  }
}

function _writeKeysToLocalStorage(keys) {
  const map = {
    oddsApi:     KEYS.oddsApi,
    gemini:      KEYS.gemini,
    groq:        KEYS.groq,
    openrouter:  KEYS.openrouter,
    balldontlie: KEYS.balldontlie
  };
  for (const [name, lsKey] of Object.entries(map)) {
    if (keys[name] !== undefined) {
      localStorage.setItem(lsKey, keys[name]);
    }
  }
}
