import { auth, app } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection,
  query, where, getDocs, onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const db = getFirestore(app);
const $ = (id) => document.getElementById(id);

let me = null;             // { uid, name }
let circle = null;         // { id, name, code, ownerId }
let unsubMembers = null;
let unsubLocs = null;

let locs = new Map();        // uid -> { name, lat, lng, accuracy, updatedAt }
let people = [];             // current members

// ---------- duty (location) state ----------
const LOCATION_INTERVAL_MS = 30000;   // auto-refresh every 30 seconds
let watchId = null;
let sharing = false;                   // true = on duty
let lastPos = null;
let locationTimer = null;
let locationBusy = false;
let wakeLock = null;

// ---------- screens ----------
function show(which) {
  $("loading").classList.toggle("hidden", which !== "loading");
  $("gate").classList.toggle("hidden", which !== "gate");
  $("circle-view").classList.toggle("hidden", which !== "circle");
  $("circle-chip").classList.toggle("hidden", which !== "circle");
  $("leave").classList.toggle("hidden", which !== "circle");
}

function friendlyError(err) {
  if (err.code === "permission-denied") {
    return "Not allowed. Check that the latest Firestore rules are published.";
  }
  if (err.code === "unavailable") return "No internet connection.";
  return "Something went wrong. (" + (err.code || err.message) + ")";
}

function showFatal(err) {
  console.error(err);
  show("loading");
  $("loading").textContent = friendlyError(err);
}

// ---------- Toast & Status helpers ----------
let toastTimer = null;
function showToast(message, isError = false) {
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 4000);
}

function setStatus(text, type = "default") {
  const statusEl = $("duty-status");
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.remove("active", "refreshing", "error");
  if (type === "active") statusEl.classList.add("active");
  else if (type === "refreshing") statusEl.classList.add("refreshing");
  else if (type === "error") statusEl.classList.add("error");
}

// ---------- start ----------
// If users/{uid}.circleId is empty but the person is still a member of a circle
// (for example the profile write failed or was overwritten), find that circle again.
async function recoverCircleId() {
  const candidates = [];
  try {
    const last = localStorage.getItem("lastCircle:" + me.uid);
    if (last) candidates.push(last);
  } catch { /* ignore */ }
  try {
    const owned = await getDocs(query(collection(db, "circles"), where("ownerId", "==", me.uid)));
    owned.docs.forEach((d) => candidates.push(d.id));
  } catch (err) {
    console.warn("owner lookup failed", err);
  }
  for (const id of [...new Set(candidates)]) {
    try {
      const m = await getDoc(doc(db, "circles", id, "members", me.uid));
      if (m.exists()) {
        await setDoc(doc(db, "users", me.uid), { circleId: id, name: me.name }, { merge: true });
        return id;
      }
    } catch (err) {
      console.warn("recover check failed", err);
    }
  }
  return null;
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace("index.html");
    return;
  }
  me = { uid: user.uid, name: user.displayName || user.email.split("@")[0] };
  $("user-name").textContent = me.name;

  // Save name + email so the admin can see who has an account
  const profile = { name: me.name, email: user.email || null };
  let pendingUsername = null;
  try {
    const p = JSON.parse(localStorage.getItem("pendingUsername") || "null");
    // only apply it to the account that just signed up with that email
    if (p && user.email && p.email === user.email.toLowerCase()) pendingUsername = p.username;
  } catch { /* ignore */ }
  if (pendingUsername) profile.username = pendingUsername;

  setDoc(doc(db, "users", me.uid), profile, { merge: true })
    .then(() => { if (pendingUsername) { try { localStorage.removeItem("pendingUsername"); } catch { /* ignore */ } } })
    .catch((err) => console.warn("profile save failed", err));

  try {
    const snap = await getDoc(doc(db, "users", me.uid));
    let circleId = snap.exists() ? snap.data().circleId : null;
    if (!circleId) circleId = await recoverCircleId();   // self-heal if the profile lost its circle
    if (circleId) await openCircle(circleId);
    else show("gate");
  } catch (err) {
    showFatal(err);
  }
});

$("logout").addEventListener("click", async () => {
  await stopSharing();
  signOut(auth);
});

// ---------- helpers ----------
function avatarColor(name) {
  const h = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0);
  return "hsl(" + (Math.abs(h) % 360) + " 45% 36%)";
}

