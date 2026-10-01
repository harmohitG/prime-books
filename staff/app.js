/* PRIME Staff v2 — talks to the Book Orders Google Apps Script JSON API.
 * Sign-in: username + password once per phone -> session token (kept on the phone) -> 4-digit PIN to open the app.
 * The PIN is never stored on the phone; it is checked by the server against that phone's session. */
(function () {
  'use strict';

  var VERSION = '2.0';
  var LS = { url: 'prime_api_url', token: 'prime_token', user: 'prime_user', tab: 'prime_tab', seg: 'prime_seg' };
  var POLL_MS = 30000, LOCK_AFTER_MS = 15 * 60 * 1000, API_TIMEOUT_MS = 30000;

  var state = {
    url: null, token: null, user: null, unlocked: false,
    tab: 'orders', stack: [],
    orders: [], ordersAt: null, lookup: null, stock: null, stockLogRows: null,
    seg: null, search: '', openMore: {},
    stats: null, staff: null, activity: null, actFilter: 'all', settings: null, me: null, revealPin: {},
    timer: null, hiddenAt: 0, busy: false, deferredInstall: null, pin: { mode: 'unlock', digits: '', first: '', busy: false }, loadedAt: {},
    push: null, os: null, pushState: 'off', pendingOrder: null,
    cash: null, cashRange: { key: 'today' }, cashRep: null, cashDetail: null, cashToday: null, cashMine: null, cashItems: null, cashBook: null, practice: false
  };
  /** true (and marks it) if `key` hasn't been loaded in the last `ms`: stops pages that re-render after loading from loading again. */
  function stale(key, ms) { var t = state.loadedAt[key] || 0; if (Date.now() - t < (ms || 15000)) return false; state.loadedAt[key] = Date.now(); return true; }

  /* =================================================================== helpers */
  function $(id) { return document.getElementById(id); }
  function show(id, on) { var el = $(id); if (el) el.hidden = !on; }
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n) { n = Number(n || 0); var cents = Math.round(n * 100) % 100 !== 0; return '$' + n.toLocaleString('en-CA', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 }); }
  function d(iso) { var x = new Date(iso); return isNaN(x) ? null : x; }
  function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
  function timeOf(iso) { var x = d(iso); return x ? x.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : ''; }
  function when(iso) {
    var x = d(iso); if (!x) return '';
    var now = new Date(), y = new Date(now.getTime() - 86400000);
    if (sameDay(x, now)) return timeOf(iso);
    if (sameDay(x, y)) return 'Yesterday ' + timeOf(iso);
    return x.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + ', ' + timeOf(iso);
  }
  function ago(iso) {
    var x = d(iso); if (!x) return 'Never';
    var s = Math.round((Date.now() - x.getTime()) / 1000);
    if (s < 60) return 'Just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return when(iso);
  }
  function dayLabel(iso) {
    var x = d(iso); if (!x) return '';
    var now = new Date(); if (sameDay(x, now)) return 'Today';
    if (sameDay(x, new Date(now.getTime() - 86400000))) return 'Yesterday';
    return x.toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' });
  }
  function initials(name) { var p = String(name || '?').trim().split(/\s+/); return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
  function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }
  var toastTimer = null;
  var toastN = 0;
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; t.dataset.n = String(++toastN); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 2600); }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 20); } catch (e) {} }
  function standalone() { return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true; }
  function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function deviceName() {
    var ua = navigator.userAgent;
    var os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
    var br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    return os + ' · ' + br + (standalone() ? ' (app)' : '');
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { return true; }, fallback);
    return Promise.resolve(fallback());
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} document.body.removeChild(ta); return ok;
    }
  }
  function validUrl(u) { u = String(u || '').trim(); return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec\/?$/.test(u) || /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/api$/.test(u); }
  function can(k) { return !!(state.user && state.user.can && state.user.can[k]); }

  var ICON = {
    orders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="3" width="15" height="18" rx="2.5"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/></svg>',
    stock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5 12 3.5l8.5 4-8.5 4-8.5-4z"/><path d="M3.5 7.5v9l8.5 4 8.5-4v-9"/><path d="M12 11.5v9"/></svg>',
    admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 19.5 6v5.5c0 4.6-3.2 8-7.5 9.5-4.3-1.5-7.5-4.9-7.5-9.5V6L12 3z"/><path d="m9 12 2.2 2.2L15.5 10"/></svg>',
    me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20.5c1.4-3.6 4.2-5.5 7.5-5.5s6.1 1.9 7.5 5.5"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 2.8 19.5h18.4L12 4z"/><path d="M12 10v4.5M12 17.2v.3"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8.5" r="3.3"/><path d="M3 19c1-3 3.3-4.6 6-4.6s5 1.6 6 4.6"/><path d="M16 5.5a3 3 0 0 1 0 6M18 14.6c1.6.6 2.6 2 3 4.4"/></svg>',
    addp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8.5" r="3.3"/><path d="M3.5 19c1-3 3.4-4.6 6.5-4.6 1.4 0 2.6.3 3.6.9"/><path d="M18 13v6M15 16h6"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    sheet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M4 9h16M4 14.5h16M10 9v11.5"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18" cy="12" r="1.9"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
    house: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3.5M7.5 8 12 3.5 16.5 8"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5 12 3.5l8.5 4-8.5 4-8.5-4z"/><path d="M3.5 7.5v9l8.5 4 8.5-4v-9"/><path d="M12 11.5v9"/></svg>',
    cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/></svg>'
  };

  /* =================================================================== API */
  function api(fn, args) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, fn === 'lookupRefresh' ? 100000 : API_TIMEOUT_MS) : null;   // re-reading the workbook from Drive can take a while
    var opts = { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ fn: fn, args: args || [] }), redirect: 'follow' };
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(state.url, opts)
      .then(function (r) { if (!r.ok) throw new Error('The server had a problem (' + r.status + '). Try again.'); return r.json(); })
      .then(function (j) { clearTimeout(timer); if (!j || j.ok !== true) throw new Error((j && j.error) || 'Unexpected reply from the server.'); show('offline', false); return j.result; },
        function (e) { clearTimeout(timer); throw e; })
      .catch(function (e) {
        var msg = e && e.name === 'AbortError' ? 'The server took too long. Check your connection and try again.' : (e && e.message) || String(e);
        var offline = /Failed to fetch|NetworkError|Load failed|network connection/i.test(msg);
        if (offline) { msg = 'Can’t reach the server. Check your connection.'; if (state.unlocked) show('offline', true); }
        var err = new Error(msg); err.offline = offline;
        if (/Sign in again\.$/.test(msg)) { err.signedOut = true; signedOut(msg); }
        else if (/Unlock with your PIN\.$/.test(msg)) { err.signedOut = true; if (state.unlocked) { state.unlocked = false; stopPolling(); closeDialog(); showPin('unlock'); } }
        throw err;
      });
  }
  function sapi(fn, extra) { return api(fn, [state.token].concat(extra || [])); }

  /* =================================================================== screens */
  var SCREENS = ['boot', 'setup', 'bootstrap', 'login', 'pin', 'main'];
  function screen(name) { SCREENS.forEach(function (s) { show('v-' + s, s === name); }); if (name !== 'main') stopPolling(); window.scrollTo(0, 0); }
  function err(id, msg) { var el = $(id); if (!el) return; el.textContent = msg || ''; el.hidden = !msg; }

  function saveSession(r) {
    state.token = r.token; state.user = r.user;
    set(LS.token, r.token); set(LS.user, JSON.stringify(r.user));
  }
  function clearSession() {
    stopPolling();
    state.token = null; state.user = null; state.unlocked = false; state.orders = []; state.ordersAt = null; state.stock = null; state.stockLogRows = null;
    state.stats = null; state.staff = null; state.activity = null; state.settings = null; state.me = null; state.stack = []; state.openMore = {}; state.revealPin = {}; state.loadedAt = {};
    state.cash = null; state.cashRep = null; state.cashDetail = null; state.cashToday = null; state.cashMine = null;
    set(LS.token, null); set(LS.user, null);
    try { if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch (e) {}
    pushLogout();
  }
  var signingOut = false;
  function signedOut(msg) {
    if (signingOut) return; signingOut = true;
    clearSession(); closeDialog(); showLogin(msg.replace(/\s*Sign in again\.$/, '') + ' Please sign in again.');
    setTimeout(function () { signingOut = false; }, 500);
  }

  /* ---------- setup (only without config.js) ---------- */
  function initSetup() {
    $('setup-go').addEventListener('click', function () {
      var u = $('setup-url').value.trim();
      if (!validUrl(u)) return err('setup-error', 'That isn’t an Apps Script web app link. It starts with https://script.google.com/macros/s/ and ends in /exec.');
      err('setup-error', ''); $('setup-go').disabled = true;
      state.url = u;
      api('authStatus').then(function (s) { set(LS.url, u); $('setup-go').disabled = false; if (s.bootstrapped) showLogin(); else screen('bootstrap'); })
        .catch(function (e) { state.url = null; $('setup-go').disabled = false; err('setup-error', 'Couldn’t connect: ' + e.message); });
    });
  }

  /* ---------- first admin ---------- */
  function initBootstrap() {
    $('bs-name').addEventListener('input', function () { if (!$('bs-username').dataset.touched) $('bs-username').value = suggestUsername($('bs-name').value); });
    $('bs-username').addEventListener('input', function () { $('bs-username').dataset.touched = '1'; });
    $('bs-go').addEventListener('click', function () {
      var f = { pin: $('bs-pin').value.trim(), name: $('bs-name').value.trim(), username: $('bs-username').value.trim(), password: $('bs-password').value, device: deviceName() };
      if (!f.pin) return err('bs-error', 'Enter the setup PIN.');
      if (!f.name) return err('bs-error', 'Enter your name.');
      if (f.password.length < 8) return err('bs-error', 'Password must be at least 8 characters.');
      if (f.password !== $('bs-password2').value) return err('bs-error', 'The two passwords don’t match.');
      err('bs-error', ''); $('bs-go').disabled = true; $('bs-go').textContent = 'Creating…';
      api('adminBootstrap', [f]).then(function (r) {
        saveSession(r); $('bs-password').value = ''; $('bs-password2').value = ''; $('bs-pin').value = '';
        showPin('create');
      }).catch(function (e) { err('bs-error', e.message); })
        .then(function () { $('bs-go').disabled = false; $('bs-go').textContent = 'Create admin account'; });
    });
  }
  function suggestUsername(name) { var p = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, '').trim().split(/\s+/).filter(Boolean); if (!p.length) return ''; return (p[0] + (p.length > 1 ? p[p.length - 1][0] : '')).slice(0, 20); }

  /* ---------- sign in ---------- */
  function showLogin(msg) {
    screen('login'); err('login-error', msg || '');
    $('login-password').value = '';
    setTimeout(function () { var el = $('login-username').value ? $('login-password') : $('login-username'); if (el) el.focus(); }, 50);
    if (state.url) api('authStatus').then(function (s) { if (!s.bootstrapped && !$('v-login').hidden) screen('bootstrap'); }).catch(function () {});
  }
  function initLogin() {
    $('login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var u = $('login-username').value.trim(), p = $('login-password').value;
      if (!u || !p) return err('login-error', 'Enter your username and password.');
      err('login-error', ''); $('login-go').disabled = true; $('login-go').textContent = 'Signing in…';
      api('staffLogin', [{ username: u, password: p, device: deviceName() }]).then(function (r) {
        saveSession(r); $('login-password').value = '';
        if (r.needsPin) showPin('create'); else enterMain();
      }).catch(function (e) { err('login-error', e.message); $('login-password').select(); })
        .then(function () { $('login-go').disabled = false; $('login-go').textContent = 'Sign in'; });
    });
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-reveal]'); if (!b) return;
      var inp = $(b.dataset.reveal); var showIt = inp.type === 'password'; inp.type = showIt ? 'text' : 'password'; b.textContent = showIt ? 'Hide' : 'Show';
    });
  }

  /* ---------- PIN pad ---------- */
  var PIN_TEXT = {
    unlock: ['Enter your PIN', ''], create: ['Create a PIN', 'You’ll use these 4 digits to open the app on this phone.'], confirm: ['Confirm your PIN', 'Type the same 4 digits again.'],
    change: ['New PIN', 'Choose 4 new digits.'], 'change-confirm': ['Confirm new PIN', 'Type the same 4 digits again.']
  };
  function showPin(mode, errMsg) {
    state.pin.mode = mode; state.pin.digits = ''; if (mode === 'create' || mode === 'change') state.pin.first = '';
    screen('pin');
    var u = state.user || {};
    $('pin-avatar').textContent = initials(u.name);
    $('pin-title').textContent = mode === 'unlock' ? 'Hi ' + firstName(u.name) : PIN_TEXT[mode][0];
    $('pin-sub').textContent = mode === 'unlock' ? 'Enter your PIN' : PIN_TEXT[mode][1];
    $('pin-alt').textContent = mode === 'unlock' ? 'Not you? Sign in with a password' : (mode.indexOf('change') === 0 ? 'Cancel' : 'Sign out');
    err('pin-error', errMsg || '');
    drawDots();
  }
  function drawDots() { var n = state.pin.digits.length; Array.prototype.forEach.call($('pin-dots').children, function (el, i) { el.classList.toggle('on', i < n); }); }
  function pinShake(msg) { var el = $('pin-dots'); el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); buzz(60); state.pin.digits = ''; drawDots(); err('pin-error', msg); }
  function pinKey(k) {
    var P = state.pin; if (P.busy) return;
    if (k === 'del') { P.digits = P.digits.slice(0, -1); drawDots(); return; }
    if (!/^\d$/.test(k) || P.digits.length >= 4) return;
    P.digits += k; drawDots(); err('pin-error', '');
    if (P.digits.length === 4) setTimeout(pinDone, 120);
  }
  function pinBusy(on) { state.pin.busy = on; $('pin-dots').classList.toggle('busy', on); }
  function pinDone() {
    var P = state.pin, pin = P.digits;
    if (P.mode === 'unlock') {
      pinBusy(true);
      sapi('staffUnlock', [pin]).then(function (r) {
        pinBusy(false); state.user = r.user; set(LS.user, JSON.stringify(r.user));
        if (r.needsPin) return showPin('create');
        enterMain(r.list || null);
      }).catch(function (e) { pinBusy(false); if (!e.signedOut) pinShake(e.message); });
      return;
    }
    if (P.mode === 'create' || P.mode === 'change') {
      if (/^(\d)\1{3}$/.test(pin) || pin === '1234' || pin === '0123' || pin === '4321') return pinShake('That PIN is too easy to guess. Pick another.');
      P.first = pin; return showPin(P.mode === 'create' ? 'confirm' : 'change-confirm');
    }
    if (P.mode === 'confirm' || P.mode === 'change-confirm') {
      if (pin !== P.first) { var m = P.mode === 'confirm' ? 'create' : 'change'; showPin(m, 'The PINs didn’t match. Try again.'); buzz(60); return; }
      pinBusy(true);
      sapi(P.mode === 'confirm' ? 'staffSetPin' : 'staffChangePin', [pin]).then(function () {
        pinBusy(false);
        if (P.mode === 'confirm') { enterMain(); toast('PIN set. Use it to open the app.'); }
        else { resumeMain(); toast('PIN changed'); }
      }).catch(function (e) { pinBusy(false); if (!e.signedOut) showPin(P.mode === 'confirm' ? 'create' : 'change', e.message); });
    }
  }
  function initPin() {
    $('keypad').addEventListener('click', function (e) { var b = e.target.closest('[data-key]'); if (b) pinKey(b.dataset.key); });
    document.addEventListener('keydown', function (e) {
      if ($('v-pin').hidden || !$('dlg').hidden) return;
      if (/^\d$/.test(e.key)) { pinKey(e.key); e.preventDefault(); } else if (e.key === 'Backspace') { pinKey('del'); e.preventDefault(); }
    });
    $('pin-alt').addEventListener('click', function () {
      var m = state.pin.mode;
      if (m.indexOf('change') === 0) { resumeMain(); return; }
      var t = state.token; clearSession(); if (t) api('staffLogout', [t]).catch(function () {});
      showLogin();
    });
  }

  /* =================================================================== main shell */
  function tabsFor() {
    var t = [{ key: 'home', label: 'Home', icon: ICON.house }, { key: 'orders', label: 'Book orders', icon: ICON.orders }];
    if (can('cash_take')) t.push({ key: 'cash', label: 'Cash', icon: ICON.cash });
    if (can('stock_view')) t.push({ key: 'stock', label: 'Stock', icon: ICON.stock });
    if (can('admin')) t.push({ key: 'admin', label: 'Admin', icon: ICON.admin });
    t.push({ key: 'me', label: 'Me', icon: ICON.me });
    return t;
  }
  function enterMain(list) {
    state.unlocked = true; screen('main');
    if (list) applyList(list);   // came back with the PIN unlock: no second round-trip
    state.tab = 'home';   // every open starts on Home; sections are in the side menu
    state.stack = []; state.seg = get(LS.seg); closeDrawer();
    render(); if (!list) loadOrders(false); else { if (state.pendingOrder) openPendingOrder(); } startPolling();
  }
  function resumeMain() { screen('main'); render(); startPolling(); }
  function lock() {
    if (!state.unlocked) return;
    if (state.token) api('staffLock', [state.token]).catch(function () {});
    state.unlocked = false; stopPolling(); closeDialog(); closeDrawer(); var fs = $('sigfs'); if (fs) { fs.remove(); document.body.classList.remove('sigfs-on'); }
    state.orders = []; state.ordersAt = null; state.staff = null; state.activity = null; state.me = null; state.settings = null; state.revealPin = {}; state.loadedAt = {};
    showPin('unlock');
  }
  function current() { return state.stack.length ? state.stack[state.stack.length - 1] : { page: state.tab }; }
  function go(page, params) { state.stack.push({ page: page, params: params || {} }); render(); window.scrollTo(0, 0); }
  function back() { state.stack.pop(); render(); window.scrollTo(0, 0); }
  function setTab(t) { closeDrawer(); if (t === state.tab && !state.stack.length) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; } state.tab = t; set(LS.tab, t); state.stack = []; render(); window.scrollTo(0, 0); }
  /* the side menu (all sections), opened with the menu button at the top left */
  function openDrawer() { renderTabbar(); var d = $('drawer'); if (!d) return; d.hidden = false; requestAnimationFrame(function () { d.classList.add('open'); }); }
  function closeDrawer() { var d = $('drawer'); if (!d || d.hidden) return; d.classList.remove('open'); setTimeout(function () { if (!d.classList.contains('open')) d.hidden = true; }, 220); }

  var PAGES = {};
  function render() {
    if (!state.unlocked) return;
    var cur = current(), P = PAGES[cur.page] || PAGES.orders;
    var nav = $('nav'); nav.classList.toggle('root', !!P.root);
    var prev = state.stack.length > 1 ? state.stack[state.stack.length - 2] : { page: state.tab };
    $('nav-left').innerHTML = state.stack.length
      ? '<button class="nav-back" data-act="back">' + ICON.back + '<span>' + esc(pageTitle(prev)) + '</span></button>'
      : '<button class="nav-btn nav-menu" data-act="drawer" aria-label="Menu">' + ICON.menu + '</button><span class="brand"><i></i>PRIME</span>';
    $('nav-title').textContent = pageTitle(cur);
    $('nav-right').innerHTML = P.right ? P.right(cur) : '';
    var page = $('page'); page.className = 'page' + (P.root ? '' : ' sub');
    page.innerHTML = P.html(cur);
    if (P.after) P.after(cur);
    renderTabbar(); onScroll();
  }
  function rerender() { var y = window.scrollY; render(); window.scrollTo(0, y); }
  function pageTitle(c) { var P = PAGES[c.page]; if (!P) return ''; return typeof P.title === 'function' ? P.title(c) : P.title; }
  function renderTabbar() {
    var c = counts(), lowN = state.stock ? state.stock.low.length : 0;
    $('tabbar').innerHTML = tabsFor().map(function (t) {
      var n = t.key === 'orders' ? (can('confirm') ? c.waiting : c.ready) : t.key === 'stock' ? lowN : 0;
      return '<button data-tab="' + t.key + '" class="' + (state.tab === t.key && !state.stack.length ? 'active' : '') + '" aria-label="' + t.label + '">' + t.icon + '<span class="lbl">' + t.label + '</span>' +
        (n ? '<span class="badge">' + (n > 99 ? '99+' : n) + '</span>' : '') + '</button>';
    }).join('') + '<div class="drawer-sep"></div><button data-act="lock" class="drawer-lock">' + ICON.lock + '<span class="lbl">Lock</span></button>';
    var who = $('drawer-who'); if (who && state.user) who.innerHTML = '<b>' + esc(state.user.name) + '</b><span>' + esc(state.user.roleLabel || '') + '</span>';
    try { if (navigator.setAppBadge) { if (can('confirm') && c.waiting) navigator.setAppBadge(c.waiting); else navigator.clearAppBadge(); } } catch (e) {}
  }
  function onScroll() { $('nav').classList.toggle('scrolled', window.scrollY > 30); }
  function navBtn(act, icon, label, extra) { return '<button class="nav-btn' + (extra || '') + '" data-act="' + act + '" aria-label="' + esc(label) + '">' + icon + '</button>'; }
  function loadingHtml() { return '<div class="loading"><div class="spinner"></div></div>'; }
  function lowBanner() {
    if (!state.stock || !state.stock.low.length) return '';
    return '<button class="banner red" data-act="tab" data-tab="stock">' + ICON.warn + '<span class="grow">Low stock: ' + esc(state.stock.low.join(' · ')) + '</span>' + (state.tab === 'stock' ? '' : '<span class="chev">' + ICON.chev + '</span>') + '</button>';
  }

  /* =================================================================== Home */
  function greeting() { var h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
  function firstNameOf(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
  PAGES.home = {
    title: 'Home', root: true,
    right: function () { return navBtn('refresh', ICON.refresh, 'Refresh'); },
    html: function () {
      var c = counts(), lowN = state.stock ? state.stock.low.length : 0;
      var h = '<div class="large-row"><h1 class="large">' + esc(greeting()) + (state.user ? ', ' + esc(firstNameOf(state.user.name)) : '') + '</h1></div>' +
        '<p class="home-date">' + esc(new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })) + '</p>' + lowBanner();
      // today at a glance
      var stats = [];
      if (can('confirm')) stats.push(['orders', c.waiting, c.waiting === 1 ? 'order to confirm' : 'orders to confirm', c.waiting ? 'hot' : '']);
      stats.push(['orders', c.ready, 'ready for pickup', '']);
      if (can('cash_take')) stats.push(['cash', state.cashMine ? money(state.cashMine.total) : '\u2013', 'cash you took today', '']);
      if (can('stock_view') && lowN) stats.push(['stock', lowN, lowN === 1 ? 'book low on stock' : 'books low on stock', 'warn']);
      h += '<div class="home-stats">' + stats.map(function (x) { return '<button class="home-stat ' + x[3] + '" data-act="tab" data-tab="' + x[0] + '"><b>' + x[1] + '</b><span>' + x[2] + '</span></button>'; }).join('') + '</div>';
      if (can('cash_take')) h += '<button class="btn primary block" data-act="cash-new" style="margin:14px 0 4px">' + ICON.plus + 'New cash payment</button>';
      // the sections, like apps on a phone
      var apps = [['orders', 'Book orders', ICON.book, 'blue', can('confirm') ? c.waiting : c.ready]];
      if (can('cash_take')) { apps.push(['cash', 'Cash', ICON.cash, 'green', 0]); apps.push(['@cashbook', 'Cash book', ICON.sheet, 'teal', 0]); }
      if (can('stock_view')) apps.push(['stock', 'Stock', ICON.stock, 'amber', lowN]);
      if (can('admin')) apps.push(['admin', 'Admin', ICON.admin, 'violet', 0]);
      apps.push(['me', 'Me', ICON.me, 'grey', 0]);
      h += '<div class="group-head">Apps</div><div class="apps">' + apps.map(function (a) {
        var attrs = a[0] === '@cashbook' ? 'data-act="cashbook"' : 'data-act="tab" data-tab="' + a[0] + '"';
        return '<button class="app" ' + attrs + ' aria-label="' + esc(a[1]) + '"><span class="app-ic ' + a[3] + '">' + a[2] + (a[4] ? '<i class="badge">' + (a[4] > 99 ? '99+' : a[4]) + '</i>' : '') + '</span><span class="app-name">' + esc(a[1]) + '</span></button>';
      }).join('') + '</div>';
      return h;
    },
    after: function () { if (can('cash_take') && (!state.cashMine || Date.now() - (state.cashMineAt || 0) > 60000)) loadCashMine(); }
  };

  /* =================================================================== Orders */
  function counts() {
    var c = { waiting: 0, ready: 0, done: 0, all: state.orders.length };
    state.orders.forEach(function (o) { if (o.status === 'NEW' || o.status === 'SENT') c.waiting++; if (o.status === 'READY') c.ready++; if (o.status === 'PICKED_UP') c.done++; });
    return c;
  }
  function segsFor() { return can('confirm') ? [['waiting', 'Waiting on me'], ['ready', 'Ready'], ['done', 'Done'], ['all', 'All']] : [['ready', 'Ready'], ['done', 'Done']]; }
  /** Staff see the official name from the accounting workbook (it matches the student ID); the typed name is in Details. */
  function titleCase(n) { return String(n || '').toLowerCase().replace(/(^|[\s'-])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); }); }
  function displayName(o) { var w = String(o.workbookName || '').trim(); if (!w) return o.name; return w === w.toUpperCase() ? titleCase(w) : w; }
  function itemsText(o) { var a = []; if (o.sorrentino) a.push('Sorrentino'); if (o.palliative) a.push('Palliative bundle'); return a.join(' + '); }
  function pill(o) {
    var m = { NEW: o.included ? ['p-incl', 'Included · confirm'] : ['p-new', 'Not paid yet'], SENT: o.included ? ['p-incl', 'Included · confirm'] : ['p-sent', 'Says it’s sent'],
      READY: ['p-ready', 'Ready for pickup'], PICKED_UP: ['p-picked', 'Picked up'], CANCELLED: ['p-cancel', 'Cancelled'] }[o.status] || ['p-new', o.status];
    return '<span class="pill ' + m[0] + '">' + esc(m[1]) + '</span>';
  }
  function whenText(o) {
    if (o.status === 'PICKED_UP') return when(o.pickedUpAt);
    if (o.status === 'READY') return 'Confirmed ' + when(o.confirmedAt);
    if (o.status === 'SENT') return 'Sent ' + when(o.sentAt);
    if (o.status === 'CANCELLED') return when(o.cancelledAt);
    return 'Ordered ' + when(o.createdAt);
  }
  function filteredOrders() {
    var seg = state.seg, q = state.search.trim().toLowerCase(), qd = q.replace(/\D/g, '');
    var list = state.orders.filter(function (o) {
      if (seg === 'waiting' && !(o.status === 'NEW' || o.status === 'SENT')) return false;
      if (seg === 'ready' && o.status !== 'READY') return false;
      if (seg === 'done' && o.status !== 'PICKED_UP') return false;
      if (!q) return true;
      var hay = [o.name, o.workbookName, o.pickupCode, '#' + o.orderNo, String(o.orderNo), o.studentNumber, o.email, o.batch].join(' ').toLowerCase();
      if (hay.indexOf(q) !== -1) return true;
      return qd.length >= 4 && String(o.phone || '').replace(/\D/g, '').indexOf(qd) !== -1;
    });
    var rank = function (o) { return o.status === 'SENT' && !o.included ? 0 : o.included ? 1 : 2; };
    if (seg === 'waiting') list.sort(function (a, b) { return (rank(a) - rank(b)) || (a.orderNo - b.orderNo); });
    else if (seg === 'ready') list.sort(function (a, b) { return displayName(a).localeCompare(displayName(b)); });
    else list.sort(function (a, b) { return b.orderNo - a.orderNo; });
    return list;
  }
  function cardHtml(o) {
    var waiting = o.status === 'NEW' || o.status === 'SENT';
    var h = '<article class="card' + (o.status === 'CANCELLED' ? ' cancelled' : '') + '" data-no="' + o.orderNo + '">' +
      '<div class="c-top"><div class="c-name">' + esc(displayName(o)) + '</div>' +
      (o.included ? '<div class="c-amt included">Included</div>' : '<div class="c-amt">' + money(o.amount) + '</div>') + '</div>' +
      '<div class="c-sub">' + esc(itemsText(o)) + ' · #' + o.orderNo + (o.test ? ' <span class="chip test">TEST</span>' : '') + '</div>' +
      '<div class="c-sub faint">' + esc(o.batch) + '</div>' +
      '<div class="c-status">' + pill(o) + '<span class="c-when">' + esc(whenText(o)) + '</span></div>';
    var tags = (o.flags || []).filter(function (f) { return f !== 'Included'; });
    if (tags.length) h += '<div class="c-tags">' + tags.map(function (f) { return '<span class="tag">' + esc(f) + '</span>'; }).join('') + '</div>';
    if (o.status === 'READY') h += '<div class="c-code"><span>Pickup code</span><b>' + esc(o.pickupCode) + '</b></div>';
    if (waiting && can('confirm')) {
      if (o.included) h += '<div class="c-hint">Books are in their fees. Nothing to check.</div>';
      else if (o.status === 'SENT') h += '<div class="c-hint">Look in the e-transfer inbox for <b>' + money(o.amount) + '</b> with the message <b>Order ' + o.orderNo + '</b>.</div>';
      else h += '<div class="c-hint">They haven’t said it’s sent yet. Confirm only if <b>' + money(o.amount) + '</b> is in the inbox.</div>';
      h += '<div class="c-act"><button class="btn primary" data-act="confirm">' + (o.included ? 'Confirm and send code' : 'Payment received · send code') + '</button></div>';
    }
    if (o.status === 'READY' && can('pickup')) h += '<div class="c-act"><button class="btn primary" data-act="pickup">Hand over · mark picked up</button></div>';
    // details
    var kv = [];
    if (o.studentNumber) kv.push(['Student ID', esc(o.studentNumber)]);
    if (o.phone) kv.push(['Phone', '<a href="tel:' + esc(String(o.phone).replace(/[^\d+]/g, '')) + '">' + esc(o.phone) + '</a>']);
    if (o.email) kv.push(['Email', '<a href="mailto:' + esc(o.email) + '">' + esc(o.email) + '</a>']);
    if (displayName(o).toLowerCase() !== String(o.name).toLowerCase()) kv.push(['Typed their name as', esc(o.name)]);
    if (o.agent) kv.push(['Agent', esc(o.agent)]);
    kv.push(['Ordered', esc(when(o.createdAt))]);
    if (o.sentAt) kv.push(['Said sent', esc(when(o.sentAt))]);
    if (o.confirmedAt) kv.push(['Confirmed', esc(when(o.confirmedAt))]);
    if (o.pickedUpAt) kv.push(['Picked up', esc(when(o.pickedUpAt))]);
    if (o.studentNote) kv.push(['Student note', esc(o.studentNote)]);
    if (o.staffNote) kv.push(['Staff note', esc(o.staffNote)]);
    var acts = '';
    if (can('notes')) acts += '<button class="btn small" data-act="note">' + (o.staffNote ? 'Edit note' : 'Add note') + '</button>';
    if (can('cancel') && o.status !== 'CANCELLED' && (o.status !== 'PICKED_UP' || can('override'))) acts += '<button class="btn small danger" data-act="cancel">' + (o.status === 'PICKED_UP' ? 'Cancel (owner)' : 'Cancel order') + '</button>';
    h += '<details class="more" data-more="' + o.orderNo + '"' + (state.openMore[o.orderNo] ? ' open' : '') + '><summary>Details' + ICON.chev + '</summary>' +
      '<dl class="kv">' + kv.map(function (p) { return '<dt>' + p[0] + '</dt><dd>' + p[1] + '</dd>'; }).join('') + '</dl>' +
      (acts ? '<div class="more-actions">' + acts + '</div>' : '') + '</details>';
    return h + '</article>';
  }
  function emptyHtml() {
    if (state.search) return '<div class="empty">' + ICON.search + '<strong>No matches</strong>Nothing matches “' + esc(state.search) + '” here.</div>';
    var t = { waiting: ['All caught up', 'No payments waiting for you.'], ready: ['Nothing to hand out', 'Confirmed orders appear here with their pickup code.'],
      done: ['No pickups yet', 'Orders handed over land here.'], all: ['No orders yet', 'Orders appear here as students place them.'] }[state.seg] || ['', ''];
    return '<div class="empty">' + ICON.check + '<strong>' + t[0] + '</strong>' + t[1] + '</div>';
  }
  function ordersTopHtml() {
    var c = counts();
    return lowBanner() + '<div class="seg" role="tablist">' + segsFor().map(function (s) {
      var n = (s[0] === 'waiting' || s[0] === 'ready') && c[s[0]] ? '<span class="n">' + c[s[0]] + '</span>' : '';
      return '<button role="tab" data-seg="' + s[0] + '" class="' + (state.seg === s[0] ? 'on' : '') + '" aria-selected="' + (state.seg === s[0]) + '">' + esc(s[1]) + n + '</button>';
    }).join('') + '</div>';
  }
  function ordersFoot() {
    if (!state.ordersAt) return '';
    var t = 'Updated ' + timeOf(state.ordersAt.toISOString()), l = state.lookup;
    if (l && l.ok) t += ' · Workbook ' + (l.dataAsOf ? new Date(l.dataAsOf).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '') + ' (' + l.students + ' students)';
    else if (l && !l.ok) t += ' · Workbook problem: ' + l.error;
    return esc(t);
  }
  function updateOrders() {
    if (current().page !== 'orders' || !$('orders-top')) return;
    $('orders-top').innerHTML = ordersTopHtml();
    var list = filteredOrders();
    $('orders-list').innerHTML = !state.ordersAt && !state.orders.length ? loadingHtml() : list.length ? list.map(cardHtml).join('') : emptyHtml();
    $('orders-foot').innerHTML = ordersFoot();
  }
  PAGES.orders = {
    title: 'Orders', root: true,
    right: function () { return navBtn('refresh', ICON.refresh, 'Refresh'); },
    html: function () {
      if (!segsFor().some(function (s) { return s[0] === state.seg; })) state.seg = segsFor()[0][0];
      return '<div class="large-row"><h1 class="large">Orders</h1></div><div id="orders-top"></div>' +
        '<div class="search">' + ICON.search + '<input id="search" type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Name, pickup code or order #" value="' + esc(state.search) + '">' +
        (state.search ? '<button class="clear" data-act="clear-search" aria-label="Clear">✕</button>' : '') + '</div>' +
        '<div id="orders-list" class="list"></div><p class="foot" id="orders-foot"></p>';
    },
    after: function () {
      updateOrders();
      $('search').addEventListener('input', function (e) {
        state.search = e.target.value; updateOrders();
        var clr = document.querySelector('.search .clear');
        if (state.search && !clr) { var b = document.createElement('button'); b.className = 'clear'; b.dataset.act = 'clear-search'; b.setAttribute('aria-label', 'Clear'); b.textContent = '✕'; e.target.parentNode.appendChild(b); }
        if (!state.search && clr) clr.remove();
      });
    }
  };
  function loadOrders(silent) {
    if (!state.token || !state.unlocked) return Promise.resolve();
    var btn = document.querySelector('[data-act="refresh"]'); if (btn && !silent) btn.classList.add('spin');
    return sapi('staffList').then(function (r) {
      var roleChanged = applyList(r);
      if (state.pendingOrder) openPendingOrder();
      if (roleChanged) { state.stack = []; if (!tabsFor().some(function (t) { return t.key === state.tab; })) state.tab = 'orders'; rerender(); }
      else { updateOrders(); renderTabbar(); if (current().page === 'stock' && !state.busy) updateStock(); if (current().page === 'home' && !state.busy && $('dlg').hidden) rerender(); }
    }).catch(function (e) { if (!silent && !e.signedOut) toast(e.message); })
      .then(function () { var b = document.querySelector('[data-act="refresh"]'); if (b) b.classList.remove('spin'); });
  }
  function applyList(r) {
    state.orders = r.orders; state.ordersAt = new Date(); state.lookup = r.lookup; if (r.stock) state.stock = r.stock;
    var roleChanged = !!(state.user && r.me && (r.me.role !== state.user.role));
    state.user = r.me; set(LS.user, JSON.stringify(r.me));
    if (r.push && (can('push_orders') || can('push_ready'))) initPush(r.push); else state.push = null;
    setPractice(!!r.practice);
    return roleChanged;
  }
  function setPractice(on) { state.practice = on; var b = $('practice-bar'); if (b) b.hidden = !on; }
  function startPolling() { stopPolling(); state.timer = setInterval(function () { if (document.visibilityState === 'visible' && state.unlocked && !state.busy && $('dlg').hidden) loadOrders(true); }, POLL_MS); }
  function stopPolling() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }
  function orderByNo(no) { for (var i = 0; i < state.orders.length; i++) if (state.orders[i].orderNo === no) return state.orders[i]; return null; }
  function replaceOrder(o) { var i = state.orders.findIndex(function (x) { return x.orderNo === o.orderNo; }); if (i >= 0) state.orders[i] = o; else state.orders.unshift(o); }
  function runOrderAction(btn, fn, args, done) {
    if (state.busy) return; state.busy = true;
    var label = btn ? btn.textContent : ''; if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner sm"></span>'; }
    sapi(fn, args).then(function (o) { replaceOrder(o); done(o); updateOrders(); renderTabbar(); buzz(25); })
      .catch(function (e) { if (!e.signedOut) { toast(e.message); if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; } loadOrders(true); } })
      .then(function () { state.busy = false; });
  }
  function orderAct(act, o, btn) {
    var nm = displayName(o);
    if (act === 'confirm') {
      dialog({ title: o.included ? 'Send ' + firstName(nm) + '’s code?' : 'Payment received?',
        html: o.included ? esc(nm) + '’s books are included in their fees. They’ll see a pickup code right away.'
          : 'Only confirm once <b>' + money(o.amount) + '</b> from ' + esc(nm) + ' is in the e-transfer inbox (message “Order ' + o.orderNo + '”).',
        ok: o.included ? 'Send code' : 'Yes, send code' })
        .then(function (r) { if (r) runOrderAction(btn, 'confirmPayment', [o.orderNo], function (x) { toast('Code ' + x.pickupCode + ' sent to ' + firstName(nm)); }); });
    } else if (act === 'pickup') {
      dialog({ title: 'Hand over to ' + firstName(nm) + '?', html: 'Check their code matches <b style="font-family:var(--mono);letter-spacing:2px">' + esc(o.pickupCode) + '</b>, then give them: ' + esc(itemsText(o)) + '.', ok: 'Picked up' })
        .then(function (r) { if (r) runOrderAction(btn, 'markPickedUp', [o.orderNo], function (x) { toast(firstName(nm) + ' picked up #' + x.orderNo); refreshStockQuiet(); }); });
    } else if (act === 'cancel') {
      var picked = o.status === 'PICKED_UP';
      dialog({ title: 'Cancel order #' + o.orderNo + '?', html: picked ? 'Owner override: the books go back into stock and this is logged. If cash was taken, void that record separately.' : esc(nm) + ' will see it as cancelled. This can’t be undone.', ok: 'Cancel order', cancel: 'Keep', destructive: true,
        inputs: [{ key: 'reason', placeholder: picked ? 'Why? (required)' : 'Reason (optional)', maxlength: 200 }], validate: picked ? function (v) { return v.reason && v.reason.trim().length >= 3 ? '' : 'Say why.'; } : null })
        .then(function (r) { if (r) runOrderAction(null, 'cancelOrder', [o.orderNo, r.reason || ''], function () { toast('Order #' + o.orderNo + ' cancelled'); }); });
    } else if (act === 'note') {
      dialog({ title: 'Staff note', html: 'Only staff see this.', ok: 'Save', inputs: [{ key: 'note', value: o.staffNote || '', placeholder: 'e.g. picked up by her sister', maxlength: 300, textarea: true }] })
        .then(function (r) { if (r) runOrderAction(null, 'saveStaffNote', [o.orderNo, r.note || ''], function () { toast('Note saved'); }); });
    }
  }

  /* =================================================================== notifications (OneSignal) */
  function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function appDir() { return location.pathname.replace(/[^\/]*$/, ''); }            // e.g. /prime-books/staff/
  function initPush(cfg) {
    if (state.push && state.push.pushId === cfg.pushId && state.push.appId === cfg.appId) return;
    state.push = cfg;
    if (!pushSupported()) { state.pushState = isIOS() && !standalone() ? 'needs-home' : 'unsupported'; return; }
    if (isIOS() && !standalone()) { state.pushState = 'needs-home'; return; }
    state.pushState = 'loading';
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(function (OneSignal) {
      return OneSignal.init({ appId: cfg.appId, serviceWorkerPath: appDir().replace(/^\//, '') + 'sw.js', serviceWorkerParam: { scope: appDir() },
        notifyButton: { enable: false }, allowLocalhostAsSecureOrigin: true })
        .then(function () { return OneSignal.login(cfg.pushId); })
        .then(function () { state.os = OneSignal; refreshPushState(); })
        .catch(function () { state.pushState = 'error'; if (current().page === 'me') rerender(); });
    });
    if (!document.getElementById('os-sdk')) {
      var sc = document.createElement('script'); sc.id = 'os-sdk'; sc.defer = true; sc.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
      sc.onerror = function () { state.pushState = 'error'; if (current().page === 'me') rerender(); };
      document.head.appendChild(sc);
    }
  }
  function refreshPushState() {
    var os = state.os; if (!os) return;
    var perm = (window.Notification && Notification.permission) || 'default';
    state.pushState = perm === 'denied' ? 'blocked' : (os.User && os.User.PushSubscription && os.User.PushSubscription.optedIn && perm === 'granted') ? 'on' : 'off';
    if (current().page === 'me') rerender();
  }
  function turnOnPush() {
    if (state.pushState === 'needs-home') return install();
    if (!state.os) return toast('Notifications are still loading. Try again in a moment.');
    Promise.resolve(state.os.Notifications.requestPermission()).then(function () {
      return state.os.User.PushSubscription.optIn ? state.os.User.PushSubscription.optIn() : null;
    }).then(function () { setTimeout(function () { refreshPushState(); if (state.pushState === 'on') toast('Notifications are on'); }, 600); })
      .catch(function () { refreshPushState(); });
  }
  function pushLogout() { try { if (state.os && state.os.logout) state.os.logout(); } catch (e) {} state.push = null; state.os = null; state.pushState = 'off'; }
  function pushRowHtml() {
    if (!can('push_orders') && !can('push_ready')) return '';
    var what = can('push_orders') ? 'new orders and \u201ce-transfer sent\u201d' : 'orders that are ready for pickup';
    var st = state.pushState, sub, btn = '';
    if (!state.push) sub = can('admin') ? 'Not set up yet. Admin › Settings › Notifications.' : 'Not set up yet.';
    else if (st === 'on') { sub = 'On. You\u2019ll get ' + what + '.'; btn = '<button class="btn small" data-act="push-test">Test</button>'; }
    else if (st === 'needs-home') { sub = 'Add this app to your home screen first, then open it from there.'; btn = '<button class="btn small" data-act="install">How</button>'; }
    else if (st === 'blocked') sub = 'Blocked. Allow notifications for this app in your phone’s settings.';
    else if (st === 'unsupported') sub = 'This browser can’t show notifications. Use Safari (iPhone) or Chrome (Android).';
    else if (st === 'loading') sub = 'Getting ready…';
    else if (st === 'error') sub = 'Couldn’t load the notification service. Check your connection and reopen the app.';
    else { sub = 'Off on this phone.'; btn = '<button class="btn small primary" data-act="push-on">Turn on</button>'; }
    return '<div class="group-head">Notifications</div><div class="group"><div class="row"><span class="ic red">' + ICON.bell + '</span><span class="grow"><span class="title">' + (can('push_orders') ? 'Order notifications' : 'Pickup notifications') + '</span><span class="sub">' + esc(sub) + '</span></span>' + btn + '</div></div>';
  }
  function openPendingOrder() {
    var no = state.pendingOrder; state.pendingOrder = null;
    var o = orderByNo(no);
    if (!o) { toast('Order #' + no + ' isn’t in your list.'); return; }
    state.seg = (o.status === 'NEW' || o.status === 'SENT') && can('confirm') ? 'waiting' : o.status === 'READY' ? 'ready' : o.status === 'PICKED_UP' ? 'done' : (can('confirm') ? 'all' : 'ready');
    state.search = '#' + no; state.openMore[no] = true; state.tab = 'orders'; state.stack = [];
    render(); window.scrollTo(0, 0);
  }

  /* =================================================================== Stock */
  function tileHtml(i) {
    var cls = !i.tracked ? ' untracked' : i.low ? ' low' : '';
    var stateChip = !i.tracked ? '<span class="t-state none">Not counted yet</span>' : i.low ? '<span class="t-state low">Low</span>' : '<span class="t-state ok">OK</span>';
    var h = '<div class="tile' + cls + '"><div class="t-name">' + esc(i.name) + '</div><div class="t-num">' + (i.tracked ? i.onHand : '–') + '</div>' +
      '<div class="t-sub">' + (can('stock_edit') ? '<button class="alert-at" data-act="stock-threshold" data-item="' + i.key + '">Alert at ' + i.threshold + '</button>' : '<span>Alert at ' + i.threshold + '</span>') + stateChip + '</div>';
    if (can('stock_edit')) h += '<div class="t-actions"><button class="btn" data-act="stock-receive" data-item="' + i.key + '">Receive</button><button class="btn" data-act="stock-count" data-item="' + i.key + '">Count</button></div>';
    return h + '</div>';
  }
  function logRowHtml(l) {
    var ch = l.change > 0 ? '+' + l.change : l.change < 0 ? String(l.change) : '';
    return '<div class="row"><span class="act-dot ' + (l.change < 0 ? 'blue' : l.change > 0 ? '' : 'grey') + '"></span><span class="grow"><span class="title">' + esc(l.itemName) + (ch ? ' <b>' + ch + '</b>' : '') + '</span>' +
      '<span class="sub">' + esc(l.reason) + (l.orderNo ? ' #' + l.orderNo : '') + ' · ' + esc(l.who || 'system') + ' · now ' + l.level + '</span></span><span class="time">' + esc(when(l.at)) + '</span></div>';
  }
  function updateStock() {
    if (current().page !== 'stock' || !$('stock-body')) return;
    var st = state.stock;
    var untracked = st && st.items.some(function (i) { return !i.tracked; });
    $('stock-body').innerHTML = !st ? loadingHtml() : lowBanner() +
      (untracked && can('stock_edit') ? '<div class="banner amber">' + ICON.box + '<span class="grow">Tap <b>Count</b> on each book to enter what’s on the shelf. Tracking and alerts start after that.</span></div>' : '') +
      '<div class="stock-grid">' + st.items.map(tileHtml).join('') + '</div>' +
      '<p class="group-foot">Each pickup takes one of each book in the order (the palliative bundle takes a textbook and a workbook). You get one email when a book reaches its alert level.</p>' +
      '<div class="group-head">Recent changes</div>' +
      (state.stockLogRows === null ? loadingHtml() : state.stockLogRows.length ? '<div class="group">' + state.stockLogRows.slice(0, 40).map(logRowHtml).join('') + '</div>' : '<p class="group-foot">No changes yet.</p>');
  }
  PAGES.stock = {
    title: 'Stock', root: true,
    right: function () { return navBtn('refresh', ICON.refresh, 'Refresh'); },
    html: function () { return '<h1 class="large">Stock</h1><div id="stock-body"></div>'; },
    after: function () { updateStock(); refreshStockQuiet(); }
  };
  function refreshStockQuiet() {
    if (!can('stock_view')) return Promise.resolve();
    return Promise.all([sapi('stockList'), sapi('stockLog', [60])]).then(function (r) { state.stock = r[0]; state.stockLogRows = r[1]; updateStock(); renderTabbar(); })
      .catch(function (e) { if (!e.signedOut && current().page === 'stock') toast(e.message); });
  }
  function stockItem(key) { return state.stock ? state.stock.items.filter(function (i) { return i.key === key; })[0] : null; }
  function stockAct(act, key) {
    var i = stockItem(key); if (!i) return;
    var mode = act.replace('stock-', ''), cfg = {
      receive: { title: 'Receive ' + i.name, html: 'How many arrived?' + (i.tracked ? ' You have ' + i.onHand + ' now.' : ''), ok: 'Add', inputs: [{ key: 'qty', type: 'number', placeholder: 'Number of books' }, { key: 'note', placeholder: 'Note (optional), e.g. supplier invoice #' , maxlength: 120 }] },
      count: { title: 'Count ' + i.name, html: 'How many are on the shelf right now?' + (i.tracked ? ' The app thinks ' + i.onHand + '.' : ''), ok: 'Save count', inputs: [{ key: 'qty', type: 'number', placeholder: 'Books on the shelf', value: i.tracked ? String(i.onHand) : '' }, { key: 'note', placeholder: 'Note (optional)', maxlength: 120 }] },
      threshold: { title: 'Alert level', html: 'Email me when ' + esc(i.name) + ' drops to this number or below.', ok: 'Save', inputs: [{ key: 'qty', type: 'number', value: String(i.threshold) }] }
    }[mode];
    cfg.validate = function (v) { var n = Number(v.qty); if (v.qty === '' || !isFinite(n) || n < 0 || Math.floor(n) !== n) return 'Enter a whole number.'; if (mode === 'receive' && n === 0) return 'Enter how many arrived.'; if (n > 100000) return 'That number looks too big.'; return ''; };
    dialog(cfg).then(function (r) {
      if (!r) return;
      state.busy = true;
      sapi('stockAdjust', [key, { mode: mode, qty: Number(r.qty), note: r.note || '' }]).then(function (st) {
        state.stock = st; toast(mode === 'receive' ? 'Added ' + r.qty + ' · ' + i.name : mode === 'count' ? i.name + ': ' + r.qty + ' on the shelf' : 'Alert level saved');
        buzz(20); return refreshStockQuiet();
      }).catch(function (e) { if (!e.signedOut) toast(e.message); }).then(function () { state.busy = false; });
    });
  }

  /* =================================================================== Cash at the desk */
  function newCashState() { return { email: '', phone: '', name: '', lookup: null, looking: false, orderNo: null, sorrentino: false, palliative: false, matchKey: '', items: {}, tuition: false, tuitionAmt: '', tuitionNote: '', external: false, ovAmount: '', ovReason: '' }; }
  function cashItemOn(i) { return !!state.cash.items[i.id] && (can('override') || !(i.wbStatus && i.wbStatus.status === 'included')); }
  function cashItemBlocked(i) { return !!(i.wbStatus && i.wbStatus.status === 'included'); }
  function bookBlocked(b) { return b.status === 'included' || b.out; }
  function bookOn(b) { var c = state.cash; return !!c[b.key] && (can('override') || !bookBlocked(b)); }
  // what the owner is overriding right now (blocked things ticked, or a changed total)
  function cashOverrides() {
    var c = state.cash, L = c.lookup, out = []; if (!L) return out;
    if (!c.orderNo) cashBooks().forEach(function (b) { if (c[b.key] && bookBlocked(b)) out.push(b.label + (b.status === 'included' ? ' (included)' : ' (out of stock)')); });
    L.items.forEach(function (i) { if (c.items[i.id] && cashItemBlocked(i)) out.push(i.name + ' (included)'); });
    if (c.ovAmount !== '' && /^\d{1,6}(\.\d{1,2})?$/.test(String(c.ovAmount).trim())) out.push('total changed');
    return out;
  }
  function tuitionAmt() { var c = state.cash; if (!c.tuition) return 0; var a = String(c.tuitionAmt).trim(); return /^\d{1,6}(\.\d{1,2})?$/.test(a) ? Number(a) : 0; }
  function cashSummary() {
    var c = state.cash, L = c.lookup, a = [];
    if (c.orderNo) { var o = L.openOrders.filter(function (x) { return x.orderNo === c.orderNo; })[0]; if (o) a.push(itemsText(o) + ' (order #' + o.orderNo + ')'); }
    else cashBooks().forEach(function (b) { if (bookOn(b)) a.push(b.label); });
    L.items.forEach(function (i) { if (cashItemOn(i)) a.push(i.name); });
    if (c.tuition && tuitionAmt() > 0) a.push('Tuition' + (c.tuitionNote.trim() ? ' (' + c.tuitionNote.trim() + ')' : ''));
    return a.join(' + ');
  }
  function cashBooks() {
    var c = state.cash, L = c.lookup;
    var m = L && L.matches.length ? L.matches[0] : null;
    var prices = L ? L.prices : { sorrentino: 0, palliative: 0 };
    var stock = {}; (L ? L.stock : []).forEach(function (i) { stock[i.key] = i; });
    var out = function (keys) { return keys.some(function (k) { return stock[k] && stock[k].tracked && stock[k].onHand <= 0; }); };
    return [
      { key: 'sorrentino', label: 'Sorrentino textbook', price: prices.sorrentino, status: m ? m.books.sorrentino.status : 'owed', paidOn: m ? m.books.sorrentino.paidOn : '', out: out(['sorrentino']) },
      { key: 'palliative', label: 'Palliative textbook + workbook', price: prices.palliative, status: m ? m.books.palliative.status : 'owed', paidOn: m ? m.books.palliative.paidOn : '', out: out(['pal_text', 'pal_work']) }
    ];
  }
  function cashAmount() {
    var c = state.cash, L = c.lookup; if (!L) return 0;
    var t = 0;
    if (c.orderNo) { var o = L.openOrders.filter(function (x) { return x.orderNo === c.orderNo; })[0]; t = o ? o.amount : 0; }
    else t = cashBooks().reduce(function (t, b) { return t + (bookOn(b) ? b.price : 0); }, 0);
    L.items.forEach(function (i) { if (cashItemOn(i)) t += i.price; });
    t += tuitionAmt();
    if (can('override') && c.ovAmount !== '' && /^\d{1,6}(\.\d{1,2})?$/.test(String(c.ovAmount).trim())) t = Number(String(c.ovAmount).trim());
    return Math.round(t * 100) / 100;
  }
  function cashBodyHtml() {
    var c = state.cash, L = c.lookup, h = '';
    if (!L) return '';
    var m = L.matches.length ? L.matches[0] : null;
    h += m ? '<div class="banner green">' + ICON.check + '<span class="grow"><b>' + esc(titleCase(m.name)) + '</b><br><span style="font-weight:400">' + esc(m.batch) + ' · ' + esc(m.agent) + (L.pending != null && L.pending > 0 ? ' · workbook balance ' + money(L.pending) : '') + '</span></span></div>'
      : L.external ? '<div class="banner">' + ICON.warn + '<span class="grow">Not a student / external. No workbook check; the record is flagged so the admin can match it later by phone or email.</span></div>'
      : '<div class="banner amber">' + ICON.warn + '<span class="grow">Not in the accounting workbook. You can still take it; it’ll be flagged for the admin.</span></div>';
    h += '<div class="group"><label class="cell"><span>Name</span><input id="cash-name" type="text" autocomplete="off" maxlength="80" value="' + esc(c.name) + '" placeholder="Student’s full name"></label></div>';
    var waiting = L.openOrders.filter(function (o) { return !o.included; });
    if (waiting.length) {
      h += '<div class="group-head">Online order waiting</div><div class="group">' + waiting.map(function (o) {
        return '<label class="row"><input type="radio" name="cash-order" value="' + o.orderNo + '"' + (c.orderNo === o.orderNo ? ' checked' : '') + '><span class="grow"><span class="title">Take cash for order #' + o.orderNo + '</span><span class="sub' + (o.status === 'SENT' ? ' warn' : '') + '">' + esc(itemsText(o)) + (o.status === 'SENT' ? '. They said they already e-transferred: check the inbox before taking cash.' : '') + '</span></span><span class="value">' + money(o.amount) + '</span></label>';
      }).join('') + '<label class="row"><input type="radio" name="cash-order" value=""' + (!c.orderNo ? ' checked' : '') + '><span class="grow"><span class="title">Something else</span></span></label></div>';
    }
    if (!c.orderNo) {
      h += '<div class="group-head">Books</div><div class="group">' + cashBooks().map(function (b) {
        var blocked = b.status === 'included' || b.out, note = b.status === 'included' ? 'In their fees. Don’t take cash.' : b.out ? 'Out of stock. Don’t take cash.' : b.status === 'paid' ? 'Workbook shows paid' + (b.paidOn ? ' ' + b.paidOn : '') + '. Check before taking cash.' : '';
        var ovOk = blocked && can('override');
        return '<label class="row' + (blocked ? ' blocked' : '') + (ovOk ? ' ov' : '') + '"><input type="checkbox" data-book="' + b.key + '"' + (c[b.key] && (!blocked || ovOk) ? ' checked' : '') + (blocked && !ovOk ? ' disabled' : '') + '><span class="grow"><span class="title">' + esc(b.label) + '</span>' +
          (note ? '<span class="sub' + (b.status === 'paid' ? ' warn' : '') + '">' + esc(note) + '</span>' : '') + '</span><span class="value">' + money(b.price) + '</span></label>';
      }).join('') + '</div>';
    }
    // courses & exams from Settings > Cash items, grouped
    var groups = [], byG = {};
    L.items.forEach(function (i) { var g = i.group || 'Other'; if (!byG[g]) { byG[g] = []; groups.push(g); } byG[g].push(i); });
    groups.forEach(function (g) {
      h += '<div class="group-head">' + esc(g) + '</div><div class="group">' + byG[g].map(function (i) {
        var st = i.wbStatus || { status: '' }, blocked = st.status === 'included', ovOk = blocked && can('override');
        var note = blocked ? 'In their fees. Don’t take cash.' : st.status === 'paid' ? 'Workbook shows ' + (i.wbLabel || i.name) + ' paid' + (st.amount != null ? ' ' + money(st.amount) : '') + (st.paidOn ? ' ' + st.paidOn : '') + '. Check before taking cash.' : st.status === 'owed' ? 'Owed per workbook' : '';
        return '<label class="row' + (blocked ? ' blocked' : '') + (ovOk ? ' ov' : '') + '"><input type="checkbox" data-item="' + esc(i.id) + '"' + (c.items[i.id] && (!blocked || ovOk) ? ' checked' : '') + (blocked && !ovOk ? ' disabled' : '') + '><span class="grow"><span class="title">' + esc(i.name) + '</span>' +
          (note ? '<span class="sub' + (st.status === 'paid' ? ' warn' : '') + '">' + esc(note) + '</span>' : '') + '</span><span class="value">' + money(i.price) + '</span></label>';
      }).join('') + '</div>';
    });
    h += '<div class="group-head">Tuition</div><div class="group"><label class="row"><input type="checkbox" data-tuition="1"' + (c.tuition ? ' checked' : '') + '><span class="grow"><span class="title">Tuition payment</span><span class="sub">You type the amount. A note is required.</span></span></label>' +
      (c.tuition ? '<label class="cell"><span>Amount</span><input id="cash-tuition-amt" type="text" inputmode="decimal" autocomplete="off" value="' + esc(c.tuitionAmt) + '" placeholder="e.g. 500"></label>' +
        '<label class="cell"><span>Note</span><input id="cash-tuition-note" type="text" autocomplete="off" maxlength="120" value="' + esc(c.tuitionNote) + '" placeholder="e.g. instalment 2 of 4"></label>' : '') + '</div>';
    if (can('override')) {
      h += '<div class="group-head">Owner override</div><div class="group">' +
        '<label class="cell"><span>Total</span><input id="cash-ov-amount" type="text" inputmode="decimal" autocomplete="off" value="' + esc(c.ovAmount) + '" placeholder="Leave blank to keep ' + money(cashAmount()) + '"></label>' +
        '<label class="cell"><span>Reason</span><input id="cash-ov-reason" type="text" autocomplete="off" maxlength="200" value="' + esc(c.ovReason) + '" placeholder="Required for any override"></label></div>' +
        '<p class="group-foot">Ticking something marked “needs override”, or changing the total, needs a reason. It’s flagged on the record and logged.</p>';
    }
    var amt = cashAmount();
    h += '<div class="cash-total"><span>Cash to collect</span><b>' + money(amt) + '</b></div>';
    h += '<div class="group-head">Student signs</div>' + sigBox('student', '<span id="sig-student-name">' + esc(c.name || 'Student') + ' · paid ' + money(amt) + ' cash</span>');
    h += '<div class="group-head">Staff signs</div>' + sigBox('staff', '<span>Received by ' + esc(state.user.name) + '</span>');
    h += '<p id="cash-error" class="error" hidden></p><button id="cash-go" class="btn primary block" data-act="cash-save"' + (amt > 0 ? '' : ' disabled') + '>' + cashGoText(amt) + '</button>';
    h += '<p class="group-foot">This is your internal record that the student paid and the money was received. It isn’t the student’s receipt.</p>';
    return h;
  }
  function cashGoText(amt) { return amt > 0 ? 'Cash ' + money(amt) + ' received' + (cashHandOver() ? ' · hand over' : '') : 'Choose what they’re paying for'; }
  function cashHandOver() { var c = state.cash; return !!(c.orderNo || c.sorrentino || c.palliative); }
  // typed tuition changes the total without a re-render (keeps the keyboard up); the student signs for a specific amount, so their signature clears
  function cashUpdateTotal() {
    var amt = cashAmount(), t = document.querySelector('.cash-total b'); if (t) t.textContent = money(amt);
    var n = $('sig-student-name'); if (n) n.textContent = (state.cash.name || 'Student') + ' \u00b7 paid ' + money(amt) + ' cash';
    var b = $('cash-go'); if (b) { b.disabled = !(amt > 0); b.textContent = cashGoText(amt); }
    if (pads.student && pads.student.signed()) pads.student.clear();
  }
  function sigBox(which, label) {
    return '<div class="sig" id="sigbox-' + which + '"><div class="sig-area"><canvas id="sig-' + which + '" aria-label="' + (which === 'student' ? 'Student' : 'Staff') + ' signature"></canvas>' +
      '<span class="sig-hint">Sign here</span><span class="sig-x">\u00d7</span><span class="sig-ok">' + ICON.check + '</span>' +
      '<button class="sig-big" data-act="sig-big" data-sig="' + which + '" aria-label="Sign full screen">' + ICON.expand + '<span>Full screen</span></button></div>' +
      '<div class="sig-foot">' + label + '<button class="link" data-act="sig-clear" data-sig="' + which + '">Clear</button></div></div>';
  }
  function sigMark(which) { var b = $('sigbox-' + which), p = pads[which]; if (b && p) b.classList.toggle('signed', !!p.signed()); }
  /** Full-screen signing: a big white pad over everything; on Done the ink is trimmed and fitted into the small box. */
  function openSigFull(which) {
    var pad = pads[which]; if (!pad) return;
    var amt = cashAmount(), who = which === 'student' ? (state.cash.name || 'Student') + ' \u00b7 paid ' + money(amt) + ' cash' : 'Received by ' + state.user.name;
    var ov = document.createElement('div'); ov.className = 'sigfs'; ov.id = 'sigfs';
    ov.innerHTML = '<div class="sigfs-top"><button class="link" data-fs="cancel">Cancel</button><b>' + (which === 'student' ? 'Student signature' : 'Your signature') + '</b><button class="link strong" data-fs="done">Done</button></div>' +
      '<div class="sigfs-area"><canvas id="sigfs-canvas" aria-label="Full screen signature pad"></canvas><span class="sig-hint">Sign here</span><span class="sigfs-line"></span></div>' +
      '<div class="sigfs-foot"><span>' + esc(who) + '</span><button class="link" data-fs="clear">Clear</button></div><p class="sigfs-tip">Tip: turn the phone sideways for more room.</p>';
    document.body.appendChild(ov); document.body.classList.add('sigfs-on');
    var big = null;
    var start = function () { big = sigPad($('sigfs-canvas'), function () { ov.classList.toggle('signed', big.signed()); }); };
    requestAnimationFrame(start);
    var onResize = function () { if (big && !big.signed()) start(); };
    window.addEventListener('resize', onResize);
    var close = function () { window.removeEventListener('resize', onResize); document.body.classList.remove('sigfs-on'); ov.remove(); };
    ov.addEventListener('click', function (e) {
      var b = e.target.closest('[data-fs]'); if (!b) return;
      if (b.dataset.fs === 'cancel') return close();
      if (b.dataset.fs === 'clear') { big.clear(); ov.classList.remove('signed'); return; }
      if (b.dataset.fs === 'done') {
        if (!big.signed()) { close(); return; }
        var url = fitInk($('sigfs-canvas'), 480, 160);
        close();
        pad.clear(); restoreSig(which, url); sigMark(which); err('cash-error', '');
      }
    });
  }
  /** Crops a canvas to its ink and centres it on a white w x h image (PNG data URL, small enough for a cell). */
  function fitInk(cv, w, h) {
    var x = cv.getContext('2d'), d = x.getImageData(0, 0, cv.width, cv.height).data, minX = cv.width, minY = cv.height, maxX = -1, maxY = -1;
    for (var y = 0; y < cv.height; y += 2) for (var i = 0; i < cv.width; i += 2) { var a = d[(y * cv.width + i) * 4 + 3]; if (a > 20) { if (i < minX) minX = i; if (i > maxX) maxX = i; if (y < minY) minY = y; if (y > maxY) maxY = y; } }
    if (maxX < 0) { minX = 0; minY = 0; maxX = cv.width - 1; maxY = cv.height - 1; }
    var pad = Math.round(Math.min(cv.width, cv.height) * 0.04); minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad); maxX = Math.min(cv.width - 1, maxX + pad); maxY = Math.min(cv.height - 1, maxY + pad);
    var sw = maxX - minX + 1, sh = maxY - minY + 1, sizes = [[w, h], [Math.round(w * 0.75), Math.round(h * 0.75)]];
    for (var k = 0; k < sizes.length; k++) {
      var W = sizes[k][0], H = sizes[k][1], s = Math.min((W * 0.94) / sw, (H * 0.88) / sh), off = document.createElement('canvas'); off.width = W; off.height = H;
      var o = off.getContext('2d'); o.fillStyle = '#fff'; o.fillRect(0, 0, W, H); o.imageSmoothingQuality = 'high';
      o.drawImage(cv, minX, minY, sw, sh, (W - sw * s) / 2, (H - sh * s) / 2, sw * s, sh * s);
      var url = off.toDataURL('image/png'); if (url.length < 44000) return url;
    }
    return '';
  }
  var pads = {}, cashListeners = false;
  function sigPad(canvas, onInk) {
    var ctx, drawing = false, len = 0, last = null;
    function setup() {
      var r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr));
      ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = canvas.id === 'sigfs-canvas' ? 3.6 : 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111'; len = 0;
    }
    function pt(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    canvas.addEventListener('pointerdown', function (e) { drawing = true; last = pt(e); err('cash-error', ''); try { canvas.setPointerCapture(e.pointerId); } catch (x) {} e.preventDefault(); });
    canvas.addEventListener('pointermove', function (e) {
      if (!drawing) return; var p = pt(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      len += Math.hypot(p.x - last.x, p.y - last.y); last = p; e.preventDefault();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { canvas.addEventListener(ev, function () { if (drawing && onInk) onInk(); drawing = false; }); });
    setup();
    return {
      clear: function () { setup(); if (onInk) onInk(); }, signed: function () { return len > 40; },
      png: function () {
        var sizes = [[480, 160], [360, 120]];
        for (var i = 0; i < sizes.length; i++) {
          var off = document.createElement('canvas'); off.width = sizes[i][0]; off.height = sizes[i][1];
          var o = off.getContext('2d'); o.fillStyle = '#fff'; o.fillRect(0, 0, off.width, off.height); o.drawImage(canvas, 0, 0, off.width, off.height);
          var url = off.toDataURL('image/png'); if (url.length < 44000) return url;
        }
        return '';
      }
    };
  }
  // opts.keepStudent=false: the student signed for a specific amount, so a change of books/order clears their signature
  function cashRenderBody(opts) {
    opts = opts || {};
    var el = $('cash-body'); if (!el) return;
    var keepS = opts.keepStudent !== false && pads.student && pads.student.signed() ? pads.student.png() : null;
    var keepT = opts.keepStaff !== false && pads.staff && pads.staff.signed() ? pads.staff.png() : null;
    el.innerHTML = cashBodyHtml();
    pads = {};
    if ($('sig-student')) { pads.student = sigPad($('sig-student'), function () { sigMark('student'); }); pads.staff = sigPad($('sig-staff'), function () { sigMark('staff'); }); }
    // re-draw signatures that were already made (e.g. after ticking a book)
    [['student', keepS], ['staff', keepT]].forEach(function (p) { if (p[1] && pads[p[0]]) restoreSig(p[0], p[1]); });
  }
  function restoreSig(which, url) {
    var cv = $('sig-' + which), img = new Image();
    img.onload = function () { var r = cv.getBoundingClientRect(); cv.getContext('2d').drawImage(img, 0, 0, r.width, r.height); pads[which].restored = url; sigMark(which); };
    img.src = url;
    var pad = pads[which], signed = pad.signed, png = pad.png;
    pad.signed = function () { return !!pad.restored || signed(); };
    pad.png = function () { return signed() ? png() : (pad.restored || ''); };
    var clear = pad.clear; pad.clear = function () { pad.restored = null; clear(); sigMark(which); };
  }
  PAGES.cashNew = {
    title: 'Cash payment',
    html: function () {
      var c = state.cash;
      return '<p class="lead">Find the student, tick what they’re paying for, both sign. Books are handed over right away.</p>' +
        '<div class="group-head">Student</div><div class="group">' +
        '<label class="cell"><span>Email</span><input id="cash-email" type="email" inputmode="email" autocapitalize="none" autocomplete="off" value="' + esc(c.email) + '" placeholder="The email they gave the college"></label>' +
        '<label class="cell"><span>Phone</span><input id="cash-phone" type="tel" inputmode="tel" autocomplete="off" value="' + esc(c.phone) + '" placeholder="10 digits"></label></div>' +
        '<p class="group-foot">Both are needed for the record. We look them up in the accounting workbook.</p>' +
        '<p id="cash-find-error" class="error" hidden></p><button id="cash-find" class="btn block" data-act="cash-find">' + (c.lookup && !c.lookup.external ? 'Look up again' : 'Find student') + '</button>' +
        '<button id="cash-external" class="btn block" data-act="cash-external" style="margin-top:8px">' + (c.lookup && c.lookup.external ? 'Not a student · change' : 'Not a student / not in the system yet') + '</button>' +
        '<div id="cash-body" style="margin-top:18px"></div>';
    },
    after: function () {
      cashRenderBody();
      ['email', 'phone'].forEach(function (k) { $('cash-' + k).addEventListener('input', function (e) { state.cash[k] = e.target.value; }); });
      if (cashListeners) return; cashListeners = true;
      $('page').addEventListener('input', function (e) {
        if (current().page !== 'cashNew' || !state.cash) return;
        if (e.target.id === 'cash-name') { state.cash.name = e.target.value; var n = $('sig-student-name'); if (n) n.textContent = (state.cash.name || 'Student') + ' \u00b7 paid ' + money(cashAmount()) + ' cash'; }
        else if (e.target.id === 'cash-tuition-amt') { state.cash.tuitionAmt = e.target.value; err('cash-error', ''); cashUpdateTotal(); }
        else if (e.target.id === 'cash-tuition-note') { state.cash.tuitionNote = e.target.value; err('cash-error', ''); }
        else if (e.target.id === 'cash-ov-amount') { state.cash.ovAmount = e.target.value; err('cash-error', ''); cashUpdateTotal(); }
        else if (e.target.id === 'cash-ov-reason') { state.cash.ovReason = e.target.value; err('cash-error', ''); }
      });
      $('page').addEventListener('change', function (e) {
        if (current().page !== 'cashNew' || !state.cash) return;
        var t = e.target;
        err('cash-error', '');
        if (t.dataset && t.dataset.book) { state.cash[t.dataset.book] = t.checked; cashRenderBody({ keepStudent: false }); }
        else if (t.dataset && t.dataset.item) { state.cash.items[t.dataset.item] = t.checked; cashRenderBody({ keepStudent: false }); }
        else if (t.dataset && t.dataset.tuition) { state.cash.tuition = t.checked; cashRenderBody({ keepStudent: false }); if (t.checked) { var a = $('cash-tuition-amt'); if (a) a.focus(); } }
        else if (t.name === 'cash-order') { state.cash.orderNo = t.value ? Number(t.value) : null; cashRenderBody({ keepStudent: false }); }
      });
    }
  };
  function cashFind(btn, external) {
    var c = state.cash; c.email = $('cash-email').value.trim(); c.phone = $('cash-phone').value.trim();
    if (external ? (!c.email || !c.phone) : (!c.email && !c.phone)) return err('cash-find-error', external ? 'Enter their email and phone number; that\u2019s how the admin finds them later.' : 'Enter their email or phone number.');
    err('cash-find-error', ''); var label = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spinner sm"></span>';
    c.external = !!external;
    sapi('cashLookup', [c.email, c.phone, !!external]).then(function (L) {
      c.lookup = L; c.orderNo = null; c.sorrentino = false; c.palliative = false; c.items = {}; c.tuition = false; c.tuitionAmt = ''; c.tuitionNote = '';
      var m = L.matches[0]; c.matchKey = m ? m.key : ''; c.name = m ? titleCase(m.name) : '';
      btn.disabled = false; btn.textContent = label; pads = {}; rerender(); cashRenderBody({ keepStudent: false, keepStaff: false });
      setTimeout(function () { var b = $('cash-body'); if (b) b.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
    }).catch(function (e) { btn.disabled = false; btn.textContent = label; if (!e.signedOut) err('cash-find-error', e.message); });
  }
  function cashSave() {
    var c = state.cash, amt = cashAmount();
    c.name = ($('cash-name') ? $('cash-name').value : c.name).trim(); c.email = $('cash-email').value.trim(); c.phone = $('cash-phone').value.trim();
    if (!c.name) return err('cash-error', 'Enter the student’s name.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) return err('cash-error', 'Enter the student’s email above.');
    if (c.phone.replace(/\D/g, '').length < 10) return err('cash-error', 'Enter the student’s phone number above (10 digits).');
    if (!(amt > 0)) return err('cash-error', 'Choose what they’re paying for.');
    if (c.tuition) {
      if (!(tuitionAmt() > 0)) return err('cash-error', 'Enter the tuition amount, like 500 or 500.50.');
      if (c.tuitionNote.trim().length < 3) return err('cash-error', 'Add a note for the tuition payment, like “instalment 2 of 4”.');
    }
    var ovs = cashOverrides();
    if (ovs.length && c.ovReason.trim().length < 3) return err('cash-error', 'Owner override (' + ovs.join(', ') + '): say why in the Reason box.');
    if (!pads.student || !pads.student.signed()) return err('cash-error', 'The student needs to sign.');
    if (!pads.staff || !pads.staff.signed()) return err('cash-error', 'You need to sign as the person receiving the cash.');
    err('cash-error', '');
    var summary = cashSummary(), hand = cashHandOver();
    dialog({ title: 'Take ' + money(amt) + ' cash?', html: 'Count the cash from <b>' + esc(c.name) + '</b> first.<br>For: ' + esc(summary) + '.' + (hand ? '<br>Then hand over the books.' : '') + (ovs.length ? '<br><b>Override:</b> ' + esc(ovs.join(', ')) + '.' : '') + (state.practice ? '<br><b>Practice mode:</b> this will be a TEST record.' : ''), ok: 'Cash received' }).then(function (r) {
      if (!r) return;
      var b = $('cash-go'); b.disabled = true; b.innerHTML = '<span class="spinner sm"></span>'; state.busy = true;
      var form = { name: c.name, email: c.email, phone: c.phone, matchKey: c.matchKey, external: !!c.external, orderNo: c.orderNo || '', sorrentino: !c.orderNo && c.sorrentino, palliative: !c.orderNo && c.palliative,
        items: c.lookup.items.filter(cashItemOn).map(function (i) { return i.id; }), tuition: c.tuition ? { amount: String(c.tuitionAmt).trim(), note: c.tuitionNote.trim() } : null,
        override: ovs.length ? { reason: c.ovReason.trim(), amount: String(c.ovAmount).trim() } : null,
        studentSig: pads.student.png(), staffSig: pads.staff.png() };
      sapi('cashRecord', [form]).then(function (x) {
        buzz(30); state.cash = newCashState(); pads = {}; state.loadedAt.me = 0;
        state.stack = []; state.tab = 'cash'; state.cashRep = null; state.cashMine = null; render(); loadOrders(true); refreshStockQuiet();
        dialog({ title: 'Saved · ' + x.cashId, html: '<b>' + money(x.amount) + '</b> for ' + esc(x.summary) + '.' + (x.handOver ? '<br>Hand over: <b>' + esc(x.handOver) + '</b>.' : '') + '<br>' + (can('cash_report') ? 'It\u2019s in the Cash tab, and emailed to you.' : 'The admin has been notified.'), ok: 'Done', noCancel: true });
      }).catch(function (e) { if (!e.signedOut) { err('cash-error', e.message); var bb = $('cash-go'); if (bb) { bb.disabled = false; bb.textContent = cashGoText(amt); } } })
        .then(function () { state.busy = false; });
    });
  }

  /* ---------- admin: cash report ---------- */
  function dayStart(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function cashRangeDates(r) {
    var now = new Date(), t0 = dayStart(now), from = null, to = null;
    if (r.key === 'today') from = t0;
    else if (r.key === 'week') from = new Date(t0.getTime() - 6 * 86400000);
    else if (r.key === 'month') from = new Date(t0.getFullYear(), t0.getMonth(), 1);
    else if (r.key === 'custom') { from = r.from ? dayStart(r.from + 'T00:00') : null; to = r.to ? new Date(dayStart(r.to + 'T00:00').getTime() + 86400000) : null; }
    return { from: from ? from.toISOString() : '', to: to ? to.toISOString() : '' };
  }
  function loadCashReport() {
    var d = cashRangeDates(state.cashRange);
    state.cashRep = null; if ($('cash-rep')) $('cash-rep').innerHTML = loadingHtml();
    return sapi('cashReport', [d.from, d.to]).then(function (r) { state.cashRep = r; state.cashRepAt = Date.now(); if ($('cash-rep')) $('cash-rep').innerHTML = cashRepHtml(); })
      .catch(function (e) { if (!e.signedOut) toast(e.message); });
  }
  function cashRepHtml() {
    var r = state.cashRep; if (!r) return loadingHtml();
    var h = '<div class="cash-sum"><div class="s-num">' + money(r.total) + '</div><div class="s-label">' + r.count + (r.count === 1 ? ' payment' : ' payments') + (r.voidCount ? ' · ' + r.voidCount + ' voided' : '') + '</div></div>';
    if (r.byStaff.length) h += '<div class="group-head">By staff</div><div class="group">' + r.byStaff.map(function (b) {
      return '<div class="row"><span class="avatar">' + esc(initials(b.name)) + '</span><span class="grow"><span class="title">' + esc(b.name) + '</span><span class="sub">' + b.count + (b.count === 1 ? ' payment' : ' payments') + '</span></span><span class="value strong">' + money(b.total) + '</span></div>';
    }).join('') + '</div>';
    if (r.byItem.length) h += '<div class="group-head">By item</div><div class="group">' + r.byItem.map(function (b) {
      return '<div class="row"><span class="grow"><span class="title">' + esc(b.name) + '</span><span class="sub">' + b.count + '×</span></span><span class="value strong">' + money(b.total) + '</span></div>';
    }).join('') + '</div>';
    if (!r.records.length) return h + '<div class="empty">' + ICON.check + '<strong>No cash in this period</strong>Cash payments taken at the desk show up here.</div>';
    var out = '', lastDay = '';
    r.records.forEach(function (x) {
      var day = dayLabel(x.at);
      if (day !== lastDay) { if (lastDay) out += '</div>'; out += '<div class="day">' + esc(day) + '</div><div class="group">'; lastDay = day; }
      out += '<button class="row' + (x.status === 'void' ? ' void' : '') + '" data-act="go" data-page="cashDetail" data-cash="' + esc(x.cashId) + '"><span class="grow"><span class="title">' + esc(x.cashId) + ' · ' + esc(titleCase(x.workbookName || x.name)) + (x.status === 'void' ? ' <span class="chip grey">VOID</span>' : '') + (x.test ? ' <span class="chip test">TEST</span>' : '') + '</span>' +
        '<span class="sub">' + esc(x.summary) + ' · by ' + esc(firstName(x.receivedByName)) + ' · ' + esc(timeOf(x.at)) + '</span></span><span class="value strong">' + money(x.amount) + '</span><span class="chev">' + ICON.chev + '</span></button>';
    });
    return h + out + '</div>';
  }
  function cashMineHtml() {
    var m = state.cashMine; if (!m) return loadingHtml();
    var h = '<div class="cash-sum"><div class="s-num">' + money(m.total) + '</div><div class="s-label">You took today · ' + m.count + (m.count === 1 ? ' payment' : ' payments') + '. Count your drawer against this.</div></div>';
    if (!m.records || !m.records.length) return h;
    return h + '<div class="group-head">Today</div><div class="group">' + m.records.map(function (x) {
      return '<div class="row"><span class="grow"><span class="title">' + esc(x.cashId) + ' · ' + esc(titleCase(x.workbookName || x.name)) + '</span><span class="sub">' + esc(x.summary) + ' · ' + esc(timeOf(x.at)) + '</span></span><span class="value strong">' + money(x.amount) + '</span></div>';
    }).join('') + '</div>';
  }
  function loadCashMine() {
    return sapi('cashMine', [dayStart(new Date()).toISOString()]).then(function (r) { state.cashMine = r; state.cashMineAt = Date.now(); if (current().page === 'cash' && $('cash-rep')) $('cash-rep').innerHTML = cashMineHtml(); if (current().page === 'me' || current().page === 'home') rerender(); }).catch(function (e) { if (!e.signedOut) toast(e.message); });
  }
  PAGES.cash = {
    title: 'Cash', root: true,
    right: function () { return navBtn('refresh-cash', ICON.refresh, 'Refresh'); },
    html: function () {
      var h = '<div class="large-row"><h1 class="large">Cash</h1></div>' +
        '<button class="btn primary block" data-act="cash-new" style="margin-bottom:12px">' + ICON.plus + 'New cash payment</button>' +
        '<div class="group" style="margin-bottom:16px"><button class="row" data-act="cashbook"><span class="ic green">' + ICON.sheet + '</span><span class="grow"><span class="title">Cash book</span><span class="sub">Today’s drawer: float, cash in, cash out, closing count</span></span><span class="chev">' + ICON.chev + '</span></button></div>';
      if (!can('cash_report')) return h + '<div id="cash-rep">' + cashMineHtml() + '</div><p class="group-foot">Books, courses, exams and tuition paid in cash at the desk. The admin sees every record.</p>';
      var R = state.cashRange, segs = [['today', 'Today'], ['week', '7 days'], ['month', 'Month'], ['all', 'All'], ['custom', 'Custom']];
      return h + '<div class="seg">' + segs.map(function (s) { return '<button data-cashrange="' + s[0] + '" class="' + (R.key === s[0] ? 'on' : '') + '">' + s[1] + '</button>'; }).join('') + '</div>' +
        (R.key === 'custom' ? '<div class="group"><label class="cell"><span>From</span><input id="cr-from" type="date" value="' + esc(R.from || '') + '"></label><label class="cell"><span>To</span><input id="cr-to" type="date" value="' + esc(R.to || '') + '"></label></div><button class="btn block" data-act="cash-custom" style="margin-top:12px">Show</button>' : '') +
        '<div id="cash-rep">' + cashRepHtml() + '</div>';
    },
    after: function () {
      if (!can('cash_report')) { if (!state.cashMine || Date.now() - (state.cashMineAt || 0) > 60000) loadCashMine(); return; }
      if (state.cashRange.key === 'custom' && !state.cashRange.from) return;
      if (!state.cashRep || Date.now() - (state.cashRepAt || 0) > 60000) loadCashReport();
    }
  };
  PAGES.cashDetail = {
    title: function (c) { return c.params.cash || 'Cash record'; },
    html: function (c) {
      var x = state.cashDetail && state.cashDetail.cashId === c.params.cash ? state.cashDetail : null;
      if (!x) return loadingHtml();
      var kv = [['Amount', '<b>' + money(x.amount) + '</b> cash'], ['For', esc(x.summary)]];
      if (x.sorrentino || x.palliative) kv.push(['Handed over', esc(itemsText(x))]);
      if (x.note) kv.push(['Note', esc(x.note)]);
      kv.push(['Student', esc(x.name)]);
      if (x.workbookName && x.workbookName.toLowerCase() !== x.name.toLowerCase()) kv.push(['In workbook as', esc(titleCase(x.workbookName))]);
      kv.push(['Phone', esc(x.phone)], ['Email', esc(x.email)]);
      if (x.studentNumber) kv.push(['Student ID', esc(x.studentNumber)]);
      if (x.batch) kv.push(['Batch', esc(x.batch)]);
      kv.push(['Agent', esc(agentLabel(x.agent))], ['Received by', esc(x.receivedByName) + ' (@' + esc(x.receivedBy) + ')'], ['When', esc(when(x.at))]);
      if (x.orderNo) kv.push(['Order', '#' + x.orderNo]);
      var h = (x.status === 'void' ? '<div class="banner red">' + ICON.warn + '<span class="grow">Voided ' + esc(when(x.voidAt)) + ' by @' + esc(x.voidBy) + ': ' + esc(x.voidReason) + '</span></div>' : '') +
        (x.flags.length ? '<div class="c-tags" style="margin:0 0 12px">' + x.flags.map(function (f) { return '<span class="tag">' + esc(f) + '</span>'; }).join('') + '</div>' : '') +
        '<div class="group"><dl class="kv" style="padding:6px 16px 10px">' + kv.map(function (p) { return '<dt>' + p[0] + '</dt><dd>' + p[1] + '</dd>'; }).join('') + '</dl></div>' +
        '<div class="group-head">Student signature</div><div class="sig-view"><img alt="Student signature" src="' + esc(x.studentSig) + '"><span>' + esc(x.name) + '</span></div>' +
        '<div class="group-head">Received by</div><div class="sig-view"><img alt="Staff signature" src="' + esc(x.staffSig) + '"><span>' + esc(x.receivedByName) + '</span></div>';
      var acts = '';
      if (can('override')) acts += '<button class="row accent" data-act="cash-edit" data-cash="' + esc(x.cashId) + '"><span class="grow"><span class="title">Fix name / phone / email</span><span class="sub">Owner only. Needs a reason; logged.</span></span></button>';
      if (x.status !== 'void' && can('cash_void')) acts += '<button class="row danger" data-act="cash-void" data-cash="' + esc(x.cashId) + '"><span class="grow"><span class="title">Void this record</span><span class="sub">If it was logged by mistake. Any books go back into stock; the record stays, marked VOID.</span></span></button>';
      if (x.status === 'void' && can('override')) acts += '<button class="row accent" data-act="cash-unvoid" data-cash="' + esc(x.cashId) + '"><span class="grow"><span class="title">Un-void</span><span class="sub">Owner only. Brings it back; any books come out of stock again.</span></span></button>';
      if (acts) h += '<div class="group" style="margin-top:26px">' + acts + '</div>';
      if (x.test) h = '<div class="banner amber">' + ICON.warn + '<span class="grow">TEST record from practice mode. Not counted anywhere.</span></div>' + h;
      return h;
    },
    after: function (c) {
      if (c.params.loaded) return; c.params.loaded = true;
      sapi('cashGet', [c.params.cash]).then(function (x) { state.cashDetail = x; if (current().page === 'cashDetail') rerender(); }).catch(function (e) { if (!e.signedOut) toast(e.message); });
    }
  };
  function agentLabel(a) { a = String(a || '').trim(); return !a || /^dir/i.test(a) ? 'Direct' : a; }
  function cashEditAct(id) {
    var x = state.cashDetail; if (!x) return;
    dialog({ title: 'Fix ' + id, html: 'Owner override. The change is written on the record and logged.', ok: 'Save',
      inputs: [{ key: 'name', value: x.name, placeholder: 'Name', maxlength: 80 }, { key: 'phone', value: x.phone, placeholder: 'Phone', maxlength: 30 }, { key: 'email', value: x.email, placeholder: 'Email', maxlength: 120 }, { key: 'reason', placeholder: 'Why? (required)', maxlength: 200 }],
      validate: function (v) { return v.reason && v.reason.trim().length >= 3 ? '' : 'Say why.'; } })
      .then(function (r) { if (!r) return; sapi('cashEdit', [id, r]).then(function (y) { state.cashDetail = y; rerender(); toast('Saved'); state.cashRep = null; }).catch(function (e) { if (!e.signedOut) toast(e.message); }); });
  }
  function cashUnvoidAct(id) {
    dialog({ title: 'Un-void ' + id + '?', html: 'Owner override. The record comes back and any books come out of stock again.', ok: 'Un-void',
      inputs: [{ key: 'reason', placeholder: 'Why? (required)', maxlength: 200 }], validate: function (v) { return v.reason && v.reason.trim().length >= 3 ? '' : 'Say why.'; } })
      .then(function (r) { if (!r) return; sapi('cashUnvoid', [id, r.reason]).then(function (y) { state.cashDetail = y; rerender(); toast(id + ' restored'); refreshStockQuiet(); state.cashRep = null; }).catch(function (e) { if (!e.signedOut) toast(e.message); }); });
  }
  function practiceToggle(on) {
    var go = function () { sapi('practiceSet', [on]).then(function (r) { setPractice(r.practice); toast(r.practice ? 'Practice mode on' : 'Practice mode off'); rerender(); }).catch(function (e) { if (!e.signedOut) { toast(e.message); rerender(); } }); };
    if (!on) return go();
    dialog({ title: 'Turn on practice mode?', html: 'Everything anyone makes while it’s on (orders on the student page too) is tagged TEST: not counted, no stock changes, no pings or emails. Turn it off when you’re done and wipe the test data.', ok: 'Turn on' })
      .then(function (r) { if (r) go(); else rerender(); });
  }
  function practiceWipe() {
    dialog({ title: 'Wipe all test data?', html: 'Every TEST order and cash record is deleted for good. Real records aren’t touched.', ok: 'Wipe', destructive: true })
      .then(function (r) { if (!r) return; sapi('practiceWipe').then(function (n) { toast('Wiped ' + n.orders + ' orders, ' + n.cash + ' cash records'); loadOrders(true); loadAdmin(); state.cashRep = null; }).catch(function (e) { if (!e.signedOut) toast(e.message); }); });
  }
  function cashVoidAct(id) {
    dialog({ title: 'Void ' + id + '?', html: 'Only if it was logged by mistake. Any books go back into stock and the record is kept, marked VOID.', ok: 'Void', destructive: true,
      inputs: [{ key: 'reason', placeholder: 'Why? (required)', maxlength: 200 }], validate: function (v) { return v.reason ? '' : 'Say why it’s being voided.'; } })
      .then(function (r) {
        if (!r) return;
        sapi('cashVoid', [id, r.reason]).then(function (x) { state.cashDetail = x; rerender(); toast(id + ' voided'); refreshStockQuiet(); state.cashRep = null; })
          .catch(function (e) { if (!e.signedOut) toast(e.message); });
      });
  }

  /* ---------- daily cash book ---------- */
  function todayStr() { return localDate(new Date()); }
  function localDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function cbMoney(n, signed) { var s = money(Math.abs(n)); return signed ? (n < 0 ? '\u2212' + s : n > 0 ? '+' + s : s) : s; }
  PAGES.cashBook = {
    title: 'Cash book',
    right: function () { return navBtn('refresh-cashbook', ICON.refresh, 'Refresh'); },
    html: function (c) {
      var seg = '';
      if (can('cash_report')) {
        var v = state.cbView || 'day';
        seg = '<div class="seg" style="margin-bottom:12px">' + [['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(function (s) { return '<button data-cbview="' + s[0] + '" class="' + (v === s[0] ? 'on' : '') + '">' + s[1] + '</button>'; }).join('') + '</div>';
        if (v !== 'day') return seg + cashBookSummaryHtml(v);
      }
      var B = state.cashBook; if (!B || B.date !== (c.params.date || B.date)) return seg + loadingHtml();
      var isToday = B.date === B.today, d = new Date(B.date + 'T12:00:00');
      var label = isToday ? 'Today' : d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
      var h = '<div class="cb-head">' + (B.canAnyDay ? '<button class="btn small" data-act="cb-prev" aria-label="Previous day">' + ICON.back + '</button>' : '<span></span>') +
        '<div style="text-align:center"><div style="font-weight:700;font-size:17px">' + esc(label) + '</div><div class="faint" style="font-size:13px">' + esc(B.date) + (B.closing ? ' · closed' : B.opening ? ' · open' : ' · not opened') + '</div></div>' +
        (B.canAnyDay && !isToday ? '<button class="btn small" data-act="cb-next" aria-label="Next day">' + ICON.chev + '</button>' : '<span style="min-width:40px"></span>') + '</div>';
      var canAct = isToday || B.canAnyDay;
      h += '<div class="group">' +
        '<div class="row"><span class="grow"><span class="title">Opening float</span><span class="sub">' + (B.opening ? 'by ' + esc(B.opening.by) + ' · ' + esc(timeOf(B.opening.at)) + (B.opening.note ? ' · ' + esc(B.opening.note) : '') : 'Count the drawer when you open') + '</span></span>' +
          (B.opening ? '<span class="value cb-num">' + money(B.opening.amount) + '</span>' + (B.canFix && canAct ? '<button class="btn small" data-act="cb-open" style="margin-left:8px">Change</button>' : '') : (canAct ? '<button class="btn small primary" data-act="cb-open">Set</button>' : '')) + '</div>' +
        '<div class="row"><span class="grow"><span class="title">Cash in</span><span class="sub">' + B.inCount + (B.inCount === 1 ? ' payment' : ' payments') + ' taken at the desk (automatic)</span></span><span class="value cb-num cb-pos">' + cbMoney(B.inTotal, true) + '</span></div>' +
        '<div class="row"><span class="grow"><span class="title">Cash out</span><span class="sub">' + B.outs.length + (B.outs.length === 1 ? ' entry' : ' entries') + '</span></span><span class="value cb-num' + (B.outTotal ? ' cb-neg' : '') + '">' + cbMoney(-B.outTotal, true) + '</span>' + (canAct && (!B.closing || B.canFix) ? '<button class="btn small" data-act="cb-out" style="margin-left:8px">Add</button>' : '') + '</div>' +
        '<div class="row"><span class="grow"><span class="title">Expected in drawer</span><span class="sub">float + in \u2212 out</span></span><span class="value cb-num">' + (B.expected === null ? '\u2013' : money(B.expected)) + '</span></div>' +
        '<div class="row"><span class="grow"><span class="title">Closing count</span><span class="sub">' + (B.closing ? 'by ' + esc(B.closing.by) + ' · ' + esc(timeOf(B.closing.at)) + (B.closing.note ? ' · ' + esc(B.closing.note) : '') : 'Count the drawer at the end of the day') + '</span></span>' +
          (B.closing ? '<span class="value cb-num">' + money(B.closing.amount) + '</span>' + (B.canFix && canAct ? '<button class="btn small" data-act="cb-close" style="margin-left:8px">Recount</button>' : '') : (canAct && B.opening ? '<button class="btn small primary" data-act="cb-close">Count</button>' : '')) + '</div>' +
        (B.difference !== null ? '<div class="row"><span class="grow"><span class="title">Difference</span><span class="sub">' + (B.difference === 0 ? 'Balanced' : B.difference < 0 ? 'Short' : 'Over') + '</span></span><span class="value cb-num ' + (B.difference < 0 ? 'cb-neg' : B.difference > 0 ? 'cb-pos' : '') + '">' + cbMoney(B.difference, true) + '</span></div>' : '') +
        '</div>';
      if (B.outs.length) h += '<div class="group-head">Cash out</div><div class="group">' + B.outs.map(function (o) {
        return '<div class="row"><span class="grow"><span class="title">' + esc(o.note) + '</span><span class="sub">' + esc(o.by) + ' · ' + esc(timeOf(o.at)) + '</span></span><span class="value cb-num cb-neg">\u2212' + money(o.amount) + '</span>' + (B.canFix ? '<button class="link" data-act="cb-remove" data-id="' + esc(o.id) + '" style="margin-left:10px">Remove</button>' : '') + '</div>';
      }).join('') + '</div>';
      if (B.ins.length) h += '<div class="group-head">Cash in</div><div class="group">' + B.ins.map(function (x) {
        return '<div class="row"><span class="grow"><span class="title">' + esc(x.cashId) + (x.name ? ' · ' + esc(titleCase(x.name)) : '') + '</span><span class="sub">' + (x.summary ? esc(x.summary) + ' · ' : '') + 'by ' + esc(firstName(x.by)) + ' · ' + esc(timeOf(x.at)) + '</span></span><span class="value cb-num">' + money(x.amount) + '</span></div>';
      }).join('') + '</div>';
      h += '<p class="group-foot">Cash in comes from the cash records automatically. Voided and TEST records aren’t included.' + (B.canAnyDay ? '' : ' You can see today and yesterday.') + '</p>';
      return seg + h;
    },
    after: function (c) { if (!c.params.loaded) { c.params.loaded = true; loadCashBook(c.params.date || ''); } if ((state.cbView || 'day') !== 'day' && !state.cbSum) loadCashBookSummary(); }
  };
  function cbRange(v) {
    var now = new Date(), t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (v === 'week') { var dow = (t0.getDay() + 6) % 7; var mon = new Date(t0.getTime() - dow * 86400000); return { from: localDate(mon), to: localDate(t0), label: 'This week (from Mon ' + mon.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + ')' }; }
    return { from: localDate(new Date(t0.getFullYear(), t0.getMonth(), 1)), to: localDate(t0), label: t0.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' }) };
  }
  function loadCashBookSummary() {
    var r = cbRange(state.cbView); state.cbSum = null; if ($('cb-sum')) $('cb-sum').innerHTML = loadingHtml();
    return sapi('cashBookSummary', [r.from, r.to]).then(function (S) { state.cbSum = S; if (current().page === 'cashBook') rerender(); }).catch(function (e) { if (!e.signedOut) toast(e.message); });
  }
  function cashBookSummaryHtml(v) {
    var S = state.cbSum, r = cbRange(v);
    var h = '<div class="cash-sum"><div class="s-num">' + (S ? money(S.inTotal) : '\u2013') + '</div><div class="s-label">' + esc(r.label) + (S ? ' · ' + S.inCount + (S.inCount === 1 ? ' payment' : ' payments') + ' in · ' + money(S.outTotal) + ' out' + (S.daysClosed ? ' · ' + S.daysClosed + (S.daysClosed === 1 ? ' day closed' : ' days closed') + ', ' + (S.differenceTotal === 0 ? 'balanced' : (S.differenceTotal < 0 ? 'short ' : 'over ') + money(Math.abs(S.differenceTotal))) : '') : '') + '</div></div>';
    h += '<div id="cb-sum">';
    if (!S) return h + loadingHtml() + '</div>';
    if (!S.days.length) return h + '<div class="empty">' + ICON.check + '<strong>Nothing yet</strong>Days with cash show up here.</div></div>';
    h += '<div class="group">' + S.days.slice().reverse().map(function (b) {
      var d = new Date(b.date + 'T12:00:00'), lab = d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
      var st = b.difference === null ? (b.opening === null ? 'not opened' : 'open, not counted') : (b.difference === 0 ? 'balanced' : (b.difference < 0 ? 'short ' : 'over ') + money(Math.abs(b.difference)));
      return '<button class="row" data-act="cb-day" data-date="' + b.date + '"><span class="grow"><span class="title">' + esc(lab) + '</span><span class="sub">' + (b.opening === null ? '' : 'float ' + money(b.opening) + ' · ') + b.inCount + ' in' + (b.outCount ? ' · ' + b.outCount + ' out' : '') + ' · ' + esc(st) + '</span></span><span class="value cb-num ' + (b.difference !== null && b.difference < 0 ? 'cb-neg' : '') + '">' + money(b.inTotal) + '</span><span class="chev">' + ICON.chev + '</span></button>';
    }).join('') + '</div>';
    return h + '</div><p class="group-foot">Amount shown is cash in for the day. Tap a day to open its page.</p>';
  }
  function loadCashBook(date) {
    return sapi('cashBookGet', [date || '']).then(function (B) { state.cashBook = B; var cur = current(); if (cur.page === 'cashBook') { cur.params.date = B.date; rerender(); } })
      .catch(function (e) { if (!e.signedOut) { toast(e.message); back(); } });
  }
  function cbAmountDialog(title, html, ok, key, placeholder, withNote, noteRequired) {
    var inputs = [{ key: key, type: 'number', placeholder: placeholder }];
    if (withNote) inputs.push({ key: 'note', placeholder: noteRequired ? 'What for? (required)' : 'Note (optional)', maxlength: 120 });
    return dialog({ title: title, html: html, ok: ok, inputs: inputs, validate: function (v) {
      if (!/^\d{1,6}(\.\d{1,2})?$/.test(String(v[key] || '').trim())) return 'Enter an amount like 200 or 200.50.';
      if (noteRequired && !(v.note && v.note.trim().length >= 3)) return 'Say what it was for.';
      return '';
    } });
  }
  function cbDo(fn, args, msg) {
    sapi(fn, [state.cashBook.date].concat(args)).then(function (B) { state.cashBook = B; rerender(); if (msg) toast(msg); }).catch(function (e) { if (!e.signedOut) toast(e.message); });
  }
  function cashBookOpenAct() {
    var B = state.cashBook, fix = !!B.opening;
    cbAmountDialog(fix ? 'Change the opening float' : 'Opening float', fix ? 'Owner override: say why.' : 'How much cash is in the drawer right now?', fix ? 'Change' : 'Set', 'amount', 'e.g. 200', true, fix)
      .then(function (r) { if (r) cbDo('cashBookOpen', [r.amount, r.note || ''], 'Float set'); });
  }
  function cashBookOutAct() {
    cbAmountDialog('Cash out', 'Money taken from the drawer.', 'Add', 'amount', 'e.g. 20', true, true)
      .then(function (r) { if (r) cbDo('cashBookOut', [r.amount, r.note], 'Cash out added'); });
  }
  function cashBookCloseAct() {
    var B = state.cashBook, fix = !!B.closing;
    cbAmountDialog(fix ? 'Recount' : 'Closing count', (fix ? 'Owner override: say why. ' : '') + 'Count everything in the drawer. Expected: <b>' + money(B.expected) + '</b>.', fix ? 'Recount' : 'Close the day', 'amount', 'e.g. ' + B.expected, true, fix)
      .then(function (r) { if (r) cbDo('cashBookClose', [r.amount, r.note || ''], 'Day closed'); });
  }
  function cashBookRemoveAct(id) {
    dialog({ title: 'Remove this entry?', html: 'Owner override. It stays in the sheet marked removed.', ok: 'Remove', destructive: true, inputs: [{ key: 'reason', placeholder: 'Why? (required)', maxlength: 200 }], validate: function (v) { return v.reason && v.reason.trim().length >= 3 ? '' : 'Say why.'; } })
      .then(function (r) { if (!r) return; sapi('cashBookRemove', [id, r.reason]).then(function (B) { state.cashBook = B; rerender(); toast('Removed'); }).catch(function (e) { if (!e.signedOut) toast(e.message); }); });
  }

  /* ---------- admin: cash items (what can be paid for in cash, and the price) ---------- */
  PAGES.cashItems = {
    title: 'Cash items',
    html: function () {
      var d = state.cashItems; if (!d) return loadingHtml();
      var h = '<p class="lead">What the desk can take cash for, and the price. Switch an item off to hide it; tuition is always there and typed in.</p>';
      var groups = [], byG = {};
      d.items.forEach(function (i, idx) { var g = i.group || 'Other'; if (!byG[g]) { byG[g] = []; groups.push(g); } byG[g].push(idx); });
      groups.forEach(function (g) {
        h += '<div class="group-head">' + esc(g) + '</div><div class="group">' + byG[g].map(function (idx) {
          var i = d.items[idx];
          return '<div class="row ci' + (i.on ? '' : ' off') + '"><label class="switch"><input type="checkbox" data-ci-on="' + idx + '"' + (i.on ? ' checked' : '') + '><span></span></label>' +
            '<input class="ci-name" type="text" maxlength="40" data-ci-name="' + idx + '" value="' + esc(i.name) + '" placeholder="Name">' +
            '<span class="ci-price">$<input type="text" inputmode="decimal" maxlength="8" data-ci-price="' + idx + '" value="' + esc(i.price) + '" placeholder="0"></span></div>';
        }).join('') + '</div>';
      });
      h += '<button class="btn block" data-act="ci-add" style="margin-top:12px">' + ICON.plus + 'Add an item</button>';
      h += '<p id="ci-error" class="error" hidden></p><button id="ci-save" class="btn primary block" data-act="ci-save" style="margin-top:12px">Save</button>';
      h += '<p class="group-foot">Items linked to the accounting workbook (CPR, GPA, NACC) warn the desk when the workbook already shows them paid or included. New items you add here aren’t linked.</p>';
      return h;
    },
    after: function (c) {
      if (!c.params.loaded) { c.params.loaded = true; state.cashItems = null; sapi('cashItemsGet').then(function (d) { state.cashItems = d; if (current().page === 'cashItems') rerender(); }).catch(function (e) { if (!e.signedOut) toast(e.message); }); }
      if (c.params.bound) return; c.params.bound = true;
      $('page').addEventListener('input', function (e) {
        if (current().page !== 'cashItems' || !state.cashItems) return;
        var t = e.target, it = state.cashItems.items;
        if (t.dataset.ciName != null) it[t.dataset.ciName].name = t.value;
        else if (t.dataset.ciPrice != null) it[t.dataset.ciPrice].price = t.value;
        err('ci-error', '');
      });
      $('page').addEventListener('change', function (e) {
        if (current().page !== 'cashItems' || !state.cashItems) return;
        var t = e.target;
        if (t.dataset.ciOn != null) { state.cashItems.items[t.dataset.ciOn].on = t.checked; t.closest('.row').classList.toggle('off', !t.checked); }
      });
    }
  };
  function cashItemsSave(btn) {
    var items = state.cashItems.items.filter(function (i) { return i.name.trim() || String(i.price).trim(); });
    for (var k = 0; k < items.length; k++) {
      if (!items[k].name.trim()) return err('ci-error', 'Every item needs a name.');
      if (!/^\d{1,5}(\.\d{1,2})?$/.test(String(items[k].price).trim())) return err('ci-error', items[k].name + ': enter a price like 45 or 45.50.');
    }
    if (!items.length) return err('ci-error', 'Keep at least one item (switch it off instead of deleting).');
    err('ci-error', ''); btn.disabled = true; btn.innerHTML = '<span class="spinner sm"></span>';
    sapi('cashItemsSave', [items]).then(function (d) { state.cashItems = d; toast('Cash items saved'); back(); })
      .catch(function (e) { if (!e.signedOut) err('ci-error', e.message); })
      .then(function () { var b = $('ci-save'); if (b) { b.disabled = false; b.textContent = 'Save'; } });
  }

  /* =================================================================== Admin */
  PAGES.admin = {
    title: 'Admin', root: true,
    right: function () { return navBtn('refresh-admin', ICON.refresh, 'Refresh'); },
    html: function () { return '<h1 class="large">Admin</h1><div id="admin-body">' + adminBody() + '</div>'; },
    after: function () { loadAdmin(); }
  };
  function adminBody() {
    var s = state.stats, l = s ? s.lookup : state.lookup, staffN = state.staff ? state.staff.staff.length : null;
    var num = function (v) { return s ? v : '–'; };
    var h = '<div class="stats">' +
      '<button class="stat' + (s && s.waiting ? ' hot' : '') + '" data-act="goto-orders" data-seg="waiting"><div class="s-num">' + num(s && s.waiting) + '</div><div class="s-label">Waiting on you</div></button>' +
      '<button class="stat" data-act="goto-orders" data-seg="ready"><div class="s-num">' + num(s && s.ready) + '</div><div class="s-label">Ready for pickup</div></button>' +
      '<div class="stat"><div class="s-num">' + num(s && s.pickedToday) + '</div><div class="s-label">Picked up today</div></div>' +
      '<div class="stat"><div class="s-num">' + (s ? money(s.moneyWeek) : '\u2013') + '</div><div class="s-label">Confirmed this week' + (s ? ' \u00b7 ' + s.confirmedWeek + ' orders' : '') + '</div></div>' +
      '<div class="stat"><div class="s-num">' + num(s && s.ordersToday) + '</div><div class="s-label">Orders today</div></div>' +
      (can('cash_report') ? '<button class="stat" data-act="cash-today"><div class="s-num">' + (state.cashToday ? money(state.cashToday.total) : '\u2013') + '</div><div class="s-label">Cash today' + (state.cashToday ? ' \u00b7 ' + state.cashToday.count : '') + '</div></button>' : '') +
      '</div>';
    if (state.stock && state.stock.low.length) h += '<div style="margin-top:14px">' + lowBanner() + '</div>';
    h += '<div class="group-head">People</div><div class="group">' +
      rowLink('staff', ICON.people, '', 'Staff accounts', staffN === null ? '' : staffN + (staffN === 1 ? ' person' : ' people')) +
      rowLink('staffNew', ICON.addp, 'blue', 'Add a staff member', '') + '</div>';
    h += '<div class="group-head">Records</div><div class="group">' +
      rowLink('activity', ICON.clock, 'violet', 'Activity', 'Who did what') +
      '<button class="row" data-act="tab" data-tab="stock"><span class="ic amber">' + ICON.stock + '</span><span class="grow"><span class="title">Stock</span></span><span class="value">' + (state.stock ? state.stock.items.filter(function (i) { return i.tracked; }).map(function (i) { return i.onHand; }).join(' · ') : '') + '</span><span class="chev">' + ICON.chev + '</span></button></div>';
    h += '<div class="group-head">Setup</div><div class="group">' +
      (can('settings') ? rowLink('settings', ICON.gear, 'grey', 'Settings', 'Prices, e-transfer email') + rowLink('cashItems', ICON.cash, 'green', 'Cash items', 'CPR, GPA, NACC prices') : '') +
      '<div class="row"><span class="ic">' + ICON.sheet + '</span><span class="grow"><span class="title">Accounting workbook</span><span class="sub">' +
      (l ? (l.ok ? esc(l.sourceName || '') + ' · ' + l.students + ' students' : 'Problem: ' + esc(l.error)) : 'Checking…') + '</span></span>' +
      '<button class="btn small" data-act="reread">Re-read</button></div></div>';
    h += '<p class="group-foot">Drop the newest workbook into Drive › PRIME Orders › PRIME PSW Accounting Workbook, then tap Re-read. The app also picks it up by itself within 6 hours.</p>';
    if (can('practice')) {
      h += '<div class="group-head">Owner</div><div class="group">' +
        '<div class="row"><span class="ic amber">' + ICON.warn + '</span><span class="grow"><span class="title">Practice mode</span><span class="sub">' + (state.practice ? 'ON: orders and cash made now are tagged TEST, not counted, no stock, pings or emails.' : 'Try the app safely. Everything made while it’s on is tagged TEST and can be wiped.') + '</span></span><label class="switch"><input type="checkbox" data-act="practice-toggle"' + (state.practice ? ' checked' : '') + '><span></span></label></div>' +
        '<button class="row danger" data-act="practice-wipe"><span class="grow"><span class="title">Wipe test data</span><span class="sub">Deletes every TEST order and cash record. Real records are never touched.</span></span></button></div>';
    }
    return h;
  }
  function rowLink(page, icon, color, title, value) {
    return '<button class="row" data-act="go" data-page="' + page + '"><span class="ic ' + color + '">' + icon + '</span><span class="grow"><span class="title">' + esc(title) + '</span></span>' +
      (value ? '<span class="value">' + esc(value) + '</span>' : '') + '<span class="chev">' + ICON.chev + '</span></button>';
  }
  function loadAdmin() {
    var b = document.querySelector('[data-act="refresh-admin"]'); if (b) b.classList.add('spin');
    var today = cashRangeDates({ key: 'today' });
    return Promise.all([sapi('adminStats'), sapi('adminStaffList'), can('cash_report') ? sapi('cashReport', [today.from, today.to]) : Promise.resolve(null)]).then(function (r) {
      state.stats = r[0]; state.stock = r[0].stock; state.lookup = r[0].lookup; state.staff = r[1]; state.cashToday = r[2];
      if ($('admin-body')) $('admin-body').innerHTML = adminBody(); renderTabbar();
    }).catch(function (e) { if (!e.signedOut) toast(e.message); })
      .then(function () { var x = document.querySelector('[data-act="refresh-admin"]'); if (x) x.classList.remove('spin'); });
  }

  /* ---------- staff list ---------- */
  function staffChip(u) {
    if (u.status === 'disabled') return '<span class="chip grey">Disabled</span>';
    if (u.locked) return '<span class="chip red">Locked 15 min</span>';
    if (!u.lastLogin) return '<span class="chip amber">Not signed in yet</span>';
    return '<span class="chip green">Active</span>';
  }
  function reloadStaff(page) { return sapi('adminStaffList').then(function (r) { state.staff = r; if (current().page === page) rerender(); }).catch(function (e) { if (!e.signedOut) toast(e.message); }); }
  PAGES.staff = {
    title: 'Staff',
    right: function () { return '<button class="nav-btn" data-act="go" data-page="staffNew" aria-label="Add staff">' + ICON.plus + '</button>'; },
    html: function () {
      if (!state.staff) return loadingHtml();
      var list = state.staff.staff.slice().sort(function (a, b) { return (a.role === b.role ? 0 : a.role === 'admin' ? -1 : 1) || a.name.localeCompare(b.name); });
      return '<div class="group">' + list.map(function (u) {
        return '<button class="row" data-act="go" data-page="staffDetail" data-username="' + esc(u.username) + '"><span class="avatar">' + esc(initials(u.name)) + '</span>' +
          '<span class="grow"><span class="title">' + esc(u.name) + (u.username === state.user.username ? ' <span class="faint">(you)</span>' : '') + '</span><span class="sub">@' + esc(u.username) + ' · ' + esc(u.roleLabel) + '</span></span>' +
          staffChip(u) + '<span class="chev">' + ICON.chev + '</span></button>';
      }).join('') + '</div><p class="group-foot">Each person signs in with the username and password you give them, then picks their own 4-digit PIN for their phone. You can see PINs on each person’s page.</p>';
    },
    after: function (c) { if (!c.params.loaded) { c.params.loaded = true; reloadStaff('staff'); } }
  };

  /* ---------- staff detail ---------- */
  function staffByName(u) { return state.staff ? state.staff.staff.filter(function (x) { return x.username === u; })[0] : null; }
  PAGES.staffDetail = {
    title: function (c) { var u = staffByName(c.params.username); return u ? u.name : 'Staff'; },
    after: function (c) { if (!c.params.loaded) { c.params.loaded = true; reloadStaff('staffDetail'); } },
    html: function (c) {
      var u = staffByName(c.params.username); if (!u) return loadingHtml();
      var mine = u.username === state.user.username, roles = state.staff.roles;
      var locked = u.role === 'owner' || ((u.role === 'admin') && !can('manage_admins'));   // server enforces; the app just hides what can't happen
      var pinCell = u.hasPin ? (state.revealPin[u.username] ? '<span class="pin-reveal">' + esc(u.pin) + '</span> <button class="link" data-act="pin-hide" data-username="' + esc(u.username) + '">Hide</button>'
        : '•••• <button class="link" data-act="pin-show" data-username="' + esc(u.username) + '">Show</button>') : '<span class="faint">Picks one at first sign-in</span>';
      var h = '<div class="profile"><span class="avatar lg">' + esc(initials(u.name)) + '</span><div class="p-name">' + esc(u.name) + '</div><div class="p-sub">@' + esc(u.username) + ' · ' + esc(u.roleLabel) + '</div><div style="margin-top:8px">' + staffChip(u) + '</div></div>';
      h += '<div class="group-head">Account</div><div class="group">' +
        '<button class="row" data-act="staff-rename" data-username="' + esc(u.username) + '"><span class="grow"><span class="title">Name</span></span><span class="value">' + esc(u.name) + '</span><span class="chev">' + ICON.chev + '</span></button>' +
        (u.role === 'owner' ? '<div class="row"><span class="grow"><span class="title">Role</span><span class="sub">The owner account. It can’t be changed or removed.</span></span><span class="value">Owner</span></div>'
        : locked ? '<div class="row"><span class="grow"><span class="title">Role</span><span class="sub">Only the owner can change an admin.</span></span><span class="value">' + esc(u.roleLabel) + '</span></div>'
        : '<div class="row"><span class="grow"><span class="title">Role</span>' + (mine ? '<span class="sub">You can’t change your own role.</span>' : '') + '</span><span class="segctl">' + roles.map(function (r) {
          return '<button data-act="staff-role" data-username="' + esc(u.username) + '" data-role="' + r.key + '" class="' + (u.role === r.key ? 'on' : '') + '"' + (mine ? ' disabled' : '') + '>' + esc(r.label) + '</button>';
        }).join('') + '</span></div>') +
        '<div class="row"><span class="grow"><span class="title">PIN</span></span><span class="value">' + pinCell + '</span></div>' +
        '<div class="row"><span class="grow"><span class="title">Last sign-in</span></span><span class="value">' + esc(u.lastLogin ? ago(u.lastLogin) : 'Never') + '</span></div>' +
        '<div class="row"><span class="grow"><span class="title">Signed in on</span></span><span class="value">' + u.phones + (u.phones === 1 ? ' phone' : ' phones') + '</span></div>' +
        '<div class="row"><span class="grow"><span class="title">Added</span></span><span class="value">' + esc(when(u.createdAt)) + (u.createdBy && u.createdBy !== 'setup' ? ' by ' + esc(u.createdBy) : '') + '</span></div>' +
        '</div>';
      h += '<div class="group-head">Actions</div><div class="group">' +
        (locked && !mine ? '' : '<button class="row accent" data-act="staff-reset" data-username="' + esc(u.username) + '"><span class="grow"><span class="title">Reset password</span><span class="sub">Makes a new password and signs them out of every phone.</span></span></button>');
      if (!mine && !locked) {
        h += u.status === 'active'
          ? '<button class="row danger" data-act="staff-disable" data-username="' + esc(u.username) + '"><span class="grow"><span class="title">Disable account</span><span class="sub">Signs them out now. You can turn it back on later.</span></span></button>'
          : '<button class="row accent" data-act="staff-enable" data-username="' + esc(u.username) + '"><span class="grow"><span class="title">Enable account</span></span></button>';
        h += '<button class="row danger" data-act="staff-remove" data-username="' + esc(u.username) + '"><span class="grow"><span class="title">Remove</span><span class="sub">Deletes the login. Their past actions stay in Activity.</span></span></button>';
      }
      return h + '</div>' + (mine ? '<p class="group-foot">This is you. Change your own password and PIN under Me.</p>' : locked ? '<p class="group-foot">Only the owner can manage this account.</p>' : '');
    }
  };
  function staffUpdate(username, changes, msg) {
    state.busy = true;
    return sapi('adminStaffUpdate', [username, changes]).then(function () { return sapi('adminStaffList'); })
      .then(function (r) { state.staff = r; rerender(); if (msg) toast(msg); })
      .catch(function (e) { if (!e.signedOut) toast(e.message); }).then(function () { state.busy = false; });
  }
  function showCredentials(title, name, username, password, intro) {
    var link = location.origin + location.pathname.replace(/index\.html$/, '');
    var text = 'PRIME Staff app: ' + link + '\nUsername: ' + username + '\nPassword: ' + password + '\nAfter signing in you’ll choose your own 4-digit PIN.';
    return dialog({ title: title, html: esc(intro) + '<div class="secret">Username: <b>' + esc(username) + '</b><br>Password: <b>' + esc(password) + '</b></div><p class="faint" style="font-size:12.5px;margin-top:8px">You won’t see this password again.</p>',
      ok: 'Copy details', cancel: 'Done' }).then(function (r) { if (r) copy(text).then(function () { toast('Copied. Send it to ' + firstName(name) + '.'); }); });
  }
  function staffAct(act, username) {
    var u = staffByName(username); if (!u) return;
    if (act === 'pin-show' || act === 'pin-hide') { state.revealPin[username] = act === 'pin-show'; rerender(); return; }
    if (act === 'staff-role') return; // handled via data-role
    if (act === 'staff-rename') {
      return dialog({ title: 'Name', ok: 'Save', inputs: [{ key: 'name', value: u.name, maxlength: 60 }], validate: function (v) { return v.name.trim() ? '' : 'Enter a name.'; } })
        .then(function (r) { if (r && r.name.trim() !== u.name) staffUpdate(username, { name: r.name.trim() }, 'Name saved'); });
    }
    if (act === 'staff-reset') {
      return dialog({ title: 'Reset ' + firstName(u.name) + '’s password?', html: 'They’ll be signed out of every phone and need the new password. Their PIN stays the same.', ok: 'Reset',
        inputs: [{ key: 'pw', placeholder: 'New password (leave blank to make one)', maxlength: 72 }], validate: function (v) { return v.pw && v.pw.length < 8 ? 'At least 8 characters, or leave it blank.' : ''; } })
        .then(function (r) {
          if (!r) return; state.busy = true;
          sapi('adminStaffResetPassword', [username, r.pw || '']).then(function (x) {
            if (username === state.user.username) toast('Your other phones were signed out');
            return showCredentials('New password', u.name, username, x.password, 'Give ' + firstName(u.name) + ' these sign-in details:');
          }).then(function () { return sapi('adminStaffList'); }).then(function (l) { state.staff = l; rerender(); })
            .catch(function (e) { if (!e.signedOut) toast(e.message); }).then(function () { state.busy = false; });
        });
    }
    if (act === 'staff-disable') {
      return dialog({ title: 'Disable ' + firstName(u.name) + '?', html: 'They’ll be signed out right away and can’t sign in until you enable the account again.', ok: 'Disable', destructive: true })
        .then(function (r) { if (r) staffUpdate(username, { status: 'disabled' }, firstName(u.name) + ' is disabled'); });
    }
    if (act === 'staff-enable') return staffUpdate(username, { status: 'active' }, firstName(u.name) + ' can sign in again');
    if (act === 'staff-remove') {
      return dialog({ title: 'Remove ' + u.name + '?', html: 'Their login is deleted and they’re signed out everywhere. Orders they handled keep their name in Activity.', ok: 'Remove', destructive: true })
        .then(function (r) {
          if (!r) return; state.busy = true;
          sapi('adminStaffRemove', [username]).then(function () { return sapi('adminStaffList'); })
            .then(function (l) { state.staff = l; state.stack.pop(); rerender(); toast(u.name + ' removed'); })
            .catch(function (e) { if (!e.signedOut) toast(e.message); }).then(function () { state.busy = false; });
        });
    }
  }

  /* ---------- new staff ---------- */
  PAGES.staffNew = {
    title: 'New staff member',
    html: function () {
      var roles = state.staff ? state.staff.roles : [{ key: 'reception', label: 'Reception' }, { key: 'admin', label: 'Admin' }];
      return '<div class="group">' +
        '<label class="cell"><span>Full name</span><input id="ns-name" type="text" autocomplete="off" placeholder="e.g. Priya Sharma" maxlength="60"></label>' +
        '<label class="cell"><span>Username</span><input id="ns-username" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" placeholder="e.g. priyas" maxlength="20"></label>' +
        '<div class="row"><span class="grow"><span class="title">Role</span></span><span class="segctl" id="ns-role">' +
        roles.slice().sort(function (a) { return a.key === 'reception' ? -1 : 1; }).map(function (r) { return '<button type="button" data-role="' + r.key + '" class="' + (r.key === 'reception' ? 'on' : '') + '">' + esc(r.label) + '</button>'; }).join('') +
        '</span></div></div>' +
        '<p class="group-foot" id="ns-role-help">Reception: sees orders that are ready, hands them out, sees stock.</p>' +
        '<div class="group-head">Password</div><div class="group">' +
        '<label class="cell"><span>Password</span><input id="ns-password" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Leave blank to make one" maxlength="72"></label></div>' +
        '<p class="group-foot">Leave it blank and the app makes an easy-to-read one, like <code>maple-river-482</code>. You’ll see it once to pass on.</p>' +
        '<p id="ns-error" class="error" hidden></p><button id="ns-go" class="btn primary block" data-act="staff-create">Create account</button>';
    },
    after: function () {
      $('ns-name').addEventListener('input', function () { if (!$('ns-username').dataset.touched) $('ns-username').value = suggestUsername($('ns-name').value); });
      $('ns-username').addEventListener('input', function () { $('ns-username').dataset.touched = '1'; });
      $('ns-role').addEventListener('click', function (e) {
        var b = e.target.closest('[data-role]'); if (!b) return;
        Array.prototype.forEach.call($('ns-role').children, function (x) { x.classList.toggle('on', x === b); });
        $('ns-role-help').textContent = b.dataset.role === 'admin' ? 'Admin: everything, including confirming payments, staff accounts and settings.' : 'Reception: sees orders that are ready, hands them out, sees stock.';
      });
      setTimeout(function () { var el = $('ns-name'); if (el) el.focus(); }, 60);
    }
  };
  function createStaff() {
    var role = document.querySelector('#ns-role .on'); role = role ? role.dataset.role : 'reception';
    var f = { name: $('ns-name').value.trim(), username: $('ns-username').value.trim().toLowerCase(), role: role, password: $('ns-password').value };
    if (!f.name) return err('ns-error', 'Enter their name.');
    if (!/^[a-z0-9._-]{3,20}$/.test(f.username)) return err('ns-error', 'Username: 3–20 letters or numbers (dots, dashes, underscores are OK).');
    if (f.password && f.password.length < 8) return err('ns-error', 'Password must be at least 8 characters, or leave it blank.');
    err('ns-error', ''); var btn = $('ns-go'); btn.disabled = true; btn.textContent = 'Creating…'; state.busy = true;
    sapi('adminStaffCreate', [f]).then(function (r) {
      return sapi('adminStaffList').then(function (l) { state.staff = l; })
        .then(function () { state.stack = [{ page: 'staff', params: { loaded: true } }, { page: 'staffDetail', params: { username: r.user.username, loaded: true } }]; render(); window.scrollTo(0, 0); })
        .then(function () { return showCredentials('Account ready', r.user.name, r.user.username, r.password, 'Give ' + firstName(r.user.name) + ' these sign-in details:'); });
    }).catch(function (e) { if (!e.signedOut) { err('ns-error', e.message); if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Create account'; } } })
      .then(function () { state.busy = false; });
  }

  /* ---------- activity ---------- */
  var ACT = {
    LOGIN: ['Signed in', 'blue', 'signin'], LOGIN_FAIL: ['Wrong password', 'red', 'signin'], LOGOUT: ['Signed out', 'grey', 'signin'], PIN_SET: ['Set their PIN', 'grey', 'signin'],
    PIN_LOCK: ['Locked out: too many wrong PINs', 'red', 'signin'], PIN_FAIL: ['Wrong setup PIN', 'red', 'signin'], PASSWORD_CHANGED: ['Changed their password', 'grey', 'signin'],
    SESSION_REVOKED: ['Signed out a phone', 'grey', 'signin'], PASSWORD_RESET: ['Reset a password', 'amber', 'changes'], BOOTSTRAP: ['Created the admin account', 'amber', 'changes'],
    STAFF_CREATED: ['Added a staff member', 'amber', 'changes'], STAFF_UPDATED: ['Changed a staff account', 'amber', 'changes'], STAFF_REMOVED: ['Removed a staff member', 'red', 'changes'],
    ORDER: ['New order', '', 'orders'], SENT: ['Student says e-transfer sent', '', 'orders'], CONFIRM: ['Confirmed payment', '', 'orders'], PICKED_UP: ['Handed over', 'blue', 'orders'],
    CANCEL: ['Cancelled an order', 'red', 'orders'], NOTE: ['Wrote a note', 'grey', 'orders'], SETTINGS: ['Changed settings', 'amber', 'changes'], STOCK: ['Updated stock', 'amber', 'changes'],
    STOCK_ERROR: ['Stock problem', 'red', 'changes'], CASH: ['Took cash', '', 'orders'], CASH_VOID: ['Voided cash', 'red', 'orders'], EMAIL_FAIL: ['Email failed', 'red', 'changes'], LOOKUP_REFRESH: ['Re-read the workbook', 'grey', 'changes']
  };
  function nameOf(username) { var u = state.staff ? state.staff.staff.filter(function (x) { return x.username === username; })[0] : null; return u ? u.name : username; }
  PAGES.activity = {
    title: 'Activity',
    right: function () { return navBtn('refresh-activity', ICON.refresh, 'Refresh'); },
    html: function () {
      var f = state.actFilter, segs = [['all', 'All'], ['orders', 'Orders'], ['signin', 'Sign-ins'], ['changes', 'Changes']];
      var h = '<div class="seg">' + segs.map(function (s) { return '<button data-actfilter="' + s[0] + '" class="' + (f === s[0] ? 'on' : '') + '">' + s[1] + '</button>'; }).join('') + '</div>';
      if (!state.activity) return h + loadingHtml();
      var rows = state.activity.filter(function (a) { var m = ACT[a.action]; return f === 'all' || (m && m[2] === f); });
      if (!rows.length) return h + '<div class="empty">' + ICON.clock + '<strong>Nothing yet</strong>Actions show up here as people use the app.</div>';
      var out = '', lastDay = '';
      rows.forEach(function (a) {
        var day = dayLabel(a.at);
        if (day !== lastDay) { if (lastDay) out += '</div>'; out += '<div class="day">' + esc(day) + '</div><div class="group">'; lastDay = day; }
        var m = ACT[a.action] || [a.action, 'grey'];
        var who = a.who ? nameOf(a.who) : a.role === 'student' ? 'Student' : a.action === 'LOGIN_FAIL' ? 'Unknown' : 'System';
        var title = m[0] + (a.orderNo ? ' #' + a.orderNo : '');
        out += '<div class="row"><span class="act-dot ' + m[1] + '"></span><span class="grow"><span class="title">' + esc(title) + '</span><span class="sub">' + esc(who) + (a.detail ? ' · ' + esc(a.detail) : '') + '</span></span><span class="time">' + esc(timeOf(a.at)) + '</span></div>';
      });
      return h + out + '</div><p class="foot">Showing the latest ' + state.activity.length + ' actions. Everything is also kept in the Audit tab of the Book Orders sheet.</p>';
    },
    after: function (c) { if (!c.params.loaded) { c.params.loaded = true; loadActivity(); } }
  };
  function loadActivity() {
    var b = document.querySelector('[data-act="refresh-activity"]'); if (b) b.classList.add('spin');
    return Promise.all([sapi('adminActivity', [300]), state.staff ? Promise.resolve(state.staff) : sapi('adminStaffList')]).then(function (r) {
      state.activity = r[0]; state.staff = r[1]; if (current().page === 'activity') rerender();
    }).catch(function (e) { if (!e.signedOut) toast(e.message); }).then(function () { var x = document.querySelector('[data-act="refresh-activity"]'); if (x) x.classList.remove('spin'); });
  }

  /* ---------- settings ---------- */
  var SETTING_FIELDS = [
    ['school_name', 'School name', 'text', ''], ['etransfer_email', 'E-transfer', 'email', 'Students send money here. They see it on their order page.'],
    ['price_sorrentino', 'Sorrentino', 'number', ''], ['price_palliative', 'Palliative', 'number', 'Prices in dollars. Students whose books are in their fees always see “Included”.'],
    ['pickup_note', 'Pickup note', 'textarea', 'Shown to students under their pickup code.'],
    ['admin_pin', 'Setup PIN', 'text', 'Only used to create the first admin if the staff accounts are ever wiped.']
  ];
  PAGES.settings = {
    title: 'Settings',
    html: function () {
      if (!state.settings) return loadingHtml();
      var s = state.settings, groups = [[0, 1], [2, 3], [4], [5]], heads = ['School', 'Prices', 'Students', 'Security'];
      var h = '';
      groups.forEach(function (g, gi) {
        h += '<div class="group-head">' + heads[gi] + '</div><div class="group">';
        var foot = '';
        g.forEach(function (i) {
          var f = SETTING_FIELDS[i], v = s[f[0]] == null ? '' : s[f[0]];
          h += f[2] === 'textarea' ? '<label class="cell stack"><span>' + f[1] + '</span><textarea id="set-' + f[0] + '" rows="3" maxlength="400">' + esc(v) + '</textarea></label>'
            : '<label class="cell"><span>' + f[1] + '</span><input id="set-' + f[0] + '" type="' + (f[2] === 'number' ? 'text' : f[2]) + '"' + (f[2] === 'number' ? ' inputmode="numeric"' : '') + (f[0] === 'etransfer_email' ? ' autocapitalize="none"' : '') + ' value="' + esc(v) + '"></label>';
          if (f[3]) foot = f[3];
        });
        h += '</div>' + (foot ? '<p class="group-foot">' + esc(foot) + '</p>' : '');
      });
      h += '<p id="set-error" class="error" hidden></p><button id="set-save" class="btn primary block" data-act="settings-save">Save settings</button>';
      h += '<div class="group-head" style="margin-top:34px">Notifications</div><div class="group">' +
        '<label class="cell"><span>App ID</span><input id="push-appid" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="From OneSignal" value="' + esc(s.onesignal_app_id || '') + '"></label>' +
        '<label class="cell"><span>API key</span><input id="push-key" type="password" autocomplete="off" placeholder="' + (s.onesignal_has_key ? 'Saved \u2713 (leave blank to keep)' : 'App API key from OneSignal') + '"></label></div>' +
        '<p class="group-foot">Free at onesignal.com: New App \u203a Web \u203a Typical site, site URL <code>' + esc(location.origin) + '</code>. Copy the App ID, and an App API key from Settings \u203a Keys &amp; IDs. Then each person turns them on under Me \u203a Notifications. Clear the App ID and save to turn notifications off.</p>' +
        '<p id="push-error" class="error" hidden></p><button id="push-save" class="btn block" data-act="push-save">Save notifications</button>';
      return h;
    },
    after: function (c) {
      if (!c.params.loaded && !state.settings) { c.params.loaded = true; sapi('getSettings').then(function (s) { state.settings = s; if (current().page === 'settings') rerender(); }).catch(function (e) { if (!e.signedOut) toast(e.message); }); }
    }
  };
  function savePushSettings() {
    var appId = $('push-appid').value.trim(), key = $('push-key').value.trim();
    if (appId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId)) return err('push-error', 'That App ID doesn\u2019t look right. It looks like 1a2b3c4d-1234-5678-9abc-def012345678.');
    err('push-error', ''); var b = $('push-save'); b.disabled = true; b.textContent = 'Saving\u2026';
    sapi('notifySetup', [{ appId: appId, apiKey: key, appUrl: location.origin + appDir() }]).then(function (st) {
      state.settings.onesignal_app_id = st.appId; state.settings.onesignal_has_key = st.hasKey; $('push-key').value = '';
      toast(st.appId ? 'Saved. Now turn them on under Me \u203a Notifications.' : 'Notifications turned off'); rerender(); loadOrders(true);
    }).catch(function (e) { if (!e.signedOut) err('push-error', e.message); }).then(function () { var x = $('push-save'); if (x) { x.disabled = false; x.textContent = 'Save notifications'; } });
  }
  function saveSettings() {
    var s = {}; SETTING_FIELDS.forEach(function (f) { s[f[0]] = $('set-' + f[0]).value.trim(); });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.etransfer_email)) return err('set-error', 'Enter a valid e-transfer email.');
    if (!/^\d+(\.\d{1,2})?$/.test(s.price_sorrentino) || !/^\d+(\.\d{1,2})?$/.test(s.price_palliative)) return err('set-error', 'Prices must be numbers, like 150.');
    err('set-error', ''); var b = $('set-save'); b.disabled = true; b.textContent = 'Saving…';
    sapi('saveSettings', [s]).then(function (saved) { state.settings = saved; toast('Settings saved'); back(); })
      .catch(function (e) { if (!e.signedOut) { err('set-error', e.message); b.disabled = false; b.textContent = 'Save settings'; } });
  }

  /* =================================================================== Me */
  PAGES.me = {
    title: 'Me', root: true,
    html: function () {
      var u = state.user, me = state.me;
      var h = '<h1 class="large">Me</h1><div class="group"><div class="row" style="padding:14px 16px"><span class="avatar lg">' + esc(initials(u.name)) + '</span><span class="grow"><span class="title" style="font-size:20px;font-weight:700">' + esc(u.name) + '</span><span class="sub">@' + esc(u.username) + ' · ' + esc(u.roleLabel) + '</span></span></div></div>';
      h += '<div class="group-head">Security</div><div class="group">' +
        '<button class="row" data-act="change-pin"><span class="ic">' + ICON.lock + '</span><span class="grow"><span class="title">Change PIN</span></span><span class="chev">' + ICON.chev + '</span></button>' +
        '<button class="row" data-act="go" data-page="password"><span class="ic grey">' + ICON.key + '</span><span class="grow"><span class="title">Change password</span></span><span class="chev">' + ICON.chev + '</span></button>' +
        '<button class="row" data-act="lock"><span class="ic blue">' + ICON.lock + '</span><span class="grow"><span class="title">Lock now</span><span class="sub">The app also locks after 15 minutes in the background.</span></span></button></div>';
      h += pushRowHtml();
      if (can('cash_take')) h += '<div class="group-head">Today</div><div class="group"><div class="row"><span class="ic green">' + ICON.cash + '</span><span class="grow"><span class="title">Cash you took today</span><span class="sub">' + (state.cashMine ? state.cashMine.count + (state.cashMine.count === 1 ? ' payment' : ' payments') + '. Count your drawer against this.' : 'Loading\u2026') + '</span></span><span class="value strong">' + (state.cashMine ? money(state.cashMine.total) : '') + '</span></div></div>';
      if (!standalone()) h += '<div class="group-head">App</div><div class="group"><button class="row" data-act="install"><span class="ic violet">' + ICON.home + '</span><span class="grow"><span class="title">Add to home screen</span><span class="sub">Opens full screen like an app.</span></span><span class="chev">' + ICON.chev + '</span></button></div>';
      h += '<div class="group-head">Signed in on</div>';
      if (!me) h += loadingHtml();
      else h += '<div class="group">' + me.sessions.map(function (s) {
        return '<div class="row"><span class="ic grey">' + ICON.phone + '</span><span class="grow"><span class="title">' + esc(s.device || 'Unknown device') + '</span><span class="sub">' + (s.current ? 'This phone' : 'Last used ' + esc(ago(s.lastSeen))) + '</span></span>' +
          (s.current ? '' : '<button class="btn small danger" data-act="revoke" data-id="' + esc(s.id) + '">Sign out</button>') + '</div>';
      }).join('') + '</div>';
      h += '<div class="group" style="margin-top:26px"><button class="row danger" data-act="signout"><span class="grow center"><span class="title">Sign out</span></span></button></div>';
      return h + '<p class="foot">PRIME Staff ' + VERSION + '</p>';
    },
    after: function () {
      if (!stale('me')) return;
      sapi('staffMe').then(function (r) { state.me = r; if (current().page === 'me') rerender(); }).catch(function (e) { if (!e.signedOut) toast(e.message); });
      if (can('cash_take')) loadCashMine();
    }
  };
  PAGES.password = {
    title: 'Change password',
    html: function () {
      return '<div class="group"><label class="cell"><span>Current</span><input id="pw-old" type="password" autocomplete="current-password"></label>' +
        '<label class="cell"><span>New</span><input id="pw-new" type="password" autocomplete="new-password" placeholder="8+ characters"></label>' +
        '<label class="cell"><span>Confirm</span><input id="pw-new2" type="password" autocomplete="new-password"></label></div>' +
        '<p class="group-foot">Your other phones will be signed out. This phone stays signed in and your PIN doesn’t change.</p>' +
        '<p id="pw-error" class="error" hidden></p><button id="pw-go" class="btn primary block" data-act="password-save">Change password</button>';
    },
    after: function () { setTimeout(function () { var el = $('pw-old'); if (el) el.focus(); }, 60); }
  };
  function savePassword() {
    var o = $('pw-old').value, n = $('pw-new').value;
    if (!o) return err('pw-error', 'Enter your current password.');
    if (n.length < 8) return err('pw-error', 'New password must be at least 8 characters.');
    if (n !== $('pw-new2').value) return err('pw-error', 'The new passwords don’t match.');
    err('pw-error', ''); var b = $('pw-go'); b.disabled = true; b.textContent = 'Saving…';
    sapi('staffChangePassword', [o, n]).then(function () { toast('Password changed'); state.me = null; state.loadedAt.me = 0; back(); })
      .catch(function (e) { if (!e.signedOut) { err('pw-error', e.message); b.disabled = false; b.textContent = 'Change password'; } });
  }
  function install() {
    if (state.deferredInstall) { state.deferredInstall.prompt(); state.deferredInstall = null; return; }
    dialog({ title: 'Add to home screen', html: isIOS() ? 'In Safari, tap the <b>Share</b> button (the square with an arrow), then <b>Add to Home Screen</b>.' : 'Open your browser menu (⋮) and choose <b>Add to Home screen</b> or <b>Install app</b>.', ok: 'OK', noCancel: true });
  }

  /* =================================================================== dialog */
  var dlgResolve = null;
  function dialog(o) {
    closeDialog();
    return new Promise(function (resolve) {
      dlgResolve = resolve;
      var inputs = (o.inputs || []).map(function (f, i) {
        var attrs = ' data-key="' + f.key + '" placeholder="' + esc(f.placeholder || '') + '"' + (f.maxlength ? ' maxlength="' + f.maxlength + '"' : '');
        return f.textarea ? '<textarea rows="3"' + attrs + '>' + esc(f.value || '') + '</textarea>'
          : '<input type="' + (f.type === 'number' ? 'text' : 'text') + '"' + (f.type === 'number' ? ' inputmode="numeric" pattern="[0-9]*"' : '') + attrs + ' value="' + esc(f.value || '') + '"' + (i === 0 ? ' data-first="1"' : '') + '>';
      }).join('');
      $('dlg').innerHTML = '<div class="dlg-card"><div class="dlg-body"><h2>' + esc(o.title || '') + '</h2>' + (o.html ? '<p>' + o.html + '</p>' : '') + inputs + '<div class="dlg-err" id="dlg-err"></div></div>' +
        '<div class="dlg-btns">' + (o.noCancel ? '' : '<button data-dlg="cancel">' + esc(o.cancel || 'Cancel') + '</button>') +
        '<button data-dlg="ok" class="' + (o.destructive ? 'destructive' : 'strong') + '">' + esc(o.ok || 'OK') + '</button></div></div>';
      $('dlg').hidden = false;
      $('dlg').onclick = function (e) {
        var b = e.target.closest('[data-dlg]');
        if (!b) { if (e.target === $('dlg') && !o.noCancel) finish(null); return; }
        if (b.dataset.dlg === 'cancel') return finish(null);
        var vals = {}; Array.prototype.forEach.call($('dlg').querySelectorAll('[data-key]'), function (el) { vals[el.dataset.key] = el.value.trim(); });
        var problem = o.validate ? o.validate(vals) : '';
        if (problem) { $('dlg-err').textContent = problem; buzz(40); return; }
        finish(o.inputs ? vals : true);
      };
      $('dlg').onkeydown = function (e) {
        if (e.key === 'Escape' && !o.noCancel) finish(null);
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); $('dlg').querySelector('[data-dlg="ok"]').click(); }
      };
      var first = $('dlg').querySelector('[data-first]');
      if (first) setTimeout(function () { first.focus(); first.select(); }, 60); else setTimeout(function () { $('dlg').querySelector('[data-dlg="ok"]').focus(); }, 30);
    });
    function finish(v) { var r = dlgResolve; dlgResolve = null; $('dlg').hidden = true; $('dlg').innerHTML = ''; if (r) r(v); }
  }
  function closeDialog() { if (!$('dlg').hidden) { var r = dlgResolve; dlgResolve = null; $('dlg').hidden = true; $('dlg').innerHTML = ''; if (r) r(null); } }

  /* =================================================================== events */
  function initMain() {
    $('tabbar').addEventListener('click', function (e) { var b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
    $('page').addEventListener('change', function (e) { if (e.target.dataset && e.target.dataset.act === 'practice-toggle') practiceToggle(e.target.checked); });
    $('v-main').addEventListener('click', function (e) {
      var s = e.target.closest('[data-seg]');
      if (s && s.closest('.seg')) { state.seg = s.dataset.seg; set(LS.seg, state.seg); updateOrders(); return; }
      var cv = e.target.closest('[data-cbview]');
      if (cv) { state.cbView = cv.dataset.cbview; state.cbSum = null; rerender(); if (state.cbView !== 'day') loadCashBookSummary(); return; }
      var cr = e.target.closest('[data-cashrange]');
      if (cr) { state.cashRange = cr.dataset.cashrange === 'custom' ? { key: 'custom', from: state.cashRange.from || '', to: state.cashRange.to || '' } : { key: cr.dataset.cashrange }; rerender(); if (state.cashRange.key !== 'custom') loadCashReport(); return; }
      var af = e.target.closest('[data-actfilter]');
      if (af) { state.actFilter = af.dataset.actfilter; rerender(); return; }
      var b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
      var act = b.dataset.act, card = b.closest('.card'), o = card ? orderByNo(Number(card.dataset.no)) : null;
      if (o && ['confirm', 'pickup', 'cancel', 'note'].indexOf(act) !== -1) return orderAct(act, o, b);
      if (act.indexOf('stock-') === 0) return stockAct(act, b.dataset.item);
      if (act.indexOf('staff-') === 0 || act.indexOf('pin-') === 0) {
        if (act === 'staff-create') return createStaff();
        if (act === 'staff-role') { var u = staffByName(b.dataset.username); if (u && u.role !== b.dataset.role) confirmRole(u, b.dataset.role); return; }
        return staffAct(act, b.dataset.username);
      }
      switch (act) {
        case 'back': return back();
        case 'go': return go(b.dataset.page, b.dataset.username ? { username: b.dataset.username } : b.dataset.cash ? { cash: b.dataset.cash } : {});
        case 'tab': return setTab(b.dataset.tab);
        case 'goto-orders': state.seg = b.dataset.seg; set(LS.seg, state.seg); return setTab('orders');
        case 'refresh': return current().page === 'stock' ? refreshStockQuiet().then(function () { toast('Stock updated'); }) : loadOrders(false);
        case 'refresh-admin': return loadAdmin();
        case 'refresh-activity': return loadActivity();
        case 'clear-search': state.search = ''; $('search').value = ''; b.remove(); updateOrders(); $('search').focus(); return;
        case 'reread':
          b.disabled = true; b.innerHTML = '<span class="spinner sm"></span>';
          return sapi('lookupRefresh').then(function (l) { state.lookup = l; if (state.stats) state.stats.lookup = l; toast(l.ok ? 'Workbook read: ' + l.students + ' students' : l.error); })
            .catch(function (e2) { if (!e2.signedOut) toast(e2.message); }).then(function () { if ($('admin-body')) $('admin-body').innerHTML = adminBody(); });
        case 'settings-save': return saveSettings();
        case 'password-save': return savePassword();
        case 'change-pin': return showPin('change');
        case 'lock': return lock();
        case 'push-on': return turnOnPush();
        case 'push-test':
          b.disabled = true;
          return sapi('notifyTest').then(function () { toast('Test sent. It should pop up in a few seconds.'); }).catch(function (e4) { if (!e4.signedOut) toast(e4.message); }).then(function () { b.disabled = false; });
        case 'push-save': return savePushSettings();
        case 'cash-new': state.cash = newCashState(); pads = {}; return go('cashNew');
        case 'cash-find': return cashFind(b, false);
        case 'cash-external': return cashFind(b, true);
        case 'cash-save': return cashSave();
        case 'sig-clear': if (pads[b.dataset.sig]) { pads[b.dataset.sig].clear(); sigMark(b.dataset.sig); } return;
        case 'sig-big': return openSigFull(b.dataset.sig);
        case 'drawer': return openDrawer();
        case 'drawer-close': return closeDrawer();
        case 'cash-today': state.cashRange = { key: 'today' }; state.cashRep = null; return setTab('cash');
        case 'refresh-cash': return can('cash_report') ? loadCashReport() : loadCashMine();
        case 'refresh-cashbook': return (state.cbView || 'day') === 'day' ? loadCashBook(state.cashBook ? state.cashBook.date : '') : loadCashBookSummary();
        case 'ci-add': state.cashItems.items.push({ id: '', name: '', group: '', price: '', wb: '', on: true }); rerender(); setTimeout(function () { var els = document.querySelectorAll('[data-ci-name]'); if (els.length) els[els.length - 1].focus(); }, 0); return;
        case 'ci-save': return cashItemsSave(b);
        case 'cash-custom': state.cashRange = { key: 'custom', from: $('cr-from').value, to: $('cr-to').value }; return loadCashReport();
        case 'cash-void': return cashVoidAct(b.dataset.cash);
        case 'cash-edit': return cashEditAct(b.dataset.cash);
        case 'cash-unvoid': return cashUnvoidAct(b.dataset.cash);
        case 'practice-wipe': return practiceWipe();
        case 'cashbook': return go('cashBook', { date: '' });
        case 'cb-prev': case 'cb-next': { var d = new Date((state.cashBook ? state.cashBook.date : todayStr()) + 'T12:00:00'); d.setDate(d.getDate() + (b.dataset.act === 'cb-prev' ? -1 : 1)); return go('cashBook', { date: localDate(d) }); }
        case 'cb-day': state.cbView = 'day'; return go('cashBook', { date: b.dataset.date });
        case 'cb-open': return cashBookOpenAct();
        case 'cb-out': return cashBookOutAct();
        case 'cb-close': return cashBookCloseAct();
        case 'cb-remove': return cashBookRemoveAct(b.dataset.id);
        case 'install': return install();
        case 'revoke':
          return sapi('staffRevokeSession', [b.dataset.id]).then(function (r) { state.me = r; state.loadedAt.me = Date.now(); rerender(); toast('That phone is signed out'); }).catch(function (e3) { if (!e3.signedOut) toast(e3.message); });
        case 'signout':
          return dialog({ title: 'Sign out?', html: 'You’ll need your username and password to sign in again on this phone.', ok: 'Sign out', destructive: true }).then(function (r) {
            if (!r) return; var t = state.token; api('staffLogout', [t]).catch(function () {}); clearSession(); showLogin();
          });
      }
    });
    document.addEventListener('toggle', function (e) { var dd = e.target; if (dd && dd.dataset && dd.dataset.more) state.openMore[dd.dataset.more] = dd.open; }, true);
    document.addEventListener('submit', function (e) { if (e.target.id !== 'login-form') e.preventDefault(); });
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { state.hiddenAt = Date.now(); return; }
      if (state.unlocked && state.hiddenAt && Date.now() - state.hiddenAt > LOCK_AFTER_MS) return lock();
      if (state.unlocked) { loadOrders(true); refreshPushState(); }
    });
    window.addEventListener('online', function () { show('offline', false); if (state.unlocked) loadOrders(true); });
    window.addEventListener('offline', function () { if (state.unlocked) show('offline', true); });
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); state.deferredInstall = e; });
  }
  function confirmRole(u, role) {
    var label = role === 'admin' ? 'Admin' : 'Reception';
    dialog({ title: 'Make ' + firstName(u.name) + ' ' + label + '?', html: (role === 'admin' ? 'Admins can confirm payments, manage staff and change settings.' : 'Reception can hand out ready orders and see stock.') + ' They’ll be signed out and sign in again with the same password.', ok: 'Change role' })
      .then(function (r) { if (r) staffUpdate(u.username, { role: role }, firstName(u.name) + ' is now ' + label); });
  }

  /* =================================================================== boot */
  function boot() {
    initSetup(); initBootstrap(); initLogin(); initPin(); initMain();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
    var qo = new URLSearchParams(location.search).get('order');
    if (qo && /^\d{1,7}$/.test(qo)) { state.pendingOrder = Number(qo); history.replaceState(null, '', location.pathname); }
    // The server link comes from config.js (published with the app). A link typed on the setup screen is only used when config.js has none.
    var cfgUrl = window.PRIME_CONFIG && validUrl(window.PRIME_CONFIG.api) ? window.PRIME_CONFIG.api : null;
    // A new server link signs this phone out, unless config.js says the new server carries the same accounts (the Cloudflare move).
    var carried = (window.PRIME_CONFIG && window.PRIME_CONFIG.sameAccountsAs) || [];
    if (cfgUrl && get(LS.url) && get(LS.url) !== cfgUrl) { if (carried.indexOf(get(LS.url)) !== -1) set(LS.url, cfgUrl); else { set(LS.url, null); set(LS.token, null); set(LS.user, null); } }
    state.url = cfgUrl || get(LS.url) || null;
    if (!state.url) return screen('setup');
    state.token = get(LS.token);
    try { state.user = JSON.parse(get(LS.user) || 'null'); } catch (e) { state.user = null; }
    if (state.token && state.user) return showPin('unlock');
    clearSession(); showLogin();
  }
  boot();
})();
