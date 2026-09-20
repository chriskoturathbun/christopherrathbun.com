/* Dreamlist — the client. State lives in one object, every mutation goes
   through api() optimistically, and a slow poll reconciles what the other
   person did. No framework: the list is small enough that direct DOM work is
   faster to read than a diffing layer. */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const ACCENTS = ['ember', 'bloom', 'tide', 'moss', 'dusk', 'clay'];
const ACCENT_HEX = { ember: '#c2562f', bloom: '#bc3f77', tide: '#2b6ba8', moss: '#44764c', dusk: '#64559f', clay: '#9c7038' };
const CATEGORIES = [
  { id: 'travel', label: 'Travel' }, { id: 'food', label: 'Food' },
  { id: 'outdoors', label: 'Outdoors' }, { id: 'culture', label: 'Culture' },
  { id: 'home', label: 'Home' }, { id: 'someday', label: 'Someday' },
];
const EMOJI = ['✨', '🌙', '🧭', '🍜', '🏔', '🌊', '🍒', '🎬', '🏛', '🚲', '☕️', '🔥', '🌿', '🛶', '🎡', '💫'];

const ICON = {
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="16" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 15a3 3 0 0 1-3 3H8l-4 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3Z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3.6 2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.9l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85Z"/></svg>',
  starFull: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3.6 2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.9l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85Z"/></svg>',
  grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11V4.5H10L20 14.5 13.5 21Z"/><circle cx="7.2" cy="7.8" r="1.1" fill="currentColor"/></svg>',
};

const state = {
  clerk: null,
  me: null,
  list: null,
  items: [],
  members: [],
  view: 'list',
  openItemId: null,
  showDone: false,
  calMonth: null,
  lastSync: 0,
  noteDrafts: {},
  dirtyUntil: 0,   // suppress poll overwrites right after a local edit
};

/* ---------- Plumbing ---------- */

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2800);
}

async function api(path, opts = {}) {
  const token = await state.clerk.session.getToken();
  const headers = { authorization: `Bearer ${token}`, ...(opts.headers || {}) };
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    // Session expired mid-session: send them back through sign-in rather than
    // failing silently on every subsequent keystroke.
    state.clerk.openSignIn({ afterSignInUrl: '/dreamlist' });
    throw new Error('signed out');
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || 'Something went wrong.');
  return data;
}

// Mark a window in which poll results are ignored, so a reconcile can't
// stomp an edit the user just made.
function markDirty(ms = 2500) { state.dirtyUntil = Date.now() + ms; }

function openSheet(id) {
  $('scrim').classList.add('on');
  $(id).classList.add('on');
}
function closeSheets() {
  $('scrim').classList.remove('on');
  document.querySelectorAll('.sheet').forEach(s => s.classList.remove('on'));
}

function initials(name) {
  const n = (name || '').trim();
  if (!n) return '?';
  const parts = n.split(/\s+/);
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function relTime(iso) {
  if (!iso) return '';
  const then = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(then.getTime())) return '';
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function whenText(item) {
  if (!item.scheduledAt) return '';
  const d = new Date(item.scheduledAt);
  if (isNaN(d.getTime())) return '';
  const opts = item.allDay
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const now = new Date();
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleString(undefined, { timeZone: TZ, ...opts });
}

// <input type="datetime-local"> wants wall-clock text, not an ISO instant.
function toLocalInput(iso, allDay) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return allDay ? ymd : `${ymd}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- Boot ---------- */

// Local dev stands in for Clerk, whose production keys are bound to
// christopherrathbun.com and cannot issue a session on localhost. The worker
// only injects __DREAMLIST_DEV__ for requests that never crossed the
// Cloudflare edge, so this can't be reached from the deployed site.
function devClerk() {
  const dev = window.__DREAMLIST_DEV__;
  if (!dev) return null;
  return {
    user: { id: dev.clerkId },
    session: { getToken: async () => 'local-dev' },
    load: async () => {},
    openSignIn: () => {},
    signOut: async () => {},
  };
}

function whenClerkReady() {
  const dev = devClerk();
  if (dev) return Promise.resolve(dev);
  return new Promise((resolve) => {
    if (window.Clerk) return resolve(window.Clerk);
    let tries = 0;
    const iv = setInterval(() => {
      if (window.Clerk) { clearInterval(iv); resolve(window.Clerk); }
      else if (++tries > 200) { clearInterval(iv); resolve(null); }
    }, 100);
  });
}

function gateMessage(msg) {
  $('gate').hidden = false;
  const box = $('gate-msg');
  box.hidden = false;
  box.innerHTML = `<p>${esc(msg)}</p>`;
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const invite = params.get('invite');
  if (invite && invite !== 'unknown') sessionStorage.setItem('dreamlist:invite', invite);
  if (invite === 'unknown') toast('That invite link is no longer valid.');

  const Clerk = await whenClerkReady();
  if (!Clerk) return gateMessage("Couldn't load the sign-in service. Refreshing usually fixes it.");
  try { await Clerk.load(); } catch { return gateMessage('Sign-in failed to start. Refresh and try again.'); }
  state.clerk = Clerk;

  if (!Clerk.user) {
    $('gate').hidden = false;
    const btn = el('button', 'btn primary', invite ? 'Sign in and open the list' : 'Start a list');
    btn.style.padding = '13px 28px';
    btn.style.fontSize = '16px';
    btn.onclick = () => Clerk.openSignIn({ afterSignInUrl: '/dreamlist', afterSignUpUrl: '/dreamlist' });
    $('clerk-signin').appendChild(btn);
    return;
  }

  // Clean the token out of the URL so a shared screenshot doesn't leak it.
  if (invite) history.replaceState({}, '', '/dreamlist');

  const pending = sessionStorage.getItem('dreamlist:invite');
  if (pending) {
    try {
      await api('/dreamlist/api/claim', { method: 'POST', body: JSON.stringify({ token: pending }) });
      toast("You're in.");
    } catch (e) { toast(e.message); }
    sessionStorage.removeItem('dreamlist:invite');
  }

  $('gate').hidden = true;
  $('app').hidden = false;
  wireChrome();
  await loadList();
  startSync();
}

async function loadList() {
  const dir = await api('/dreamlist/api/lists');
  state.me = dir.me;
  const target = dir.lists[0];
  if (!target) return gateMessage('No list found.');
  const full = await api(`/dreamlist/api/lists/${target.id}`);
  applyPayload(full);
}

function applyPayload(p) {
  state.list = p.list;
  state.items = p.items;
  state.members = p.members;
  if (p.me) state.me = p.me;
  state.lastSync = Date.now();
  document.body.dataset.accent = p.list.accent || 'ember';
  const nameEl = $('list-name');
  if (!nameEl.matches(':focus')) nameEl.textContent = p.list.name;
  nameEl.contentEditable = p.list.role === 'owner' ? 'true' : 'false';
  $('emoji-btn').textContent = p.list.emoji || '✨';
  renderFaces();
  renderCurrentView();
}

/* ---------- Chrome ---------- */

function renderFaces() {
  const box = $('faces');
  box.innerHTML = '';
  // Leftmost sits on top so its initials stay fully readable.
  let z = 20;
  const active = state.members.filter(m => m.status === 'active');
  const pending = state.members.filter(m => m.status === 'pending');
  for (const m of active.slice(0, 4)) {
    const f = el('div', 'face', initials(m.name || m.email));
    f.title = m.name || m.email || 'Someone';
    f.style.zIndex = z--;
    box.appendChild(f);
  }
  for (const m of pending.slice(0, 2)) {
    const f = el('div', 'face pending', '…');
    f.title = `${m.email} has been invited but hasn't joined yet`;
    f.style.zIndex = z--;
    box.appendChild(f);
  }
  const add = el('button', 'face-add', '+');
  add.title = 'People on this list';
  add.onclick = openPeople;
  box.appendChild(add);
}

