import { app as driverApp } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeAuth, browserSessionPersistence, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, deleteDoc, updateDoc, collection, onSnapshot, query, orderBy, limit, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// The admin uses its own Firebase app instance whose login lives only in THIS tab.
// That way an admin login never replaces the driver's login in another tab.
const app = initializeApp(driverApp.options, "admin");
const auth = initializeAuth(app, { persistence: browserSessionPersistence });
const db = getFirestore(app);
const $ = (id) => document.getElementById(id);

const STALE_MS = 10 * 60 * 1000;   // dim pins not updated for 10 minutes
const INACTIVE_DAYS = 7;            // off duty + no duty for this long = inactive

let unsubCircles = null;
let unsubUsers = null;
let accounts = [];          // everyone with a profile doc in "users"
let accountFilter = "";
const circles = new Map();   // circleId -> { id, name, code, members: [], locs: Map, unsubM, unsubL }
let selected = null;         // circleId or null (= all circles)

let map = null;
const markers = new Map();   // "circleId:uid" -> Leaflet marker
let shownKeys = new Set();        // pins currently on the map
let lastUserMove = 0;            // when the admin last moved/zoomed the map by hand
let programmatic = false;

// Movement history per driver: key -> { points: [{lat,lng,t,acc}], trail, circle }
const history = new Map();
const lastSeen = new Map();   // "circleId:uid" -> last known { lat, lng, t, name }
const ghostMarkers = new Map();
const MAX_POINTS = 30;

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

const loadErrors = new Map();
function showLoadError(label, err) {
  console.error(label, err);
  loadErrors.set(label, err.code || err.message);
  const el = $("load-error");
  el.textContent = "Couldn't load: " + [...loadErrors].map(([l, c]) => l + " (" + c + ")").join(", ");
  el.classList.remove("hidden");
}

function setTab(name) {
  $("admin").dataset.active = name;
  document.querySelectorAll("#tabbar button").forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle("is-active", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (name === "map" && map) setTimeout(() => map.invalidateSize(), 0);   // map was hidden
}
document.querySelectorAll("#tabbar button").forEach((b) => {
  b.addEventListener("click", () => setTab(b.dataset.tab));
});

function show(which) {
  $("tabbar").classList.toggle("hidden", which !== "admin");
  $("loading").classList.toggle("hidden", which !== "loading");
  $("denied").classList.toggle("hidden", which !== "denied");
  $("admin").classList.toggle("hidden", which !== "admin");
}

// ---------- movement + accuracy helpers ----------
function distanceM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function recordFix(key, loc) {
  let h = history.get(key);
  if (!h) {
    h = { points: [], trail: null, circle: null };
    history.set(key, h);
  }
  lastSeen.set(key, { lat: loc.lat, lng: loc.lng, t: loc.updatedAt, name: loc.name });
  const last = h.points[h.points.length - 1];
  if (!last || last.t !== loc.updatedAt) {
    h.points.push({ lat: loc.lat, lng: loc.lng, t: loc.updatedAt, acc: loc.accuracy || 0 });
    if (h.points.length > MAX_POINTS) h.points.shift();
  }
}

function dropHistory(key) {
  const h = history.get(key);
  if (!h) return;
  if (h.trail) h.trail.remove();
  if (h.circle) h.circle.remove();
  history.delete(key);
}

function accuracyLabel(acc) {
  if (!acc) return "Accuracy unknown";
  const q = acc <= 30 ? "Good" : acc <= 100 ? "Fair" : "Poor";
  return "±" + Math.round(acc) + " m (" + q + ")";
}

// Compares the last two fixes. Movement smaller than the GPS error counts as not moving.
function movementInfo(key) {
  const h = history.get(key);
  if (!h || h.points.length < 2) return { text: "First fix, waiting for next update", short: "" };
  const a = h.points[h.points.length - 2];
  const b = h.points[h.points.length - 1];
  const d = distanceM(a, b);
  const secs = Math.max(1, (b.t - a.t) / 1000);
  const threshold = Math.max(15, b.acc || 0);
  if (d <= threshold) return { text: "Not moving (changed " + Math.round(d) + " m)", short: "Stopped" };
  const kmh = (d / secs) * 3.6;
  return {
    text: "Moved " + Math.round(d) + " m in " + Math.round(secs) + " s (" + Math.round(kmh) + " km/h)",
    short: "Moving " + Math.round(kmh) + " km/h",
  };
}

// ---------- auth + admin check ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace("admin-login.html");
    return;
  }
  $("user-name").textContent = user.displayName || user.email.split("@")[0];

  try {
    // Rules only allow reading this doc if your email is in the admin list
    try {
      await getDoc(doc(db, "admins", "check"));
    } catch (err) {
      if (err.code === "permission-denied") {
        $("denied").textContent = "This account (" + user.email + ") doesn't have admin access.";
        show("denied");
        return;
      }
      throw err;
    }
    show("admin");
    $("project-note").textContent = "Firebase project: " + (app.options.projectId || "unknown");
    initMap();
    watchCircles();
    watchUsers();
  } catch (err) {
    console.error(err);
    show("loading");
    $("loading").textContent = err.code === "permission-denied"
      ? "Not allowed. Check the Firestore rules for admins."
      : "Something went wrong. (" + (err.code || err.message) + ")";
  }
});

