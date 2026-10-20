'use strict';
/* PST Explorer — user interface (library of several PSTs) */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;

async function api(url, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || data || r.statusText);
  return data;
}

function toast(msg, isErr = false, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), ms);
}

const LS = {
  get(k, d) { try { const v = localStorage.getItem('pstx.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pstx.' + k, JSON.stringify(v)); } catch { /* */ } },
};

// ------------------------------------------------------------------ language (texts in i18n.js)

const LOCALES = { en: 'en-US', es: 'es-CL' };
// the real language is stored by the server; the last one is remembered here to paint without flicker
let LANG = LOCALES[LS.get('lang', 'en')] ? LS.get('lang', 'en') : 'en';
const LOC = () => LOCALES[LANG];
const plurals = {};
function t(key, vars = {}) {
  const D = window.I18N;
  let s = D[LANG][key] ?? D.en[key];
  if (s == null) return key;
  if (typeof s === 'object') {
    plurals[LANG] = plurals[LANG] || new Intl.PluralRules(LOC());
    s = s[plurals[LANG].select(Number(vars.n) || 0)] || s.other;
  }
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : k === 'n' ? fmtNum(vars[k]) : String(vars[k])));
}
// fixed texts of index.html
function applyI18n(root = document) {
  document.documentElement.lang = LANG;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  const sel = $('#langSel');
  if (sel) sel.value = LANG;
}

// ------------------------------------------------------------------ icons (SVG, do not depend on emoji fonts)

const svg = (d) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const I = {
  clip: svg('M16.5 6.5l-8.3 8.3a2 2 0 0 0 2.8 2.8l8.5-8.5a4 4 0 0 0-5.7-5.7L5.3 11.9a6 6 0 0 0 8.5 8.5l6.7-6.7'),
  chat: svg('M4 5h16v11H9l-5 4z'),
  print: svg('M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z'),
  down: svg('M12 3v12m-5-5l5 5 5-5M5 21h14'),
  eye: svg('M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'),
  cal: svg('M4 6h16v15H4zM4 10h16M8 3v4M16 3v4'),
  user: svg('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 9a8 8 0 0 1 16 0'),
  task: svg('M4 4h16v16H4zM8 12l3 3 5-6'),
  note: svg('M5 4h14v11l-5 5H5zM14 20v-5h5'),
  mail: svg('M3 6h18v12H3zM3 7l9 7 9-7'),
  shield: svg('M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'),
  folder: svg('M3 6h6l2 2h10v11H3z'),
  all: svg('M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'),
  db: svg('M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'),
  copy: svg('M8 8h12v12H8zM4 16V4h12'),
  warn: svg('M12 3l10 18H2zM12 10v5M12 18v.5'),
};

// ------------------------------------------------------------------ formatting