function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " hr ago";
  return Math.round(s / 86400) + " d ago";
}

// ---------- circle: open ----------
async function openCircle(circleId) {
  const snap = await getDoc(doc(db, "circles", circleId));
  if (!snap.exists()) {
    await setDoc(doc(db, "users", me.uid), { circleId: null }, { merge: true });
    show("gate");
    return;
  }
  circle = { id: snap.id, ...snap.data() };
  try { localStorage.setItem("lastCircle:" + me.uid, circle.id); } catch { /* ignore */ }
  $("circle-name").textContent = circle.name;
  $("circle-code").textContent = circle.code;
  show("circle");
  updateShareButton();

  if (unsubMembers) unsubMembers();
  unsubMembers = onSnapshot(
    collection(db, "circles", circle.id, "members"),
    (s) => {
      people = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
      renderMembers();
    },
    (err) => showFatal(err)
  );

  if (unsubLocs) unsubLocs();
  locs = new Map();
  unsubLocs = onSnapshot(
    collection(db, "circles", circle.id, "locations"),
    (s) => {
      locs = new Map(s.docs.map((d) => [d.id, d.data()]));
      renderMembers();
    },
    (err) => {
      setStatus(friendlyError(err), "error");
      showToast(friendlyError(err), true);
    }
  );

  // Auto-resume duty if it was on before (e.g. after a page reload)
  // Restore an unfinished trip, and resume duty if it was on before a reload
  const saved = getTripPref();
  if (saved) currentTrip = saved;
  updateShareButton();
  if (getSharePref() && !sharing) {
    if (currentTrip && !currentTrip.ended) startSharing();
    else setSharePref(false);   // nothing to continue
  }

}

// ---------- members list (with Owner Remove Support) ----------
async function removeMember(memberUid, memberName) {
  if (!confirm(`Talagang gusto mong alisin si ${memberName} sa circle na ito?`)) return;
  try {
    await deleteDoc(doc(db, "circles", circle.id, "members", memberUid));
    await setDoc(doc(db, "users", memberUid), { circleId: null }, { merge: true });
    showToast(`Naalis si ${memberName} sa circle.`);
  } catch (err) {
    showToast(friendlyError(err), true);
  }
}

function renderMembers() {
  const list = $("members");
  if (!list) return;
  list.replaceChildren();
  $("member-count").textContent = people.length;

  const isUserOwner = circle && circle.ownerId === me.uid;

  for (const p of people) {
    const li = document.createElement("li");
    li.className = "member";

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = (p.name[0] || "?").toUpperCase();
    avatar.style.background = avatarColor(p.name);

    const info = document.createElement("div");
    info.className = "member__info";
    const name = document.createElement("span");
    name.className = "member__name";
    name.textContent = p.name;
    const status = document.createElement("span");
    status.className = "member__status";
    const loc = locs.get(p.id);
    status.textContent = loc ? "On duty, " + timeAgo(loc.updatedAt) : "Off duty";
    info.append(name, status);
    li.append(avatar, info);

    const tags = [];
    if (p.id === me.uid) tags.push("You");
    if (p.id === circle.ownerId) tags.push("Owner");
    for (const t of tags) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = t;
      li.append(tag);
    }

    if (isUserOwner && p.id !== me.uid) {
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Remove";
      removeBtn.className = "btn-remove";
      removeBtn.style.cssText = "background: #dc2626; color: white; border: none; padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer; margin-left: auto; width: auto;";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeMember(p.id, p.name);
      });
      li.append(removeBtn);
    }

    list.append(li);
  }
}

setInterval(() => {
  if (circle) renderMembers();
}, 10000);

// =====================================================================
//  DUTY (location sharing under the hood)
// =====================================================================
const prefKey = () => "sharing:" + (me ? me.uid : "");
function getSharePref() {
  try { return localStorage.getItem(prefKey()) === "1"; } catch { return false; }
}
function setSharePref(on) {
  try { localStorage.setItem(prefKey(), on ? "1" : "0"); } catch { /* ignore */ }
}