$("logout").addEventListener("click", () => {
  stopAll();
  signOut(auth);
});

// ---------- realtime data ----------
function watchCircles() {
  unsubCircles = onSnapshot(collection(db, "circles"), (snap) => {
    const seen = new Set();
    for (const d of snap.docs) {
      seen.add(d.id);
      const data = d.data();
      let c = circles.get(d.id);
      if (!c) {
        c = { id: d.id, members: [], locs: new Map(), trips: [], unsubM: null, unsubL: null, unsubT: null };
        circles.set(d.id, c);
        watchCircle(c);
      }
      c.name = data.name;
      c.code = data.code;
      c.ownerId = data.ownerId;
    }
    for (const id of [...circles.keys()]) {
      if (!seen.has(id)) removeCircle(id);
    }
    renderAll();
  }, (err) => showLoadError("circles", err));
}

function watchUsers() {
  unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
    accounts = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    renderAccounts();
  }, (err) => showLoadError("accounts", err));
}

function watchCircle(c) {
  c.unsubM = onSnapshot(collection(db, "circles", c.id, "members"), (s) => {
    c.members = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  }, (err) => showLoadError("members", err));

  c.unsubL = onSnapshot(collection(db, "circles", c.id, "locations"), (s) => {
    c.locs = new Map(s.docs.map((d) => [d.id, d.data()]));
    for (const [uid, l] of c.locs) recordFix(c.id + ":" + uid, l);
    for (const key of [...history.keys()]) {
      if (key.startsWith(c.id + ":") && !c.locs.has(key.slice(c.id.length + 1))) dropHistory(key);
    }
    renderAll();
  }, (err) => showLoadError("locations", err));

  // latest trips (from / to) of this circle
  c.unsubT = onSnapshot(
    query(collection(db, "circles", c.id, "trips"), orderBy("startedAt", "desc"), limit(100)),
    (s) => {
      c.trips = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    },
    (err) => showLoadError("trips", err)
  );
}

function removeCircle(id) {
  const c = circles.get(id);
  if (!c) return;
  if (c.unsubM) c.unsubM();
  if (c.unsubL) c.unsubL();
  if (c.unsubT) c.unsubT();
  for (const key of [...history.keys()]) if (key.startsWith(id + ":")) dropHistory(key);
  circles.delete(id);
  if (selected === id) selected = null;
}

function stopAll() {
  if (unsubCircles) unsubCircles();
  unsubCircles = null;
  if (unsubUsers) unsubUsers();
  unsubUsers = null;
  for (const id of [...circles.keys()]) removeCircle(id);
}

// ---------- map ----------
function initMap() {
  if (!map) {
    map = L.map("map").setView([14.5995, 120.9842], 11);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
  }
  map.on("dragstart zoomstart", () => { if (!programmatic) lastUserMove = Date.now(); });
  setTimeout(() => map.invalidateSize(), 0);
}

// map moves made by the page itself must not count as the admin moving the map
function moveMap(fn) {
  programmatic = true;
  fn();
  setTimeout(() => { programmatic = false; }, 1500);
}

function pinIcon(name) {
  const el = document.createElement("span");
  el.textContent = (name[0] || "?").toUpperCase();
  el.style.background = avatarColor(name);
  return L.divIcon({ className: "pin", html: el, iconSize: [38, 38], iconAnchor: [19, 19] });
}

// Drivers currently visible given the selected circle
function visibleDrivers() {
  const out = [];
  for (const c of circles.values()) {
    if (selected && c.id !== selected) continue;
    for (const [uid, l] of c.locs) {
      out.push({ key: c.id + ":" + uid, circle: c, uid, loc: l });
    }
  }
  return out.sort((a, b) => (a.loc.name || "").localeCompare(b.loc.name || ""));
}