function wireChrome() {
  // View switcher
  const views = $('views');
  views.querySelectorAll('.seg').forEach(btn => {
    btn.onclick = () => switchView(btn.dataset.view);
  });
  requestAnimationFrame(() => moveThumb());
  window.addEventListener('resize', moveThumb);

  // Composer
  const input = $('composer-input');
  input.addEventListener('input', () => {
    $('add-btn').classList.toggle('ready', input.value.trim().length > 0);
  });
  $('composer').onsubmit = (e) => { e.preventDefault(); addItem(); };
  // Implicit form submission is standard, but stating it outright means Enter
  // works the same everywhere, including inside embedded webviews.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addItem(); }
  });

  // Editable list name. Only the owner can rename, so the affordance is
  // switched on in applyPayload once the role is known.
  const nameEl = $('list-name');
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { nameEl.textContent = state.list.name; nameEl.blur(); }
  });
  nameEl.addEventListener('blur', saveListName);

  $('emoji-btn').onclick = openLook;
  $('account-btn').onclick = () => {
    if (confirm('Sign out of Dreamlist?')) state.clerk.signOut().then(() => location.reload());
  };

  $('scrim').onclick = closeSheets;
  document.querySelectorAll('[data-close-sheet]').forEach(b => { b.onclick = closeSheets; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheets();
    // Quick-add from anywhere, the way a capture tool should work.
    if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey
        && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName) && !e.target.isContentEditable) {
      e.preventDefault();
      switchView('list');
      $('composer-input').focus();
    }
  });

  $('invite-form').onsubmit = (e) => { e.preventDefault(); sendInvite(); };
  $('cal-prev').onclick = () => stepMonth(-1);
  $('cal-next').onclick = () => stepMonth(1);
  $('cal-today').onclick = () => { state.calMonth = startOfMonth(new Date()); renderCalendar(); };
}

function moveThumb() {
  const active = $('views').querySelector('.seg[aria-selected="true"]');
  if (!active) return;
  const thumb = $('seg-thumb');
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.transform = `translateX(${active.offsetLeft - 3}px)`;
}

function switchView(view) {
  if (state.view === view) return;
  state.view = view;
  $('views').querySelectorAll('.seg').forEach(b => {
    b.setAttribute('aria-selected', String(b.dataset.view === view));
  });
  moveThumb();
  $('view-list').hidden = view !== 'list';
  $('view-map').hidden = view !== 'map';
  $('view-calendar').hidden = view !== 'calendar';
  document.querySelector('.shell').classList.toggle('wide', view !== 'list');
  renderCurrentView();
}

function renderCurrentView() {
  if (state.view === 'list') renderList();
  else if (state.view === 'map') renderMap();
  else renderCalendar();
}

