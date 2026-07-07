// PH Business Continuity Advisory — cloud monitor (runs in GitHub Actions)
// Deterministic, no LLM. Fetches USGS (earthquakes), Open-Meteo (Metro Manila
// 3-day forecast + heat index), and the PAGASA TC bulletin (active-cyclone
// detection). Builds feed.json + feed-data.js at the repo root and manages the
// notifications history. Every network call is defensive: on failure it degrades
// gracefully and records a note rather than crashing.
//
// Run:  node scan.mjs           (normal — writes feed.json + feed-data.js)
//       node scan.mjs --selftest (offline logic check with mock data)

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TAGUIG = { lat: 14.52, lon: 121.05 };
const MM = { lat: 14.55, lon: 121.02 }; // Metro Manila centroid for forecast
const TIER_LABELS = { 1: "MONITOR", 2: "PREPARE", 3: "ACT", 4: "CRITICAL" };
const SOURCES = [
  { label: "PAGASA — Tropical Cyclone Bulletin", url: "https://www.pagasa.dost.gov.ph/tropical-cyclone/severe-weather-bulletin" },
  { label: "PAGASA — Weather / Heat Index", url: "https://www.pagasa.dost.gov.ph/weather/heat-index" },
  { label: "PAGASA — Flood / Dam", url: "https://www.pagasa.dost.gov.ph/flood" },
  { label: "USGS — Earthquakes", url: "https://earthquake.usgs.gov/earthquakes/map/" },
  { label: "PHIVOLCS", url: "https://www.phivolcs.dost.gov.ph/" }
];

/* ---------- time helpers (Asia/Manila) ---------- */
function manila(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(d).map(x => [x.type, x.value]));
  const hour = p.hour === "24" ? 0 : parseInt(p.hour, 10);
  return { date: `${p.year}-${p.month}-${p.day}`, hour, minute: parseInt(p.minute, 10),
           iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00+08:00` };
}
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function shortDate(isoDate) { // "2026-07-08" -> "Jul 8"
  const [y, m, d] = isoDate.split("-").map(Number);
  return MONTHS[m - 1] + " " + d;
}
function longDate(isoDate) { // "2026-07-08" -> "Jul 8, 2026"
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/* ---------- math / weather ---------- */
function haversineKm(a, b) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function heatIndexC(Tc, RH) { // NOAA Rothfusz; °C + % -> °C
  const T = Tc * 9 / 5 + 32;
  let HI;
  if (T < 80) { HI = 0.5 * (T + 61 + (T - 68) * 1.2 + RH * 0.094); }
  else {
    HI = -42.379 + 2.04901523 * T + 10.14333127 * RH - 0.22475541 * T * RH
       - 0.00683783 * T * T - 0.05481717 * RH * RH + 0.00122874 * T * T * RH
       + 0.00085282 * T * RH * RH - 0.00000199 * T * T * RH * RH;
    if (RH < 13 && T >= 80 && T <= 112) HI -= ((13 - RH) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
    else if (RH > 85 && T >= 80 && T <= 87) HI += ((RH - 85) / 10) * ((87 - T) / 5);
  }
  return (HI - 32) * 5 / 9;
}
function heatCategory(hiC) {
  if (hiC == null || isNaN(hiC)) return null;
  if (hiC >= 52) return "Extreme Danger"; if (hiC >= 42) return "Danger";
  if (hiC >= 33) return "Extreme Caution"; if (hiC >= 27) return "Caution"; return "Not significant";
}
const WMO = {
  0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Cloudy",
  45: "Fog", 48: "Fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Snow", 73: "Snow", 75: "Snow", 80: "Rain showers", 81: "Rain showers",
  82: "Heavy rain showers", 95: "Thunderstorms", 96: "Thunderstorms with hail", 99: "Severe thunderstorms"
};
function wmoText(c) { return WMO[c] || "Variable"; }

/* ---------- fetch helpers ---------- */
async function getJSON(url, ms = 15000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "mySMB-BizCon/1.0" } }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
async function getText(url, ms = 15000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "mySMB-BizCon/1.0" } }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.text(); }
  finally { clearTimeout(t); }
}

/* ---------- source scans (each returns data + a degraded flag) ---------- */
async function scanQuakes() {
  const start = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&minmagnitude=4.0&minlatitude=4&maxlatitude=21&minlongitude=116&maxlongitude=128&orderby=time&limit=100`;
  try {
    const j = await getJSON(url);
    const feats = j.features || [];
    let maxNear = 0, nearest = null;
    for (const f of feats) {
      const [lon, lat] = f.geometry.coordinates;
      const km = haversineKm(TAGUIG, { lat, lon });
      if (km <= 300 && f.properties.mag > maxNear) { maxNear = f.properties.mag; nearest = { mag: f.properties.mag, km: Math.round(km), place: f.properties.place }; }
    }
    const ncrRelevant = nearest && nearest.km <= 150 && nearest.mag >= 6.0;
    return {
      ok: true,
      count: feats.length,
      ncrRelevant: !!ncrRelevant,
      nearest,
      note: feats.length
        ? `${feats.length} M4.0+ event(s) in the PH region (last 24h)` + (nearest ? `; nearest of note M${nearest.mag} ~${nearest.km} km from Taguig (${nearest.place}).` : "; none near Metro Manila.")
        : "No M4.0+ earthquakes in the PH region in the last 24h."
    };
  } catch (e) { return { ok: false, count: 0, ncrRelevant: false, nearest: null, note: "USGS feed unreachable this run." }; }
}