function drawPins() {
  if (!map) return;
  const drivers = visibleDrivers();
  const keep = new Set(drivers.map((d) => d.key));

  for (const [key, m] of markers) {
    if (!keep.has(key)) {
      m.remove();
      markers.delete(key);
    }
  }
  for (const [key, h] of history) {
    if (!keep.has(key)) {
      if (h.trail) { h.trail.remove(); h.trail = null; }
      if (h.circle) { h.circle.remove(); h.circle = null; }
    }
  }

  const pos = displayPositions(drivers);
  for (const d of drivers) {
    try {
    const name = d.loc.name || "?";
    const info = movementInfo(d.key);
    const popup = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = name;
    popup.append(strong);
    const trip = d.circle.trips.find((t) => t.uid === d.uid && t.status !== "done");
    for (const line of [
      d.circle.name + " · updated " + timeAgo(d.loc.updatedAt),
      trip ? "Route: " + (trip.from || "?") + " → " + (trip.to || "?") : "No route submitted",
      "Accuracy: " + accuracyLabel(d.loc.accuracy),
      info.text,
    ]) {
      popup.append(document.createElement("br"), document.createTextNode(line));
    }
    const hb = document.createElement("button");
    hb.type = "button";
    hb.className = "act";
    hb.textContent = "View history";
    hb.style.marginTop = "8px";
    hb.addEventListener("click", () => openHistory(d.uid, name));
    popup.append(document.createElement("br"), hb);

    let m = markers.get(d.key);
    if (!m) {
      m = L.marker(pos.get(d.key), { icon: pinIcon(name) }).addTo(map);
      m.bindTooltip(name, { permanent: true, direction: "top", offset: [0, -22], className: "pin-label" });
      m.bindPopup(popup);
      markers.set(d.key, m);
    } else {
      m.setLatLng(pos.get(d.key));   // pin jumps to the new position on each update
      m.setPopupContent(popup);
    }
    const stale = Date.now() - d.loc.updatedAt > STALE_MS;
    m.setOpacity(stale ? 0.5 : 1);

    // accuracy circle + trail of recent positions
    const h = history.get(d.key);
    if (h) {
      const color = avatarColor(name);
      const latlngs = h.points.map((p) => [p.lat, p.lng]);
      if (d.loc.accuracy) {
        if (!h.circle) h.circle = L.circle([d.loc.lat, d.loc.lng], { radius: d.loc.accuracy, color, weight: 1, fillColor: color, fillOpacity: 0.12 }).addTo(map);
        else h.circle.setLatLng([d.loc.lat, d.loc.lng]).setRadius(d.loc.accuracy);
      }
      if (latlngs.length > 1) {
        if (!h.trail) h.trail = L.polyline(latlngs, { color, weight: 3, opacity: 0.7 }).addTo(map);
        else h.trail.setLatLngs(latlngs);
      }
    }
    } catch (err) {
      console.error("pin failed", d.key, err);
    }
  }

  // when a new driver shows up, zoom out to include everyone (unless the admin is looking around)
  const fresh = drivers.some((d) => !shownKeys.has(d.key));
  shownKeys = keep;
  if (fresh && Date.now() - lastUserMove > 20000) fitToVisible();
}

// Drivers standing within ~20 m of each other would hide behind one pin: fan them out a little
function displayPositions(drivers) {
  const pos = new Map(drivers.map((d) => [d.key, [d.loc.lat, d.loc.lng]]));
  const used = new Set();
  for (let i = 0; i < drivers.length; i++) {
    if (used.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < drivers.length; j++) {
      if (used.has(j)) continue;
      const a = drivers[i].loc, b = drivers[j].loc;
      if (distanceM({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }) < 20) group.push(j);
    }
    if (group.length < 2) continue;
    const cLat = group.reduce((n, k) => n + drivers[k].loc.lat, 0) / group.length;
    const cLng = group.reduce((n, k) => n + drivers[k].loc.lng, 0) / group.length;
    group.forEach((k, n) => {
      used.add(k);
      const ang = (2 * Math.PI * n) / group.length;
      const r = 18;   // metres
      pos.set(drivers[k].key, [
        cLat + (r * Math.cos(ang)) / 111320,
        cLng + (r * Math.sin(ang)) / (111320 * Math.cos((cLat * Math.PI) / 180)),
      ]);
    });
  }
  return pos;
}

// Faded "last seen" pin for a driver who is still on duty but whose live location stopped
function drawGhosts() {
  if (!map) return;
  const keep = new Set();
  for (const c of circles.values()) {
    if (selected && c.id !== selected) continue;
    for (const t of c.trips) {
      if (t.status === "done" || !t.dutyStartedAt || t.dutyEndedAt) continue;
      if (c.locs.has(t.uid)) continue;
      const key = c.id + ":" + t.uid;
      const seen = lastSeen.get(key);
      if (!seen) continue;
      keep.add(key);
      const text = (seen.name || t.name || "?") + " · last seen " + timeAgo(seen.t);
      let m = ghostMarkers.get(key);
      if (!m) {
        m = L.marker([seen.lat, seen.lng], { icon: pinIcon(seen.name || "?"), opacity: 0.45 }).addTo(map);
        m.bindTooltip(text, { permanent: true, direction: "top", offset: [0, -22], className: "pin-label" });
        ghostMarkers.set(key, m);
      } else {
        m.setTooltipContent(text);
      }
    }
  }
  for (const [key, m] of ghostMarkers) {
    if (!keep.has(key)) { m.remove(); ghostMarkers.delete(key); }
  }
}

