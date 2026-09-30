/* PRIME (Staff) — book orders. Talks to the Google Apps Script JSON API. */
(function () {
  'use strict';

  var LS = { url: 'prime_api_url', pin: 'prime_pin', role: 'prime_role', cache: 'prime_orders_cache', tab: 'prime_tab' };
  var POLL_MS = 30000;
  var state = { url: null, pin: null, role: null, tab: 'payments', orders: [], updatedAt: null, timer: null, deferredInstall: null, busy: false, lookup: null };

  /* ---------- tiny helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function show(id, on) { $(id).hidden = !on; }
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n) { return '$' + Number(n || 0).toLocaleString('en-CA'); }
  function when(iso) { if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return String(iso); var now = new Date(); var sameDay = d.toDateString() === now.toDateString(); return d.toLocaleString('en-CA', sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function err(id, msg) { var el = $(id); el.textContent = msg || ''; el.hidden = !msg; }
  var toastTimer = null;
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 2200); }
  function items(o) { var a = []; if (o.sorrentino) a.push('Sorrentino'); if (o.palliative) a.push('Palliative bundle'); return a.join(' + '); }
  function itemsDetailed(o) {
    var a = [];
    if (o.sorrentino) a.push('Sorrentino' + (o.sorrentinoStatus === 'included' ? ' (included)' : ''));
    if (o.palliative) a.push('Palliative bundle' + (o.palliativeStatus === 'included' ? ' (included)' : ''));
    return a.join(' + ');
  }
  function tags(o) {
    var t = [];
    (o.flags || []).forEach(function (f) {
      if (f === 'Included') return;
      var cls = /paid/i.test(f) ? 'warn' : /differs|matched/i.test(f) ? 'warn' : 'info';
      t.push('<span class="tag ' + cls + '">' + esc(f) + '</span>');
    });
    return t.length ? '<div class="tags">' + t.join('') + '</div>' : '';
  }
  function badge(o) {
    var cls = { NEW: o.included ? 'b-sent' : 'b-new', SENT: 'b-sent', READY: 'b-ready', PICKED_UP: 'b-picked', CANCELLED: 'b-cancel' }[o.status] || 'b-cancel';
    var txt = { NEW: o.included ? 'Included \u00b7 to confirm' : 'Waiting for payment', SENT: 'Payment sent', READY: 'Ready for pickup', PICKED_UP: 'Picked up', CANCELLED: 'Cancelled' }[o.status] || o.status;
    return '<span class="badge ' + cls + '">' + esc(txt) + '</span>';
  }
  function validUrl(u) { return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec\/?$/.test(String(u || '').trim()); }

  /* ---------- API ---------- */
  function api(fn, args) {
    var body = JSON.stringify({ fn: fn, args: args || [] });
    return fetch(state.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, redirect: 'follow' })
      .then(function (r) { if (!r.ok) throw new Error('Server error (' + r.status + ')'); return r.json(); })
      .then(function (j) { if (!j || j.ok !== true) throw new Error((j && j.error) || 'Unexpected reply'); return j.result; });
  }

  /* ---------- screens ---------- */
  var SCREENS = ['boot', 'setup', 'login', 'queue', 'settings'];
  function screen(name) {
    SCREENS.forEach(function (s) { show('v-' + s, s === name); });
    show('bar-menu', name === 'queue' || name === 'settings');
    $('bar-role').textContent = (name === 'queue' || name === 'settings') && state.role ? (state.role === 'admin' ? 'Admin' : 'Reception') : '';
    if (name !== 'queue') stopPolling();
    window.scrollTo(0, 0);
  }

  /* ---------- setup ---------- */
  function initSetup() {
    $('setup-go').addEventListener('click', function () {
      var u = $('setup-url').value.trim();
      if (!validUrl(u)) return err('setup-error', 'That doesn’t look like an Apps Script web app link. It should start with https://script.google.com/macros/s/ and end in /exec.');
      err('setup-error', '');
      $('setup-go').disabled = true; $('setup-go').textContent = 'Checking…';
      state.url = u;
      api('getPublicConfig').then(function () {
        set(LS.url, u); $('setup-go').disabled = false; $('setup-go').textContent = 'Connect'; screen('login'); $('login-pin').focus();
      }).catch(function (e) { state.url = null; $('setup-go').disabled = false; $('setup-go').textContent = 'Connect'; err('setup-error', 'Couldn’t reach the order system: ' + e.message); });
    });
    $('setup-change').addEventListener('click', function () { $('setup-url').value = state.url || ''; screen('setup'); });
  }

  /* ---------- login ---------- */
  function initLogin() {
    function go() {
      var pin = $('login-pin').value.trim();
      if (!pin) return err('login-error', 'Enter your PIN.');
      err('login-error', '');
      $('login-go').disabled = true;
      api('staffLogin', [pin]).then(function (r) {
        state.pin = pin; state.role = r.role;
        if ($('login-remember').checked) { set(LS.pin, pin); set(LS.role, r.role); } else { set(LS.pin, null); set(LS.role, null); }
        $('login-pin').value = ''; $('login-go').disabled = false;
        state.tab = get(LS.tab) || (r.role === 'admin' ? 'payments' : 'ready');
        screen('queue'); renderTabs(); renderList(); loadOrders(); startPolling();
      }).catch(function (e) { $('login-go').disabled = false; err('login-error', e.message); });
    }
    $('login-go').addEventListener('click', go);
    $('login-pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  }
  function signOut() {
    state.pin = null; state.role = null; state.orders = [];
    set(LS.pin, null); set(LS.role, null); set(LS.cache, null);
    closeSheet(); screen('login'); $('login-pin').focus();
  }

  /* ---------- queue ---------- */
  function tabsFor() {
    return state.role === 'admin'
      ? [['payments', 'To confirm'], ['ready', 'Ready'], ['done', 'Done'], ['all', 'All']]
      : [['ready', 'Ready for pickup'], ['done', 'Picked up']];
  }
  function counts() {
    var c = { payments: 0, ready: 0, done: 0, all: state.orders.length };
    state.orders.forEach(function (o) { if (o.status === 'NEW' || o.status === 'SENT') c.payments++; if (o.status === 'READY') c.ready++; if (o.status === 'PICKED_UP') c.done++; });
    return c;
  }
  function renderTabs() {
    var tabs = tabsFor(), c = counts();
    if (!tabs.some(function (t) { return t[0] === state.tab; })) state.tab = tabs[0][0];
    $('tabs').innerHTML = tabs.map(function (t) {
      var n = (t[0] === 'payments' || t[0] === 'ready') && c[t[0]] ? '<span class="n">' + c[t[0]] + '</span>' : '';
      return '<button class="tab' + (state.tab === t[0] ? ' active' : '') + '" data-tab="' + t[0] + '" role="tab" aria-selected="' + (state.tab === t[0]) + '">' + esc(t[1]) + n + '</button>';
    }).join('');
    updateBadge(c.payments);
  }
  function updateBadge(n) {
    try { if ('setAppBadge' in navigator) { if (n > 0 && state.role === 'admin') navigator.setAppBadge(n); else navigator.clearAppBadge(); } } catch (e) {}
  }
  function filtered() {
    var list = state.orders.filter(function (o) {
      if (state.tab === 'payments') return o.status === 'NEW' || o.status === 'SENT';
      if (state.tab === 'ready') return o.status === 'READY';
      if (state.tab === 'done') return o.status === 'PICKED_UP';
      return true;
    });
    if (state.tab === 'payments') list.sort(function (a, b) { var ra = a.included ? 2 : (a.status === 'SENT' ? 1 : 0), rb = b.included ? 2 : (b.status === 'SENT' ? 1 : 0); return (rb - ra) || (b.orderNo - a.orderNo); });
    return list;
  }
  function emptyText() {
    return { payments: ['All caught up', 'No payments waiting for you.'], ready: ['Nothing to hand out', 'Confirmed orders show here with their pickup code.'],
             done: ['No pickups yet', 'Orders marked picked up land here.'], all: ['No orders yet', 'New orders appear here as students place them.'] }[state.tab];
  }
  function renderList() {
    var isAdmin = state.role === 'admin';
    var list = filtered();
    if (!list.length) { var t = emptyText(); $('list').innerHTML = '<div class="empty"><strong>' + t[0] + '</strong>' + t[1] + '</div>'; return; }
    $('list').innerHTML = list.map(function (o) {
      var h = '<article class="card' + (o.status === 'CANCELLED' ? ' dim' : '') + '" data-no="' + o.orderNo + '">' +
        '<div class="top"><span class="name">' + esc(o.name) + '</span><span class="when">' + esc(when(o.createdAt)) + '</span></div>' +
        '<div class="meta">#' + o.orderNo + ' · ' + esc(o.studentNumber) + ' · ' + esc(o.batch) + '</div>' +
        '<div class="items">' + esc(itemsDetailed(o)) + '</div>' +
        '<div class="amt-row"><span class="amt">' + (o.included ? 'Included' : money(o.amount)) + '</span>' + badge(o) + '</div>' + tags(o);
      if (o.workbookName && o.workbookName !== o.name) h += '<div class="hint">Workbook name: <strong>' + esc(o.workbookName) + '</strong>' + (o.agent ? ' \u00b7 ' + esc(o.agent) : '') + '</div>';
      else if (o.agent) h += '<div class="hint">' + esc(o.agent) + '</div>';
      if (o.included && (o.status === 'NEW' || o.status === 'SENT')) h += '<div class="hint">Books are in their fees. Confirm to send the pickup code.</div>';
      else if (o.status === 'SENT') h += '<div class="hint">Sent ' + esc(when(o.sentAt)) + ' \u00b7 look in the e-transfer inbox for <strong>' + money(o.amount) + '</strong>, message <strong>Order ' + o.orderNo + '</strong></div>';
      else if (o.status === 'NEW' && isAdmin) h += '<div class="hint">Hasn’t tapped “sent” yet. Confirm anyway if the money arrived.</div>';
      if (o.status === 'READY') h += '<div class="code">Pickup code <b>' + esc(o.pickupCode) + '</b></div>';
      if (o.studentNote) h += '<div class="hint">Note from student: ' + esc(o.studentNote) + '</div>';
      if (o.staffNote) h += '<div class="hint">Staff note: ' + esc(o.staffNote) + '</div>';
      if (o.phone || o.email) h += '<div class="hint">' + esc([o.phone, o.email].filter(Boolean).join(' · ')) + '</div>';
      var btns = '';
      if (isAdmin && (o.status === 'NEW' || o.status === 'SENT')) btns += '<button class="go" data-act="confirmPayment">Confirm · send code</button>';
      if (o.status === 'READY') btns += '<button class="go" data-act="markPickedUp">Picked up</button>';
      if (isAdmin && o.status !== 'PICKED_UP' && o.status !== 'CANCELLED') btns += '<button class="warn" data-act="cancel">Cancel</button>';
      if (btns) h += '<div class="actions">' + btns + '</div>';
      return h + '</article>';
    }).join('');
  }
  function loadOrders(silent) {
    if (!state.pin) return;
    return api('staffList', [state.pin]).then(function (r) {
      state.role = r.role; state.orders = r.orders; state.updatedAt = new Date(); state.lookup = r.lookup || null;
      set(LS.cache, JSON.stringify({ role: r.role, orders: r.orders, at: state.updatedAt.toISOString() }));
      err('queue-error', ''); show('offline', false);
      renderTabs(); renderList(); renderFooter();
    }).catch(function (e) {
      if (!navigator.onLine || /Failed to fetch|NetworkError|Load failed/i.test(e.message)) { show('offline', true); return; }
      if (/PIN|Not allowed/i.test(e.message)) { toast('Your PIN no longer works. Sign in again.'); return signOut(); }
      if (!silent) err('queue-error', e.message);
    });
  }
  function renderFooter() {
    var t = 'Updated ' + when(state.updatedAt.toISOString());
    var l = state.lookup;
    if (l && l.ok) t += ' \u00b7 Workbook from ' + (l.dataAsOf ? new Date(l.dataAsOf).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '?') + ' (' + l.students + ' students)';
    else if (l && !l.ok) t += ' \u00b7 Workbook lookup: ' + l.error;
    $('updated').textContent = t;
  }
  function startPolling() { stopPolling(); state.timer = setInterval(function () { if (document.visibilityState === 'visible') loadOrders(true); }, POLL_MS); }
  function stopPolling() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  function act(fn, orderNo, btn) {
    if (state.busy) return; state.busy = true;
    var label = btn.textContent; btn.disabled = true; btn.textContent = 'Working…';
    api(fn, [state.pin, orderNo]).then(function (o) {
      var i = state.orders.findIndex(function (x) { return x.orderNo === o.orderNo; });
      if (i >= 0) state.orders[i] = o; else state.orders.unshift(o);
      renderTabs(); renderList();
      toast(fn === 'confirmPayment' ? 'Confirmed. Code ' + o.pickupCode + ' sent to #' + o.orderNo : fn === 'markPickedUp' ? '#' + o.orderNo + ' picked up' : '#' + o.orderNo + ' cancelled');
      if (navigator.vibrate) navigator.vibrate(30);
    }).catch(function (e) { toast(e.message); btn.disabled = false; btn.textContent = label; loadOrders(true); })
      .then(function () { state.busy = false; });
  }
  function initQueue() {
    $('tabs').addEventListener('click', function (e) { var b = e.target.closest('[data-tab]'); if (!b) return; state.tab = b.dataset.tab; set(LS.tab, state.tab); renderTabs(); renderList(); });
    $('list').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]'); if (!b) return;
      var no = Number(b.closest('.card').dataset.no);
      if (b.dataset.act === 'cancel') {
        if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to cancel'; setTimeout(function () { if (b.isConnected && b.dataset.armed === '1') { b.dataset.armed = ''; b.textContent = 'Cancel'; } }, 4000); return; }
        return act('cancelOrder', no, b);
      }
      act(b.dataset.act, no, b);
    });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && state.pin && !$('v-queue').hidden) loadOrders(true); });
    window.addEventListener('online', function () { if (state.pin) loadOrders(true); });
    window.addEventListener('offline', function () { show('offline', true); });
  }

  /* ---------- settings (admin) ---------- */
  var KEYS = ['school_name', 'etransfer_email', 'price_sorrentino', 'price_palliative', 'pickup_note', 'admin_pin', 'reception_pin'];
  function openSettings() {
    closeSheet(); screen('settings'); err('set-error', ''); err('set-ok', '');
    api('getSettings', [state.pin]).then(function (s) { KEYS.forEach(function (k) { $('set-' + k).value = s[k] || ''; }); })
      .catch(function (e) { err('set-error', e.message); });
  }
  function initSettings() {
    $('set-save').addEventListener('click', function () {
      var s = {}; KEYS.forEach(function (k) { s[k] = $('set-' + k).value; });
      err('set-error', ''); err('set-ok', ''); $('set-save').disabled = true;
      api('saveSettings', [state.pin, s]).then(function (saved) {
        state.pin = saved.admin_pin; if (get(LS.pin)) set(LS.pin, state.pin);
        $('set-save').disabled = false; err('set-ok', 'Saved.'); toast('Settings saved');
      }).catch(function (e) { $('set-save').disabled = false; err('set-error', e.message); });
    });
    $('set-back').addEventListener('click', function () { screen('queue'); renderTabs(); renderList(); loadOrders(true); startPolling(); });
  }

  /* ---------- menu sheet ---------- */
  function openSheet() { show('sheet-settings', state.role === 'admin'); show('sheet-install', !!state.deferredInstall); show('sheet', true); }
  function closeSheet() { show('sheet', false); }
  function initSheet() {
    $('bar-menu').addEventListener('click', openSheet);
    $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) closeSheet(); });
    $('sheet-close').addEventListener('click', closeSheet);
    $('sheet-refresh').addEventListener('click', function () { closeSheet(); loadOrders().then(function () { toast('Refreshed'); }); });
    $('sheet-lookup').addEventListener('click', function () {
      closeSheet(); toast('Re-reading the workbook\u2026');
      api('lookupRefresh', [state.pin]).then(function (l) { state.lookup = l; renderFooter(); toast(l.ok ? 'Workbook loaded: ' + l.students + ' students' : l.error); }).catch(function (e) { toast(e.message); });
    });
    $('sheet-settings').addEventListener('click', openSettings);
    $('sheet-signout').addEventListener('click', signOut);
    $('sheet-install').addEventListener('click', function () { closeSheet(); if (state.deferredInstall) { state.deferredInstall.prompt(); state.deferredInstall = null; } });
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); state.deferredInstall = e; });
  }

  /* ---------- boot ---------- */
  function boot() {
    initSetup(); initLogin(); initQueue(); initSettings(); initSheet();
    if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch(function () {}); }
    var qs = new URLSearchParams(location.search);
    var urlParam = qs.get('api');
    if (urlParam && validUrl(urlParam)) { set(LS.url, urlParam); history.replaceState(null, '', location.pathname); }
    state.url = get(LS.url) || (window.PRIME_CONFIG && window.PRIME_CONFIG.api) || null;
    if (!state.url) return screen('setup');
    var pin = get(LS.pin), role = get(LS.role);
    if (!pin) return screen('login');
    state.pin = pin; state.role = role || 'reception'; state.tab = get(LS.tab) || (state.role === 'admin' ? 'payments' : 'ready');
    try { var c = JSON.parse(get(LS.cache) || 'null'); if (c && c.orders) { state.orders = c.orders; state.role = c.role || state.role; } } catch (e) {}
    screen('queue'); renderTabs(); renderList();
    loadOrders().then(function () { startPolling(); });
  }
  boot();
})();
