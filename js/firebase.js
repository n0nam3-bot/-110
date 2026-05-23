import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithPopup, signInWithEmailAndPassword,
         createUserWithEmailAndPassword, signOut, GoogleAuthProvider, updateProfile,
         sendPasswordResetEmail
       } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp
       } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let app, auth, db;

export function initFirebase() {
  if (CONFIG.firebase.apiKey.startsWith("FIREBASE_")) {
    console.error("Replace FIREBASE_* placeholders in js/config.js");
    _showSetupBanner();
    return;
  }
  app  = initializeApp(CONFIG.firebase);
  auth = getAuth(app);
  db   = getFirestore(app);
}

function _showSetupBanner() {
  if (document.getElementById("fb-setup-banner")) return;
  const b = document.createElement("div");
  b.id = "fb-setup-banner";
  b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#1a1a00;border-bottom:2px solid #b5f23d;padding:14px 20px;font-family:monospace;font-size:13px;color:#b5f23d;text-align:center;line-height:1.6";
  b.innerHTML = `<strong>⚙ Setup Required</strong> — Open <code>js/config.js</code> and replace <code>FIREBASE_*</code> with your real Firebase credentials. <a href="https://console.firebase.google.com" target="_blank" style="color:#b5f23d">console.firebase.google.com →</a>`;
  document.body.prepend(b);
}

export function getCurrentUser() { return auth?.currentUser || null; }
export function onUserChange(cb) { if (!auth) return; onAuthStateChanged(auth, cb); }
export async function loginGoogle() { return signInWithPopup(auth, new GoogleAuthProvider()); }
export async function loginEmail(email, password) { return signInWithEmailAndPassword(auth, email, password); }
export async function logout() { return signOut(auth); }
export async function sendPasswordReset(email) {
  if (!auth) throw new Error("Firebase not initialised");
  return sendPasswordResetEmail(auth, email);
}

export async function registerEmail(email, password, displayName) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  // Use provided display name, fall back to email prefix — never "Bettor"
  const name = displayName?.trim() || email.split("@")[0];
  await updateProfile(cred.user, { displayName: name });
  await ensureUserDoc({ ...cred.user, displayName: name });
  return cred;
}

export async function ensureUserDoc(user) {
  if (!db || !user) return;
  const ref  = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    // Never store "Bettor" — use display name or email prefix
    const name = user.displayName?.trim() || user.email?.split("@")[0] || "Member";
    await setDoc(ref, {
      uid: user.uid, displayName: name,
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

export async function getCachedPick(gameId) {
  if (!db) return null;
  try {
    const snap = await getDoc(doc(db, "pick_cache", gameId));
    if (!snap.exists()) return null;
    const d = snap.data();
    if (Date.now() - d.cachedAt > CONFIG.cache.picks) return null;
    return d;
  } catch { return null; }
}

export async function setCachedPick(gameId, data) {
  if (!db) return;
  try { await setDoc(doc(db, "pick_cache", gameId), { ...data, cachedAt: Date.now() }); } catch {}
}

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

function _enc(v) { try { return v ? btoa(v) : ""; } catch { return ""; } }
function _dec(v) { try { return v ? atob(v) : ""; } catch { return ""; } }

export async function saveUserKeys(uid, keys) {
  if (!db || !uid) return;
  const enc = {};
  for (const [k, v] of Object.entries(keys)) enc[k] = _enc(v);
  await updateDoc(doc(db, "users", uid), { keys: enc });
  _writeKeysToLS(keys);
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

export async function syncUserKeysToLocalStorage(uid) {
  try { _writeKeysToLS(await getUserKeys(uid)); } catch (e) { console.warn("Key sync:", e.message); }
}

function _writeKeysToLS(keys) {
  const map = { oddsApi:KEYS.oddsApi, gemini:KEYS.gemini, groq:KEYS.groq, openrouter:KEYS.openrouter, balldontlie:KEYS.balldontlie };
  for (const [name, lsKey] of Object.entries(map))
    if (keys[name] !== undefined) localStorage.setItem(lsKey, keys[name]);
}