// ---------- trips (from / to) ----------
let currentTrip = null;   // { id, from, to }
const tripKey = () => "trip:" + (me ? me.uid : "");
function getTripPref() {
  try { return JSON.parse(localStorage.getItem(tripKey()) || "null"); } catch { return null; }
}
function setTripPref(t) {
  try {
    if (t) localStorage.setItem(tripKey(), JSON.stringify(t));
    else localStorage.removeItem(tripKey());
  } catch { /* ignore */ }
}

// ---------- destination lookup + arrival check ----------
const GEO_COUNTRY = "ph";            // limit place search to the Philippines ("" = worldwide)
const ARRIVE_RADIUS_M = 150;         // within this distance of the destination = arrived
const ARRIVE_MAX_ACCURACY_M = 200;   // ignore GPS fixes less accurate than this

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Turns the typed destination into coordinates (OpenStreetMap Nominatim, free)
async function geocode(text) {
  try {
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1" +
      (GEO_COUNTRY ? "&countrycodes=" + GEO_COUNTRY : "") + "&q=" + encodeURIComponent(text);
    const res = await fetch(url);
    if (!res.ok) return null;
    const arr = await res.json();
    if (!arr.length) return null;
    const r = arr[0];
    const bb = (r.boundingbox || []).map(Number);   // [south, north, west, east]
    return {
      lat: Number(r.lat),
      lng: Number(r.lon),
      bbox: bb.length === 4 && bb.every(Number.isFinite) ? bb : null,
      label: String(r.display_name || "").slice(0, 120),
    };
  } catch {
    return null;
  }
}

// Records (once) that the driver reached the destination
async function checkArrival(pos) {
  const t = currentTrip;
  if (!t || t.arrivedAt || t.toLat == null || !circle || !pos) return;
  const { latitude, longitude, accuracy } = pos.coords;
  if (accuracy > ARRIVE_MAX_ACCURACY_M) return;

  const d = distanceM(latitude, longitude, t.toLat, t.toLng);
  const pad = 0.001;   // ~100 m around the place's area
  const inArea = t.toBbox &&
    latitude >= t.toBbox[0] - pad && latitude <= t.toBbox[1] + pad &&
    longitude >= t.toBbox[2] - pad && longitude <= t.toBbox[3] + pad;
  if (d > ARRIVE_RADIUS_M && !inArea) return;

  t.arrivedAt = Date.now();
  setTripPref(t);
  try {
    await updateDoc(doc(db, "circles", circle.id, "trips", t.id), {
      arrivedAt: t.arrivedAt,
      arrivedDistance: Math.round(d),
    });
    showToast("Arrival recorded: " + t.to);
  } catch (err) {
    console.warn("couldn't save arrival", err);
    t.arrivedAt = null;   // try again on the next update
  }
}

// Saves a new trip (From / To) so the admin can see it
async function submitTrip() {
  const from = $("trip-from").value.trim();
  const to = $("trip-to").value.trim();
  const errEl = $("trip-error");
  errEl.textContent = "";
  if (!circle) return;
  if (!from || !to) {
    errEl.textContent = "Enter where you're coming from and where you're going.";
    return;
  }
  try {
    setStatus("Looking up your destination…", "refreshing");
    const geo = await geocode(to);
    const ref = await addDoc(collection(db, "circles", circle.id, "trips"), {
      uid: me.uid,
      name: me.name,
      from: from.slice(0, 80),
      to: to.slice(0, 80),
      startedAt: Date.now(),
      status: "ongoing",
      toLat: geo ? geo.lat : null,
      toLng: geo ? geo.lng : null,
      toBbox: geo ? geo.bbox : null,
      toLabel: geo ? geo.label : null,
    });
    currentTrip = {
      id: ref.id,
      from: from.slice(0, 80),
      to: to.slice(0, 80),
      toLat: geo ? geo.lat : null,
      toLng: geo ? geo.lng : null,
      toBbox: geo ? geo.bbox : null,
      arrivedAt: null,
    };
    setTripPref(currentTrip);
    setStatus("Route submitted. Tap Start your duty when you're ready.");
    showToast("Route submitted: " + currentTrip.from + " → " + currentTrip.to);
    if (!geo) {
      showToast("Couldn't find \"" + to + "\" on the map, so the admin can't verify arrival. Try a more specific place or address next time.", true);
    }
  } catch (err) {
    const errText = friendlyError(err);
    errEl.textContent = errText;
    showToast(errText, true);
  }
}

