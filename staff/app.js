/* PRIME Staff v2 — talks to the Book Orders Google Apps Script JSON API.
 * Sign-in: username + password once per phone -> session token (kept on the phone) -> 4-digit PIN to open the app.
 * The PIN is never stored on the phone; it is checked by the server against that phone's session. */
(function () {
  'use strict';

  var VERSION = '2.0';
  var LS = { url: 'prime_api_url', token: 'prime_token', user: 'prime_user', tab: 'prime_tab', seg: 'prime_seg' };
  var POLL_MS = 30000, LOCK_AFTER_MS = 5 * 60 * 1000, API_TIMEOUT_MS = 30000;

  var state = {
    url: null, token: null, user: null, unlocked: false,
    tab: 'orders', stack: [],
    orders: [], ordersAt: null, lookup: null, stock: null, stockLogRows: null,
    seg: null, search: '', openMore: {},
    stats: null, staff: null, activity: null, actFilter: 'all', settings: null, me: null, revealPin: {},
    timer: null, hiddenAt: 0, busy: false, deferredInstall: null, pin: { mode: 'unlock', digits: '', first: '', busy: false }, loadedAt: {}
  };
  /** true (and marks it) if `key` hasn't been loaded in the last `ms`: stops pages that re-render after loading from loading again. */
  function stale(key, ms) { var t = state.loadedAt[key] || 0; if (Date.now() - t < (ms || 15000)) return false; state.loadedAt[key] = Date.now(); return true; }

  /* =================================================================== helpers */
  function $(id) { return document.getElementById(id); }
  function show(id, on) { var el = $(id); if (el) el.hidden = !on; }
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n) { return '$' + Number(n || 0).toLocaleString('en-CA'); }
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
  function validUrl(u) { return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec\/?$/.test(String(u || '').trim()); }
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
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3.5M7.5 8 12 3.5 16.5 8"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5 12 3.5l8.5 4-8.5 4-8.5-4z"/><path d="M3.5 7.5v9l8.5 4 8.5-4v-9"/><path d="M12 11.5v9"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/></svg>'
  };

  /* =================================================================== API */
  function api(fn, args) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, API_TIMEOUT_MS) : null;
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
    set(LS.token, null); set(LS.user, null);
    try { if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch (e) {}
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
    setTimeout(function () { ($('login-username').value ? $('login-password') : $('login-username')).focus(); }, 50);
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
        enterMain();
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
    var t = [{ key: 'orders', label: 'Orders', icon: ICON.orders }];
    if (can('stock_view')) t.push({ key: 'stock', label: 'Stock', icon: ICON.stock });
    if (can('admin')) t.push({ key: 'admin', label: 'Admin', icon: ICON.admin });
    t.push({ key: 'me', label: 'Me', icon: ICON.me });
    return t;
  }
  function enterMain() {
    state.unlocked = true; screen('main');
    var t = get(LS.tab); state.tab = tabsFor().some(function (x) { return x.key === t; }) ? t : 'orders';
    state.stack = []; state.seg = get(LS.seg);
    render(); loadOrders(false); startPolling();
  }
  function resumeMain() { screen('main'); render(); startPolling(); }
  function lock() {
    if (!state.unlocked) return;
    if (state.token) api('staffLock', [state.token]).catch(function () {});
    state.unlocked = false; stopPolling(); closeDialog();
    state.orders = []; state.ordersAt = null; state.staff = null; state.activity = null; state.me = null; state.settings = null; state.revealPin = {}; state.loadedAt = {};
    showPin('unlock');
  }
  function current() { return state.stack.length ? state.stack[state.stack.length - 1] : { page: state.tab }; }
  function go(page, params) { state.stack.push({ page: page, params: params || {} }); render(); window.scrollTo(0, 0); }
  function back() { state.stack.pop(); render(); window.scrollTo(0, 0); }
  function setTab(t) { if (t === state.tab && !state.stack.length) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; } state.tab = t; set(LS.tab, t); state.stack = []; render(); window.scrollTo(0, 0); }

  var PAGES = {};
  function render() {
    if (!state.unlocked) return;
    var cur = current(), P = PAGES[cur.page] || PAGES.orders;
    var nav = $('nav'); nav.classList.toggle('root', !!P.root);
    var prev = state.stack.length > 1 ? state.stack[state.stack.length - 2] : { page: state.tab };
    $('nav-left').innerHTML = state.stack.length
      ? '<button class="nav-back" data-act="back">' + ICON.back + '<span>' + esc(pageTitle(prev)) + '</span></button>'
      : '<span class="brand"><i></i>PRIME</span>';
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
      return '<button data-tab="' + t.key + '" class="' + (state.tab === t.key ? 'active' : '') + '" aria-label="' + t.label + '">' + t.icon + '<span>' + t.label + '</span>' +
        (n ? '<span class="badge">' + (n > 99 ? '99+' : n) + '</span>' : '') + '</button>';
    }).join('');
    try { if (navigator.setAppBadge) { if (can('confirm') && c.waiting) navigator.setAppBadge(c.waiting); else navigator.clearAppBadge(); } } catch (e) {}
  }
  function onScroll() { $('nav').classList.toggle('scrolled', window.scrollY > 30); }
  function navBtn(act, icon, label, extra) { return '<button class="nav-btn' + (extra || '') + '" data-act="' + act + '" aria-label="' + esc(label) + '">' + icon + '</button>'; }
  function loadingHtml() { return '<div class="loading"><div class="spinner"></div></div>'; }
  function lowBanner() {
    if (!state.stock || !state.stock.low.length) return '';
    return '<button class="banner red" data-act="tab" data-tab="stock">' + ICON.warn + '<span class="grow">Low stock: ' + esc(state.stock.low.join(' · ')) + '</span>' + (state.tab === 'stock' ? '' : '<span class="chev">' + ICON.chev + '</span>') + '</button>';
  }

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
      '<div class="c-sub">' + esc(itemsText(o)) + ' · #' + o.orderNo + '</div>' +
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
    if (can('cancel') && o.status !== 'PICKED_UP' && o.status !== 'CANCELLED') acts += '<button class="btn small danger" data-act="cancel">Cancel order</button>';
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
      return '<h1 class="large">Orders</h1><div id="orders-top"></div>' +
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
      state.orders = r.orders; state.ordersAt = new Date(); state.lookup = r.lookup; if (r.stock) state.stock = r.stock;
      var roleChanged = state.user && r.me && (r.me.role !== state.user.role);
      state.user = r.me; set(LS.user, JSON.stringify(r.me));
      if (roleChanged) { state.stack = []; if (!tabsFor().some(function (t) { return t.key === state.tab; })) state.tab = 'orders'; rerender(); }
      else { updateOrders(); renderTabbar(); if (current().page === 'stock' && !state.busy) updateStock(); }
    }).catch(function (e) { if (!silent && !e.signedOut) toast(e.message); })
      .then(function () { var b = document.querySelector('[data-act="refresh"]'); if (b) b.classList.remove('spin'); });
  }
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
      dialog({ title: 'Cancel order #' + o.orderNo + '?', html: esc(nm) + ' will see it as cancelled. This can’t be undone.', ok: 'Cancel order', cancel: 'Keep', destructive: true,
        inputs: [{ key: 'reason', placeholder: 'Reason (optional)', maxlength: 200 }] })
        .then(function (r) { if (r) runOrderAction(null, 'cancelOrder', [o.orderNo, r.reason || ''], function () { toast('Order #' + o.orderNo + ' cancelled'); }); });
    } else if (act === 'note') {
      dialog({ title: 'Staff note', html: 'Only staff see this.', ok: 'Save', inputs: [{ key: 'note', value: o.staffNote || '', placeholder: 'e.g. picked up by her sister', maxlength: 300, textarea: true }] })
        .then(function (r) { if (r) runOrderAction(null, 'saveStaffNote', [o.orderNo, r.note || ''], function () { toast('Note saved'); }); });
    }
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
      '<div class="stat"><div class="s-num">' + (s ? money(s.moneyWeek) : '–') + '</div><div class="s-label">Confirmed this week' + (s ? ' · ' + s.confirmedWeek + ' orders' : '') + '</div></div>' +
      '</div>';
    if (state.stock && state.stock.low.length) h += '<div style="margin-top:14px">' + lowBanner() + '</div>';
    h += '<div class="group-head">People</div><div class="group">' +
      rowLink('staff', ICON.people, '', 'Staff accounts', staffN === null ? '' : staffN + (staffN === 1 ? ' person' : ' people')) +
      rowLink('staffNew', ICON.addp, 'blue', 'Add a staff member', '') + '</div>';
    h += '<div class="group-head">Records</div><div class="group">' +
      rowLink('activity', ICON.clock, 'violet', 'Activity', 'Who did what') +
      '<button class="row" data-act="tab" data-tab="stock"><span class="ic amber">' + ICON.stock + '</span><span class="grow"><span class="title">Stock</span></span><span class="value">' + (state.stock ? state.stock.items.filter(function (i) { return i.tracked; }).map(function (i) { return i.onHand; }).join(' · ') : '') + '</span><span class="chev">' + ICON.chev + '</span></button></div>';
    h += '<div class="group-head">Setup</div><div class="group">' +
      rowLink('settings', ICON.gear, 'grey', 'Settings', 'Prices, e-transfer email') +
      '<div class="row"><span class="ic">' + ICON.sheet + '</span><span class="grow"><span class="title">Accounting workbook</span><span class="sub">' +
      (l ? (l.ok ? esc(l.sourceName || '') + ' · ' + l.students + ' students' : 'Problem: ' + esc(l.error)) : 'Checking…') + '</span></span>' +
      '<button class="btn small" data-act="reread">Re-read</button></div></div>';
    h += '<p class="group-foot">Drop the newest workbook into Drive › PRIME Orders › PRIME PSW Accounting Workbook, then tap Re-read. The app also picks it up by itself within 6 hours.</p>';
    return h;
  }
  function rowLink(page, icon, color, title, value) {
    return '<button class="row" data-act="go" data-page="' + page + '"><span class="ic ' + color + '">' + icon + '</span><span class="grow"><span class="title">' + esc(title) + '</span></span>' +
      (value ? '<span class="value">' + esc(value) + '</span>' : '') + '<span class="chev">' + ICON.chev + '</span></button>';
  }
  function loadAdmin() {
    var b = document.querySelector('[data-act="refresh-admin"]'); if (b) b.classList.add('spin');
    return Promise.all([sapi('adminStats'), sapi('adminStaffList')]).then(function (r) {
      state.stats = r[0]; state.stock = r[0].stock; state.lookup = r[0].lookup; state.staff = r[1];
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
      var pinCell = u.hasPin ? (state.revealPin[u.username] ? '<span class="pin-reveal">' + esc(u.pin) + '</span> <button class="link" data-act="pin-hide" data-username="' + esc(u.username) + '">Hide</button>'
        : '•••• <button class="link" data-act="pin-show" data-username="' + esc(u.username) + '">Show</button>') : '<span class="faint">Picks one at first sign-in</span>';
      var h = '<div class="profile"><span class="avatar lg">' + esc(initials(u.name)) + '</span><div class="p-name">' + esc(u.name) + '</div><div class="p-sub">@' + esc(u.username) + ' · ' + esc(u.roleLabel) + '</div><div style="margin-top:8px">' + staffChip(u) + '</div></div>';
      h += '<div class="group-head">Account</div><div class="group">' +
        '<button class="row" data-act="staff-rename" data-username="' + esc(u.username) + '"><span class="grow"><span class="title">Name</span></span><span class="value">' + esc(u.name) + '</span><span class="chev">' + ICON.chev + '</span></button>' +
        '<div class="row"><span class="grow"><span class="title">Role</span>' + (mine ? '<span class="sub">You can’t change your own role.</span>' : '') + '</span><span class="segctl">' + roles.map(function (r) {
          return '<button data-act="staff-role" data-username="' + esc(u.username) + '" data-role="' + r.key + '" class="' + (u.role === r.key ? 'on' : '') + '"' + (mine ? ' disabled' : '') + '>' + esc(r.label) + '</button>';
        }).join('') + '</span></div>' +
        '<div class="row"><span class="grow"><span class="title">PIN</span></span><span class="value">' + pinCell + '</span></div>' +
        '<div class="row"><span class="grow"><span class="title">Last sign-in</span></span><span class="value">' + esc(u.lastLogin ? ago(u.lastLogin) : 'Never') + '</span></div>' +
        '<div class="row"><span class="grow"><span class="title">Signed in on</span></span><span class="value">' + u.phones + (u.phones === 1 ? ' phone' : ' phones') + '</span></div>' +
        '<div class="row"><span class="grow"><span class="title">Added</span></span><span class="value">' + esc(when(u.createdAt)) + (u.createdBy && u.createdBy !== 'setup' ? ' by ' + esc(u.createdBy) : '') + '</span></div>' +
        '</div>';
      h += '<div class="group-head">Actions</div><div class="group">' +
        '<button class="row accent" data-act="staff-reset" data-username="' + esc(u.username) + '"><span class="grow"><span class="title">Reset password</span><span class="sub">Makes a new password and signs them out of every phone.</span></span></button>';
      if (!mine) {
        h += u.status === 'active'
          ? '<button class="row danger" data-act="staff-disable" data-username="' + esc(u.username) + '"><span class="grow"><span class="title">Disable account</span><span class="sub">Signs them out now. You can turn it back on later.</span></span></button>'
          : '<button class="row accent" data-act="staff-enable" data-username="' + esc(u.username) + '"><span class="grow"><span class="title">Enable account</span></span></button>';
        h += '<button class="row danger" data-act="staff-remove" data-username="' + esc(u.username) + '"><span class="grow"><span class="title">Remove</span><span class="sub">Deletes the login. Their past actions stay in Activity.</span></span></button>';
      }
      return h + '</div>' + (mine ? '<p class="group-foot">This is you. Change your own password and PIN under Me.</p>' : '');
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
      setTimeout(function () { $('ns-name').focus(); }, 60);
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
    STOCK_ERROR: ['Stock problem', 'red', 'changes'], LOOKUP_REFRESH: ['Re-read the workbook', 'grey', 'changes']
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
      return h + '<p id="set-error" class="error" hidden></p><button id="set-save" class="btn primary block" data-act="settings-save">Save settings</button>';
    },
    after: function (c) {
      if (!c.params.loaded) { c.params.loaded = true; sapi('getSettings').then(function (s) { state.settings = s; if (current().page === 'settings') rerender(); }).catch(function (e) { if (!e.signedOut) toast(e.message); }); }
    }
  };
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
        '<button class="row" data-act="lock"><span class="ic blue">' + ICON.lock + '</span><span class="grow"><span class="title">Lock now</span><span class="sub">The app also locks after 5 minutes in the background.</span></span></button></div>';
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
    after: function () { if (stale('me')) sapi('staffMe').then(function (r) { state.me = r; if (current().page === 'me') rerender(); }).catch(function (e) { if (!e.signedOut) toast(e.message); }); }
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
    after: function () { setTimeout(function () { $('pw-old').focus(); }, 60); }
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
    $('v-main').addEventListener('click', function (e) {
      var s = e.target.closest('[data-seg]');
      if (s && s.closest('.seg')) { state.seg = s.dataset.seg; set(LS.seg, state.seg); updateOrders(); return; }
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
        case 'go': return go(b.dataset.page, b.dataset.username ? { username: b.dataset.username } : {});
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
      if (state.unlocked) loadOrders(true);
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
    // The server link comes from config.js (published with the app). A link typed on the setup screen is only used when config.js has none.
    var cfgUrl = window.PRIME_CONFIG && validUrl(window.PRIME_CONFIG.api) ? window.PRIME_CONFIG.api : null;
    if (cfgUrl && get(LS.url) && get(LS.url) !== cfgUrl) { set(LS.url, null); set(LS.token, null); set(LS.user, null); }
    state.url = cfgUrl || get(LS.url) || null;
    if (!state.url) return screen('setup');
    state.token = get(LS.token);
    try { state.user = JSON.parse(get(LS.user) || 'null'); } catch (e) { state.user = null; }
    if (state.token && state.user) return showPin('unlock');
    clearSession(); showLogin();
  }
  boot();
})();