function fitToVisible() {
  if (!map) return;
  const pts = visibleDrivers().map((d) => [d.loc.lat, d.loc.lng]);
  if (pts.length === 0) return;
  moveMap(() => {
    if (pts.length === 1) map.setView(pts[0], 16);
    else map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 17 });
  });
}

// ---------- sidebar ----------
function renderCircles() {
  const list = $("circles");
  list.replaceChildren();
  $("circle-count").textContent = circles.size;

  const all = document.createElement("li");
  const totalLive = [...circles.values()].reduce((n, c) => n + c.locs.size, 0);
  all.append(makeRow("All circles", circles.size + " circles", totalLive, selected === null, () => selectCircle(null)));
  list.append(all);

  const sorted = [...circles.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  for (const c of sorted) {
    const li = document.createElement("li");
    const sub = c.members.length + " member" + (c.members.length === 1 ? "" : "s") + " · Code " + (c.code || "—");
    li.className = "circle-li";
    li.append(makeRow(c.name || "Untitled", sub, c.locs.size, selected === c.id, () => selectCircle(c.id)));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "act act--danger";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete circle " + (c.name || "Untitled"));
    del.addEventListener("click", () => {
      selectCircle(c.id);      // opens the manage panel so the result message is visible
      deleteCircle(c);
    });
    li.append(del);
    list.append(li);
  }
}

function makeRow(title, sub, liveCount, isSelected, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "row" + (isSelected ? " is-selected" : "");
  btn.setAttribute("aria-pressed", String(isSelected));

  const main = document.createElement("span");
  main.className = "row__main";
  const t = document.createElement("span");
  t.className = "row__title";
  t.textContent = title;
  const s = document.createElement("span");
  s.className = "row__sub";
  s.textContent = sub;
  main.append(t, s);

  const badge = document.createElement("span");
  badge.className = "badge" + (liveCount > 0 ? " is-live" : "");
  badge.textContent = liveCount + " on duty";

  btn.append(main, badge);
  btn.addEventListener("click", onClick);
  return btn;
}

// Drivers who started duty but have no live location right now
function noSignalDrivers() {
  const out = [];
  for (const c of circles.values()) {
    if (selected && c.id !== selected) continue;
    for (const t of c.trips) {
      if (t.status === "done" || !t.dutyStartedAt || t.dutyEndedAt) continue;
      if (c.locs.has(t.uid)) continue;
      out.push({ circle: c, trip: t });
    }
  }
  return out;
}

function renderDrivers() {
  const list = $("drivers");
  list.replaceChildren();
  const drivers = visibleDrivers();
  const lost = noSignalDrivers();
  $("driver-count").textContent = drivers.length + lost.length;
  $("drivers-empty").classList.toggle("hidden", drivers.length + lost.length > 0);

  for (const x of lost) {
    const name = x.trip.name || "?";
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "row";
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = (name[0] || "?").toUpperCase();
    avatar.style.background = avatarColor(name);
    const main = document.createElement("span");
    main.className = "row__main";
    const t = document.createElement("span");
    t.className = "row__title";
    t.textContent = name;
    const sub = document.createElement("span");
    sub.className = "row__sub";
    const seen = lastSeen.get(x.circle.id + ":" + x.trip.uid);
    sub.textContent = x.circle.name + " · on duty since " + fmtTime(x.trip.dutyStartedAt) +
      (seen ? ", last seen " + timeAgo(seen.t) : ", no location yet") +
      (x.trip.locIssue ? " · Reason: " + x.trip.locIssue : "");
    main.append(t, sub);
    const badge = document.createElement("span");
    badge.className = "badge bad";
    badge.textContent = "No signal";
    row.append(avatar, main, badge);
    li.append(row);
    list.append(li);
  }

  for (const d of drivers) {
    const name = d.loc.name || "?";
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "row";

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = (name[0] || "?").toUpperCase();
    avatar.style.background = avatarColor(name);

    const main = document.createElement("span");
    main.className = "row__main";
    const t = document.createElement("span");
    t.className = "row__title";
    t.textContent = name;
    const s = document.createElement("span");
    s.className = "row__sub";
    const mv = movementInfo(d.key).short;
    s.textContent = d.circle.name + " · " + timeAgo(d.loc.updatedAt) +
      (d.loc.accuracy ? " · ±" + Math.round(d.loc.accuracy) + " m" : "") + (mv ? " · " + mv : "");
    main.append(t, s);

    btn.append(avatar, main);
    btn.addEventListener("click", () => focusDriver(d.key, d.loc));
    li.append(btn);
    list.append(li);
  }
}

function focusDriver(key, loc) {
  const m = markers.get(key);
  if (!m) return;
  moveMap(() => map.flyTo([loc.lat, loc.lng], 17));
  m.openPopup();
}

function selectCircle(id) {
  selected = id;
  const c = id ? circles.get(id) : null;
  $("map-note").textContent = c ? "Showing " + c.name : "Showing all circles";
  renderAll();
  fitToVisible();
  if (c) $("manage").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderAll() {
  // each part runs on its own, so one bad record can't stop the map or lists from updating
  for (const fn of [renderTrips, drawDestinations, renderAccounts, renderCircles, renderManage, renderDrivers, drawPins, drawGhosts]) {
    try { fn(); } catch (err) { console.error(fn.name, err); }
  }
}


// ---------- trips table (below the map) ----------
function fmtDate(ms) {
  return new Date(ms).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}
function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function renderTrips() {
  const body = $("trips-body");
  if (!body) return;
  body.replaceChildren();

  const rows = [];
  for (const c of circles.values()) {
    if (selected && c.id !== selected) continue;
    for (const t of c.trips) if (!t.clearedAt) rows.push({ t, circle: c });
  }
  rows.sort((a, b) => (b.t.startedAt || 0) - (a.t.startedAt || 0));
  const shown = rows.slice(0, 100);

  const doneRows = rows.filter((r) => r.t.status === "done");
  const clearBtn = $("clear-done");
  clearBtn.disabled = doneRows.length === 0;
  clearBtn.textContent = "Clear done (" + doneRows.length + ")";

  $("trip-count").textContent = rows.length;
  const sel = selected ? circles.get(selected) : null;
  $("trip-scope").textContent = sel ? "· " + sel.name : "· All circles";
  $("trips-empty").classList.toggle("hidden", rows.length > 0);

  for (const { t, circle } of shown) {
    const tr = document.createElement("tr");
    const cells = [
      t.name || "?",
      circle.name || "—",
      t.from || "—",
      t.to || "—",
      t.startedAt ? fmtDate(t.startedAt) : "—",
      t.startedAt ? fmtTime(t.startedAt) : "—",
    ];
    const labels = ["Driver", "Circle", "From", "To", "Date", "Time"];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.dataset.label = labels[i];
      td.textContent = text;
      tr.append(td);
    });
    const st = document.createElement("td");
    st.dataset.label = "Status";
    const badge = document.createElement("span");
    const done = t.status === "done";
    badge.className = "badge" + (done ? "" : " is-live");
    badge.textContent = done ? "Done" + (t.doneAt ? " " + fmtTime(t.doneAt) : "") : "Ongoing";
    st.append(badge);
    tr.append(st);

    const ar = document.createElement("td");
    ar.dataset.label = "Arrival";
    const info = arrivalInfo(t, circle);
    const ab = document.createElement("span");
    ab.className = "badge" + (info.cls ? " " + info.cls : "");
    ab.textContent = info.text;
    ar.append(ab);
    tr.append(ar);

    const act = document.createElement("td");
    act.className = "td-action";
    if (done) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "act";
      del.textContent = "Clear";
      del.setAttribute("aria-label", "Clear trip " + (t.from || "") + " to " + (t.to || "") + " from the table");
      del.addEventListener("click", () => clearTrip(circle, t));
      act.append(del);
    }
    tr.append(act);
    body.append(tr);
  }
}