// Marks the current trip as done
async function closeTrip() {
  const t = currentTrip;
  currentTrip = null;
  setTripPref(null);
  if (!t || !circle) return;
  try {
    await updateDoc(doc(db, "circles", circle.id, "trips", t.id), { status: "done", doneAt: Date.now() });
  } catch (err) {
    console.warn("couldn't close trip", err);
  }
}

// Remember when the user last started/ended duty (lets the admin see who is inactive)
async function stampDuty() {
  if (!circle || !me) return;
  try {
    await updateDoc(doc(db, "circles", circle.id, "members", me.uid), { lastDutyAt: Date.now() });   // update only: never re-creates a removed member
  } catch (err) {
    console.warn("duty stamp failed", err);
  }
}

// Route form: editable only when no route is open. Locked while a route exists.
// Done unlocks only after End your duty.
function updateTripUI() {
  const has = !!currentTrip;
  const from = $("trip-from"), to = $("trip-to");
  if (!from || !to) return;
  if (has) {
    from.value = currentTrip.from;
    to.value = currentTrip.to;
  }
  from.disabled = has;
  to.disabled = has;
  const submit = $("trip-submit");
  submit.disabled = has;
  submit.textContent = has ? "Submitted" : "Submit";
  $("trip-done").disabled = !(has && currentTrip.ended) || sharing;   // Done only after End your duty
}

function updateShareButton() {
  const btn = $("share-btn");
  if (!btn) return;
  btn.textContent = sharing ? "End your duty" : "Start your duty";
  btn.classList.toggle("is-sharing", sharing);
  btn.disabled = !sharing && !(currentTrip && !currentTrip.ended);   // needs a fresh route; after End duty, press Done first
  const state = $("duty-state");
  if (state) state.textContent = sharing ? "On duty" : "Off duty";
  updateTripUI();
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch { /* not supported or denied */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function startSharing() {
  if (!navigator.geolocation) {
    const errText = "This device can't share location.";
    setStatus(errText, "error");
    showToast(errText, true);
    return;
  }
  sharing = true;
  lastPos = null;
  updateShareButton();
  stampDuty();
  setStatus("Starting your duty… please allow location permission.", "refreshing");
  requestWakeLock();

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const first = !lastPos;
      lastPos = pos;
      if (first) writeLocation(pos);
    },
    onPositionError,
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  );

  if (locationTimer) clearInterval(locationTimer);
  locationTimer = setInterval(locationTick, LOCATION_INTERVAL_MS);
}

function locationTick() {
  if (!sharing || !circle || locationBusy) return;
  locationBusy = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      lastPos = pos;
      writeLocation(pos).finally(() => { locationBusy = false; });
    },
    () => {
      if (lastPos && Date.now() - lastPos.timestamp < 60000) {
        writeLocation(lastPos).finally(() => { locationBusy = false; });
      } else {
        locationBusy = false;
        setStatus("Still looking for your location…", "refreshing");
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 8000 }
  );
}

async function writeLocation(pos) {
  if (!circle || !sharing) return;
  const { latitude, longitude, accuracy } = pos.coords;
  try {
    await setDoc(doc(db, "circles", circle.id, "locations", me.uid), {
      name: me.name,
      lat: latitude,
      lng: longitude,
      accuracy: Math.round(accuracy),
      updatedAt: Date.now(),
    });
    setStatus("You're on duty. " + circle.name + " can see your status.", "active");
    checkArrival(pos);
  } catch (err) {
    const errText = friendlyError(err);
    setStatus(errText, "error");
    showToast(errText, true);
  }
}

async function onPositionError(err) {
  if (err.code === 1) {
    setSharePref(false);
    await stopSharing();
    const errText = "Location is blocked. Please allow Location in your phone settings.";
    setStatus(errText, "error");
    showToast(errText, true);
  } else if (err.code === 2) {
    setStatus("Your device can't find its location right now.", "refreshing");
  } else {
    setStatus("Still looking for your location…", "refreshing");
  }
}