function fmtShort(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(LOC(), { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(LOC(), { day: 'numeric', month: 'short' });
  return d.toLocaleDateString(LOC(), { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fmtLong(ms) {
  if (ms == null) return '';
  return new Date(ms).toLocaleString(LOC(), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const fmtNum = (n) => Number(n || 0).toLocaleString(LOC());
const fmtDec = (n, d) => Number(n).toLocaleString(LOC(), { minimumFractionDigits: d, maximumFractionDigits: d });
function fmtSize(b) {
  if (!b) return '0 KB';
  if (b < 1024 * 1024) return `${fmtNum(Math.max(1, Math.round(b / 1024)))} KB`;
  if (b < 1024 ** 3) return `${fmtDec(b / 1024 / 1024, b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${fmtDec(b / 1024 ** 3, 1)} GB`;
}
function fmtEta(s) {
  if (s == null) return '';
  if (s < 90) return `~${Math.max(1, Math.round(s))} s`;
  if (s < 5400) return `~${Math.round(s / 60)} min`;
  return `~${fmtDec(s / 3600, 1)} h`;
}
const fmtAddr = (a) => (a.email && a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.name || a.email || '');

function initials(name) {
  const w = String(name || '?').replace(/[<>"'@].*$/, '').trim().split(/\s+/).filter(Boolean);
  return ((w[0] || '?')[0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
}
function colorFor(s) {
  let h = 0;
  for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}
function fileIco(ext) {
  const e = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `<div class="fileico ${esc(e)}">${esc(e.slice(0, 4) || '?')}</div>`;
}

// ------------------------------------------------------------------ highlighting

const ACC = { a: 'aáàäâã', e: 'eéèëê', i: 'iíìïî', o: 'oóòöôõ', u: 'uúùüû', n: 'nñ', c: 'cç' };
function termRegex(terms) {
  const parts = (terms || []).filter(Boolean).map((t) => t.split(/\s+/).map((w) => [...w.toLowerCase()].map((ch) => {
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return ACC[base] ? `[${ACC[base]}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('')).join('[^\\p{L}\\p{N}]+'));
  if (!parts.length) return null;
  parts.sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})[\\p{L}\\p{N}]*`, 'giu');
}
function hl(text, re) {
  const s = String(text ?? '');
  if (!re) return esc(s);
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  for (const m of s.matchAll(re)) {
    if (!m[0]) continue;
    out += esc(s.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}
// Highlights inside a document (email body in the iframe)
function highlightDoc(doc, re) {
  if (!re || !doc || !doc.body) return [];
  const marks = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentNode && /^(SCRIPT|STYLE|TEXTAREA|MARK)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const s = node.nodeValue;
    re.lastIndex = 0;
    const ms = [...s.matchAll(re)].filter((m) => m[0]);
    if (!ms.length) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of ms) {
      frag.appendChild(doc.createTextNode(s.slice(last, m.index)));
      const mk = doc.createElement('mark');
      mk.textContent = m[0];
      mk.style.cssText = 'background:#fff3a3;color:inherit;border-radius:2px';
      frag.appendChild(mk);
      marks.push(mk);
      last = m.index + m[0].length;
    }
    frag.appendChild(doc.createTextNode(s.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
  return marks;
}

// ------------------------------------------------------------------ state

const DEFAULT_FILTERS = { dateFrom: '', dateTo: '', att: false, unread: false, mail: false, attext: '', inatt: true, dups: false, only: '' };
const state = {
  lib: null, // last /api/state
  view: 'mail', // mail | threads | attachments
  node: { type: 'all' }, // node chosen in the tree: all | file (id) | folder (ref "f:nid")
  nodeName: '',
  q: '',
  scope: 'all',
  filters: { ...DEFAULT_FILTERS },
  sort: 'date',
  dir: 'desc',
  terms: [],
  selected: null,
  images: false,
  attExt: '',
  attName: '',
  attSel: new Set(),
  hideDup: true,
  tree: { files: [], folders: [] },
};

const fileOfNode = () => (state.node.type === 'file' ? state.node.id : state.node.type === 'folder' ? Number(state.node.id.split(':')[0]) : null);
const multiFile = () => (state.tree.files || []).length > 1;
const fileLabel = (id) => {
  const f = (state.lib && state.lib.files.find((x) => x.id === id)) || (state.tree.files || []).find((x) => x.id === id);
  return f ? f.name : `#${id}`;
};

function filterParams({ forExport = false } = {}) {
  const p = new URLSearchParams();
  if (state.q) {
    p.set('q', state.q);
    if (!state.filters.inatt) p.set('inatt', '0');
  }
  // without a search the chosen node is shown; with a search the scope decides
  const n = state.node;
  const scope = state.q ? state.scope : 'node';
  if (scope === 'node') {
    if (n.type === 'file') p.set('file', n.id);
    if (n.type === 'folder') p.set('folder', n.id);
  } else if (scope === 'file' && fileOfNode() != null) p.set('file', fileOfNode());
  else if ((scope === 'folder' || scope === 'foldersub') && n.type !== 'all') {
    if (n.type === 'folder') p.set('folder', n.id); else p.set('file', n.id);
    if (scope === 'foldersub') p.set('sub', '1');
  }
  const f = state.filters;
  if (f.dateFrom) p.set('dateFrom', f.dateFrom);
  if (f.dateTo) p.set('dateTo', f.dateTo);
  if (f.att) p.set('att', '1');
  if (f.unread) p.set('unread', '1');
  if (f.mail) p.set('kind', 'mail');
  if (f.attext) p.set('attext', f.attext);
  if (f.dups) p.set('dups', '1');
  if (f.only) p.set('only', f.only);
  p.set('sort', state.sort);
  p.set('dir', state.dir);
  if (state.view === 'attachments' && !forExport) {
    if (state.attExt) p.set('ext', state.attExt);
    if (state.attName) p.set('name', state.attName);
  }
  return p;
}

// ------------------------------------------------------------------ virtual list

const ROW_H = 74;
const PAGE = 100;

const vlist = {
  el: $('#list'),
  spacer: $('#list .vspacer'),
  rows: $('#list .vrows'),
  total: 0,
  capped: false,
  pages: new Map(),
  gen: 0,
  sel: -1,

  endpoint() {
    return state.view === 'threads' ? '/api/threads' : state.view === 'attachments' ? '/api/attachments' : '/api/messages';
  },
  async load({ keepScroll = false } = {}) {
    const gen = ++this.gen;
    const params = filterParams();
    params.set('offset', 0);
    params.set('limit', PAGE);
    if (!keepScroll) $('#listCount').textContent = t('list.searching');
    let data;
    try {
      data = await api(`${this.endpoint()}?${params}`);
    } catch (e) {
      if (gen === this.gen) { this.total = 0; this.pages.clear(); this.lastHtml = null; this.render(); showEmpty(e.message); updateListHeader(); }
      return;
    }
    if (gen !== this.gen) return;
    this.params = params;
    this.pages = new Map([[0, data.rows]]);
    this.total = data.total;
    this.capped = !!data.capped;
    state.terms = data.terms || [];
    this.re = termRegex(state.terms);
    if (data.exts) renderExtChips(data.exts);
    if (!keepScroll) { this.el.scrollTop = 0; this.sel = -1; }
    this.sel = this.indexOfSelected();
    this.spacer.style.height = `${this.total * ROW_H}px`;
    this.lastHtml = null;
    updateListHeader();
    showEmpty(this.total ? '' : emptyText());
    this.render();
    // with many results the quick count is capped; the exact one arrives later
    if (this.capped) {
      const cp = new URLSearchParams(params);
      cp.set('view', state.view);
      api(`/api/count?${cp}`).then((c) => {
        if (gen !== this.gen) return;
        this.total = c.total;
        this.capped = false;
        this.spacer.style.height = `${this.total * ROW_H}px`;
        updateListHeader();
        this.render();
      }).catch(() => {});
    }
  },
  indexOfSelected() {
    if (state.selected == null) return -1;
    for (const [pg, rows] of this.pages) {
      if (!Array.isArray(rows)) continue;
      const i = rows.findIndex((r) => rowKey(r) === state.selected);
      if (i >= 0) return pg * PAGE + i;
    }
    return -1;
  },
  async fetchPage(pg) {
    if (this.pages.has(pg)) return;
    this.pages.set(pg, 'loading');
    const gen = this.gen;
    const params = new URLSearchParams(this.params);
    params.set('offset', pg * PAGE);
    params.set('limit', PAGE);
    params.set('count', '0');
    try {
      const data = await api(`${this.endpoint()}?${params}`);
      if (gen !== this.gen) return;
      this.pages.set(pg, data.rows);
      this.render();
    } catch {
      this.pages.delete(pg);
    }
  },
  row(i) {
    const pg = Math.floor(i / PAGE);
    const rows = this.pages.get(pg);
    if (!rows) { this.fetchPage(pg); return null; }
    return Array.isArray(rows) ? rows[i % PAGE] : null;
  },
  render() {
    const top = this.el.scrollTop;
    const h = this.el.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - 4);
    const last = Math.min(this.total - 1, Math.ceil((top + h) / ROW_H) + 4);
    let html = '';
    for (let i = first; i <= last; i++) html += renderRow(this.row(i), i, i === this.sel, this.re);
    // do not replace the DOM if nothing changed (avoids losing clicks mid-render)
    if (html !== this.lastHtml) { this.rows.innerHTML = html; this.lastHtml = html; }
  },
  select(i, { open = true, scroll = true } = {}) {
    if (i < 0 || i >= this.total) return;
    const r = this.row(i);
    if (!r) return;
    this.sel = i;
    state.selected = rowKey(r);
    if (scroll) {
      const y = i * ROW_H;
      if (y < this.el.scrollTop) this.el.scrollTop = y;
      else if (y + ROW_H > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = y + ROW_H - this.el.clientHeight;
    }
    this.render();
    if (open) openRow(r);
  },
};

const rowKey = (r) => (state.view === 'threads' ? r.conv_key : state.view === 'attachments' ? `${r.ref}:${r.idx}` : r.ref);

function fileTag(src) {
  if (!multiFile()) return '';
  const name = fileLabel(src).replace(/\.(pst|ost)$/i, '');
  return `<span class="ftag" style="--c:${colorFor(name)}" title="${esc(fileLabel(src))}">${esc(name.length > 18 ? name.slice(0, 17) + '…' : name)}</span>`;
}

function renderRow(r, i, sel, re) {
  const style = `style="top:${i * ROW_H}px"`;
  if (!r) return `<div class="row loading" ${style}><div class="l1"><span class="who">&nbsp;</span></div><div class="l2"><span class="subj">&nbsp;</span></div></div>`;
  if (state.view === 'attachments') {
    const key = `${r.ref}:${r.idx}`;
    return `<div class="row att${sel ? ' sel' : ''}" data-i="${i}" ${style}>
      <input type="checkbox" data-key="${esc(key)}" ${state.attSel.has(key) ? 'checked' : ''} title="${esc(t('att.select'))}">
      ${fileIco(r.ext)}
      <div class="att-info">
        <div class="an" title="${esc(r.name)}">${hl(r.name, re)}</div>
        <div class="am">${fmtSize(r.size)} · ${esc(fmtShort(r.date))} · ${esc(r.sender_name || '')} ${fileTag(r.src)}</div>
        <div class="am">${hl(r.subject || t('row.noSubject'), re)}</div>
      </div></div>`;
  }
  if (state.view === 'threads') {
    return `<div class="row${sel ? ' sel' : ''}${r.is_read === 0 ? ' unread' : ''}" data-i="${i}" ${style}>
      <div class="l1"><span class="who">${hl(r.senders ? r.senders.split(',').slice(0, 4).join(', ') : r.sender_name, re)}</span><span class="when">${esc(fmtShort(r.date))}</span></div>
      <div class="l2"><span class="subj">${hl(r.subject || t('row.noSubject'), re)}</span>
        <span class="flags">${r.att_count ? I.clip : ''}<span class="badge${state.q ? ' hit' : ''}" title="${t(state.q ? 'row.convHitsTitle' : 'row.convTitle')}">${state.q && r.conv_n && r.hits !== r.conv_n ? `${r.hits}/` : ''}${r.conv_n || r.hits}</span></span></div>
      <div class="snip">${hl(r.snippet, re)}</div></div>`;
  }
  const cls = r.msg_class || '';
  const kind = /^IPM\.(Appointment|Schedule)/i.test(cls) ? I.cal : /^IPM\.Contact/i.test(cls) ? I.user : /^IPM\.Task/i.test(cls) ? I.task : /^IPM\.StickyNote/i.test(cls) ? I.note : '';
  return `<div class="row${sel ? ' sel' : ''}${r.is_read === 0 ? ' unread' : ''}" data-i="${i}" ${style}>
    <div class="l1"><span class="who" title="${esc(r.sender_email || '')}">${hl(r.sender_name || r.sender_email || t('row.noSender'), re)}</span>${fileTag(r.src)}<span class="when">${esc(fmtShort(r.date))}</span></div>
    <div class="l2"><span class="subj">${kind}${hl(r.subject || t('row.noSubject'), re)}</span>
      <span class="flags">${r.importance === 2 ? `<span class="imp" title="${t('row.highImportance')}">!</span>` : ''}${r.hit_src === 1 ? `<span class="badge hit" title="${t('row.inAttTitle')}">${t('row.inAtt')}</span>` : ''}${r.att_count ? `<span title="${t('row.attCount', { n: r.att_count })}">${I.clip}</span>` : ''}${r.conv_n > 1 ? `<span class="badge" data-thread="${esc(r.conv_key)}" title="${t('row.viewConv', { n: r.conv_n })}">${I.chat} ${r.conv_n}</span>` : ''}</span></div>
    <div class="snip">${hl(r.snippet, re)}</div></div>`;
}

function emptyText() {
  if (!state.lib || !state.lib.files.length) return t('list.emptyLib');
  if (state.q) return t('list.noResults', { q: state.q });
  if (state.lib.indexing) return t('list.stillIndexing');
  return t('list.empty');
}
function showEmpty(text) {
  const e = $('#listEmpty');
  e.hidden = !text;
  e.textContent = text || '';
}

function updateListHeader() {
  let title;
  if (state.q) {
    const sc = state.scope;
    title = sc === 'all' || state.node.type === 'all' ? t('list.resultsAll')
      : t('list.resultsIn', { name: sc === 'file' ? fileLabel(fileOfNode()) : state.nodeName });
  } else {
    title = state.nodeName;
  }
  if (state.view === 'threads') title = t('list.threadsPrefix', { title });
  if (state.view === 'attachments') title = t('list.attPrefix', { title });
  $('#listTitle').textContent = title;
  let count = '';
  if (vlist.total != null) {
    count = t(`list.count.${state.view}`, { n: vlist.total });
    if (vlist.capped) count = t('list.more', { count });
  }
  $('#listCount').textContent = count;
}

vlist.el.addEventListener('scroll', () => {
  if (vlist.raf) return;
  vlist.raf = requestAnimationFrame(() => { vlist.raf = 0; vlist.render(); });
});
new ResizeObserver(() => vlist.render()).observe(vlist.el);

vlist.rows.addEventListener('click', (e) => {
  const cb = e.target.closest('input[type=checkbox][data-key]');
  if (cb) {
    if (cb.checked) state.attSel.add(cb.dataset.key);
    else state.attSel.delete(cb.dataset.key);
    updateAttSel();
    return;
  }
  const rowEl = e.target.closest('.row[data-i]');
  if (!rowEl) return;
  const i = Number(rowEl.dataset.i);
  const th = e.target.closest('[data-thread]');
  if (th) {
    vlist.select(i, { open: false });
    openThread(th.dataset.thread, vlist.row(i).ref);
    return;
  }
  vlist.select(i);
  vlist.el.focus();
});

vlist.el.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    vlist.select(Math.max(0, Math.min(vlist.total - 1, vlist.sel + (e.key === 'ArrowDown' ? 1 : -1))));
  } else if (e.key === 'PageDown' || e.key === 'PageUp') {
    e.preventDefault();
    const n = Math.floor(vlist.el.clientHeight / ROW_H);
    vlist.select(Math.max(0, Math.min(vlist.total - 1, vlist.sel + (e.key === 'PageDown' ? n : -n))));
  } else if (e.key === 'Home') { e.preventDefault(); vlist.select(0); }
  else if (e.key === 'End') { e.preventDefault(); vlist.select(vlist.total - 1); }
  else if (e.key === 'Enter' && vlist.sel >= 0) {
    const r = vlist.row(vlist.sel);
    if (r && r.conv_key && state.view === 'mail') openThread(r.conv_key, r.ref);
  }
});

function openRow(r) {
  if (state.view === 'threads') openThread(r.conv_key, r.ref);
  else if (state.view === 'attachments') openMessage(r.ref, { focusAtt: r.idx });
  else openMessage(r.ref);
}

// ------------------------------------------------------------------ tree (files and folders)

const expanded = new Set(LS.get('expanded2', []));
const collapsed = new Set(LS.get('collapsed2', []));

async function loadTree() {
  try {
    state.tree = await api('/api/folders');
  } catch { return; }
  renderTree();
}

// standard Outlook folders named in the UI language (the PST may come in another one)
const FOLDERS = {
  es: {
    'Inbox': 'Bandeja de entrada', 'Sent Items': 'Elementos enviados', 'Deleted Items': 'Elementos eliminados', 'Drafts': 'Borradores',
    'Outbox': 'Bandeja de salida', 'Junk Email': 'Correo no deseado', 'Junk E-mail': 'Correo no deseado', 'Calendar': 'Calendario',
    'Contacts': 'Contactos', 'Tasks': 'Tareas', 'Notes': 'Notas', 'Journal': 'Diario', 'Archive': 'Archivo',
    'Top of Personal Folders': 'Carpetas personales', 'Top of Outlook data file': 'Archivo de datos de Outlook',
  },
  en: {
    'Bandeja de entrada': 'Inbox', 'Elementos enviados': 'Sent Items', 'Elementos eliminados': 'Deleted Items', 'Borradores': 'Drafts',
    'Bandeja de salida': 'Outbox', 'Correo no deseado': 'Junk Email', 'Calendario': 'Calendar', 'Contactos': 'Contacts',
    'Tareas': 'Tasks', 'Notas': 'Notes', 'Diario': 'Journal', 'Archivo': 'Archive', 'Carpetas personales': 'Personal Folders',
    'Top of Personal Folders': 'Personal Folders', 'Top of Outlook data file': 'Outlook data file',
    'Principio de Carpetas personales': 'Personal Folders', 'Principio del archivo de datos de Outlook': 'Outlook data file',
  },
};
const folderName = (n) => FOLDERS[LANG][n] || n;
const folderLabel = (f) => folderName(f.name);

function fileStateLabel(fid) {
  const f = state.lib && state.lib.files.find((x) => x.id === fid);
  if (!f) return '';
  if (!f.exists) return `<span class="tstate warn" title="${esc(t('tree.noAccessTitle'))}">${t('tree.noAccess')}</span>`;
  if (f.job) {
    const pct = f.job.phase === 'messages' ? (f.job.total ? (f.job.done / f.job.total) * 100 : 0) : (f.job.attTotal ? (f.job.attDone / f.job.attTotal) * 100 : 0);
    return `<span class="tstate busy">${f.job.phase === 'messages' ? '' : t('tree.att') + ' '}${pct.toFixed(0)}%</span>`;
  }
  if (!f.status.complete) return `<span class="tstate">${t('tree.queued')}</span>`;
  return '';
}

function renderTree() {
  const hideEmpty = $('#hideEmpty').checked;
  const { files, folders } = state.tree;
  const byParent = new Map();
  for (const f of folders) {
    if (!byParent.has(f.parent_id)) byParent.set(f.parent_id, []);
    byParent.get(f.parent_id).push(f);
  }
  const sub = new Map();
  const subtotal = (f) => {
    if (sub.has(f.id)) return sub.get(f.id);
    let n = f.total;
    for (const c of byParent.get(f.id) || []) n += subtotal(c);
    sub.set(f.id, n);
    return n;
  };
  const totalAll = files.reduce((s, f) => s + (f.indexed || 0), 0);
  const isSel = (t, id) => state.node.type === t && (id == null || state.node.id === id);
  let html = `<div class="tnode${isSel('all') ? ' sel' : ''}" data-node="all" style="padding-left:4px"><span class="tw">${I.all}</span><span class="tn"><b>${t('tree.all')}</b></span><span class="tc">${fmtNum(totalAll)}</span></div>`;
  const draw = (parentId, depth) => {
    for (const f of byParent.get(parentId) || []) {
      if (hideEmpty && subtotal(f) === 0) continue;
      const kids = (byParent.get(f.id) || []).filter((c) => !hideEmpty || subtotal(c) > 0);
      const isOpen = expanded.has(f.id) || (!collapsed.has(f.id) && f.depth <= 1);
      const count = f.total ? (f.indexed < f.total ? `${fmtNum(f.indexed)}/${fmtNum(f.total)}` : fmtNum(f.total)) : '';
      html += `<div class="tnode${isSel('folder', f.id) ? ' sel' : ''}${f.total ? '' : ' empty'}" data-node="folder" data-id="${f.id}" style="padding-left:${depth * 14 + 4}px" title="${esc(f.path)}">
        <span class="tw" data-tw="${f.id}">${kids.length ? (isOpen ? '▾' : '▸') : ''}</span>
        <span class="tn">${esc(folderLabel(f))}</span>
        <span class="tc">${f.unread ? `<b>${fmtNum(f.unread)}</b> · ` : ''}${count}</span></div>`;
      if (kids.length && isOpen) draw(f.id, depth + 1);
    }
  };
  for (const file of files) {
    const fkey = `file:${file.id}`;
    const isOpen = !collapsed.has(fkey) && (files.length <= 2 || expanded.has(fkey));
    const rootFolder = folders.find((x) => x.file === file.id && x.parent_id == null);
    html += `<div class="tnode tfile${isSel('file', file.id) ? ' sel' : ''}" data-node="file" data-id="${file.id}" style="padding-left:4px" title="${esc(file.name)}">
      <span class="tw" data-tw="${fkey}">${isOpen ? '▾' : '▸'}</span>
      <span class="tn">${I.db} ${esc(file.name.replace(/\.(pst|ost)$/i, ''))}</span>
      <span class="tc">${fileStateLabel(file.id)} ${fmtNum(file.indexed)}</span></div>`;
    if (isOpen && rootFolder) draw(rootFolder.id, 1);
  }
  $('#tree').innerHTML = html;
}

$('#tree').addEventListener('click', (e) => {
  const tw = e.target.closest('[data-tw]');
  if (tw && tw.textContent.trim()) {
    const key = tw.dataset.tw;
    const isOpen = tw.textContent.trim() === '▾';
    if (isOpen) { expanded.delete(key); collapsed.add(key); } else { collapsed.delete(key); expanded.add(key); }
    LS.set('expanded2', [...expanded]);
    LS.set('collapsed2', [...collapsed]);
    renderTree();
    return;
  }
  const n = e.target.closest('.tnode');
  if (!n) return;
  const type = n.dataset.node;
  if (type === 'all') {
    state.node = { type: 'all' };
    state.nodeName = t('tree.all');
  } else if (type === 'file') {
    state.node = { type: 'file', id: Number(n.dataset.id) };
    state.nodeName = fileLabel(state.node.id);
  } else {
    const f = state.tree.folders.find((x) => x.id === n.dataset.id);
    state.node = { type: 'folder', id: n.dataset.id };
    state.nodeName = f ? `${folderLabel(f)} (${fileLabel(f.file).replace(/\.(pst|ost)$/i, '')})` : '';
  }
  // when choosing a file or folder while searching, narrow the search to it
  if (state.q && state.scope === 'all' && type !== 'all') $('#scope').value = state.scope = type === 'file' ? 'file' : 'folder';
  renderTree();
  state.selected = null;
  vlist.load();
});
$('#hideEmpty').addEventListener('change', renderTree);

// ------------------------------------------------------------------ views / sorting

$$('.view').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
function setView(v) {
  state.view = v;
  $$('.view').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('#attBar').hidden = v !== 'attachments';
  renderSortOptions();
  state.selected = null;
  vlist.load();
}
function renderSortOptions() {
  const v = state.view;
  const sortSel = $('#sort');
  const keys = v === 'attachments' ? ['date', 'name', 'size', 'ext'] : ['date', 'relevance', 'sender', 'subject', 'size', 'att'];
  sortSel.innerHTML = keys.map((k) => `<option value="${k}">${esc(t('sort.' + k))}</option>`).join('');
  if (v === 'threads') for (const o of sortSel.options) o.hidden = !['date', 'relevance'].includes(o.value);
  if (![...sortSel.options].some((o) => o.value === state.sort && !o.hidden)) state.sort = 'date';
  sortSel.value = state.sort;
}
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; state.sortTouched = true; vlist.load(); });
$('#dir').addEventListener('click', () => {
  state.dir = state.dir === 'desc' ? 'asc' : 'desc';
  $('#dir').textContent = state.dir === 'desc' ? '↓' : '↑';
  vlist.load();
});

// ------------------------------------------------------------------ search

const qInput = $('#q');
let qTimer = 0;
qInput.addEventListener('input', () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => setQuery(qInput.value), 400);
});
qInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(qTimer); setQuery(qInput.value); }
  if (e.key === 'Escape') { qInput.value = ''; clearTimeout(qTimer); setQuery(''); }
  if (e.key === 'ArrowDown') { e.preventDefault(); vlist.el.focus(); if (vlist.sel < 0) vlist.select(0); }
});
$('#scope').addEventListener('change', (e) => { state.scope = e.target.value; if (state.q) vlist.load(); });

function setQuery(q) {
  q = q.trim();
  if (q === state.q) return;
  const had = !!state.q;
  state.q = q;
  if (!q) state.terms = [];
  // with a new search it is better to see the most relevant first
  if (q && !had && state.sort === 'date' && !state.sortTouched && state.view !== 'attachments') state.sort = 'relevance';
  if (!q && state.sort === 'relevance') { state.sort = 'date'; state.sortTouched = false; }
  $('#sort').value = state.sort;
  state.selected = null;
  renderChips();
  vlist.load();
}

function renderChips() {
  const f = state.filters;
  const chips = [];
  if (f.dateFrom) chips.push(['dateFrom', t('chip.dateFrom', { v: f.dateFrom })]);
  if (f.dateTo) chips.push(['dateTo', t('chip.dateTo', { v: f.dateTo })]);
  if (f.att) chips.push(['att', t('chip.att')]);
  if (f.unread) chips.push(['unread', t('chip.unread')]);
  if (f.mail) chips.push(['mail', t('chip.mail')]);
  if (f.attext) chips.push(['attext', t('chip.attext', { v: $(`#advForm [name=attext] option[value="${f.attext}"]`)?.textContent || f.attext })]);
  if (!f.inatt) chips.push(['inatt', t('chip.noInatt')]);
  if (f.dups) chips.push(['dups', t('chip.dups')]);
  if (f.only === 'unique') chips.push(['only', t('chip.unique')]);
  $('#chips').innerHTML = chips.map(([k, text]) => `<span class="chip">${esc(text)}<button data-k="${k}" title="${esc(t('chip.remove'))}">✕</button></span>`).join('');
  $('#btnAdv').classList.toggle('on', chips.length > 0);
}
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-k]');
  if (!b) return;
  const k = b.dataset.k;
  state.filters[k] = DEFAULT_FILTERS[k];
  syncAdvForm();
  renderChips();
  vlist.load();
});

$('#btnAdv').addEventListener('click', () => {
  const p = $('#advPanel');
  p.hidden = !p.hidden;
  if (!p.hidden) { syncAdvForm(); $('#advForm [name=from]').focus(); }
});
function syncAdvForm() {
  const fm = $('#advForm');
  const f = state.filters;
  fm.dateFrom.value = f.dateFrom; fm.dateTo.value = f.dateTo; fm.attext.value = f.attext;
  fm.att.checked = f.att; fm.unread.checked = f.unread; fm.mail.checked = f.mail; fm.inatt.checked = f.inatt; fm.dups.checked = f.dups;
}
const quoteIf = (v) => (/\s/.test(v) ? `"${v.replace(/"/g, '')}"` : v);
$('#advForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fm = e.target;
  const parts = [];
  // keep what is typed in the search box and append the fields
  if (qInput.value.trim()) parts.push(qInput.value.trim());
  const field = (name, prefix) => {
    const v = fm[name].value.trim();
    if (!v) return;
    for (const w of v.match(/"[^"]+"|\S+/g) || []) parts.push(`${prefix}${w.startsWith('"') ? w : quoteIf(w)}`);
    fm[name].value = '';
  };
  field('from', t('field.from')); field('to', t('field.to')); field('subject', t('field.subject')); field('body', t('field.body'));
  field('attname', t('field.attachment')); field('content', t('field.content')); field('without', '-');
  Object.assign(state.filters, {
    dateFrom: fm.dateFrom.value, dateTo: fm.dateTo.value, attext: fm.attext.value,
    att: fm.att.checked, unread: fm.unread.checked, mail: fm.mail.checked, inatt: fm.inatt.checked, dups: fm.dups.checked,
  });
  qInput.value = parts.join(' ');
  $('#advPanel').hidden = true;
  renderChips();
  if (qInput.value.trim() !== state.q) setQuery(qInput.value);
  else vlist.load();
});
$('#advClear').addEventListener('click', () => {
  $('#advForm').reset();
  state.filters = { ...DEFAULT_FILTERS };
  syncAdvForm();
  renderChips();
  qInput.value = '';
  setQuery('');
  vlist.load();
});
$('#btnHelp').addEventListener('click', () => $('#helpDlg').showModal());

// ------------------------------------------------------------------ attachments view

function renderExtChips(exts) {
  $('#extChips').innerHTML = exts.filter((x) => x.ext).map((x) =>
    `<button data-ext="${esc(x.ext)}" class="${state.attExt === x.ext ? 'on' : ''}">.${esc(x.ext)} <span class="muted">${fmtNum(x.n)}</span></button>`).join('');
}
$('#extChips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-ext]');
  if (!b) return;
  state.attExt = state.attExt === b.dataset.ext ? '' : b.dataset.ext;
  $$('#extChips button').forEach((x) => x.classList.toggle('on', x.dataset.ext === state.attExt));
  vlist.load();
});
let attNameTimer = 0;
$('#attName').addEventListener('input', (e) => {
  clearTimeout(attNameTimer);
  attNameTimer = setTimeout(() => { state.attName = e.target.value.trim(); vlist.load(); }, 300);
});
function updateAttSel() {
  const n = state.attSel.size;
  $('#attSelCount').textContent = n ? t('att.selCount', { n }) : t('att.selHint');
  $('#attSelZip').disabled = !n;
}
$('#attSelZip').addEventListener('click', () => {
  download(`/api/export/attachments.zip?pairs=${enc([...state.attSel].join(','))}&flat=1&name=${enc(t('att.selected'))}`);
});

// ------------------------------------------------------------------ reader

const reader = $('#reader');
let readerGen = 0;

function bodyUrl(ref) {
  return `/api/message/${enc(ref)}/body${state.images ? '?images=1' : ''}`;
}

// Isolated iframe with the email body; it fits its content and highlights matches
function makeFrame(ref, onMarks) {
  const fr = document.createElement('iframe');
  fr.className = 'body-frame';
  fr.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  fr.setAttribute('referrerpolicy', 'no-referrer');
  fr.title = t('reader.frameTitle');
  const fit = () => {
    try {
      const d = fr.contentDocument;
      if (!d || !d.documentElement) return;
      fr.style.height = Math.max(120, d.documentElement.scrollHeight + 4) + 'px';
    } catch { /* */ }
  };
  fr.addEventListener('load', () => {
    let marks = [];
    try {
      const d = fr.contentDocument;
      marks = highlightDoc(d, termRegex(state.terms));
      for (const img of d.images) img.addEventListener('load', fit);
      new ResizeObserver(fit).observe(d.body);
    } catch { /* */ }
    fit();
    setTimeout(fit, 300);
    if (onMarks) onMarks(marks);
  });
  fr.src = bodyUrl(ref);
  return fr;
}

function recipLine(label, list, limit = 6) {
  if (!list || !list.length) return '';
  const shown = list.slice(0, limit).map((a) => `<span title="${esc(a.email || '')}">${esc(a.name || a.email)}</span>`).join('; ');
  const more = list.length > limit ? ` <span class="more-rc" data-all="${esc(list.slice(0, 3000).map(fmtAddr).join('; '))}">${t('reader.andMore', { n: list.length - limit })}</span>` : '';
  return `<div class="ln"><b>${label}</b> ${shown}${more}</div>`;
}

function attChips(info) {
  const atts = info.attachments.filter((a) => !a.hidden);
  if (!atts.length) return '';
  const base = `/api/message/${enc(info.ref)}/att/`;
  const off = !!info.unavailable;
  return `<div class="atts">${atts.map((a) => {
    const canView = !off && (/^image\/(png|jpe?g|gif|bmp|webp)$/.test(a.mime) || a.mime === 'application/pdf' || a.mime === 'text/plain');
    return `<div class="attc" data-idx="${a.idx}" title="${esc(a.name)}">
      ${fileIco(a.ext)}
      <div class="ai" ${off ? '' : `data-dl="${base}${a.idx}"`}><div>${hl(a.name, termRegex(state.terms))}</div><div>${fmtSize(a.size)}${a.embedded ? ' · ' + t('reader.attachedEmail') : ''}${a.byReference ? ' · ' + t('reader.link') : ''}</div></div>
      <div class="ab">
        ${a.embedded && !off ? `<button data-openemb="${a.idx}" title="${t('reader.openAttached')}">${t('reader.open')}</button>` : ''}
        ${canView ? `<button data-view="${base}${a.idx}?inline=1" title="${t('reader.viewInBrowser')}">${I.eye}</button>` : ''}
        ${off ? '' : `<button data-dl="${base}${a.idx}" title="${t('reader.download')}">${I.down}</button>`}
      </div></div>`;
  }).join('')}</div>`;
}

const folderPretty = (p) => (p || '').replace(/^\//, '').split('/').map(folderName).join(' › ');

function msgHeaderHtml(info) {
  return `
    <div class="from-line">
      <div class="avatar" style="background:${colorFor(info.from.email || info.from.name)}">${esc(initials(info.from.name || info.from.email))}</div>
      <div class="hdr-lines">
        <div><span class="fn">${esc(info.from.name || t('row.noSender'))}</span> ${info.from.email && info.from.email !== info.from.name ? `<span class="fe">&lt;${esc(info.from.email)}&gt;</span>` : ''}
          ${info.onBehalf && info.onBehalf !== info.from.name ? `<span class="muted"> ${esc(t('reader.onBehalf', { name: info.onBehalf }))}</span>` : ''}</div>
        ${recipLine(t('reader.to'), info.to)}${recipLine(t('reader.cc'), info.cc)}${recipLine(t('reader.bcc'), info.bcc)}
        ${info.location ? `<div class="ln"><b>${t('reader.location')}</b> ${esc(info.location)}</div>` : ''}
        <div class="ln"><b>${t('reader.source')}</b> ${I.db} ${esc(info.file.name)}${info.folder ? ' › ' + esc(folderPretty(info.folder)) : ''}</div>
        ${info.alsoIn && info.alsoIn.length ? `<div class="ln" title="${t('reader.alsoInTitle')}">${I.copy} <b>${t('reader.alsoIn')}</b> ${info.alsoIn.map((x) => esc(x.name)).join(', ')}</div>` : ''}
      </div>
      <div class="hdr-date">${esc(fmtLong(info.date))}${info.importance === 2 ? `<br><span class="imp">${t('reader.highImportance')}</span>` : ''}<br>${fmtSize(info.size)}</div>
    </div>`;
}

function wireMessageEvents(root, info, ctx) {
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-dl],[data-view],[data-openemb],.more-rc');
    if (!t || !root.contains(t)) return;
    if (t.dataset.openemb != null) {
      openMessage(`${info.ref}.${t.dataset.openemb}`, { crumbs: [...(ctx.crumbs || []), { ref: info.ref, subject: info.subject }] });
    } else if (t.dataset.view) window.open(t.dataset.view, '_blank', 'noopener');
    else if (t.dataset.dl) download(t.dataset.dl);
    else if (t.classList.contains('more-rc')) { t.parentNode.innerHTML = `<b>${t.parentNode.querySelector('b').textContent}</b> ${esc(t.dataset.all)}`; }
  });
}