async function saveListName() {
  const nameEl = $('list-name');
  const name = nameEl.textContent.trim().slice(0, 120);
  if (!name) { nameEl.textContent = state.list.name; return; }
  if (name === state.list.name) return;
  const prev = state.list.name;
  state.list.name = name;
  markDirty();
  try {
    await api(`/dreamlist/api/lists/${state.list.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  } catch (e) {
    state.list.name = prev;
    nameEl.textContent = prev;
    toast(e.message);
  }
}

/* ---------- List view ---------- */

function renderList() {
  const body = $('list-body');
  body.innerHTML = '';

  const open = state.items.filter(i => i.status === 'open');
  const done = state.items.filter(i => i.status === 'done');
  const starred = open.filter(i => i.starred).sort((a, b) => a.position - b.position);
  const rest = open.filter(i => !i.starred).sort((a, b) => a.position - b.position);

  if (!open.length && !done.length) {
    body.appendChild(emptyState());
    return;
  }

  if (starred.length) {
    body.appendChild(sectionLabel('Right now'));
    body.appendChild(itemList(starred, 'starred'));
  }
  if (rest.length) {
    if (starred.length) body.appendChild(sectionLabel('Everything else'));
    body.appendChild(itemList(rest, 'open'));
  }
  if (!open.length && done.length) {
    body.appendChild(allDoneState());
  }

  if (done.length) {
    const label = sectionLabel('');
    const btn = el('button', '', `${state.showDone ? 'Hide' : 'Show'} done together`);
    btn.onclick = () => { state.showDone = !state.showDone; renderList(); };
    label.appendChild(btn);
    label.appendChild(el('span', 'count', `· ${done.length}`));
    body.appendChild(label);
    if (state.showDone) {
      const sorted = done.slice().sort((a, b) => String(b.doneAt || '').localeCompare(String(a.doneAt || '')));
      const ul = itemList(sorted, 'done');
      ul.classList.add('done-list');
      body.appendChild(ul);
    }
  }
}

function sectionLabel(text) {
  const d = el('div', 'section-label');
  if (text) d.appendChild(el('span', '', text));
  return d;
}

function emptyState() {
  const d = el('div', 'empty');
  d.innerHTML = `<div class="mark">✨</div><h3>Nothing here yet</h3>
    <p>Add the first thing you two keep talking about. Somewhere to eat, somewhere to go, something you've been putting off.</p>`;
  return d;
}

function allDoneState() {
  const d = el('div', 'empty');
  d.innerHTML = `<div class="mark">🌤</div><h3>All caught up</h3>
    <p>You've done everything on the list. Time to think of something new.</p>`;
  return d;
}

function itemList(items, kind) {
  const ul = el('ul', 'items');
  ul.dataset.kind = kind;
  for (const item of items) ul.appendChild(renderItem(item));
  if (kind !== 'done') enableDrag(ul);
  return ul;
}

function renderItem(item, { draggable = true } = {}) {
  const li = el('li', 'item');
  li.dataset.id = item.id;
  if (item.status === 'done') li.classList.add('done');
  if (item.starred) li.classList.add('starred');

  const row = el('div', 'item-row');

  // Check
  const check = el('button', 'check');
  check.setAttribute('aria-label', item.status === 'done' ? 'Mark as not done' : 'Mark as done');
  check.innerHTML = ICON.check;
  check.onclick = (e) => { e.stopPropagation(); toggleDone(item.id); };
  row.appendChild(check);

  // Body
  const bodyBox = el('div', 'item-body');
  const title = el('div', 'item-title', item.title);
  title.contentEditable = 'true';
  title.spellcheck = false;
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
    if (e.key === 'Escape') { title.textContent = item.title; title.blur(); }
  });
  title.addEventListener('blur', () => {
    const next = title.textContent.trim();
    if (!next) { title.textContent = item.title; return; }
    if (next !== item.title) patchItem(item.id, { title: next });
  });
  bodyBox.appendChild(title);

  const chips = el('div', 'chips');
  if (item.placeLabel) {
    const c = el('button', 'chip');
    c.innerHTML = `${ICON.pin}<span>${esc(item.placeLabel)}</span>`;
    c.title = item.placeAddress || item.placeLabel;
    c.onclick = (e) => {
      e.stopPropagation();
      if (item.lat != null) { switchView('map'); focusPin(item.id); }
      else openDetail(item.id);
    };
    chips.appendChild(c);
  }
  if (item.scheduledAt) {
    const c = el('button', 'chip accent');
    c.innerHTML = `${ICON.cal}<span>${esc(whenText(item))}</span>`;
    c.onclick = (e) => { e.stopPropagation(); switchView('calendar'); };
    chips.appendChild(c);
  }
  if (item.category) {
    const cat = CATEGORIES.find(c => c.id === item.category);
    const c = el('span', 'chip');
    c.innerHTML = `${ICON.tag}<span>${esc(cat ? cat.label : item.category)}</span>`;
    chips.appendChild(c);
  }
  if (item.noteCount > 0) {
    const c = el('button', 'chip');
    c.innerHTML = `${ICON.note}<span>${item.noteCount}</span>`;
    c.onclick = (e) => { e.stopPropagation(); openDetail(item.id); };
    chips.appendChild(c);
  }
  if (item.status === 'done' && item.doneByName) {
    chips.appendChild(el('span', 'chip', `${item.doneByName.split(' ')[0]} finished it`));
  } else if (item.createdByName && state.members.filter(m => m.status === 'active').length > 1
             && item.createdByClerkId !== state.me?.clerkId) {
    chips.appendChild(el('span', 'chip', `${item.createdByName.split(' ')[0]}'s idea`));
  }
  if (chips.children.length) bodyBox.appendChild(chips);
  row.appendChild(bodyBox);

  // Tools
  const tools = el('div', 'item-tools');
  if (item.status !== 'done') {
    const star = el('button', `tool star${item.starred ? ' starred' : ''}`);
    star.innerHTML = item.starred ? ICON.starFull : ICON.star;
    star.setAttribute('aria-label', item.starred ? 'Unpin from Right now' : 'Pin to Right now');
    star.onclick = (e) => { e.stopPropagation(); patchItem(item.id, { starred: !item.starred }); };
    tools.appendChild(star);
  }
  const more = el('button', 'tool');
  more.setAttribute('aria-label', 'Details');
  more.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>';
  more.onclick = (e) => { e.stopPropagation(); toggleDetail(item.id); };
  tools.appendChild(more);
  if (item.status !== 'done' && draggable) {
    const grip = el('button', 'tool grip');
    grip.setAttribute('aria-label', 'Drag to reorder');
    grip.innerHTML = ICON.grip;
    tools.appendChild(grip);
  }
  row.appendChild(tools);
  li.appendChild(row);

  // Detail drawer
  const detail = el('div', 'detail');
  li.appendChild(detail);
  if (state.openItemId === item.id) {
    li.classList.add('open-detail');
    fillDetail(detail, item);
    requestAnimationFrame(() => { detail.style.height = `${detail.scrollHeight}px`; });
  }
  return li;
}