// ---------- clear finished trips from the table (history is kept) ----------
function setTripsNotice(text, isError = false) {
  const el = $("trips-notice");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

// Only hides the trip from the Trips table. The trip stays in the driver's History.
async function clearTrip(circle, t) {
  setTripsNotice("");
  try {
    await updateDoc(doc(db, "circles", circle.id, "trips", t.id), { clearedAt: Date.now() });
  } catch (err) {
    console.error(err);
    setTripsNotice("Couldn't clear the trip. (" + (err.code || err.message) + ")", true);
  }
}

$("clear-done").addEventListener("click", async () => {
  const targets = [];
  for (const c of circles.values()) {
    if (selected && c.id !== selected) continue;
    for (const t of c.trips) if (t.status === "done" && !t.clearedAt) targets.push({ c, t });
  }
  if (targets.length === 0) return;

  setTripsNotice("Clearing…");
  let failed = 0;
  const now = Date.now();
  await Promise.all(targets.map(({ c, t }) =>
    updateDoc(doc(db, "circles", c.id, "trips", t.id), { clearedAt: now }).catch((err) => { failed++; console.error(err); })
  ));
  setTripsNotice(
    failed
      ? failed + " couldn't be cleared."
      : "Cleared " + targets.length + " done trip(s) from the table. They are still in each driver's history.",
    failed > 0
  );
});

// ---------- did the driver actually reach the destination? ----------
function fmtDist(m) {
  return m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(1) + " km";
}

function arrivalInfo(t, circle) {
  if (t.arrivedAt) return { text: "Arrived " + fmtTime(t.arrivedAt), cls: "ok" };
  if (t.toLat == null) return { text: "Can't verify", cls: "" };
  if (t.status === "done") return { text: "Did not arrive", cls: "bad" };
  const loc = circle.locs.get(t.uid);
  if (loc) {
    const d = distanceM({ lat: loc.lat, lng: loc.lng }, { lat: t.toLat, lng: t.toLng });
    return { text: fmtDist(d) + " away", cls: "" };
  }
  if (t.dutyStartedAt && !t.dutyEndedAt) return { text: "No location signal", cls: "bad" };
  return { text: "Not arrived yet", cls: "" };
}

// Destination flags + a dashed line from the driver's live pin, for unfinished trips
const destLayers = new Map();   // tripId -> { marker, line }
function drawDestinations() {
  if (!map) return;
  const keep = new Set();
  for (const c of circles.values()) {
    if (selected && c.id !== selected) continue;
    for (const t of c.trips) {
      if (t.status === "done" || t.toLat == null) continue;
      keep.add(t.id);
      let layer = destLayers.get(t.id);
      if (!layer) {
        const marker = L.marker([t.toLat, t.toLng], {
          icon: L.divIcon({ className: "dest", html: "🏁", iconSize: [28, 28], iconAnchor: [6, 26] }),
        }).addTo(map);
        marker.bindTooltip((t.name || "?") + " → " + (t.to || ""), { direction: "top", offset: [8, -24] });
        layer = { marker, line: null };
        destLayers.set(t.id, layer);
      }
      const loc = c.locs.get(t.uid);
      if (loc) {
        const pts = [[loc.lat, loc.lng], [t.toLat, t.toLng]];
        if (!layer.line) layer.line = L.polyline(pts, { color: "#f2b01e", weight: 2, dashArray: "6 6", opacity: 0.9 }).addTo(map);
        else layer.line.setLatLngs(pts);
      } else if (layer.line) {
        layer.line.remove();
        layer.line = null;
      }
    }
  }
  for (const [id, layer] of destLayers) {
    if (!keep.has(id)) {
      layer.marker.remove();
      if (layer.line) layer.line.remove();
      destLayers.delete(id);
    }
  }
}

// ---------- driver history ----------
let histDriver = null;     // { uid, name }
let histTrips = [];
let histRange = "all";     // "7" | "30" | "all"
let histToken = 0;

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "<1 min";
  if (m < 60) return m + " min";
  return Math.floor(m / 60) + " h " + (m % 60) + " min";
}