async function openMessage(ref, ctx = {}) {
  const gen = ++readerGen;
  let info;
  try {
    info = await api(`/api/message/${enc(ref)}`);
  } catch (e) {
    if (gen === readerGen) reader.innerHTML = `<div class="welcome"><p class="err">${esc(e.message)}</p></div>`;
    return;
  }
  if (gen !== readerGen) return;
  state.current = { type: 'msg', ref, info };
  const crumbs = ctx.crumbs || [];
  const off = !!info.unavailable;
  reader.innerHTML = `<div class="msg-view">
    <div class="msg-actions">
      ${crumbs.length ? `<button class="btn small" data-act="back">${t('reader.back')}</button>` : ''}
      ${info.convCount > 1 && !info.embedded ? `<button class="btn small" data-act="thread">${I.chat} ${t('reader.viewConv', { n: info.convCount })}</button>` : ''}
      ${off ? '' : `<button class="btn small" data-act="print" title="${t('reader.printTitle')}">${I.print} ${t('reader.print')}</button>
      <button class="btn small" data-act="eml" title="${t('reader.emlTitle')}">${I.down} .eml</button>
      ${info.attachments.some((a) => !a.hidden) ? `<button class="btn small" data-act="attzip">${I.clip} ${t('reader.attZip')}</button>` : ''}
      ${info.hasHeaders ? `<button class="btn small" data-act="headers">${t('reader.headers')}</button>` : ''}`}
      <span class="sp"></span>
      <span class="hitnav" hidden><span class="hitc"></span><button class="btn ghost icon small" data-act="prev" title="${t('reader.prev')}">▲</button><button class="btn ghost icon small" data-act="next" title="${t('reader.next')}">▼</button></span>
    </div>
    <div class="msg-head">
      ${crumbs.length ? `<div class="crumb">${t('reader.crumb')} ${crumbs.map((c, i) => `<a data-crumb="${i}">${esc(c.subject || t('row.noSubject'))}</a>`).join(' › ')}</div>` : ''}
      <h2>${hl(info.subject || t('row.noSubject'), termRegex(state.terms))}</h2>
      ${msgHeaderHtml(info)}
    </div>
    ${off ? `<div class="banner warn">${I.warn} ${esc(info.unavailable)}</div>` : ''}
    ${attChips(info)}
    ${info.remoteImages && !state.images ? `<div class="banner">${I.shield} ${t('reader.imagesBlocked')} <a data-act="images">${t('reader.showImages')}</a></div>` : ''}
  </div>`;
  const view = $('.msg-view', reader);
  let marks = [];
  let cur = -1;
  const hitnav = $('.hitnav', view);
  const go = (d) => {
    if (!marks.length) return;
    if (cur >= 0) marks[cur].style.background = '#fff3a3';
    cur = (cur + d + marks.length) % marks.length;
    marks[cur].style.background = '#ffb02e';
    marks[cur].scrollIntoView({ block: 'center' });
    $('.hitc', view).textContent = t('reader.hitOf', { i: cur + 1, n: marks.length });
  };
  view.appendChild(makeFrame(ref, (m) => {
    marks = m;
    if (marks.length) {
      hitnav.hidden = false;
      $('.hitc', view).textContent = t('reader.hits', { n: marks.length });
    }
  }));
  wireMessageEvents(view, info, { crumbs });
  view.querySelector('.msg-actions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'back') { const c = crumbs[crumbs.length - 1]; openMessage(c.ref, { crumbs: crumbs.slice(0, -1) }); }
    else if (a === 'thread') openThread(info.convKey, ref);
    else if (a === 'print') printRefs([ref]);
    else if (a === 'eml') download(`/api/message/${enc(ref)}/eml`);
    else if (a === 'attzip') download(`/api/message/${enc(ref)}/attachments.zip`);
    else if (a === 'headers') showHeaders(ref);
    else if (a === 'prev') go(-1);
    else if (a === 'next') go(1);
  });
  view.addEventListener('click', (e) => {
    const c = e.target.closest('[data-crumb]');
    if (c) { const i = Number(c.dataset.crumb); openMessage(crumbs[i].ref, { crumbs: crumbs.slice(0, i) }); }
    if (e.target.closest('.banner [data-act=images]')) { state.images = true; openMessage(ref, ctx); }
  });
  if (ctx.focusAtt != null) {
    const chip = view.querySelector(`.attc[data-idx="${ctx.focusAtt}"]`);
    if (chip) { chip.style.outline = '2px solid var(--accent)'; chip.scrollIntoView({ block: 'nearest' }); }
  }
  reader.scrollTop = 0;
}