/* ---------- Mutations ---------- */

async function addItem() {
  const input = $('composer-input');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  $('add-btn').classList.remove('ready');
  markDirty();

  // Optimistic: the dream appears before the round trip, at the top where a
  // server-assigned position will also put it.
  const minPos = Math.min(1000, ...state.items.filter(i => i.status === 'open').map(i => i.position));
  const temp = {
    id: `temp-${Date.now()}`, title, notes: '', status: 'open',
    position: minPos - 100, starred: false, category: null,
    placeLabel: null, placeAddress: null, lat: null, lng: null,
    scheduledAt: null, allDay: true, noteCount: 0,
    createdByName: state.me?.name || null, createdByClerkId: state.me?.clerkId || null,
  };
  state.items.push(temp);
  renderList();
  const fresh = document.querySelector(`.item[data-id="${temp.id}"]`);
  if (fresh) fresh.classList.add('entering');

  try {
    const res = await api(`/dreamlist/api/lists/${state.list.id}/items`, {
      method: 'POST', body: JSON.stringify({ title }),
    });
    const i = state.items.findIndex(x => x.id === temp.id);
    if (i !== -1) state.items[i] = res.item;
    renderList();
  } catch (e) {
    state.items = state.items.filter(x => x.id !== temp.id);
    renderList();
    toast(e.message);
    input.value = title;
  }
}

async function patchItem(id, changes, { silent } = {}) {
  const item = state.items.find(i => i.id === id);
  if (!item || id.startsWith('temp-')) return;
  const before = { ...item };
  Object.assign(item, changes);
  markDirty();
  if (!silent) renderCurrentView();
  try {
    const res = await api(`/dreamlist/api/lists/${state.list.id}/items/${id}`, {
      method: 'PATCH', body: JSON.stringify(changes),
    });
    Object.assign(item, res.item);
    if (!silent) renderCurrentView();
  } catch (e) {
    Object.assign(item, before);
    renderCurrentView();
    toast(e.message);
  }
}

async function toggleDone(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  const next = item.status === 'done' ? 'open' : 'done';
  if (next === 'done') {
    // Let the check animation finish before the row leaves the section.
    const li = document.querySelector(`.item[data-id="${id}"]`);
    if (li) {
      li.classList.add('done');
      li.querySelector('.check')?.setAttribute('aria-label', 'Mark as not done');
      await new Promise(r => setTimeout(r, 260));
      li.classList.add('leaving');
      await new Promise(r => setTimeout(r, 200));
    }
    item.doneByName = state.me?.name || null;
    item.doneAt = new Date().toISOString();
  } else {
    item.doneByName = null;
    item.doneAt = null;
  }
  if (state.openItemId === id) state.openItemId = null;
  await patchItem(id, { status: next });
}

async function deleteItem(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  const li = document.querySelector(`.item[data-id="${id}"]`);
  if (li) { li.classList.add('leaving'); await new Promise(r => setTimeout(r, 220)); }
  const snapshot = state.items.slice();
  state.items = state.items.filter(i => i.id !== id);
  if (state.openItemId === id) state.openItemId = null;
  markDirty();
  renderCurrentView();
  try {
    await api(`/dreamlist/api/lists/${state.list.id}/items/${id}`, { method: 'DELETE' });
  } catch (e) {
    state.items = snapshot;
    renderCurrentView();
    toast(e.message);
  }
}

/* ---------- Item detail ---------- */

function toggleDetail(id) {
  if (state.openItemId === id) closeDetail();
  else openDetail(id);
}

function closeDetail() {
  const prev = document.querySelector('.item.open-detail');
  if (prev) {
    const d = prev.querySelector('.detail');
    d.style.height = '0px';
    prev.classList.remove('open-detail');
  }
  state.openItemId = null;
}