function arrivalText(t) {
  if (t.arrivedAt) return "Arrived " + fmtTime(t.arrivedAt);
  if (t.toLat == null) return "Can't verify";
  return t.status === "done" ? "Did not arrive" : "In progress";
}

function dutyText(t) {
  if (!t.dutyStartedAt) return "—";
  const end = t.dutyEndedAt || (t.status === "done" ? t.doneAt : null);
  return end ? fmtDuration(end - t.dutyStartedAt) : "On duty";
}

function histRows() {
  if (histRange === "all") return histTrips;
  const cutoff = Date.now() - Number(histRange) * 86400000;
  return histTrips.filter((t) => (t.startedAt || 0) >= cutoff);
}

function renderHistory() {
  const rows = histRows();
  const done = rows.filter((t) => t.status === "done").length;
  const arrived = rows.filter((t) => t.arrivedAt).length;
  const missed = rows.filter((t) => !t.arrivedAt && t.toLat != null && t.status === "done").length;
  const unknown = rows.filter((t) => !t.arrivedAt && t.toLat == null).length;

  $("hist-sub").textContent = "Includes trips cleared from the Trips table.";

  const sum = $("hist-summary");
  sum.replaceChildren();
  for (const [label, value] of [["Trips", rows.length], ["Done", done], ["Arrived", arrived], ["Did not arrive", missed], ["Can't verify", unknown]]) {
    const chip = document.createElement("div");
    chip.className = "hist-chip";
    const b = document.createElement("b");
    b.textContent = value;
    chip.append(b, document.createTextNode(label));
    sum.append(chip);
  }

  document.querySelectorAll("#hist-filters .act[data-range]").forEach((b) => b.classList.toggle("is-on", b.dataset.range === histRange));

  const body = $("hist-body");
  body.replaceChildren();
  $("hist-empty").classList.toggle("hidden", rows.length > 0);
  $("hist-csv").disabled = rows.length === 0;

  const labels = ["Date", "Time", "From", "To", "Duty time", "Arrival", "Status"];
  for (const t of rows) {
    const tr = document.createElement("tr");
    const cells = [
      t.startedAt ? fmtDate(t.startedAt) : "—",
      t.startedAt ? fmtTime(t.startedAt) : "—",
      t.from || "—",
      t.to || "—",
      dutyText(t),
      arrivalText(t),
      t.status === "done" ? "Done" + (t.doneAt ? " " + fmtTime(t.doneAt) : "") : "Ongoing",
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.dataset.label = labels[i];
      td.textContent = text;
      tr.append(td);
    });
    body.append(tr);
  }
}