async function showHeaders(ref) {
  $('#headersPre').textContent = t('reader.loading');
  $('#headersDlg').showModal();
  try { $('#headersPre').textContent = await api(`/api/message/${enc(ref)}/headers`); } catch (e) { $('#headersPre').textContent = e.message; }
}

// ------------------------------------------------------------------ conversation

async function openThread(key, focusRef) {
  if (!key) return;
  const gen = ++readerGen;
  let data;
  try {
    data = await api(`/api/thread?key=${enc(key)}${state.filters.dups ? '&dups=1' : ''}`);
  } catch (e) {
    reader.innerHTML = `<div class="welcome"><p class="err">${esc(e.message)}</p></div>`;
    return;
  }
  if (gen !== readerGen) return;
  state.current = { type: 'thread', key };
  const rows = data.rows;
  if (!rows.length) { reader.innerHTML = `<div class="welcome"><p>${t('thread.empty')}</p></div>`; return; }
  const dups = rows.filter((r) => r.duplicateOf).length;
  const participants = [...new Set(rows.map((r) => r.sender_name).filter(Boolean))];
  const filesIn = [...new Set(rows.map((r) => r.fileName))];
  const latest = rows[rows.length - 1] || {};
  const focus = rows.find((r) => r.ref === focusRef) || latest;
  const re = termRegex(state.terms);
  reader.innerHTML = `<div class="msg-view">
    <div class="msg-actions">
      <button class="btn small" data-act="print">${I.print} ${t('thread.print')}</button>
      <button class="btn small" data-act="attzip">${I.clip} ${t('thread.attZip')}</button>
      <button class="btn small" data-act="emlzip">${I.down} ${t('thread.emlZip')}</button>
      <button class="btn small" data-act="expand">${t('thread.expand')}</button>
      ${dups ? `<label class="ck small"><input type="checkbox" data-act="dup" ${state.hideDup ? 'checked' : ''}> ${t('thread.hideCopies', { n: dups })}</label>` : ''}
    </div>
    <div class="thread-head">
      <h2>${hl(latest.subject || t('row.noSubject'), re)}</h2>
      <div class="muted">${esc(t('thread.summary', { emails: t('thread.emails', { n: rows.length }), people: t('thread.people', { n: participants.length }), names: participants.slice(0, 8).join(', ') + (participants.length > 8 ? '…' : '') }))}
        ${filesIn.length > 1 ? `<br>${I.db} ${esc(t('thread.inFiles', { n: filesIn.length, names: filesIn.join(', ') }))}` : ''}</div>
    </div>
    <div class="cards">${rows.map((r) => `
      <div class="tcard${r.duplicateOf ? ' dup' : ''}" data-ref="${esc(r.ref)}" ${r.duplicateOf && state.hideDup ? 'hidden' : ''}>
        <div class="th">
          <div class="avatar" style="background:${colorFor(r.sender_email || r.sender_name)}">${esc(initials(r.sender_name))}</div>
          <div class="tw"><div>${hl(r.sender_name || r.sender_email, re)}${r.att_count ? ' ' + I.clip : ''}${r.duplicateOf ? ` <span class="badge">${t('thread.copy')}</span>` : ''}</div><div>${hl(r.snippet || '', re)}</div></div>
          <div class="td">${esc(fmtLong(r.date))}<br><span class="muted">${esc((r.folder || '').split('/').pop().replace(/.+/, folderName))}${filesIn.length > 1 ? ' · ' + esc(r.fileName.replace(/\.(pst|ost)$/i, '')) : ''}</span></div>
        </div>
        <div class="tb" hidden></div>
      </div>`).join('')}</div>
  </div>`;
  const view = $('.msg-view', reader);
  const expand = async (card, scroll) => {
    const tb = $('.tb', card);
    if (!tb.hidden && tb.dataset.loaded) { tb.hidden = true; return; }
    tb.hidden = false;
    card.classList.add('cur');
    if (!tb.dataset.loaded) {
      tb.dataset.loaded = '1';
      tb.innerHTML = `<div class="msg-head muted">${t('reader.loading')}</div>`;
      try {
        const info = await api(`/api/message/${enc(card.dataset.ref)}`);
        tb.innerHTML = `<div class="msg-actions" style="position:static">
            <button class="btn small" data-a="open">${t('thread.openAlone')}</button>
            ${info.unavailable ? '' : `<button class="btn small" data-a="print" title="${t('reader.print')}">${I.print}</button>
            <button class="btn small" data-a="eml">${I.down} .eml</button>
            ${info.attachments.some((a) => !a.hidden) ? `<button class="btn small" data-a="attzip">${I.clip} ZIP</button>` : ''}`}
          </div>
          <div class="msg-head">${msgHeaderHtml(info)}</div>${info.unavailable ? `<div class="banner warn">${I.warn} ${esc(info.unavailable)}</div>` : ''}${attChips(info)}`;
        tb.appendChild(makeFrame(info.ref));
        wireMessageEvents(tb, info, {});
        tb.querySelector('.msg-actions').addEventListener('click', (e) => {
          const b = e.target.closest('[data-a]');
          if (!b) return;
          if (b.dataset.a === 'open') openMessage(info.ref);
          else if (b.dataset.a === 'print') printRefs([info.ref]);
          else if (b.dataset.a === 'eml') download(`/api/message/${enc(info.ref)}/eml`);
          else if (b.dataset.a === 'attzip') download(`/api/message/${enc(info.ref)}/attachments.zip`);
        });
      } catch (e) {
        tb.innerHTML = `<p class="err" style="padding:10px">${esc(e.message)}</p>`;
      }
    }
    if (scroll) card.scrollIntoView({ block: 'start' });
  };
  view.addEventListener('click', (e) => {
    const th = e.target.closest('.th');
    if (th) return expand(th.parentNode);
    const b = e.target.closest('.msg-actions > [data-act], .msg-actions [data-act=dup]');
    if (!b) return;
    const a = b.dataset.act;
    const subj = latest.subject || t('thread.fileName');
    if (a === 'print') window.open(`/print?conv=${enc(key)}${state.images ? '&images=1' : ''}`, '_blank');
    else if (a === 'attzip') download(`/api/export/attachments.zip?conv=${enc(key)}&name=${enc(t('thread.zipAtt', { subject: subj }))}`);
    else if (a === 'emlzip') download(`/api/export/eml.zip?conv=${enc(key)}&sort=date&dir=asc&name=${enc(t('thread.zipEml', { subject: subj }))}`);
    else if (a === 'expand') $$('.tcard:not([hidden])', view).forEach((c) => { if ($('.tb', c).hidden) expand(c); });
    else if (a === 'dup') {
      state.hideDup = b.checked;
      $$('.tcard.dup', view).forEach((c) => (c.hidden = state.hideDup));
    }
  });
  const fc = view.querySelector(`.tcard[data-ref="${CSS.escape(focus.ref)}"]`);
  if (fc) { fc.hidden = false; expand(fc, rows.length > 3); }
}

