/* PH Business Continuity Advisory — app logic (mySMB.com) */
(function () {
  "use strict";

  var TIER_LABELS = { 1: "MONITOR", 2: "PREPARE", 3: "ACT", 4: "CRITICAL" };
  var STALE_MIN = 90;         // Today status considered stale after this many minutes
  var LS = window.localStorage;

  /* ---------- storage helpers (safe if disabled) ---------- */
  function get(k, d) { try { var v = LS.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function set(k, v) { try { LS.setItem(k, v); } catch (e) {} }
  function getReadIds() { try { return JSON.parse(get("pbca.readIds", "[]")); } catch (e) { return []; } }
  function setReadIds(a) { set("pbca.readIds", JSON.stringify(a)); }
  function channel() { return get("pbca.channel", "teams"); }
  function emailMode() { return get("pbca.emailMode", "default"); }

  /* ---------- utils ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtAbs(iso) {
    try { return new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }); }
    catch (e) { return iso || ""; }
  }
  function ago(iso) {
    var t = new Date(iso).getTime(); if (isNaN(t)) return { text: "unknown", mins: 1e9 };
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return { text: "just now", mins: 0 };
    if (m < 60) return { text: m + " min ago", mins: m };
    var h = Math.round(m / 60);
    if (h < 24) return { text: h + (h === 1 ? " hour ago" : " hours ago"), mins: m };
    var d = Math.round(h / 24);
    return { text: d + (d === 1 ? " day ago" : " days ago"), mins: m };
  }
  var ICON = {
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>'
  };
  var CHANNEL_NAME = { teams: "Teams", viber: "Viber", whatsapp: "WhatsApp" };

  /* ---------- data ---------- */
  function loadFeed() {
    return fetch("feed.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .catch(function () { return window.PBCA_FEED || null; });
  }

  /* ---------- compose builders ---------- */
  function emailFor(n, feed) {
    var subject = n.title || "PH hazard brief";
    var lines = [];
    lines.push("Hi team,");
    lines.push("");
    lines.push(n.bottom_line || "");
    if (n.body) { lines.push(""); lines.push(n.body); }
    if (n.sources && n.sources.length) {
      lines.push("");
      lines.push("Official bulletin: " + n.sources[0].url);
    }
    lines.push("");
    lines.push("— mySMB.com Business Continuity  |  Advisory only; confirm with the official bulletin.");
    return { subject: subject, body: lines.join("\n") };
  }
  function chatTextFor(n) {
    var label = n.tier_label || TIER_LABELS[n.tier || 1];
    var parts = [];
    parts.push("[" + label + "] " + (n.title || "PH hazard brief"));
    parts.push(n.bottom_line || "");
    if (n.sources && n.sources.length) parts.push("Bulletin: " + n.sources[0].url);
    parts.push("— mySMB.com Business Continuity");
    return parts.filter(Boolean).join("\n");
  }
  // Pre-built hrefs so the buttons are REAL links — the browser opens the mail
  // client / Teams natively on click (most reliable across environments).
  function emailHref(n) {
    var e = emailFor(n, FEED);
    var qs = "subject=" + encodeURIComponent(e.subject) + "&body=" + encodeURIComponent(e.body);
    return emailMode() === "outlookweb"
      ? "https://outlook.office.com/mail/deeplink/compose?" + qs
      : "mailto:?" + qs;   // no recipient → opens a new draft, user picks recipients
  }
  function chatHref(n) {
    var text = encodeURIComponent(chatTextFor(n));
    var ch = channel();
    if (ch === "whatsapp") return "https://wa.me/?text=" + text;
    if (ch === "viber") return "viber://forward?text=" + text;
    return "https://teams.microsoft.com/l/chat/0/0?users=&message=" + text; // Teams: new chat, message prefilled, user picks recipient
  }

  /* ---------- Today ---------- */
  function renderToday(feed) {
    var c = feed.current || {};
    var tier = c.tier || 1;
    var card = document.getElementById("statusCard");
    card.setAttribute("data-tier", tier);
    var badge = document.getElementById("statusBadge");
    badge.textContent = c.tier_label || TIER_LABELS[tier];
    badge.style.background = "var(--t" + tier + "-bg)";
    badge.style.color = "var(--t" + tier + ")";
    document.getElementById("statusLine").textContent = c.bottom_line || "—";
    document.getElementById("statusHeadline").textContent = c.headline || "";

    var conf = document.getElementById("confidence");
    if (c.confidence) { conf.hidden = false; conf.innerHTML = "Confidence: <b>" + esc(c.confidence) + "</b>" + (c.next_update ? " · Next update: " + esc(c.next_update) : ""); }
    else { conf.hidden = true; }

    // freshness
    var a = ago(feed.generated_at);
    var fr = document.getElementById("freshness");
    document.getElementById("freshnessText").textContent = "Updated " + a.text;
    if (a.mins > STALE_MIN) { fr.classList.add("stale"); document.getElementById("freshnessText").textContent = "Updated " + a.text + " — may be behind"; }
    else { fr.classList.remove("stale"); }

    // degraded
    var dn = document.getElementById("degradedNote");
    if (c.monitoring_degraded) { dn.hidden = false; dn.textContent = "Monitoring partially degraded. " + (c.degraded_note || ""); }
    else { dn.hidden = true; }

    // tiles
    var tiles = [];
    if (c.weather) tiles.push(tile("Weather", c.weather, ""));
    if (c.heat_index) tiles.push(tile("Heat index", (c.heat_index.max_c != null ? c.heat_index.max_c + "°C · " : "") + (c.heat_index.category || "—"), c.heat_index.note || ""));
    if (c.volcanoes && c.volcanoes.length) tiles.push(tile("Volcanoes", c.volcanoes.map(function (v) { return v.name + ": AL" + v.alert_level; }).join(" · "), c.volcanoes[0].note || ""));
    if (c.seismic_24h) tiles.push(tile("Seismic (24h)", c.seismic_24h.count + (c.seismic_24h.count === 1 ? " event" : " events"), c.seismic_24h.note || ""));
    if (c.dams && c.dams.length) tiles.push(tile("Dams", c.dams.map(function (d) { return d.name + ": " + d.status; }).join(" · "), c.dams[0].detail || ""));
    document.getElementById("tiles").innerHTML = tiles.join("") || '<div class="tile"><div class="detail">No conditions reported.</div></div>';

    // outlook (plan-ahead band)
    document.getElementById("outlookGrid").innerHTML = (c.outlook_3day || []).map(function (d) {
      return '<div class="outlook-day"><div class="d">' + esc(d.date) + '</div><div class="s">' + esc(d.summary) + "</div></div>";
    }).join("") || '<p class="ph-sub">No outlook available.</p>';

    // sources
    document.getElementById("sources").innerHTML = (c.sources || []).map(function (s) {
      return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.label) + " ↗</a>";
    }).join("");
  }
  function tile(label, value, detail) {
    return '<div class="tile"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div>' +
      (detail ? '<div class="detail">' + esc(detail) + "</div>" : "") + "</div>";
  }

  /* ---------- Notifications ---------- */
  var currentFilter = "all";
  var FEED = null;
  function items() {
    return (FEED.notifications || []).slice().sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
  }
  function unreadCount() {
    var read = getReadIds();
    return items().filter(function (n) { return read.indexOf(n.id) === -1; }).length;
  }
  function updateBadge() {
    var host = document.querySelector('.tab[data-view="notifications"] .tab-label');
    if (!host) return;
    var n = unreadCount();
    var dot = host.querySelector(".dot");
    if (n > 0) { if (!dot) { dot = document.createElement("span"); dot.className = "dot"; host.appendChild(dot); } dot.textContent = n > 9 ? "9+" : n; }
    else if (dot) { dot.remove(); }
  }
  function renderNotifications() {
    var read = getReadIds();
    var lastSeen = get("pbca.lastSeen", "1970-01-01T00:00:00Z");
    var list = document.getElementById("notifList");
    var data = items().filter(function (n) { return currentFilter === "all" ? true : (n.type || "digest") === currentFilter; });
    if (!data.length) { list.innerHTML = '<p class="page-sub">Nothing to show.</p>'; return; }

    list.innerHTML = data.map(function (n) {
      var tier = n.tier || 1;
      var label = n.tier_label || TIER_LABELS[tier];
      var isUnread = read.indexOf(n.id) === -1;
      var isNew = new Date(n.timestamp) > new Date(lastSeen);
      var mailTarget = emailMode() === "outlookweb" ? ' target="_blank" rel="noopener"' : "";
      var cHref = chatHref(n);
      var chatTarget = /^https/i.test(cHref) ? ' target="_blank" rel="noopener"' : "";
      var srcBtn = (n.sources && n.sources.length) ? '<a class="btn" href="' + esc(n.sources[0].url) + '" target="_blank" rel="noopener">' + ICON.link + 'Bulletin</a>' : "";
      return '<div class="notif' + (isUnread ? " unread" : "") + '" data-tier="' + tier + '" data-id="' + esc(n.id) + '">' +
        '<div class="notif-head">' +
          '<span class="pill" data-tier="' + tier + '">' + esc(label) + '</span>' +
          (isNew ? '<span class="tag-new">NEW</span>' : '') +
          '<span class="notif-type">' + esc((n.type || "brief").toUpperCase()) + '</span>' +
          '<span class="notif-time">' + fmtAbs(n.timestamp) + '</span>' +
        '</div>' +
        '<div class="notif-title">' + esc(n.title) + '</div>' +
        (n.bottom_line ? '<p class="notif-bottom">' + esc(n.bottom_line) + '</p>' : '') +
        (n.body ? '<p class="notif-body">' + esc(n.body) + '</p>' : '') +
        '<div class="notif-tools">' +
          '<a class="btn btn-primary" href="' + esc(emailHref(n)) + '"' + mailTarget + ' data-mark>' + ICON.mail + 'Send email</a>' +
          '<a class="btn" href="' + esc(cHref) + '"' + chatTarget + ' data-mark>' + ICON.chat + 'Send to ' + esc(CHANNEL_NAME[channel()]) + '</a>' +
          '<button class="btn" data-act="share">' + ICON.share + 'Share</button>' +
          srcBtn +
        '</div>' +
      '</div>';
    }).join("");

    list.querySelectorAll(".notif").forEach(function (el) {
      var id = el.getAttribute("data-id");
      var n = (FEED.notifications || []).filter(function (x) { return x.id === id; })[0];
      // links carry the draft in their href → let the browser open it natively; just mark read
      el.querySelectorAll("a[data-mark]").forEach(function (a) {
        a.addEventListener("click", function () { markRead(id); });
      });
      var sb = el.querySelector('button[data-act="share"]');
      if (sb) sb.addEventListener("click", function () { markRead(id); shareNotif(n); });
    });

    // Conventional behaviour: mark a notification read once it is actually shown
    // on screen (opened/viewed) — no button click needed. Only when the tab is visible.
    if (!document.getElementById("view-notifications").hidden) setupReadOnView(list);
  }

  var readObserver;
  function setupReadOnView(list) {
    if (readObserver) readObserver.disconnect();
    var cards = list.querySelectorAll(".notif");
    if (!("IntersectionObserver" in window)) {           // fallback: opening the tab clears them
      cards.forEach(function (el) { markRead(el.getAttribute("data-id")); });
      return;
    }
    readObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { markRead(e.target.getAttribute("data-id")); readObserver.unobserve(e.target); }
      });
    }, { threshold: 0.1 });
    cards.forEach(function (el) { readObserver.observe(el); });
  }
  function markRead(id) {
    var read = getReadIds();
    if (read.indexOf(id) === -1) { read.push(id); setReadIds(read); updateBadge();
      var el = document.querySelector('.notif[data-id="' + id + '"]'); if (el) el.classList.remove("unread"); }
  }
  function shareNotif(n) {
    var text = chatTextFor(n);
    if (navigator.share) { navigator.share({ title: n.title, text: text }).catch(function () {}); }
    else if (navigator.clipboard) { navigator.clipboard.writeText(text).then(function () { toast("Copied — paste into any app"); }); }
    else { toast("Sharing not available on this device"); }
  }

  /* ---------- tabs ---------- */
  function initTabs() {
    var tabs = document.querySelectorAll(".tab");
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        tabs.forEach(function (x) { x.classList.remove("is-active"); });
        t.classList.add("is-active");
        var view = t.getAttribute("data-view");
        ["today", "notifications", "settings"].forEach(function (v) { document.getElementById("view-" + v).hidden = (v !== view); });
        if (view === "notifications") { set("pbca.lastSeen", new Date().toISOString()); renderNotifications(); }
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
    document.querySelectorAll(".chip[data-filter]").forEach(function (c) {
      c.addEventListener("click", function () {
        document.querySelectorAll(".chip[data-filter]").forEach(function (x) { x.classList.remove("is-active"); });
        c.classList.add("is-active"); currentFilter = c.getAttribute("data-filter"); renderNotifications();
      });
    });
    document.getElementById("markAllRead").addEventListener("click", function () {
      setReadIds(items().map(function (n) { return n.id; })); updateBadge(); renderNotifications(); toast("All marked read");
    });
  }

  /* ---------- settings ---------- */
  function initSettings() {
    var cs = document.getElementById("channelSelect");
    cs.value = channel();
    cs.addEventListener("change", function () { set("pbca.channel", cs.value); renderNotifications(); toast("Default set to " + CHANNEL_NAME[cs.value]); });
    var em = document.getElementById("emailModeSelect");
    em.value = emailMode();
    em.addEventListener("change", function () { set("pbca.emailMode", em.value); renderNotifications(); });
  }

  /* ---------- install / SW / toast ---------- */
  function initInstall() {
    var deferred = null, btn = document.getElementById("installBtn");
    window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; btn.hidden = false; });
    btn.addEventListener("click", function () { if (deferred) { deferred.prompt(); deferred.userChoice.finally(function () { deferred = null; btn.hidden = true; }); } });
    window.addEventListener("appinstalled", function () { toast("App installed"); btn.hidden = true; });
  }
  function initSW() { if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) navigator.serviceWorker.register("service-worker.js").catch(function () {}); }
  var toastEl;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "toast"; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function () { toastEl.classList.remove("show"); }, 2200);
  }

  /* ---------- boot ---------- */
  function boot(feed) {
    if (!feed) { document.getElementById("statusLine").textContent = "Could not load the latest brief."; return; }
    FEED = feed;
    document.title = "PH Business Continuity Advisory — mySMB.com";
    var bm = document.getElementById("buildMeta");
    if (bm) bm.textContent = "Data generated " + fmtAbs(feed.generated_at) + " · " + (feed.client || "mySMB.com") + " · " + (feed.location || "");
    renderToday(feed);
    renderNotifications();
    updateBadge();
  }
  function start() { initTabs(); initSettings(); initInstall(); initSW(); loadFeed().then(boot); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