async function openHistory(uid, name) {
  histDriver = { uid, name };
  histRange = "all";
  histTrips = [];
  const token = ++histToken;

  $("hist-title").textContent = "History · " + name;
  $("hist-sub").textContent = "Loading…";
  $("hist-summary").replaceChildren();
  $("hist-body").replaceChildren();
  $("hist-empty").classList.add("hidden");
  $("hist-csv").disabled = true;
  $("history").classList.remove("hidden");
  $("hist-close").focus();

  try {
    const all = await Promise.all([...circles.values()].map(async (c) => {
      const snap = await getDocs(query(collection(db, "circles", c.id, "trips"), where("uid", "==", uid)));
      return snap.docs.map((d) => ({ id: d.id, circleName: c.name, ...d.data() }));
    }));
    if (token !== histToken) return;   // another driver was opened meanwhile
    histTrips = all.flat().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    renderHistory();
  } catch (err) {
    console.error(err);
    $("hist-sub").textContent = "Couldn't load history. (" + (err.code || err.message) + ")";
  }
}

function closeHistory() {
  histToken++;
  $("history").classList.add("hidden");
}

function downloadHistoryCsv() {
  const rows = histRows();
  const esc = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const lines = [["Date", "Time", "Circle", "From", "To", "Duty time", "Arrival", "Status"].map(esc).join(",")];
  for (const t of rows) {
    lines.push([
      t.startedAt ? fmtDate(t.startedAt) : "",
      t.startedAt ? fmtTime(t.startedAt) : "",
      t.circleName || "",
      t.from || "",
      t.to || "",
      dutyText(t),
      arrivalText(t),
      t.status === "done" ? "Done" : "Ongoing",
    ].map(esc).join(","));
  }
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "history-" + (histDriver ? histDriver.name.replace(/[^\w-]+/g, "_") : "driver") + "-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$("hist-close").addEventListener("click", closeHistory);
$("history").addEventListener("click", (e) => { if (e.target === $("history")) closeHistory(); });
$("history").addEventListener("keydown", (e) => { if (e.key === "Escape") closeHistory(); });
$("hist-csv").addEventListener("click", downloadHistoryCsv);
document.querySelectorAll("#hist-filters .act[data-range]").forEach((b) => {
  b.addEventListener("click", () => { histRange = b.dataset.range; renderHistory(); });
});

// ---------- all accounts ----------
function renderAccounts() {
  const list = $("accounts");
  if (!list) return;
  list.replaceChildren();

  const q = accountFilter.trim().toLowerCase();
  const rows = accounts
    .map((a) => {
      const c = a.circleId ? circles.get(a.circleId) : null;
      return {
        uid: a.uid,
        name: a.name || ("User " + a.uid.slice(0, 6)),
        email: a.email || "",
        username: a.username || (a.email ? a.email.split("@")[0] : ""),
        circle: c || null,
        onDuty: !!(c && c.locs.has(a.uid)),
      };
    })
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q) || r.username.toLowerCase().includes(q) ||
      (r.circle && (r.circle.name || "").toLowerCase().includes(q)))
    .sort((a, b) => (b.onDuty - a.onDuty) || a.name.localeCompare(b.name));

  $("account-count").textContent = accounts.length;
  $("accounts-empty").classList.toggle("hidden", rows.length > 0);

  for (const r of rows) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "row";

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = (r.name[0] || "?").toUpperCase();
    avatar.style.background = avatarColor(r.name);

    const main = document.createElement("span");
    main.className = "row__main";
    const t = document.createElement("span");
    t.className = "row__title";
    t.textContent = r.name;
    const mail = document.createElement("span");
    mail.className = "row__sub";
    mail.textContent = r.username ? "@" + r.username + (r.email ? " · " + r.email : "") : "Username not recorded yet";
    const sub = document.createElement("span");
    sub.className = "row__sub";
    sub.textContent = r.circle ? "Circle: " + r.circle.name : "No circle";
    main.append(t, mail, sub);

    const badge = document.createElement("span");
    badge.className = "badge" + (r.onDuty ? " is-live" : " is-off");
    badge.textContent = r.onDuty ? "On duty" : "Off duty";

    btn.append(avatar, main, badge);
    if (r.circle) btn.addEventListener("click", () => selectCircle(r.circle.id));
    li.className = "circle-li";
    li.append(btn);
    const hb = document.createElement("button");
    hb.type = "button";
    hb.className = "act";
    hb.textContent = "History";
    hb.setAttribute("aria-label", "History of " + r.name);
    hb.addEventListener("click", () => openHistory(r.uid, r.name));
    li.append(hb);
    list.append(li);
  }
}

$("account-search").addEventListener("input", (e) => {
  accountFilter = e.target.value;
  renderAccounts();
});

