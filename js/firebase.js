// ── Firebase Auth + Firestore wrapper ──
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithPopup, signInWithEmailAndPassword,
         createUserWithEmailAndPassword, signOut, GoogleAuthProvider, updateProfile
       } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc,
         collection, query, orderBy, limit, getDocs, serverTimestamp
       } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let app, auth, db;

export function initFirebase() {
  app  = initializeApp(CONFIG.firebase);
  auth = getAuth(app);
  db   = getFirestore(app);
}

// ── Auth ──
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

// ── User doc ──
export async function ensureUserDoc(user) {
  if (!db || !user) return;
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      uid:         user.uid,
      displayName: user.displayName || "Bettor",
      email:       user.email,
      createdAt:   serverTimestamp(),
      picks:       [],
      savedPicks:  [],
      record:      { wins:0, losses:0, pushes:0 },
      keys:        {},
      prefs:       { defaultSport:"nba", notifications:false }
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

// ── Pick cache in Firestore (shared across all users) ──
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
  try {
    await setDoc(doc(db, "pick_cache", gameId), {
      ...pickData, cachedAt: Date.now()
    });
  } catch {}
}

// ── User saved picks ──
export async function savePick(uid, pick) {
  if (!db || !uid) return;
  const ref  = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const saved = snap.data().savedPicks || [];
  const exists = saved.find(p => p.id === pick.id);
  if (!exists) {
    saved.unshift({ ...pick, savedAt: Date.now() });
    await updateDoc(ref, { savedPicks: saved.slice(0, 100) });
  }
}

export async function unsavePick(uid, pickId) {
  if (!db || !uid) return;
  const ref  = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const saved = (snap.data().savedPicks || []).filter(p => p.id !== pickId);
  await updateDoc(ref, { savedPicks: saved });
}

// ── Save encrypted user keys ──
export async function saveUserKeys(uid, keys) {
  if (!db || !uid) return;
  // Simple base64 obfuscation (real encryption needs a backend)
  const enc = {};
  for (const [k, v] of Object.entries(keys)) {
    enc[k] = v ? btoa(v) : "";
  }
  await updateDoc(doc(db, "users", uid), { keys: enc });
}

export async function getUserKeys(uid) {
  if (!db || !uid) return {};
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return {};
  const enc = snap.data().keys || {};
  const dec = {};
  for (const [k, v] of Object.entries(enc)) {
    try { dec[k] = v ? atob(v) : ""; } catch { dec[k] = ""; }
  }
  return dec;
}