function openDetail(id) {
  if (state.view !== 'list') switchView('list');
  closeDetail();
  state.openItemId = id;
  const li = document.querySelector(`.item[data-id="${id}"]`);
  const item = state.items.find(i => i.id === id);
  if (!li || !item) { renderList(); return; }
  li.classList.add('open-detail');
  const detail = li.querySelector('.detail');
  fillDetail(detail, item);
  requestAnimationFrame(() => {
    detail.style.height = `${detail.scrollHeight}px`;
    li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

// The drawer grows as its contents do (a note added, place results opening),
// so nothing gets clipped by the fixed height the transition set.
function growDetail(node) {
  const detail = node.closest('.detail');
  if (detail) detail.style.height = `${detail.scrollHeight}px`;
}

function fillDetail(detail, item) {
  detail.innerHTML = '';
  const pad = el('div', 'detail-pad');
  pad.style.paddingLeft = '53px';
  pad.style.borderTop = '1px solid var(--hairline)';
  pad.style.marginTop = '2px';

  // Place
  const placeField = el('div', 'field');
  placeField.appendChild(el('div', 'field-label', 'Place'));
  const search = el('div', 'place-search');
  const placeInput = el('input', 'input');
  placeInput.placeholder = 'Search for a place, or just type one';
  placeInput.value = item.placeLabel || '';
  search.appendChild(placeInput);
  const results = el('div', 'place-results');
  results.hidden = true;
  search.appendChild(results);
  placeField.appendChild(search);
  if (item.placeAddress) {
    const addr = el('div', '', item.placeAddress);
    addr.style.cssText = 'font-size:12.5px;color:var(--muted);margin-top:6px;line-height:1.45';
    placeField.appendChild(addr);
  }
  wirePlaceSearch(placeInput, results, item);
  pad.appendChild(placeField);

  // When
  const whenField = el('div', 'field');
  whenField.appendChild(el('div', 'field-label', 'When'));
  const whenRow = el('div', 'row-2');
  const dateInput = el('input', 'input');
  dateInput.type = item.allDay ? 'date' : 'datetime-local';
  dateInput.value = toLocalInput(item.scheduledAt, item.allDay);
  const timeToggle = el('button', 'btn quiet');
  timeToggle.style.cssText = 'border:1px solid var(--hairline);border-radius:var(--r-sm)';
  timeToggle.textContent = item.allDay ? 'Add a time' : 'All day';
  timeToggle.onclick = () => {
    const allDay = !item.allDay;
    // Keep whatever they already picked when switching precision.
    const keep = dateInput.value;
    item.allDay = allDay;
    dateInput.type = allDay ? 'date' : 'datetime-local';
    dateInput.value = allDay ? keep.slice(0, 10) : (keep.length === 10 ? `${keep}T18:00` : keep);
    timeToggle.textContent = allDay ? 'Add a time' : 'All day';
    if (dateInput.value) commitDate();
    else patchItem(item.id, { allDay }, { silent: true });
  };
  const commitDate = () => {
    const v = dateInput.value;
    if (!v) return patchItem(item.id, { scheduledAt: null });
    const d = new Date(v.length === 10 ? `${v}T12:00` : v);
    if (isNaN(d.getTime())) return;
    patchItem(item.id, { scheduledAt: d.toISOString(), allDay: item.allDay });
  };
  dateInput.onchange = commitDate;
  whenRow.appendChild(dateInput);
  whenRow.appendChild(timeToggle);
  whenField.appendChild(whenRow);
  pad.appendChild(whenField);

  // Category
  const catField = el('div', 'field');
  catField.appendChild(el('div', 'field-label', 'Kind'));
  const catRow = el('div', 'cat-row');
  for (const c of CATEGORIES) {
    const b = el('button', `cat${item.category === c.id ? ' sel' : ''}`, c.label);
    b.onclick = () => {
      const next = item.category === c.id ? null : c.id;
      item.category = next;
      patchItem(item.id, { category: next });
    };
    catRow.appendChild(b);
  }
  catField.appendChild(catRow);
  pad.appendChild(catField);

  // Notes
  const notesField = el('div', 'field');
  notesField.appendChild(el('div', 'field-label', 'Notes'));
  const thread = el('div', 'notes-thread');
  notesField.appendChild(thread);
  const compose = el('div', 'note-compose');
  const noteBox = el('textarea', 'textarea');
  noteBox.placeholder = 'Add a note…';
  noteBox.rows = 1;
  noteBox.value = state.noteDrafts[item.id] || '';
  const noteSend = el('button', 'btn primary', 'Add');
  noteSend.disabled = !noteBox.value.trim();
  noteBox.addEventListener('input', () => {
    state.noteDrafts[item.id] = noteBox.value;
    noteSend.disabled = !noteBox.value.trim();
    noteBox.style.height = 'auto';
    noteBox.style.height = `${Math.min(noteBox.scrollHeight, 180)}px`;
    growDetail(noteBox);
  });
  noteBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); noteSend.click(); }
  });
  noteSend.onclick = () => submitNote(item, noteBox, thread, noteSend);
  compose.appendChild(noteBox);
  compose.appendChild(noteSend);
  notesField.appendChild(compose);
  pad.appendChild(notesField);
  if (item.noteCount > 0) loadNotes(item, thread);

  // Actions
  const actions = el('div', 'detail-actions');
  const kill = el('button', 'btn danger', 'Delete');
  kill.onclick = () => {
    if (confirm(`Delete "${item.title}"?`)) deleteItem(item.id);
  };
  const close = el('button', 'btn quiet', 'Close');
  close.onclick = () => closeDetail();
  actions.appendChild(kill);
  actions.appendChild(close);
  pad.appendChild(actions);

  detail.appendChild(pad);
}

async function loadNotes(item, thread) {
  try {
    const res = await api(`/dreamlist/api/lists/${state.list.id}/items/${item.id}/notes`);
    thread.innerHTML = '';
    for (const n of res.notes) thread.appendChild(renderNote(item, n, thread));
    growDetail(thread);
  } catch { /* the compose box still works without the history */ }
}

function renderNote(item, n, thread) {
  const box = el('div', 'note');
  const who = el('div', 'who');
  who.innerHTML = `<b>${esc((n.authorName || 'Someone').split(' ')[0])}</b><span>${esc(relTime(n.createdAt))}</span>`;
  box.appendChild(who);
  box.appendChild(el('div', 'body', n.body));
  if (n.authorClerkId === state.me?.clerkId) {
    const kill = el('button', 'kill', '×');
    kill.title = 'Delete note';
    kill.onclick = async () => {
      box.remove();
      item.noteCount = Math.max(0, item.noteCount - 1);
      growDetail(thread);
      markDirty();
      try { await api(`/dreamlist/api/lists/${state.list.id}/notes/${n.id}`, { method: 'DELETE' }); }
      catch (e) { toast(e.message); }
    };
    box.appendChild(kill);
  }
  return box;
}

async function submitNote(item, noteBox, thread, sendBtn) {
  const body = noteBox.value.trim();
  if (!body) return;
  noteBox.value = '';
  delete state.noteDrafts[item.id];
  noteBox.style.height = 'auto';
  sendBtn.disabled = true;
  markDirty();
  try {
    const res = await api(`/dreamlist/api/lists/${state.list.id}/items/${item.id}/notes`, {
      method: 'POST', body: JSON.stringify({ body }),
    });
    item.noteCount = (item.noteCount || 0) + 1;
    thread.appendChild(renderNote(item, res.note, thread));
    growDetail(thread);
  } catch (e) {
    noteBox.value = body;
    state.noteDrafts[item.id] = body;
    sendBtn.disabled = false;
    toast(e.message);
  }
}