async function scanForecast() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${MM.lat}&longitude=${MM.lon}` +
    `&daily=weather_code,temperature_2m_max,precipitation_probability_max&hourly=temperature_2m,relative_humidity_2m` +
    `&timezone=Asia%2FManila&forecast_days=3`;
  try {
    const j = await getJSON(url);
    const d = j.daily;
    const outlook = d.time.map((date, i) => {
      const pp = d.precipitation_probability_max?.[i];
      const w = wmoText(d.weather_code[i]);
      return { date: shortDate(date), summary: `${w}${pp != null ? `, ${pp}% chance of rain` : ""}. Max ~${Math.round(d.temperature_2m_max[i])}°C.` };
    });
    // today's max heat index from hourly temp + humidity (first 24 hours)
    let hiMax = -99;
    const H = j.hourly;
    for (let i = 0; i < Math.min(24, H.time.length); i++) {
      const hi = heatIndexC(H.temperature_2m[i], H.relative_humidity_2m[i]);
      if (hi > hiMax) hiMax = hi;
    }
    const hiRounded = Math.round(hiMax);
    return {
      ok: true, outlook,
      heat_index: { max_c: hiRounded, category: heatCategory(hiMax), note: "Computed from Open-Meteo temperature and humidity for Metro Manila." },
      weatherToday: `${wmoText(d.weather_code[0])} in Metro Manila; max ~${Math.round(d.temperature_2m_max[0])}°C.`
    };
  } catch (e) {
    return { ok: false, outlook: [], heat_index: { max_c: null, category: "Not available", note: "Forecast source unreachable this run." }, weatherToday: null };
  }
}

async function scanTC() {
  try {
    const html = (await getText("https://www.pagasa.dost.gov.ph/tropical-cyclone/severe-weather-bulletin")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (/no active tropical cyclone/i.test(html)) return { ok: true, active: false, note: "No active tropical cyclone within the Philippine Area of Responsibility." };
    if (/(wind signal|signal no\.?\s*\d|tropical cyclone bulletin nr)/i.test(html)) return { ok: true, active: true, note: "An active tropical cyclone appears in the PAGASA bulletin — check the official bulletin for wind signal levels over Metro Manila." };
    return { ok: false, active: false, note: "Could not read the PAGASA TC bulletin clearly this run." };
  } catch (e) { return { ok: false, active: false, note: "PAGASA TC bulletin unreachable this run." }; }
}

/* ---------- classification ---------- */
function classify({ quakes, forecast, tc }) {
  let tier = 1; const reasons = [];
  // Earthquake proxy (USGS magnitude + distance; PEIS confirmation is manual)
  if (quakes.nearest && quakes.nearest.km <= 150) {
    if (quakes.nearest.mag >= 6.0) { tier = Math.max(tier, 3); reasons.push(`Strong M${quakes.nearest.mag} quake ~${quakes.nearest.km} km from Taguig — check PHIVOLCS for felt intensity.`); }
    else if (quakes.nearest.mag >= 4.5) { tier = Math.max(tier, 2); reasons.push(`M${quakes.nearest.mag} quake ~${quakes.nearest.km} km from Taguig — may be felt in NCR.`); }
  }
  // Tropical cyclone (best-effort detection; signal level is manual)
  if (tc.active) { tier = Math.max(tier, 2); reasons.push("Active tropical cyclone in PAR — confirm wind signal over Metro Manila on the official bulletin."); }
  // Heat index
  const hi = forecast.heat_index?.max_c;
  if (hi != null) {
    if (hi >= 52) { tier = Math.max(tier, 3); reasons.push(`Extreme Danger heat index (~${hi}°C) forecast.`); }
    else if (hi >= 42) { tier = Math.max(tier, 2); reasons.push(`Danger-level heat index (~${hi}°C) forecast — hydration advisory for field staff.`); }
  }
  return { tier, reasons };
}

/* ---------- build feed ---------- */
function loadPrev(path) {
  try { if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")); } catch (e) {}
  return null;
}
function buildFeed(prev, scans, now) {
  const { quakes, forecast, tc } = scans;
  const { tier, reasons } = classify(scans);
  const label = TIER_LABELS[tier];
  const degraded = [];
  if (!quakes.ok) degraded.push("USGS");
  if (!forecast.ok) degraded.push("forecast");
  if (!tc.ok) degraded.push("PAGASA TC bulletin");

  const action = tier >= 4 ? "Suspend operations and check in on staff safety."
    : tier === 3 ? "Consider shifting to work-from-home — your call; confirm on the official bulletin."
    : tier === 2 ? "No action needed yet — review contingencies and watch the next bulletin."
    : "No action needed. Normal operations.";
  const bottom_line = `BGC/Taguig: ${tier === 1 ? "No action needed today. Normal operations." : action}`;
  const headline = tier === 1
    ? (tc.ok && !tc.active ? "Calm — no active cyclone" : "No elevated hazard detected") + (quakes.ncrRelevant ? "" : ", no NCR quakes") + "."
    : reasons[0] || "Elevated hazard — see details.";

  const current = {
    tier, tier_label: label, action_needed: tier > 1,
    bottom_line, headline,
    confidence: (quakes.ok && (tc.ok || forecast.ok)) ? "MEDIUM" : "LOW",
    next_update: "Automated hourly; full brief at 12:00 NN (Asia/Manila)",
    monitoring_degraded: degraded.length > 0,
    degraded_note: degraded.length ? `Automated cloud monitor: ${degraded.join(", ")} unreachable this run — figures may lag; confirm on the official sites. Volcano (PHIVOLCS) and dam levels are not yet in the automated version.`
      : "Volcano (PHIVOLCS) and dam levels are not yet in the automated cloud version — confirm those on the official sites if relevant.",
    outlook_3day: forecast.outlook,
    weather: (tc.ok ? tc.note + " " : "") + (forecast.weatherToday || ""),
    heat_index: forecast.heat_index,
    volcanoes: [],
    seismic_24h: { count: quakes.count, ncr_relevant: quakes.ncrRelevant, note: quakes.note },
    dams: [],
    sources: SOURCES
  };

  // notifications history
  let notifications = (prev && Array.isArray(prev.notifications)) ? prev.notifications.slice() : [];
  const prevTier = prev?.current?.tier || 1;

  // Alert on escalation to Tier 3+ or all-clear back to <3
  if (tier >= 3 && tier !== prevTier) {
    notifications.unshift({
      id: `${now.date}-${now.hour}${String(now.minute).padStart(2,"0")}-alert`,
      type: "alert", tier, tier_label: label, timestamp: now.iso,
      title: `[${label}] PH hazard alert — ${longDate(now.date)}`,
      bottom_line, body: reasons.join(" ") || headline, sms: `MYSMB alert ${longDate(now.date)}: ${bottom_line} Details in the app.`,
      sources: [SOURCES[0]]
    });
  } else if (prevTier >= 3 && tier < 3) {
    notifications.unshift({
      id: `${now.date}-${now.hour}${String(now.minute).padStart(2,"0")}-allclear`,
      type: "alert", tier, tier_label: label, timestamp: now.iso,
      title: `[ALL CLEAR] PH hazard update — ${longDate(now.date)}`,
      bottom_line: `BGC/Taguig: Hazard has eased. ${action}`, body: "Previous elevated hazard has eased. Confirm facilities/commute before resuming as needed.",
      sms: `MYSMB all-clear ${longDate(now.date)}: hazard eased, normal operations may resume.`, sources: [SOURCES[0]]
    });
  }

  // Daily brief: once per day. Created on the first run from 12:00 NN onward
  // (so a skipped noon tick still yields a brief), or immediately on a manual run.
  const isManual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch" || process.env.FORCE_DIGEST === "1";
  const digestId = `${now.date}-digest`;
  if ((isManual || now.hour >= 12) && !notifications.some(n => n.id === digestId)) {
    const outlookTxt = current.outlook_3day.map(o => `${o.date}: ${o.summary}`).join(" ");
    notifications.unshift({
      id: digestId, type: "digest", tier, tier_label: label, timestamp: `${now.date}T12:00:00+08:00`,
      title: `PH hazard brief — ${longDate(now.date)} — ${tier === 1 ? "No action" : label}`,
      bottom_line, sms: `MYSMB brief ${longDate(now.date)}: ${bottom_line} 3-day + heat index in the app.`,
      body: `${headline} Heat index today ~${current.heat_index.max_c ?? "n/a"}°C (${current.heat_index.category}). Seismic: ${quakes.note} 3-day outlook — ${outlookTxt}${current.monitoring_degraded ? " Note: " + current.degraded_note : ""}`,
      sources: [SOURCES[0]]
    });
  }

  notifications = notifications.slice(0, 30);
  return { app: "PH Business Continuity Advisory", client: "mySMB.com", location: "BGC, Taguig City, Metro Manila", generated_at: now.iso, current, notifications };
}

/* ---------- selftest (offline, mock data) ---------- */
function selftest() {
  const now = manila();
  const mkForecast = (hi) => ({ ok: true, outlook: [{ date: "Jul 8", summary: "Partly cloudy, 40% chance of rain. Max ~33°C." }], heat_index: { max_c: hi, category: heatCategory(hi), note: "mock" }, weatherToday: "Partly cloudy." });
  const cases = [
    ["calm", { quakes: { ok: true, count: 0, ncrRelevant: false, nearest: null, note: "none" }, forecast: mkForecast(34), tc: { ok: true, active: false, note: "no TC" } }, 1],
    ["danger heat", { quakes: { ok: true, count: 1, ncrRelevant: false, nearest: null, note: "1" }, forecast: mkForecast(43), tc: { ok: true, active: false, note: "no TC" } }, 2],
    ["active TC", { quakes: { ok: true, count: 0, ncrRelevant: false, nearest: null, note: "none" }, forecast: mkForecast(30), tc: { ok: true, active: true, note: "TC" } }, 2],
    ["strong quake NCR", { quakes: { ok: true, count: 3, ncrRelevant: true, nearest: { mag: 6.3, km: 90, place: "Rizal" }, note: "n" }, forecast: mkForecast(30), tc: { ok: true, active: false, note: "no TC" } }, 3],
  ];
  console.log("heatIndexC(35,70)=", heatIndexC(35, 70).toFixed(1), "cat", heatCategory(heatIndexC(35, 70)));
  console.log("haversine Taguig->Rizal(~14.6,121.3)=", Math.round(haversineKm(TAGUIG, { lat: 14.6, lon: 121.3 })), "km");
  let pass = true;
  for (const [name, scans, expTier] of cases) {
    const t = classify(scans).tier;
    const ok = t === expTier; pass = pass && ok;
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}: tier ${t} (expected ${expTier})`);
  }
  // notification build: escalation + digest dedupe
  const prev = { current: { tier: 1 }, notifications: [] };
  const escScans = cases[3][1];
  const f1 = buildFeed(prev, escScans, { ...now, hour: 12 });
  const hasAlert = f1.notifications.some(n => n.type === "alert");
  const hasDigest = f1.notifications.some(n => n.id === `${now.date}-digest`);
  const f2 = buildFeed(f1, escScans, { ...now, hour: 12 }); // rerun same hour -> no duplicate digest
  const dupDigest = f2.notifications.filter(n => n.id === `${now.date}-digest`).length;
  // morning behaviour: scheduled morning run -> no digest; manual run -> digest
  const calm = cases[0][1];
  const morn = buildFeed({ current: { tier: 1 }, notifications: [] }, calm, { ...now, hour: 9 });
  const mornDigest = morn.notifications.some(n => n.id === `${now.date}-digest`);
  process.env.GITHUB_EVENT_NAME = "workflow_dispatch";
  const manual = buildFeed({ current: { tier: 1 }, notifications: [] }, calm, { ...now, hour: 9 });
  const manualDigest = manual.notifications.some(n => n.id === `${now.date}-digest`);
  delete process.env.GITHUB_EVENT_NAME;
  console.log(`  [${hasAlert ? "PASS" : "FAIL"}] escalation created an alert`);
  console.log(`  [${hasDigest ? "PASS" : "FAIL"}] noon created a digest`);
  console.log(`  [${dupDigest === 1 ? "PASS" : "FAIL"}] digest not duplicated on rerun (count ${dupDigest})`);
  console.log(`  [${!mornDigest ? "PASS" : "FAIL"}] scheduled 9am run did NOT create a digest`);
  console.log(`  [${manualDigest ? "PASS" : "FAIL"}] manual run created today's digest on demand`);
  const allpass = pass && hasAlert && hasDigest && dupDigest === 1 && !mornDigest && manualDigest;
  console.log(allpass ? "SELFTEST: ALL PASS" : "SELFTEST: FAILURES ABOVE");
}

/* ---------- main ---------- */
async function main() {
  if (process.argv.includes("--selftest")) { selftest(); return; }
  const now = manila();
  const [quakes, forecast, tc] = await Promise.all([scanQuakes(), scanForecast(), scanTC()]);
  const prev = loadPrev("feed.json");
  const feed = buildFeed(prev, { quakes, forecast, tc }, now);
  writeFileSync("feed.json", JSON.stringify(feed, null, 2) + "\n");
  writeFileSync("feed-data.js",
    "/* Auto-generated by the cloud monitor (GitHub Actions). Do not edit by hand. */\n" +
    "window.PBCA_FEED = " + JSON.stringify(feed, null, 2) + ";\n");
  console.log(`feed updated @ ${now.iso} — tier ${feed.current.tier} (${feed.current.tier_label}); notifications ${feed.notifications.length}`);
}
main();