// ---------- manage: remove members / delete circle ----------
function setNotice(text, isError = false) {
  const el = $("notice");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function lastActiveMs(m) {
  if (m.lastDutyAt) return m.lastDutyAt;
  if (m.joinedAt && typeof m.joinedAt.toMillis === "function") return m.joinedAt.toMillis();
  return 0;
}

function isInactive(c, m) {
  if (m.id === c.ownerId) return false;       // never auto-flag the owner
  if (c.locs.has(m.id)) return false;         // on duty right now
  return Date.now() - lastActiveMs(m) > INACTIVE_DAYS * 86400000;
}

function lastActiveText(c, m) {
  if (c.locs.has(m.id)) return "On duty now";
  if (m.lastDutyAt) return "Last on duty " + timeAgo(m.lastDutyAt);
  const j = lastActiveMs(m);
  return j ? "No duty recorded · joined " + timeAgo(j) : "No duty recorded";
}

function renderManage() {
  const c = selected ? circles.get(selected) : null;
  $("manage").classList.toggle("hidden", !c);
  if (!c) return;

  $("manage-title").textContent = c.name || "Circle";
  const list = $("members-list");
  list.replaceChildren();

  const members = [...c.members].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const inactive = members.filter((m) => isInactive(c, m));
  const btn = $("remove-inactive");
  btn.textContent = "Remove inactive (" + inactive.length + ")";
  btn.disabled = inactive.length === 0;

  for (const m of members) {
    const name = m.name || "?";
    const li = document.createElement("li");
    li.className = "mrow" + (isInactive(c, m) ? " is-inactive" : "");

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = (name[0] || "?").toUpperCase();
    avatar.style.background = avatarColor(name);

    const main = document.createElement("span");
    main.className = "row__main";
    const t = document.createElement("span");
    t.className = "row__title";
    t.textContent = name + (m.id === c.ownerId ? " (owner)" : "");
    const sub = document.createElement("span");
    sub.className = "row__sub";
    sub.textContent = lastActiveText(c, m);
    main.append(t, sub);

    li.append(avatar, main);

    const hist = document.createElement("button");
    hist.type = "button";
    hist.className = "act";
    hist.textContent = "History";
    hist.addEventListener("click", () => openHistory(m.id, name));
    li.append(hist);

    if (m.id !== c.ownerId) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "act act--danger";
      rm.textContent = "Remove";
      rm.addEventListener("click", () => removeOne(c, m));
      li.append(rm);
    }
    list.append(li);
  }
}

// Removes one person from a circle and frees them to join another
async function removeFromCircle(circleId, uid) {
  await deleteDoc(doc(db, "circles", circleId, "locations", uid));
  await deleteDoc(doc(db, "circles", circleId, "members", uid));
  try {
    await updateDoc(doc(db, "users", uid), { circleId: null });
  } catch (err) {
    console.warn("couldn't clear user's circle", err);   // user doc may not exist
  }
}

async function removeOne(c, m) {
  setNotice("Removing…");
  try {
    await removeFromCircle(c.id, m.id);
    setNotice((m.name || "Member") + " was removed.");
  } catch (err) {
    console.error(err);
    setNotice("Couldn't remove. (" + (err.code || err.message) + ")", true);
  }
}

async function removeInactive() {
  const c = selected ? circles.get(selected) : null;
  if (!c) return;
  const list = c.members.filter((m) => isInactive(c, m));
  if (list.length === 0) return;
  setNotice("Removing…");
  let ok = 0;
  for (const m of list) {
    try {
      await removeFromCircle(c.id, m.id);
      ok++;
    } catch (err) {
      console.error(err);
    }
  }
  setNotice(ok + " of " + list.length + " removed.", ok !== list.length);
}

async function deleteAllDocs(circleId, sub) {
  const snap = await getDocs(collection(db, "circles", circleId, sub));
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
  return snap.docs.map((d) => d.id);
}

async function deleteCircle(c) {
  if (!c) return;
  setNotice("Deleting…");
  try {
    const memberIds = await deleteAllDocs(c.id, "members");
    await deleteAllDocs(c.id, "locations");
    // older chat / walkie-talkie data (best effort)
    for (const sub of ["trips", "messages", "signals"]) {
      try { await deleteAllDocs(c.id, sub); } catch (err) { console.warn(sub, err); }
    }
    for (const uid of memberIds) {
      try { await updateDoc(doc(db, "users", uid), { circleId: null }); } catch (err) { console.warn(err); }
    }
    await deleteDoc(doc(db, "circles", c.id));
    setNotice("");
  } catch (err) {
    console.error(err);
    setNotice("Couldn't delete. (" + (err.code || err.message) + ")", true);
  }
}

$("view-map").addEventListener("click", () => setTab("map"));
$("fit-all").addEventListener("click", () => { lastUserMove = 0; fitToVisible(); });
$("remove-inactive").addEventListener("click", removeInactive);
$("delete-circle").addEventListener("click", () => {
  const c = selected ? circles.get(selected) : null;
  if (c) deleteCircle(c);
});

// keep "x min ago" and stale dimming fresh
setInterval(() => {
  if (circles.size) renderAll();
}, 10000);