/* ---------- Place search ---------- */

function wirePlaceSearch(input, results, item) {
  let timer, lastQuery = '', hits = [], cursor = -1;

  // Picking a result must not blur the input first: the blur handler hides
  // the list, and an element removed between mousedown and mouseup never
  // fires a click. Swallowing mousedown keeps focus where it is.
  results.addEventListener('mousedown', (e) => e.preventDefault());

  const close = () => { results.hidden = true; cursor = -1; growDetail(results); };

  const choose = (hit) => {
    input.value = hit.label;
    close();
    Object.assign(item, {
      placeLabel: hit.label, placeAddress: hit.address, lat: hit.lat, lng: hit.lng,
    });
    toast(`Pinned ${hit.label}`);
    patchItem(item.id, {
      placeLabel: hit.label, placeAddress: hit.address, lat: hit.lat, lng: hit.lng,
    });
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      if (q === lastQuery) return;
      lastQuery = q;
      try {
        const res = await api(`/dreamlist/api/geocode?q=${encodeURIComponent(q)}`);
        hits = res.results || [];
        results.innerHTML = '';
        if (!hits.length) { close(); return; }
        hits.forEach((h, idx) => {
          const b = el('button', 'place-hit');
          b.type = 'button';
          b.innerHTML = `<strong>${esc(h.label)}</strong><small>${esc(h.address)}</small>`;
          b.onclick = () => choose(h);
          b.onmouseenter = () => { cursor = idx; paintCursor(); };
          results.appendChild(b);
        });
        results.hidden = false;
        growDetail(results);
      } catch { close(); }
    }, 320);
  });

  const paintCursor = () => {
    results.querySelectorAll('.place-hit').forEach((n, idx) => n.classList.toggle('active', idx === cursor));
  };

  input.addEventListener('keydown', (e) => {
    if (!results.hidden && hits.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); cursor = (cursor + 1) % hits.length; paintCursor(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); cursor = (cursor - 1 + hits.length) % hits.length; paintCursor(); return; }
      if (e.key === 'Enter' && cursor >= 0) { e.preventDefault(); choose(hits[cursor]); return; }
    }
    if (e.key === 'Escape') { close(); return; }
    // Enter with nothing highlighted keeps the typed text as a plain place,
    // which is how a dream with no findable address still gets a label.
    if (e.key === 'Enter') {
      e.preventDefault();
      close();
      const label = input.value.trim();
      if (label === (item.placeLabel || '')) return;
      const changes = label
        ? { placeLabel: label, placeAddress: null, lat: null, lng: null }
        : { placeLabel: null, placeAddress: null, lat: null, lng: null };
      Object.assign(item, changes);
      patchItem(item.id, changes);
    }
  });

  input.addEventListener('blur', () => setTimeout(close, 180));
}

/* ---------- Drag to reorder ---------- */

// Pointer-based so it works the same with a mouse or a thumb. The dragged row
// follows the pointer while its neighbours shift out of the way; the server
// gets only the two ids it landed between.
function enableDrag(ul) {
  let dragging = null, ghost = null, offsetY = 0, startY = 0, moved = false;

  const rowsBelow = (y) => {
    const rows = [...ul.querySelectorAll('.item:not(.dragging)')];
    return rows.find(r => {
      const box = r.getBoundingClientRect();
      return y < box.top + box.height / 2;
    });
  };

  ul.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.grip');
    if (!grip) return;
    const li = grip.closest('.item');
    if (!li) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);

    dragging = li;
    moved = false;
    startY = e.clientY;
    const box = li.getBoundingClientRect();
    offsetY = e.clientY - box.top;

    ghost = li.cloneNode(true);
    ghost.classList.add('lifted');
    ghost.style.cssText += `position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;margin:0;pointer-events:none;`;
    document.body.appendChild(ghost);
    li.classList.add('dragging');
  });

  ul.addEventListener('pointermove', (e) => {
    if (!dragging || !ghost) return;
    if (Math.abs(e.clientY - startY) > 3) moved = true;
    ghost.style.top = `${e.clientY - offsetY}px`;
    const next = rowsBelow(e.clientY);
    if (next) ul.insertBefore(dragging, next);
    else ul.appendChild(dragging);
  });

  const finish = async (e) => {
    if (!dragging) return;
    const li = dragging;
    const id = li.dataset.id;
    dragging = null;
    if (ghost) { ghost.remove(); ghost = null; }
    li.classList.remove('dragging');
    li.classList.add('settling');
    setTimeout(() => li.classList.remove('settling'), 520);
    if (!moved) return;

    const siblings = [...ul.querySelectorAll('.item')];
    const idx = siblings.indexOf(li);
    const beforeId = idx > 0 ? siblings[idx - 1].dataset.id : null;
    const afterId = idx < siblings.length - 1 ? siblings[idx + 1].dataset.id : null;

    markDirty();
    try {
      const res = await api(`/dreamlist/api/lists/${state.list.id}/reorder`, {
        method: 'POST', body: JSON.stringify({ itemId: id, beforeId, afterId }),
      });
      state.items = res.items;
    } catch (err) {
      toast(err.message);
      renderList();
    }
  };

  ul.addEventListener('pointerup', finish);
  ul.addEventListener('pointercancel', finish);
}

/* ---------- Map ---------- */

let map = null, markers = new Map(), leafletReady = null;

// Leaflet loads the first time the map is opened, so the list view never pays
// for a library it doesn't use.
function loadLeaflet() {
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    css.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
    css.crossOrigin = '';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
    s.crossOrigin = '';
    s.onload = () => resolve(window.L);
    s.onerror = () => reject(new Error('map failed to load'));
    document.head.appendChild(s);
  });
  return leafletReady;
}