async function stopSharing(message) {
  const finalPos = lastPos;     // last known position, for a final arrival check
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  if (locationTimer) clearInterval(locationTimer);
  watchId = null;
  locationTimer = null;
  locationBusy = false;
  lastPos = null;
  releaseWakeLock();

  const wasSharing = sharing;
  sharing = false;
  updateShareButton();
  if (wasSharing && circle) {
    await checkArrival(finalPos);
    if (currentTrip) {                 // duty ended: unlock Done (the route stays open until then)
      currentTrip.ended = true;
      setTripPref(currentTrip);
    }
    updateShareButton();
    await stampDuty();
    try {
      await deleteDoc(doc(db, "circles", circle.id, "locations", me.uid));
    } catch (err) {
      console.error(err);
    }
  }
  if (message) setStatus(message, "default");
}

// Duty button: start / end location sharing (needs a submitted route)
$("share-btn").addEventListener("click", async () => {
  if (sharing) {
    setSharePref(false);
    await stopSharing("Duty ended. Tap Done, then submit your next route (back to company or to your destination).");
  } else {
    if (!currentTrip || currentTrip.ended) {
      setStatus("Submit your route (From and To) first.", "error");
      return;
    }
    setSharePref(true);
    startSharing();
  }
});

// Route form: Submit
$("trip-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (currentTrip || sharing) return;
  const btn = $("trip-submit");
  btn.disabled = true;
  await submitTrip();
  updateShareButton();          // unlocks Start your duty, locks the route
});

// Route: Done. Only available after End your duty. Closes the route; a new one must be submitted.
$("trip-done").addEventListener("click", async () => {
  if (sharing || !currentTrip || !currentTrip.ended) return;
  await closeTrip();
  $("trip-from").value = "";
  $("trip-to").value = "";
  updateShareButton();
  setStatus("Route done. Submit your next route to start again.");
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (sharing) {
    requestWakeLock();
    locationTick();
  }
});

// ---------- circle: create / join / leave ----------
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode() {
  const bytes = new Uint32Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => CODE_CHARS[n % CODE_CHARS.length]).join("");
}

async function addMeToCircle(circleId) {
  await setDoc(doc(db, "circles", circleId, "members", me.uid), {
    name: me.name,
    joinedAt: serverTimestamp(),
  });
  await setDoc(doc(db, "users", me.uid), { circleId, name: me.name }, { merge: true });
  await openCircle(circleId);
}

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("circle-name-input").value.trim();
  $("create-error").textContent = "";
  if (!name) {
    $("create-error").textContent = "Give your circle a name.";
    return;
  }
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const ref = await addDoc(collection(db, "circles"), {
      name,
      code: makeCode(),
      ownerId: me.uid,
      createdAt: serverTimestamp(),
    });
    await addMeToCircle(ref.id);
  } catch (err) {
    const errText = friendlyError(err);
    $("create-error").textContent = errText;
    showToast(errText, true);
  } finally {
    btn.disabled = false;
  }
});

$("join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("code-input").value.trim().toUpperCase();
  $("join-error").textContent = "";
  if (code.length !== 6) {
    $("join-error").textContent = "Enter the 6-character code from your circle owner.";
    return;
  }
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const found = await getDocs(query(collection(db, "circles"), where("code", "==", code)));
    if (found.empty) {
      $("join-error").textContent = "No circle with that code. Check it and try again.";
    } else {
      await addMeToCircle(found.docs[0].id);
    }
  } catch (err) {
    const errText = friendlyError(err);
    $("join-error").textContent = errText;
    showToast(errText, true);
  } finally {
    btn.disabled = false;
  }
});

$("leave").addEventListener("click", async () => {
  if (!confirm("Leave " + circle.name + "? You can rejoin later with the invite code.")) return;
  try {
    setSharePref(false);
    await stopSharing();
    await closeTrip();      // finish any submitted trip before leaving
    if (unsubMembers) unsubMembers();
    if (unsubLocs) unsubLocs();
    unsubMembers = unsubLocs = null;

    await deleteDoc(doc(db, "circles", circle.id, "members", me.uid));
    await setDoc(doc(db, "users", me.uid), { circleId: null }, { merge: true });
    try { localStorage.removeItem("lastCircle:" + me.uid); } catch { /* ignore */ }
    circle = null;
    show("gate");
  } catch (err) {
    showFatal(err);
  }
});

$("copy-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(circle.code);
    showToast("Copied code to clipboard!");
  } catch (err) {
    showToast("Failed to copy code.", true);
  }
});