// ------------------------------------------------------------------ downloads and printing

function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function printRefs(refs) {
  window.open(`/print?ref=${refs.map(enc).join(',')}&auto=1${state.images ? '&images=1' : ''}`, '_blank');
}

// ------------------------------------------------------------------ export menu

$('#btnMenu').addEventListener('click', (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; });
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) $('#menu').hidden = true; });
$('#menu').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  $('#menu').hidden = true;
  const act = b.dataset.act;
  if (act === 'library') return showLibrary();
  if (act === 'compare') return showCompare();
  if (act === 'pause') return togglePause();
  const p = filterParams({ forExport: true });
  // exports are based on emails, not on conversations or files
  let count = null;
  try {
    const c = await api(`/api/messages?${p}&limit=1`);
    count = c.capped ? (await api(`/api/count?${p}`)).total : c.total;
  } catch { /* */ }
  const label = state.q ? t('export.results') : state.nodeName;
  if (count === 0) return toast(t('export.none'), true);
  if (act === 'csv') return download(`/api/export/csv?${p}`);
  if (act === 'print') {
    const data = await api(`/api/messages?${p}&limit=200&count=0`);
    if (count > 200) toast(t('export.printFirst', { n: count }));
    return printRefs(data.rows.map((r) => r.ref));
  }
  if (count > 2000 && !confirm(t('export.confirm', { n: count }))) return;
  if (act === 'attzip') download(`/api/export/attachments.zip?${p}&name=${enc(t('export.attName', { label }))}`);
  if (act === 'attzipflat') download(`/api/export/attachments.zip?${p}&flat=1&name=${enc(t('export.attName', { label }))}`);
  if (act === 'emlzip') download(`/api/export/eml.zip?${p}&name=${enc(t('export.emlName', { label }))}`);
  toast(t('export.preparing'));
});