async function renderMap() {
  const withPins = state.items.filter(i => i.lat != null && i.lng != null);
  const without = state.items.filter(i => (i.lat == null || i.lng == null) && i.status === 'open');
  renderUnpinned(without, withPins.length);

  let L;
  try { L = await loadLeaflet(); }
  catch { $('map').innerHTML = '<div class="empty"><p>The map could not load. Check your connection and try again.</p></div>'; return; }

  if (!map) {
    map = L.map('map', { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    map.setView([20, 0], 2);
    // Scroll-zoom only once the map has focus, so the page still scrolls past it.
    map.on('click', () => map.scrollWheelZoom.enable());
    map.on('mouseout', () => map.scrollWheelZoom.disable());
  }

  for (const m of markers.values()) m.remove();
  markers.clear();

  for (const item of withPins) {
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin${item.status === 'done' ? ' done' : ''}"><b>${item.status === 'done' ? '✓' : ''}</b></div>`,
      iconSize: [26, 26], iconAnchor: [13, 26], popupAnchor: [0, -24],
    });
    const marker = L.marker([item.lat, item.lng], { icon }).addTo(map);
    marker.bindPopup(
      `<b>${esc(item.title)}</b><small>${esc(item.placeAddress || item.placeLabel || '')}</small>` +
      (item.scheduledAt ? `<small>${esc(whenText(item))}</small>` : '')
    );
    marker.on('popupopen', () => {
      const node = marker.getPopup().getElement();
      if (!node || node.querySelector('.popup-open')) return;
      const b = el('button', 'btn quiet popup-open', 'Open');
      b.style.cssText = 'padding:5px 0;font-size:13px;color:var(--accent)';
      b.onclick = () => { switchView('list'); openDetail(item.id); };
      node.querySelector('.leaflet-popup-content').appendChild(b);
    });
    markers.set(item.id, marker);
  }

  requestAnimationFrame(() => {
    map.invalidateSize();
    if (withPins.length === 1) map.setView([withPins[0].lat, withPins[0].lng], 12);
    else if (withPins.length > 1) {
      map.fitBounds(withPins.map(i => [i.lat, i.lng]), { padding: [46, 46], maxZoom: 13 });
    }
  });
}

function renderUnpinned(items, pinCount) {
  const box = $('unpinned');
  box.innerHTML = '';
  if (!pinCount) {
    const d = el('div', 'empty');
    d.innerHTML = `<div class="mark">🧭</div><h3>No places yet</h3>
      <p>Open a dream and search for a place. Anything you pin shows up here.</p>`;
    box.appendChild(d);
  }
  if (!items.length) return;
  const label = sectionLabel(pinCount ? 'Not on the map yet' : 'Waiting for a place');
  label.appendChild(el('span', 'count', `· ${items.length}`));
  box.appendChild(label);
  const ul = el('ul', 'items');
  for (const item of items) {
    const li = el('li', 'item');
    li.dataset.id = item.id;
    const row = el('div', 'item-row');
    row.style.paddingLeft = '17px';
    const body = el('div', 'item-body');
    body.appendChild(el('div', 'item-title', item.title));
    row.appendChild(body);
    const add = el('button', 'btn quiet', 'Add a place');
    add.onclick = () => { switchView('list'); openDetail(item.id); };
    row.appendChild(add);
    li.appendChild(row);
    ul.appendChild(li);
  }
  box.appendChild(ul);
}

function focusPin(itemId) {
  const go = () => {
    const m = markers.get(itemId);
    const item = state.items.find(i => i.id === itemId);
    if (m && item) { map.setView([item.lat, item.lng], 14, { animate: true }); m.openPopup(); }
  };
  if (map && markers.has(itemId)) go();
  else setTimeout(go, 700);
}

/* ---------- Calendar ---------- */

const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const localKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function stepMonth(delta) {
  const base = state.calMonth || startOfMonth(new Date());
  state.calMonth = new Date(base.getFullYear(), base.getMonth() + delta, 1);
  renderCalendar();
}

function scheduledByDay() {
  const map = new Map();
  for (const item of state.items) {
    if (!item.scheduledAt) continue;
    const d = new Date(item.scheduledAt);
    if (isNaN(d.getTime())) continue;
    const key = localKey(d);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  for (const list of map.values()) {
    list.sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
  }
  return map;
}

function renderCalendar() {
  if (!state.calMonth) state.calMonth = startOfMonth(new Date());
  const month = state.calMonth;
  const byDay = scheduledByDay();

  $('cal-title').textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const grid = $('cal-grid');
  grid.innerHTML = '';
  for (const d of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) grid.appendChild(el('div', 'cal-dow', d));

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const todayKey = localKey(new Date());

  for (let i = 0; i < 42; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = localKey(day);
    const cell = el('button', 'cal-day');
    if (day.getMonth() !== month.getMonth()) cell.classList.add('other');
    if (key === todayKey) cell.classList.add('today');
    cell.appendChild(el('span', 'n', String(day.getDate())));

    const onDay = byDay.get(key) || [];
    if (onDay.length) {
      const dots = el('div', 'cal-dots');
      for (const item of onDay.slice(0, 4)) {
        dots.appendChild(el('span', `cal-dot${item.status === 'done' ? ' done' : ''}`));
      }
      cell.appendChild(dots);
      cell.title = onDay.map(i => i.title).join('\n');
    }
    cell.onclick = () => onDayClick(day, onDay);
    grid.appendChild(cell);
  }

  renderAgenda(byDay);
}

function onDayClick(day, onDay) {
  if (onDay.length === 1) { switchView('list'); openDetail(onDay[0].id); return; }
  if (onDay.length > 1) {
    document.getElementById(`agenda-${localKey(day)}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  // An empty day is an invitation: name a dream and it lands on that date.
  const title = prompt(`What are you two doing on ${day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}?`);
  if (title && title.trim()) createOnDay(title.trim(), day);
}

async function createOnDay(title, day) {
  markDirty();
  try {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0);
    const res = await api(`/dreamlist/api/lists/${state.list.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ title, scheduledAt: at.toISOString(), allDay: true }),
    });
    state.items.push(res.item);
    renderCalendar();
    toast('Added to the calendar.');
  } catch (e) { toast(e.message); }
}