// ------------------------------------------------------------------ library

$('#btnLib').addEventListener('click', showLibrary);
$('#progress').addEventListener('click', showLibrary);
reader.addEventListener('click', (e) => { if (e.target.closest('[data-act=open]')) showLibrary(); });

function showLibrary() {
  $('#libMsg').hidden = true;
  if (!$('#libDlg').open) $('#libDlg').showModal();
  renderLibrary();
  refreshState();
}

function libMsg(text, isErr) {
  const m = $('#libMsg');
  m.innerHTML = text;
  m.className = 'lib-msg' + (isErr ? ' err' : '');
  m.hidden = !text;
}

function renderLibrary() {
  const s = state.lib;
  if (!s) return;
  if (!s.files.length) {
    $('#libList').innerHTML = `<div class="muted lib-empty">${esc(t('lib.empty'))}</div>`;
  } else {
    $('#libList').innerHTML = s.files.map((f) => {
      const st = f.status;
      let status;
      let pct = null;
      if (!f.enabled) status = `<span class="muted">${t('lib.disabled')}</span>`;
      else if (f.failed) status = `<span class="err">${I.warn} ${esc(f.failed)}</span> <button type="button" class="btn small" data-retry="${f.id}">${t('lib.retry')}</button>`;
      else if (f.job) {
        const j = f.job;
        if (j.phase === 'messages') {
          pct = j.total ? (j.done / j.total) * 100 : 0;
          status = j.stage === 'scanning' || j.stage === 'starting' ? t('lib.readingFolders')
            : j.stage === 'finalizing' || j.stage === 'optimizing' ? t('lib.finishing')
              : t('lib.indexingMails', { done: fmtNum(j.done), total: fmtNum(j.total), pct: pct.toFixed(0), eta: fmtEta(j.eta) });
        } else {
          pct = j.attTotal ? (j.attDone / j.attTotal) * 100 : 0;
          status = j.stage === 'optimizing' ? t('lib.finishing') : t('lib.indexingAtts', { done: fmtNum(j.attDone), total: fmtNum(j.attTotal), pct: pct.toFixed(0), eta: fmtEta(j.eta) });
        }
        if (j.careful || j.recovered) status += ` · <span title="${t('lib.recoveredTitle')}">${t('lib.recovered')}</span>`;
      } else if (!st.complete) status = st.indexed ? t('lib.queuedResume', { n: st.indexed }) : t('lib.queued');
      else if (!st.attComplete) status = `${I.mail} ${t('lib.attsQueued', { n: st.indexed })}`;
      else status = `<span class="ok">${t('lib.done', { n: st.indexed })}</span>${st.errors ? ` · ${t('lib.unreadable', { n: st.errors })}` : ''}`;
      if (!f.exists) status += ` · <span class="err" title="${esc(f.path)}">${t('lib.unavailable')}</span>`;
      if (f.overLimit) status += ` · <span class="err">${t('lib.overLimit', { max: s.maxActive })}</span>`;
      return `<div class="litem${f.enabled ? '' : ' off'}">
        <label class="ck" title="${t('lib.include')}"><input type="checkbox" data-enable="${f.id}" ${f.enabled ? 'checked' : ''}></label>
        <div class="li">
          <div class="ln1"><b>${esc(f.name)}</b> <span class="muted">${fmtSize(f.size)}</span></div>
          <div class="ln2 muted" title="${esc(f.path)}">${esc(f.path)}</div>
          <div class="ln3">${status}</div>
          ${pct != null ? `<div class="pbar"><div style="width:${pct.toFixed(1)}%"></div></div>` : ''}
        </div>
        <div class="la">
          <button type="button" class="btn small" data-reindex="${f.id}" title="${t('lib.reindexTitle')}">${t('lib.reindex')}</button>
          <button type="button" class="btn small" data-remove="${f.id}" title="${t('lib.removeTitle')}">${t('lib.remove')}</button>
        </div>
      </div>`;
    }).join('');
  }
  const active = s.files.filter((f) => f.active).length;
  $('#libSummary').textContent = t('lib.summary', { files: t('lib.files', { n: s.files.length }), active: t('lib.active', { n: active }), messages: fmtNum(s.totals.messages) })
    + (s.lastConsolidation && s.lastConsolidation.duplicates ? ` · ${t('lib.dupsHidden', { n: s.lastConsolidation.duplicates })}` : '')
    + (s.consolidating ? ` · ${t('lib.consolidating')}` : '');
  $('#btnPause').textContent = t(s.paused ? 'lib.resume' : 'lib.pause');
  $('#btnPause').hidden = !s.paused && !s.files.some((f) => f.enabled && f.exists && !f.failed && !f.status.attComplete);
  const mig = s.migration;
  $('#libNote').innerHTML = [
    t('lib.dataDir', { dir: desktop ? `<a data-act="datafolder" title="${t('lib.openFolder')}">${esc(s.dataDir)}</a>` : `<code>${esc(s.dataDir)}</code>` }),
    mig && mig.from && !mig.oldDeleted
      ? t('lib.migrated', { dir: `<code>${esc(mig.from)}</code>`, n: mig.messages }) + (desktop ? ` <a data-act="delold">${t('lib.deleteOld')}</a>` : '')
      : '',
  ].filter(Boolean).join(' ');
}

$('#libList').addEventListener('click', async (e) => {
  // not 't': that name is the translation function
  const el = e.target;
  try {
    if (el.dataset.enable) {
      await api('/api/library/enable', { id: Number(el.dataset.enable), enabled: el.checked });
      afterLibraryChange();
    } else if (el.dataset.remove) {
      const f = state.lib.files.find((x) => x.id === Number(el.dataset.remove));
      if (!confirm(t('lib.confirmRemove', { name: f.name }))) return;
      const del = confirm(t('lib.confirmDeleteIndex'));
      await api('/api/library/remove', { id: f.id, deleteIndex: del });
      afterLibraryChange();
    } else if (el.dataset.reindex) {
      const f = state.lib.files.find((x) => x.id === Number(el.dataset.reindex));
      if (!confirm(t('lib.confirmReindex', { name: f.name }))) return;
      await api('/api/library/reindex', { id: f.id });
      afterLibraryChange();
    } else if (el.dataset.retry) {
      await api('/api/library/retry', { id: Number(el.dataset.retry) });
      refreshState();
    }
  } catch (err) {
    libMsg(esc(err.message), true);
  }
});

async function addPaths(body, url = '/api/library/add') {
  libMsg(esc(t('lib.checking')));
  try {
    const r = await api(url, body);
    const parts = [];
    if (r.found != null) parts.push(esc(t('lib.found', { n: r.found })));
    if (r.added.length) parts.push(t('lib.added', { list: r.added.map((f) => esc(f.name) + (f.relocated ? ` (${t('lib.relocated')})` : '')).join(', ') }));
    if (r.skipped.length) parts.push(t('lib.notAdded', { list: r.skipped.map((s) => `${esc(s.path.split(/[\\/]/).pop())} (${esc(s.reason)})`).join(', ') }));
    libMsg(parts.join(' ') || esc(t('lib.noneFound')), !r.added.length && r.skipped.length > 0);
    if (r.added.length) afterLibraryChange();
  } catch (err) {
    libMsg(esc(err.message), true);
  }
}