function renderAgenda(byDay) {
  const box = $('agenda');
  box.innerHTML = '';
  const today = localKey(new Date());
  const upcoming = [...byDay.entries()]
    .filter(([key]) => key >= today)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 8);

  if (!upcoming.length) {
    const d = el('div', 'empty');
    d.innerHTML = `<div class="mark">📅</div><h3>Nothing scheduled</h3>
      <p>Put a date on a dream and it shows up here. Or tap an empty day above to start one.</p>`;
    box.appendChild(d);
    return;
  }

  box.appendChild(sectionLabel('Coming up'));
  for (const [key, items] of upcoming) {
    const group = el('div', 'agenda-day');
    group.id = `agenda-${key}`;
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const label = key === today
      ? 'Today'
      : date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    group.appendChild(el('div', 'agenda-date', label));
    const ul = el('ul', 'items');
    for (const item of items) ul.appendChild(renderItem(item, { draggable: false }));
    group.appendChild(ul);
    box.appendChild(group);
  }
}

/* ---------- People ---------- */

function openPeople() {
  const box = $('member-list');
  box.innerHTML = '';
  const isOwner = state.list.role === 'owner';

  for (const m of state.members) {
    const row = el('div', 'member-row');
    const face = el('div', `face${m.status === 'pending' ? ' pending' : ''}`,
      m.status === 'pending' ? '…' : initials(m.name || m.email));
    face.style.marginLeft = '0';
    row.appendChild(face);
    const who = el('div', 'who');
    const name = m.name || (m.email ? m.email.split('@')[0] : 'Someone');
    who.innerHTML = `<b>${esc(name)}</b><small>${esc(
      m.role === 'owner' ? 'Started this list'
      : m.status === 'pending' ? `Invited · ${esc(m.email || '')}`
      : m.email || 'On the list'
    )}</small>`;
    row.appendChild(who);
    if (isOwner && m.role !== 'owner') {
      const kill = el('button', 'btn quiet', m.status === 'pending' ? 'Cancel' : 'Remove');
      kill.onclick = async () => {
        if (m.status === 'active' && !confirm(`Remove ${name} from this list?`)) return;
        try {
          const res = await api(`/dreamlist/api/lists/${state.list.id}/members/${m.id}`, { method: 'DELETE' });
          state.members = res.members;
          renderFaces();
          openPeople();
        } catch (e) { toast(e.message); }
      };
      row.appendChild(kill);
    }
    box.appendChild(row);
  }

  $('invite-form').hidden = !isOwner;
  $('invite-note').hidden = true;
  openSheet('people-sheet');
}

async function sendInvite() {
  const input = $('invite-email');
  const email = input.value.trim();
  if (!email) return;
  const btn = $('invite-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await api(`/dreamlist/api/lists/${state.list.id}/invite`, {
      method: 'POST', body: JSON.stringify({ email }),
    });
    state.members = res.members;
    renderFaces();
    input.value = '';
    const message = res.sent
      ? `Invite sent to ${email}.`
      : `Email didn't go through. Send them this link instead: ${res.link}`;
    openPeople();
    const note = $('invite-note');
    note.hidden = false;
    note.textContent = message;
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
  }
}

/* ---------- Look ---------- */

function openLook() {
  const row = $('emoji-row');
  row.innerHTML = '';
  for (const e of EMOJI) {
    const b = el('button', `cat${state.list.emoji === e ? ' sel' : ''}`, e);
    b.style.fontSize = '17px';
    b.onclick = () => saveLook({ emoji: e });
    row.appendChild(b);
  }
  const accents = $('accent-row');
  accents.innerHTML = '';
  for (const a of ACCENTS) {
    const b = el('button', `swatch${state.list.accent === a ? ' sel' : ''}`);
    b.style.background = ACCENT_HEX[a];
    b.title = a;
    b.onclick = () => saveLook({ accent: a });
    accents.appendChild(b);
  }
  openSheet('look-sheet');
}

async function saveLook(changes) {
  Object.assign(state.list, changes);
  document.body.dataset.accent = state.list.accent;
  $('emoji-btn').textContent = state.list.emoji;
  openLook();
  markDirty();
  try {
    await api(`/dreamlist/api/lists/${state.list.id}`, { method: 'PATCH', body: JSON.stringify(changes) });
  } catch (e) { toast(e.message); }
}

/* ---------- Sync ---------- */

// Two people, both with the tab open. An 8-second poll while visible is
// indistinguishable from realtime at this scale and costs nothing when the
// tab is in the background.
function startSync() {
  const tick = async () => {
    if (document.hidden) return;
    if (Date.now() < state.dirtyUntil) return;
    // An open drawer is an editing context. Reconciling under it rebuilds the
    // DOM and would close a place dropdown or drop a half-typed note, so the
    // poll waits until the drawer is closed. It catches up on the next tick.
    if (state.openItemId) return;
    if (document.querySelector('.item-title:focus, .input:focus, .textarea:focus, .list-name:focus')) return;
    try {
      const fresh = await api(`/dreamlist/api/lists/${state.list.id}`);
      if (Date.now() < state.dirtyUntil) return;
      if (JSON.stringify(fresh.items) === JSON.stringify(state.items)
          && fresh.list.name === state.list.name
          && fresh.list.accent === state.list.accent
          && JSON.stringify(fresh.members) === JSON.stringify(state.members)) return;
      applyPayload(fresh);
    } catch { /* a dropped poll just retries on the next tick */ }
  };
  setInterval(tick, 8000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

boot();