// In the desktop app the native dialogs are used (window.pstx, see electron/preload.js);
// in the browser, the Windows dialog opened by the server.
const desktop = window.pstx && window.pstx.isDesktop ? window.pstx : null;
$('#btnPickFiles').addEventListener('click', async () => {
  try {
    const paths = desktop ? await desktop.pickFiles() : (await api('/api/library/pick', { mode: 'files' })).paths;
    if (paths && paths.length) addPaths({ paths });
  } catch (err) { libMsg(esc(err.message), true); }
});
$('#btnPickFolder').addEventListener('click', async () => {
  try {
    const dir = desktop ? await desktop.pickFolder() : (await api('/api/library/pick', { mode: 'folder' })).dir;
    if (dir) addPaths({ dir }, '/api/library/add-folder');
  } catch (err) { libMsg(esc(err.message), true); }
});
$('#libNote').addEventListener('click', async (e) => {
  if (!desktop) return;
  if (e.target.closest('[data-act=datafolder]')) desktop.openDataFolder();
  if (e.target.closest('[data-act=delold]')) {
    const r = await desktop.deleteOldLibrary();
    if (r && r.ok) libMsg(esc(t('lib.oldDeleted')));
    else if (r && r.error) libMsg(esc(r.error), true);
    refreshState();
  }
});
function addTyped() {
  const v = $('#pathInput').value.trim().replace(/^"|"$/g, '');
  if (!v) return;
  if (/\.(pst|ost)$/i.test(v)) addPaths({ paths: [v] });
  else addPaths({ dir: v }, '/api/library/add-folder');
  $('#pathInput').value = '';
}
$('#btnAddPath').addEventListener('click', addTyped);
$('#pathInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTyped(); } });
$('#btnPause').addEventListener('click', togglePause);
async function togglePause() {
  try {
    await api('/api/library/pause', { paused: !(state.lib && state.lib.paused) });
    refreshState();
  } catch (err) { toast(err.message, true); }
}

// folder browser
$('#browseBox').addEventListener('toggle', (e) => { if (e.target.open) browse(''); });
async function browse(dir) {
  try {
    const r = await api(`/api/browse?dir=${enc(dir)}`);
    $('#browsePath').innerHTML = r.dir ? `${esc(r.dir)} <button type="button" class="btn small" data-adddir="${esc(r.dir)}">${t('lib.addAllHere')}</button>` : esc(t('lib.locations'));
    $('#browseList').innerHTML = (r.parent !== null && r.dir ? `<div data-dir="${esc(r.parent)}">⬆ ..</div>` : '') +
      r.entries.map((x) => (x.dir ? `<div data-dir="${esc(x.path)}">${I.folder} ${esc(x.name)}</div>` : `<div data-file="${esc(x.path)}"><span>${I.mail} ${esc(x.name)}</span><span class="muted">${fmtSize(x.size)} · ${t('lib.addOne')}</span></div>`)).join('');
  } catch (e) {
    $('#browseList').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}
$('#browseList').addEventListener('click', (e) => {
  const d = e.target.closest('[data-dir]');
  if (d) return browse(d.dataset.dir);
  const f = e.target.closest('[data-file]');
  if (f) addPaths({ paths: [f.dataset.file] });
});
$('#browsePath').addEventListener('click', (e) => {
  const b = e.target.closest('[data-adddir]');
  if (b) addPaths({ dir: b.dataset.adddir }, '/api/library/add-folder');
});

function afterLibraryChange() {
  state.attSel.clear();
  updateAttSel();
  refreshState(true);
}

// ------------------------------------------------------------------ compare files

$('#btnCompare').addEventListener('click', () => { $('#libDlg').close(); showCompare(); });
$('#btnCmpRefresh').addEventListener('click', async () => {
  try { await api('/api/compare/refresh', {}); } catch (e) { return toast(e.message, true); }
  renderCompare();
});

let cmpTimer = 0;
function showCompare() {
  if (!$('#cmpDlg').open) $('#cmpDlg').showModal();
  renderCompare();
}
$('#cmpDlg').addEventListener('close', () => clearTimeout(cmpTimer));

const shortName = (n) => String(n || '').replace(/\.(pst|ost)$/i, '');
function fmtPeriod(a, b) {
  if (a == null || b == null) return '';
  const m = (ms) => new Date(ms).toLocaleDateString(LOC(), { month: 'short', year: 'numeric' });
  return m(a) === m(b) ? m(a) : `${m(a)} – ${m(b)}`;
}

async function renderCompare() {
  clearTimeout(cmpTimer);
  let data;
  try { data = await api('/api/compare'); } catch (e) {
    $('#cmpMsg').textContent = e.message;
    $('#cmpMsg').className = 'lib-msg err';
    $('#cmpMsg').hidden = false;
    return;
  }
  if (!$('#cmpDlg').open) return;
  const files = data.files;
  const byId = new Map(files.map((f) => [f.id, f]));
  const nameOf = (id) => esc(shortName((byId.get(id) || {}).name || `#${id}`));
  const msg = data.consolidating ? t('cmp.running') : data.indexing ? t('cmp.indexing') : data.stale ? t('cmp.stale') : '';
  $('#cmpMsg').textContent = msg;
  $('#cmpMsg').className = 'lib-msg';
  $('#cmpMsg').hidden = !msg;

  if (!files.length) {
    $('#cmpBody').innerHTML = `<div class="muted lib-empty">${t('cmp.emptyLib')}</div>`;
  } else {
    const rows = files.map((f) => {
      const s = f.stats;
      const v = f.verdict;
      let verdict;
      const discard = `<span class="tag warn">${t('cmp.discardable')}</span>`;
      if (v.kind === 'excluded') verdict = `<span class="muted">${esc(t('cmp.excluded', { reason: t('cmp.reason.' + v.reason) }))}</span>`;
      else if (v.kind === 'empty') verdict = `${discard} ${esc(t('cmp.emptyFile'))}`;
      else if (v.kind === 'pending' || !s) verdict = `<span class="muted">${t('cmp.calculating')}</span>`;
      else if (v.kind === 'keep') verdict = `<span class="tag ok">${t('cmp.keep')}</span> ${esc(t('cmp.keepText', { n: s.unique }))}`;
      else {
        verdict = `${discard} ${esc(t('cmp.allElsewhere'))}`;
        if (v.keepWith.length) verdict += ' ' + t('cmp.keepWith', { list: v.keepWith.map((k) => `<b>${nameOf(k.id)}</b> <span class="muted">(${esc(t('cmp.onlyThere', { n: k.n }))})</span>`).join(', ') });
        else if (s.total) verdict += ' ' + esc(t('cmp.twoCopies'));
        if (v.mutual && v.mutual.length) verdict += ` <span class="err">${I.warn} ${t('cmp.mutual', { names: v.mutual.map(nameOf).join(', ') })}</span>`;
      }
      if (s && !f.complete) verdict += ` <span class="muted">${t('cmp.provisional')}</span>`;
      const pct = s && s.total ? Math.round((s.unique / s.total) * 100) : 0;
      return `<tr class="${f.active ? '' : 'off'}">
        <td><b title="${esc(f.path)}">${esc(shortName(f.name))}</b><div class="muted">${fmtSize(f.size)}</div></td>
        <td class="nw">${s ? fmtPeriod(s.minDate, s.maxDate) : ''}</td>
        <td class="num">${s ? fmtNum(s.total) : ''}</td>
        <td class="num">${s ? `<b>${fmtNum(s.unique)}</b><div class="muted">${pct}%</div>` : ''}</td>
        <td class="num">${s ? fmtNum(s.shared) : ''}</td>
        <td class="num" title="${t('cmp.intraTitle')}">${s ? fmtNum(s.intraDup) : ''}</td>
        <td class="verdict">${verdict}</td>
        <td>${s && s.unique ? `<button type="button" class="btn small" data-uniq="${f.id}" title="${t('cmp.viewUniqueTitle')}">${t('cmp.viewUnique')}</button>` : ''}</td>
      </tr>`;
    }).join('');

    const cmp = files.filter((f) => f.stats && f.stats.total);
    let matrix = '';
    if (cmp.length > 1) {
      const head = cmp.map((b) => `<th title="${esc(b.name)}">${esc(shortName(b.name))}</th>`).join('');
      const body = cmp.map((a) => {
        const ov = new Map(a.overlap.map((o) => [o.id, o.shared]));
        const cells = cmp.map((b) => {
          if (a.id === b.id) return '<td class="muted diag">—</td>';
          const n = ov.get(b.id) || 0;
          const p = (n / a.stats.total) * 100;
          const txt = n === 0 ? '0%' : p < 1 ? '<1%' : `${Math.floor(p)}%`;
          return `<td class="num heat" style="background:color-mix(in srgb, var(--accent) ${Math.round(p * 0.35)}%, transparent)"
            title="${esc(t('cmp.cellTitle', { n, total: fmtNum(a.stats.total), a: shortName(a.name), b: shortName(b.name) }))}">${txt}</td>`;
        }).join('');
        return `<tr><th class="rowh" title="${esc(a.name)}">${esc(shortName(a.name))}</th>${cells}</tr>`;
      }).join('');
      matrix = `<h4>${t('cmp.matrix')}</h4>
        <div class="cmp-wrap"><table class="cmp-table cmp-matrix"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    }

    $('#cmpBody').innerHTML = `<div class="cmp-wrap"><table class="cmp-table">
      <thead><tr><th>${t('cmp.col.file')}</th><th>${t('cmp.col.period')}</th><th class="num">${t('cmp.col.items')}</th><th class="num">${t('cmp.col.unique')}</th>
        <th class="num">${t('cmp.col.shared')}</th><th class="num">${t('cmp.col.intra')}</th><th>${t('cmp.col.verdict')}</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>${matrix}`;
  }
  const done = files.filter((f) => f.stats);
  const total = done.reduce((n, f) => n + f.stats.total, 0);
  const uniq = done.reduce((n, f) => n + f.stats.unique, 0);
  $('#cmpSummary').textContent = done.length ? t('cmp.summary', { files: t('lib.files', { n: done.length }), items: t('cmp.items', { n: total }), unique: fmtNum(uniq) }) : '';
  if (data.consolidating || data.indexing) cmpTimer = setTimeout(renderCompare, data.consolidating ? 1500 : 5000);
}

$('#cmpBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-uniq]');
  if (!b) return;
  const fid = Number(b.dataset.uniq);
  $('#cmpDlg').close();
  // show in the list only the unique items of that file (they can be exported from there)
  state.node = { type: 'file', id: fid };
  state.nodeName = fileLabel(fid);
  state.filters.only = 'unique';
  qInput.value = '';
  state.q = '';
  state.terms = [];
  if (state.sort === 'relevance') { state.sort = 'date'; state.sortTouched = false; $('#sort').value = 'date'; }
  state.selected = null;
  renderChips();
  renderTree();
  vlist.load();
});

// ------------------------------------------------------------------ state and indexing

let pollTimer = 0;
let lastRefresh = 0;
let lastSig = '';

function headerProgress(s) {
  const box = $('#progress');
  box.hidden = !s.files.length;
  const job = s.files.find((f) => f.job);
  let text;
  let pct = null;
  if (job) {
    const j = job.job;
    const n = s.files.filter((f) => f.enabled).length;
    const pos = s.files.filter((f) => f.enabled).indexOf(job) + 1;
    if (j.phase === 'messages') {
      pct = j.total ? (j.done / j.total) * 100 : 0;
      text = t('prog.indexing', { name: job.name, pos, count: n, detail: j.stage === 'indexing' ? `${pct.toFixed(0)}% ${fmtEta(j.eta)}` : t('prog.preparing') });
    } else {
      pct = j.attTotal ? (j.attDone / j.attTotal) * 100 : 0;
      text = t('prog.attachments', { name: job.name, pos, count: n, pct: pct.toFixed(0), eta: fmtEta(j.eta) });
    }
  } else if (s.paused && s.files.some((f) => f.enabled && !f.status.attComplete)) text = t('prog.paused');
  else if (s.consolidating) text = t('prog.consolidating');
  else text = t('prog.ready', { files: t('lib.files', { n: s.files.filter((f) => f.active).length }), messages: fmtNum(s.totals.messages) });
  box.classList.toggle('done', pct == null);
  $('.ptext', box).textContent = text;
  $('.pbar div', box).style.width = (pct || 0) + '%';
  $('#menuPause').textContent = t(s.paused ? 'menu.resume' : 'menu.pause');
}

async function refreshState(force = false) {
  clearTimeout(pollTimer);
  let s;
  try { s = await api('/api/state'); } catch { pollTimer = setTimeout(refreshState, 3000); return; }
  state.lib = s;
  // the language stored on the server wins (e.g. if it was changed from the desktop app menu)
  if (s.lang && s.lang !== LANG && LOCALES[s.lang]) setLangLocal(s.lang);
  headerProgress(s);
  if (s.files.length && reader.querySelector('.welcome [data-act=open]')) {
    reader.innerHTML = `<div class="welcome"><p>${t('reader.select')}</p></div>`;
  }
  if ($('#libDlg').open) renderLibrary();
  // signature: which files are active and how much they have indexed
  const sig = s.files.map((f) => `${f.id}:${f.active}:${f.status.indexed}:${f.status.complete}:${f.job ? f.job.done : ''}`).join('|') + (s.consolidating ? 'c' : '');
  const busy = s.indexing || s.consolidating;
  const now = Date.now();
  if (force || (sig !== lastSig && (now - lastRefresh > 5000 || !busy))) {
    lastSig = sig;
    lastRefresh = now;
    await loadTree();
    if (force || !state.loadedOnce) { state.loadedOnce = true; vlist.load(); } else vlist.load({ keepScroll: true });
  }
  pollTimer = setTimeout(refreshState, busy || $('#libDlg').open ? 1500 : 8000);
  return s;
}

// ------------------------------------------------------------------ paneles redimensionables

(function splitters() {
  const root = document.documentElement;
  const saved = LS.get('widths', null);
  const ok = (w) => Number.isFinite(w) && w >= 160 && w <= 900;
  if (saved && ok(saved.side)) root.style.setProperty('--side-w', saved.side + 'px');
  if (saved && ok(saved.list)) root.style.setProperty('--list-w', saved.list + 'px');
  $$('.splitter').forEach((sp) => {
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sp.classList.add('drag');
      sp.setPointerCapture(e.pointerId);
      const which = sp.dataset.split;
      const startX = e.clientX;
      const startW = which === 'side' ? $('#sidebar').offsetWidth : $('.list-pane').offsetWidth;
      // iframes capture the mouse; disable them while dragging
      $$('iframe').forEach((f) => (f.style.pointerEvents = 'none'));
      let moved = false;
      const move = (ev) => {
        moved = true;
        const w = Math.max(160, Math.min(900, startW + ev.clientX - startX));
        root.style.setProperty(which === 'side' ? '--side-w' : '--list-w', w + 'px');
      };
      const up = () => {
        sp.classList.remove('drag');
        sp.removeEventListener('pointermove', move);
        $$('iframe').forEach((f) => (f.style.pointerEvents = ''));
        if (moved) LS.set('widths', { side: $('#sidebar').offsetWidth, list: $('.list-pane').offsetWidth });
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up, { once: true });
    });
  });
})();

// ------------------------------------------------------------------ atajos

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); qInput.focus(); qInput.select(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && state.current) {
    e.preventDefault();
    if (state.current.type === 'thread') window.open(`/print?conv=${enc(state.current.key)}&auto=1${state.images ? '&images=1' : ''}`, '_blank');
    else printRefs([state.current.ref]);
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !typing) { e.preventDefault(); qInput.focus(); }
});

// ------------------------------------------------------------------ inicio

function setLangLocal(lang) {
  LANG = lang;
  LS.set('lang', lang);
  applyI18n();
  if (state.node.type === 'all') state.nodeName = t('tree.all');
  renderSortOptions();
  renderChips();
  updateAttSel();
  updateListHeader();
}
// language change: saved on the server (also used by the desktop app, printing
// and exports) and the page reloads to redo all texts
$('#langSel').addEventListener('change', async (e) => {
  try {
    await api('/api/settings', { lang: e.target.value });
    LS.set('lang', e.target.value);
    location.reload();
  } catch (err) {
    toast(err.message, true);
    e.target.value = LANG;
  }
});

applyI18n();
state.nodeName = t('tree.all');
renderSortOptions();
renderChips();
updateAttSel();
refreshState(true).then((s) => {
  if (s && !s.files.length) showLibrary();
});
