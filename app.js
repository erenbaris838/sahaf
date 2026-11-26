/* Sahaf: EPUB reader. Library in IndexedDB, reader in a sandboxed iframe (no book scripts run). */
(function () {
  'use strict';
  const VERSION = '1.0.0';
  const LANGS = window.SAHAF_LANGS;
  const { openBook, splitFrag } = window.SahafBook;
  const OPS = 'http://www.idpf.org/2007/ops';
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const $ = s => document.querySelector(s);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('sahaf-' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('sahaf-' + k, JSON.stringify(v)); } catch (e) {} }
  };

  // ---------- language ----------
  function pickLang() {
    const saved = store.get('lang');
    if (saved && LANGS[saved]) return saved;
    for (const l of (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'])) {
      const c = (l || '').slice(0, 2).toLowerCase();
      if (LANGS[c]) return c;
    }
    return 'en';
  }
  let lang = pickLang();
  function t(k, v) {
    let s = LANGS[lang].s[k];
    if (s == null) s = LANGS.en.s[k];
    if (s == null) return k;
    if (v) s = s.replace(/\{(\w+)\}/g, (_, x) => (v[x] != null ? v[x] : ''));
    return s;
  }
  const fmtPct = x => new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 0 }).format(clamp(x, 0, 1));
  const fmtBytes = b => {
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return new Intl.NumberFormat(lang, { maximumFractionDigits: b < 10 && i ? 1 : 0 }).format(b) + ' ' + u[i];
  };
  function applyLang() {
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
    for (const el of document.querySelectorAll('[data-tp]')) el.placeholder = t(el.dataset.tp);
    for (const el of document.querySelectorAll('[data-tt]')) { el.title = t(el.dataset.tt); el.setAttribute('aria-label', t(el.dataset.tt)); }
    document.title = 'Sahaf — ' + t('tagline');
    renderLibrary();
    if (R.book) { updateInfo(); renderToc(); renderMarks(); }
  }
  const langSel = $('#langSel');
  for (const [code, L] of Object.entries(LANGS)) { const o = document.createElement('option'); o.value = code; o.textContent = L.name; langSel.appendChild(o); }
  langSel.value = lang;
  langSel.onchange = () => { lang = langSel.value; store.set('lang', lang); applyLang(); };
  $('#ver').textContent = VERSION;

  // ---------- toast ----------
  let toastT;
  function toast(msg, ms = 3200) {
    const el = $('#toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toastT); if (ms) toastT = setTimeout(() => { el.hidden = true; }, ms);
  }
  let rtoastT;
  function rtoast(msg, ms = 2600, action) {
    const el = $('#rToast'); el.textContent = '';
    if (action) {
      const b = document.createElement('button');
      b.textContent = msg; b.style.cssText = 'all:unset;cursor:pointer;font-weight:600';
      b.onclick = () => { el.hidden = true; action(); };
      el.appendChild(b);
    } else el.textContent = msg;
    el.hidden = false; clearTimeout(rtoastT); rtoastT = setTimeout(() => { el.hidden = true; }, ms);
  }
  function errText(e) {
    const c = e && e.code;
    if (c === 'drm') return t('eDrm');
    if (c === 'notZip' || c === 'notEpub') return t('eNotEpub');
    if (c === 'oldBrowser') return t('eOld');
    if (c === 'storage') return t('eStorage');
    return t('eBad');
  }

  // ---------- database ----------
  const DB = (() => {
    let p;
    const open = () => p || (p = new Promise((res, rej) => {
      const r = indexedDB.open('sahaf', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('books', { keyPath: 'id' }); d.createObjectStore('files'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => { p = null; rej(r.error); };
    }));
    const tx = async (st, mode, fn) => {
      const d = await open();
      return new Promise((res, rej) => {
        const x = d.transaction(st, mode);
        const req = fn(x.objectStore(st));
        x.oncomplete = () => res(req ? req.result : undefined);
        x.onerror = () => rej(x.error); x.onabort = () => rej(x.error || new Error('abort'));
      });
    };
    return {
      all: () => tx('books', 'readonly', s => s.getAll()),
      get: (st, k) => tx(st, 'readonly', s => s.get(k)),
      put: (st, v, k) => tx(st, 'readwrite', s => (k === undefined ? s.put(v) : s.put(v, k))),
      del: async k => { await tx('books', 'readwrite', s => s.delete(k)); await tx('files', 'readwrite', s => s.delete(k)); }
    };
  })();

  async function fileId(file) {
    const h = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function makeThumb(blob) {
    return new Promise(res => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      const done = v => { URL.revokeObjectURL(url); res(v); };
      img.onload = () => {
        try {
          const w = 360, h = Math.round(w * (img.naturalHeight || 540) / (img.naturalWidth || 360));
          const c = document.createElement('canvas'); c.width = w; c.height = clamp(h, 120, 720);
          const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          g.drawImage(img, 0, 0, c.width, c.height);
          c.toBlob(b => done(b), 'image/webp', 0.86);
        } catch (e) { done(null); }
      };
      img.onerror = () => done(null);
      img.src = url;
    });
  }

  // ---------- library ----------
  let books = [];
  const thumbUrls = new Map();
  const HUES = [[156, 47, 42], [44, 92, 120], [36, 110, 78], [120, 70, 30], [92, 60, 128], [20, 100, 110], [140, 90, 20], [60, 70, 90]];
  function genColor(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0; const c = HUES[h % HUES.length]; return `linear-gradient(160deg, rgb(${c}) 0%, rgb(${c.map(v => Math.round(v * 0.62))}) 100%)`; }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  async function renderLibrary() {
    try { books = await DB.all(); } catch (e) { books = []; }
    const has = books.length > 0;
    $('#empty').hidden = has; $('#lib').hidden = !has;
    $('#searchWrap').hidden = !has; $('#sortSel').hidden = books.length < 2;
    if (!has) return;
    const q = $('#libSearch').value.trim().toLocaleLowerCase(lang);
    const sort = $('#sortSel').value;
    const coll = new Intl.Collator(lang, { sensitivity: 'base', numeric: true });
    const list = books.filter(b => !q || (b.title + ' ' + b.author).toLocaleLowerCase(lang).includes(q));
    if (sort === 'title') list.sort((a, b) => coll.compare(a.title, b.title));
    else if (sort === 'author') list.sort((a, b) => coll.compare(a.author || '￿', b.author || '￿') || coll.compare(a.title, b.title));
    else list.sort((a, b) => Math.max(b.opened || 0, b.added) - Math.max(a.opened || 0, a.added));
    $('#libTitle').textContent = t('library');
    const grid = $('#grid'); grid.textContent = '';
    for (const b of list) {
      const card = el('div', 'card'); card.tabIndex = 0; card.setAttribute('role', 'button');
      card.setAttribute('aria-label', b.title + (b.author ? ' — ' + b.author : ''));
      const cv = el('div', 'cv');
      if (b.thumb) {
        let u = thumbUrls.get(b.id); if (!u) { u = URL.createObjectURL(b.thumb); thumbUrls.set(b.id, u); }
        const im = el('img'); im.src = u; im.alt = ''; im.loading = 'lazy'; cv.appendChild(im);
      } else {
        const g = el('div', 'gen'); g.style.background = genColor(b.title);
        g.appendChild(el('b', '', b.title)); g.appendChild(el('span', '', b.author || '')); cv.appendChild(g);
      }
      card.appendChild(cv);
      const del = el('button', 'del'); del.title = t('remove'); del.setAttribute('aria-label', t('remove'));
      del.innerHTML = '<svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
      del.onclick = e => { e.stopPropagation(); removeBook(b); };
      card.appendChild(del);
      card.appendChild(el('div', 't', b.title));
      card.appendChild(el('div', 'a', b.author || t('unknownAuthor')));
      const pg = el('div', 'pg');
      const pct = b.progress ? b.progress.pct : 0;
      if (!b.progress) pg.appendChild(el('span', 'new', t('newBook')));
      else if (pct >= 0.995) pg.appendChild(el('span', '', t('finished')));
      else { const bar = el('i'); bar.style.setProperty('--p', (pct * 100).toFixed(1) + '%'); pg.appendChild(bar); pg.appendChild(el('span', '', fmtPct(pct))); }
      card.appendChild(pg);
      card.onclick = () => openReader(b.id);
      card.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReader(b.id); } else if (e.key === 'Delete') removeBook(b); };
      grid.appendChild(card);
    }
    if (!list.length) grid.appendChild(el('div', 'hint', t('noMatch')));
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      $('#storeInfo').textContent = t('stored', { n: books.length, size: est && est.usage ? fmtBytes(est.usage) : '' }).replace(/\s*·\s*$/, '');
    } catch (e) {}
  }
  $('#libSearch').oninput = () => renderLibrary();
  $('#sortSel').value = store.get('sort', 'recent');
  $('#sortSel').onchange = () => { store.set('sort', $('#sortSel').value); renderLibrary(); };

  function confirmBox(title, text) {
    const d = $('#confirmDlg');
    $('#cTitle').textContent = title; $('#cText').textContent = text;
    return new Promise(res => {
      $('#cYes').onclick = () => { d.close(); res(true); };
      $('#cNo').onclick = () => { d.close(); res(false); };
      d.oncancel = () => res(false);
      d.showModal();
    });
  }
  async function removeBook(b) {
    if (!(await confirmBox(t('removeTitle'), t('removeText', { t: b.title })))) return;
    await DB.del(b.id);
    const u = thumbUrls.get(b.id); if (u) { URL.revokeObjectURL(u); thumbUrls.delete(b.id); }
    renderLibrary();
  }

  async function importOne(file) {
    const id = await fileId(file);
    let existing = null; try { existing = await DB.get('books', id); } catch (e) {}
    if (existing) return existing;
    const book = await openBook(file);
    let thumb = null;
    try { const cb = await book.coverBlob(); if (cb) thumb = await makeThumb(cb); } catch (e) {}
    const rec = {
      id, name: file.name, title: book.title || file.name.replace(/\.epub$/i, ''), author: book.author || '', lang: book.lang || '',
      size: file.size, added: Date.now(), opened: 0, thumb, progress: null, bookmarks: []
    };
    book.close();
    try {
      await DB.put('files', new Blob([file], { type: 'application/epub+zip' }), id);
      await DB.put('books', rec);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (e) {
      rec.temp = true; rec.file = file; // could not save (storage full or private mode): read it anyway
    }
    return rec;
  }

  let importing = false;
  async function addFiles(fileList, openIfOne) {
    const files = [...fileList].filter(f => /\.epub$/i.test(f.name) || f.type === 'application/epub+zip');
    if (!files.length) { toast(t('eNotEpub')); return; }
    if (importing) return;
    importing = true;
    let last = null, ok = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        if (files.length > 1) toast(t('adding', { i: i + 1, n: files.length }), 0);
        else toast(t('opening'), 0);
        try { last = await importOne(files[i]); ok++; }
        catch (e) { console.warn(e); toast(errText(e) + (files.length > 1 ? ' (' + files[i].name + ')' : ''), 6000); if (files.length === 1) return; }
      }
    } finally { importing = false; }
    $('#toast').hidden = true;
    await renderLibrary();
    if (ok > 1) toast(t('added', { n: ok }));
    if (openIfOne && files.length === 1 && last) openReader(last.id, last.temp ? last : null);
    else if (last && last.temp) toast(t('eStorage'), 6000);
  }

  const fileIn = $('#fileIn');
  const pick = () => fileIn.click();
  $('#btnAdd').onclick = pick; $('#btnOpen').onclick = pick;
  fileIn.onchange = () => { const f = [...fileIn.files]; fileIn.value = ''; addFiles(f, true); };

  // drag & drop anywhere
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#dropzone').hidden = false; });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropzone').hidden = true; });
  window.addEventListener('drop', async e => {
    if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $('#dropzone').hidden = true;
    const files = [...e.dataTransfer.files];
    if (R.book && files.length === 1) closeReader();
    addFiles(files, true);
  });

  // ---------- reader ----------
  const DEFS = { theme: 'auto', size: 100, font: 'pub', lh: 0, margin: 'm', layout: 'paged', spread: 'auto', justify: false };
  let S = Object.assign({}, DEFS, store.get('settings', {}));
  const SIZES = [70, 80, 90, 100, 110, 120, 135, 150, 170, 200];
  const TH = { light: ['#FBF9F4', '#221E1A', '#9C2F2A'], sepia: ['#F4ECD8', '#3B2F21', '#9C4A1E'], dark: ['#1C1B19', '#DCD6CC', '#E8826F'], black: ['#000000', '#C9C4BC', '#E8826F'] };
  const FONTS = {
    serif: 'Georgia, Charter, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", "Noto Serif", "Yu Mincho", "Hiragino Mincho ProN", "SimSun", "Songti SC", serif',
    sans: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, "Noto Sans", "Yu Gothic UI", "Hiragino Sans", "Microsoft YaHei", "PingFang SC", sans-serif'
  };
  const darkMq = matchMedia('(prefers-color-scheme: dark)');
  const effTheme = () => (S.theme === 'auto' ? (darkMq.matches ? 'dark' : 'light') : S.theme);

  const R = { rec: null, book: null, index: 0, page: 0, pages: 1, url: null, doc: null, win: null, geom: null, busy: false, token: 0, rtl: false, vertical: false, ret: null, stoken: 0, texts: new Map() };
  const frame = $('#frame'), stage = $('#stage'), reader = $('#reader');

  function geometry() {
    const W = stage.clientWidth, H = stage.clientHeight;
    const small = W < 600;
    const M = { s: small ? 14 : 28, m: small ? 22 : 56, l: small ? 34 : 100 }[S.margin] || 56;
    const TM = { s: small ? 16 : 22, m: small ? 22 : 34, l: small ? 30 : 48 }[S.margin] || 34;
    if (R.book && R.book.fixed) return { mode: 'fixed', W, H };
    if (S.layout === 'scroll') {
      return { mode: 'scroll', W, H, m: M, tm: TM, maxw: Math.round(700 * S.size / 100) };
    }
    if (R.vertical) {
      return { mode: 'vertical', W, H, w: W, h: H, m: M, tm: TM, cw: H - 2 * TM, stride: H };
    }
    let n = S.spread === 'auto' ? (W >= 980 && W > H * 1.15 ? 2 : 1) : +S.spread;
    if (W < 520 || R.picture) n = 1;
    if (R.picture) return { mode: 'paged', W, H, n: 1, w: W, h: H, m: M, tm: TM, cw: W - 2 * M, stride: W, picture: true };
    const pc = Math.floor(W / n);
    let m = M;
    const maxCol = Math.round(720 * Math.max(1, S.size / 100));
    let cw = pc - 2 * m;
    if (cw > maxCol) { m = Math.floor((pc - maxCol) / 2); cw = pc - 2 * m; }
    return { mode: 'paged', W, H, n, w: pc * n, h: H, m, tm: TM, cw, stride: pc * n };
  }

  function buildCss(g) {
    const th = effTheme(); const [bg, fg, ac] = TH[th];
    let c = '';
    if (g && g.mode === 'fixed') return 'html,body{overflow:hidden !important;margin:0 !important}';
    c += `html{background:${bg} !important;color:${fg} !important;font-size:${S.size}% !important;-webkit-text-size-adjust:none;text-size-adjust:none}`;
    c += 'body{background:transparent !important;margin:0 !important;padding:0 !important;max-width:none !important;min-height:0 !important;width:auto !important;height:auto !important;font-size:1rem}';
    if (th !== 'light') c += `body,body *{color:${fg} !important;background-color:transparent !important;border-color:color-mix(in srgb, ${fg} 30%, transparent) !important}`;
    c += `a,a *{color:${ac} !important}`;
    if (S.font !== 'pub') c += `body,body *{font-family:${FONTS[S.font]} !important}body :is(code,pre,kbd,samp,tt),body :is(code,pre,kbd,samp,tt) *{font-family:Consolas,"Cascadia Mono",Menlo,monospace !important}`;
    if (S.lh) c += `body,body :is(p,li,div,blockquote,dd,dt,td,th,span,a,em,i,b,strong,small,cite,q){line-height:${S.lh} !important}`;
    if (S.justify) c += 'body p{text-align:justify !important;hyphens:auto;-webkit-hyphens:auto;hyphenate-character:"-";-webkit-hyphenate-character:"-"}';
    c += 'img,video{max-width:100% !important;height:auto;box-sizing:border-box}svg{max-width:100% !important}pre{white-space:pre-wrap !important;overflow-wrap:anywhere}table{max-width:100%}';
    c += `::selection{background:color-mix(in srgb, ${ac} 32%, transparent)}mark.sahaf-hit{background:color-mix(in srgb, ${ac} 38%, transparent) !important;color:inherit !important;border-radius:2px}`;
    if (!g) return c;
    if (g.mode === 'paged') {
      c += `html{margin:0 !important;padding:${g.tm}px ${g.m}px !important;height:${g.h}px !important;width:${g.w}px !important;max-width:none !important;max-height:none !important;min-height:0 !important;box-sizing:border-box !important;column-width:${g.cw}px !important;column-gap:${2 * g.m}px !important;column-fill:auto !important;column-count:auto !important;overflow:hidden !important}`;
      c += `img,svg,video{max-height:${g.h - 2 * g.tm}px !important;object-fit:contain;break-inside:avoid}`;
      if (g.picture) {
        const ph = g.h - 2 * g.tm;
        c += `body{display:flex !important;flex-direction:column !important;align-items:center !important;justify-content:center !important;height:${ph}px !important;text-align:center !important}body *{max-width:100% !important;margin-left:auto !important;margin-right:auto !important}`;
        c += `img{width:auto !important;height:auto !important;max-height:${ph}px !important}svg[viewBox]{width:auto !important;height:${ph}px !important}`;
      }
    } else if (g.mode === 'vertical') {
      c += `html{writing-mode:${R.vertical} !important;margin:0 !important;padding:${g.tm}px ${g.m}px !important;height:${g.h}px !important;width:${g.w}px !important;max-width:none !important;max-height:none !important;box-sizing:border-box !important;column-width:${g.cw}px !important;column-gap:${2 * g.tm}px !important;column-fill:auto !important;overflow:hidden !important}`;
      c += `img,svg,video{max-width:${g.w - 2 * g.m}px !important;max-height:${g.h - 2 * g.tm}px !important;object-fit:contain;break-inside:avoid}`;
    } else if (g.mode === 'scroll') {
      c += `html{margin:0 !important;padding:${g.tm}px ${g.m}px ${g.tm * 3}px !important;overflow-x:hidden !important;overflow-y:auto !important;height:auto !important;width:auto !important}body{max-width:${g.maxw}px !important;margin:0 auto !important}`;
      c += `img,svg,video{max-height:${Math.round(g.h * 0.92)}px !important;object-fit:contain}`;
    }
    return c;
  }

  function applyTheme() { reader.dataset.th = effTheme(); }

  const absPage = rect => {
    const g = R.geom;
    if (g.mode === 'vertical') return Math.max(0, Math.floor((rect.top + 1 + R.win.scrollY) / g.stride));
    if (R.rtl) return Math.max(0, Math.ceil(-(rect.right - 1 + R.win.scrollX) / g.stride - 1e-6));
    return Math.max(0, Math.floor((rect.left + 1 + R.win.scrollX) / g.stride));
  };

  function measure() {
    const d = R.doc, g = R.geom;
    const oldPad = d.getElementById('sahaf-pad'); if (oldPad) oldPad.remove();
    if (g.mode === 'fixed') { R.pages = 1; return; }
    if (g.mode === 'scroll') { R.pages = 1; return; }
    const root = d.body || d.documentElement;
    let last = -1;
    const rects = root.getClientRects();
    for (const r of rects) if (r.width || r.height) last = Math.max(last, absPage(r));
    // also check the last real piece of content (fragments of the body may not be reported)
    try {
      const rg = d.createRange(); rg.selectNodeContents(root); rg.collapse(false);
      let node = root.lastChild;
      while (node && (node.nodeType === 3 ? !node.data.trim() : node.nodeType !== 1 || (node.getClientRects && !node.getClientRects().length))) node = node.previousSibling;
      if (node) { const rs = node.nodeType === 1 ? node.getClientRects() : []; for (const r of rs) last = Math.max(last, absPage(r)); }
    } catch (e) {}
    const se = d.scrollingElement || d.documentElement;
    const byScroll = g.mode === 'vertical' ? Math.round(se.scrollHeight / g.stride) : Math.round(se.scrollWidth / g.stride);
    R.pages = Math.max(1, last + 1, last < 0 ? byScroll : 0);
    // make the last page fully scrollable: an absolutely placed marker stretches the scroll area to whole pages
    const pad = d.createElementNS(XHTML, 'div'); pad.id = 'sahaf-pad';
    const far = R.pages * g.stride - 1;
    pad.setAttribute('style', 'position:absolute !important;width:1px !important;height:1px !important;margin:0 !important;padding:0 !important;border:0 !important;visibility:hidden !important;' +
      (g.mode === 'vertical' ? `top:${far}px !important;left:0 !important;` : R.rtl ? `right:${far}px !important;top:0 !important;` : `left:${far}px !important;top:0 !important;`));
    d.documentElement.appendChild(pad);
  }

  function setFrameBox() {
    const g = R.geom;
    frame.style.position = ''; frame.style.transform = ''; frame.style.left = ''; frame.style.top = '';
    if (g.mode === 'paged') { frame.style.width = g.w + 'px'; frame.style.height = g.h + 'px'; }
    else if (g.mode === 'vertical' || g.mode === 'scroll') { frame.style.width = g.W + 'px'; frame.style.height = g.H + 'px'; }
    else if (g.mode === 'fixed') {
      let vw = 0, vh = 0;
      const d = R.doc;
      const vp = d && d.querySelector('meta[name="viewport"]');
      if (vp) { const c = vp.getAttribute('content') || ''; vw = +(c.match(/width\s*=\s*(\d+)/) || [])[1] || 0; vh = +(c.match(/height\s*=\s*(\d+)/) || [])[1] || 0; }
      if ((!vw || !vh) && d) {
        const svg = d.documentElement.localName === 'svg' ? d.documentElement : d.querySelector('body > svg');
        const vb = svg && svg.viewBox && svg.viewBox.baseVal;
        if (vb && vb.width) { vw = vb.width; vh = vb.height; }
        else { const im = d.querySelector('img'); if (im && im.naturalWidth) { vw = im.naturalWidth; vh = im.naturalHeight; } }
      }
      if (!vw || !vh) { vw = 1200; vh = 1600; }
      const s = Math.min(g.W / vw, g.H / vh);
      Object.assign(frame.style, { position: 'absolute', width: vw + 'px', height: vh + 'px', transformOrigin: '0 0', transform: `scale(${s})`, left: Math.round((g.W - vw * s) / 2) + 'px', top: Math.round((g.H - vh * s) / 2) + 'px' });
    }
  }

  function currentFrac() {
    const g = R.geom; if (!g || !R.win) return 0;
    if (g.mode === 'scroll') {
      const se = R.doc.scrollingElement || R.doc.documentElement;
      const max = se.scrollHeight - R.win.innerHeight;
      return max > 4 ? clamp(R.win.scrollY / max, 0, 1) : 0;
    }
    return R.pages > 1 ? R.page / R.pages : 0;
  }
  const readFrac = () => {
    const g = R.geom; if (!g) return 0;
    if (g.mode === 'scroll') {
      const se = R.doc.scrollingElement || R.doc.documentElement;
      const max = se.scrollHeight - R.win.innerHeight;
      return max > 4 ? clamp(R.win.scrollY / max, 0, 1) : 1;
    }
    return (R.page + 1) / R.pages;
  };
  const bookPct = f => { const s = R.book.spine[R.index]; return s.start + f * (s.end - s.start); };

  function layout(keep) {
    if (!R.doc || !R.doc.documentElement) return;
    const frac = keep ? currentFrac() : null;
    R.geom = geometry();
    setFrameBox();
    const st = R.doc.getElementById('sahaf-style');
    if (st) st.textContent = buildCss(R.geom);
    detectDir();
    measure();
    if (frac != null) restoreFrac(frac);
    updateInfo();
  }
  function detectDir() {
    try {
      const cs = R.win.getComputedStyle(R.doc.body || R.doc.documentElement);
      R.rtl = cs.direction === 'rtl' && R.geom.mode === 'paged';
    } catch (e) { R.rtl = false; }
  }
  function restoreFrac(frac) {
    if (R.geom.mode === 'scroll') {
      const se = R.doc.scrollingElement || R.doc.documentElement;
      R.win.scrollTo(0, Math.round(frac * Math.max(0, se.scrollHeight - R.win.innerHeight)));
    } else goPage(Math.floor(frac * R.pages + 1e-4), true);
  }

  function goPage(p, quiet) {
    const g = R.geom; if (!g) return;
    R.page = clamp(p, 0, R.pages - 1);
    if (g.mode === 'paged') { const x = R.page * g.stride; R.win.scrollTo(R.rtl ? -x : x, 0); }
    else if (g.mode === 'vertical') { R.win.scrollTo(0, R.page * g.stride); }
    if (!quiet) { updateInfo(); saveSoon(); }
  }

  async function settle(doc) {
    const imgs = [...doc.images].filter(im => !im.complete);
    if (imgs.length) await Promise.race([Promise.all(imgs.map(im => new Promise(r => { im.addEventListener('load', r, { once: true }); im.addEventListener('error', r, { once: true }); }))), sleep(2500)]);
    try { if (doc.fonts) await Promise.race([doc.fonts.ready, sleep(1200)]); } catch (e) {}
  }

  // navigate the book frame without adding browser history entries
  function frameNav(url) { try { frame.contentWindow.location.replace(url); } catch (e) { frame.src = url; } }
  function loading(on) { $('#rLoading').hidden = !on; }

  async function loadChapter(i, pos) {
    pos = pos || {};
    const token = ++R.token;
    R.busy = true; loading(true); $('#rErr').hidden = true;
    try {
      // detect vertical writing early is not possible before render; geometry is refined after load
      R.vertical = false; R.picture = false;
      const g0 = geometry();
      R.geom = g0;
      const url = await R.book.chapter(i, buildCss(g0));
      if (token !== R.token) { URL.revokeObjectURL(url); return; }
      frame.style.visibility = 'hidden';
      setFrameBox();
      await new Promise(res => { frame.onload = () => res(); frameNav(url); });
      if (token !== R.token) return;
      if (R.url) URL.revokeObjectURL(R.url);
      R.url = url; R.index = i; R.page = 0;
      R.doc = frame.contentDocument; R.win = frame.contentWindow;
      hook(R.doc);
      await settle(R.doc);
      if (token !== R.token) return;
      // vertical writing (e.g. Japanese tategaki) paginates downwards
      if (S.layout !== 'scroll' && !R.book.fixed) {
        try {
          const wm = R.win.getComputedStyle(R.doc.body || R.doc.documentElement).writingMode;
          if (/^vertical|^sideways/.test(wm)) R.vertical = wm;
        } catch (e) {}
      }
      // a page that is only a picture (a cover, a map) is shown as one centred page
      if (!R.vertical && !R.book.fixed && S.layout !== 'scroll') {
        try {
          const body = R.doc.body || R.doc.documentElement;
          const pics = body.querySelectorAll('img, svg, image').length;
          if (pics && pics <= 2 && (body.textContent || '').replace(/\s+/g, '').length < 30) {
            R.picture = true;
            for (const sv of R.doc.querySelectorAll('svg[preserveAspectRatio="none"]')) sv.setAttribute('preserveAspectRatio', 'xMidYMid meet');
          }
        } catch (e) {}
      }
      layout(false);
      position(pos);
      frame.style.visibility = '';
      if (R.doc.fonts) R.doc.fonts.addEventListener('loadingdone', () => { if (token === R.token) layout(true); });
    } catch (e) {
      console.error(e);
      $('#rErr').textContent = errText(e); $('#rErr').hidden = false;
    } finally {
      if (token === R.token) { R.busy = false; loading(false); updateInfo(); saveSoon(); }
    }
  }

  function findTarget(doc, frag) {
    if (!frag) return null;
    let id = frag; try { id = decodeURIComponent(frag); } catch (e) {}
    return doc.getElementById(id) || doc.querySelector(`[name="${CSS.escape(id)}"]`);
  }

  function position(pos) {
    const g = R.geom;
    if (pos.hit) {
      const mk = highlight(pos.hit.q, pos.hit.n);
      if (mk) { revealEl(mk); return; }
    }
    if (pos.frag) {
      const tEl = findTarget(R.doc, pos.frag);
      if (tEl) { revealEl(tEl); return; }
    }
    if (pos.end) {
      if (g.mode === 'scroll') { const se = R.doc.scrollingElement || R.doc.documentElement; R.win.scrollTo(0, se.scrollHeight); }
      else goPage(R.pages - 1, true);
      return;
    }
    if (pos.frac != null) { restoreFrac(pos.frac); return; }
    goPage(0, true);
    if (g.mode === 'scroll') R.win.scrollTo(0, 0);
  }
  function revealEl(elm) {
    const g = R.geom;
    if (g.mode === 'scroll') { elm.scrollIntoView({ block: 'center' }); return; }
    if (g.mode === 'fixed') return;
    const rs = elm.getClientRects(); const r = rs.length ? rs[0] : elm.getBoundingClientRect();
    goPage(absPage(r), true);
  }

  // events inside the book page
  function hook(doc) {
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('wheel', onWheel, { passive: false });
    doc.addEventListener('click', e => {
      const tg = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
      const a = tg && tg.closest && tg.closest('a[data-href]');
      if (a) { e.preventDefault(); followLink(a); return; }
      closeOverlays();
      const g = R.geom; if (!g || g.mode === 'scroll') return;
      const sel = doc.getSelection && doc.getSelection();
      if (sel && !sel.isCollapsed) return;
      const w = R.win.innerWidth, x = e.clientX - (g.mode === 'paged' ? 0 : 0);
      const back = R.book.rtl || R.rtl;
      if (x < w * 0.25) back ? next() : prev();
      else if (x > w * 0.75) back ? prev() : next();
    });
    let sx = 0, sy = 0, st = 0;
    doc.addEventListener('touchstart', e => { const p = e.touches[0]; sx = p.clientX; sy = p.clientY; st = Date.now(); }, { passive: true });
    doc.addEventListener('touchend', e => {
      const g = R.geom; if (!g || g.mode === 'scroll') return;
      const p = e.changedTouches[0]; const dx = p.clientX - sx, dy = p.clientY - sy;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3 && Date.now() - st < 900) {
        const back = R.book.rtl || R.rtl;
        if ((dx < 0) !== back) next(); else prev();
      }
    }, { passive: true });
    doc.addEventListener('scroll', () => { if (R.geom && R.geom.mode === 'scroll') { updateInfo(); saveSoon(); } }, { passive: true });
  }

  let wheelT = 0;
  function onWheel(e) {
    const g = R.geom; if (!g || g.mode === 'scroll') return;
    e.preventDefault();
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(d) < 3) return;
    const now = Date.now(); if (now - wheelT < 380) { wheelT = now; return; }
    wheelT = now;
    d > 0 ? next() : prev();
  }
  stage.addEventListener('wheel', onWheel, { passive: false });

  async function next() {
    if (R.busy || !R.doc) return;
    const g = R.geom;
    if (g.mode === 'paged' || g.mode === 'vertical') { if (R.page < R.pages - 1) return goPage(R.page + 1); }
    else if (g.mode === 'scroll') {
      const se = R.doc.scrollingElement || R.doc.documentElement;
      if (R.win.scrollY < se.scrollHeight - R.win.innerHeight - 4) { R.win.scrollBy({ top: Math.round(R.win.innerHeight * 0.88), behavior: 'smooth' }); return; }
    }
    if (R.index < R.book.spine.length - 1) return loadChapter(R.index + 1, {});
    rtoast(t('theEnd'));
  }
  async function prev() {
    if (R.busy || !R.doc) return;
    const g = R.geom;
    if (g.mode === 'paged' || g.mode === 'vertical') { if (R.page > 0) return goPage(R.page - 1); }
    else if (g.mode === 'scroll') {
      if (R.win.scrollY > 4) { R.win.scrollBy({ top: -Math.round(R.win.innerHeight * 0.88), behavior: 'smooth' }); return; }
    }
    if (R.index > 0) return loadChapter(R.index - 1, { end: true });
  }
  function go(i, frag) {
    if (i < 0) return;
    if (i === R.index && R.doc) { const tEl = findTarget(R.doc, frag); if (tEl) { revealEl(tEl); updateInfo(); saveSoon(); return; } if (!frag) { goPage(0); return; } }
    loadChapter(i, { frag });
  }

  const typeOf = e => ((e.getAttributeNS && e.getAttributeNS(OPS, 'type')) || e.getAttribute('epub:type') || '') + ' ' + (e.getAttribute('role') || '');
  async function followLink(a) {
    const href = a.getAttribute('data-href') || '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
      if (/^(https?|mailto):/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    const [path, frag] = splitFrag(href);
    const idx = path ? R.book.spineOf(path) : R.index;
    if (idx < 0) return;
    const isRef = /noteref/.test(typeOf(a));
    if (frag) {
      let target = null;
      try {
        if (idx === R.index) target = findTarget(R.doc, frag);
        else { const { doc } = await R.book.parse(idx); target = findTarget(doc, frag); }
      } catch (e) {}
      if (target) {
        const isNote = /footnote|endnote|rearnote|(^|\s)note|doc-footnote|doc-endnote/.test(typeOf(target)) || target.localName === 'aside' ||
          (target.closest && target.closest('aside,[*|type~="footnote"],[*|type~="endnote"],[*|type~="rearnote"]'));
        if (isRef || isNote) {
          let box = target;
          if (/^(a|span|sup)$/.test(box.localName)) box = box.closest('p,li,div,aside,section,dd') || box;
          const txt = (box.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt && txt.length < 3000) { showNote(txt); return; }
        }
      }
    }
    R.ret = { i: R.index, frac: currentFrac() };
    go(idx, frag);
    setTimeout(() => rtoast('↩ ' + t('goBack'), 8000, () => { const r = R.ret; R.ret = null; if (r) loadChapter(r.i, { frac: r.frac }); }), 350);
  }
  function showNote(text) {
    $('#noteBody').textContent = text;
    $('#note').hidden = false;
  }
  $('#noteClose').onclick = () => { $('#note').hidden = true; };

  // ---------- highlight search hits ----------
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const makeRe = q => new RegExp(escRe(q.trim()).replace(/\s+/g, '\\s+'), 'giu');
  function textNodes(doc) {
    const root = doc.body || doc.documentElement; const out = [];
    const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => (/^(script|style|title)$/i.test(n.parentNode && n.parentNode.localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    let n; while ((n = w.nextNode())) out.push(n);
    return out;
  }
  function clearMarks() {
    if (!R.doc) return;
    for (const m of [...R.doc.querySelectorAll('mark.sahaf-hit')]) { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); m.remove(); p.normalize(); }
  }
  function highlight(q, nth) {
    clearMarks();
    const re = makeRe(q); let count = 0;
    for (const node of textNodes(R.doc)) {
      re.lastIndex = 0; let m;
      while ((m = re.exec(node.data))) {
        if (count === nth) {
          const rg = R.doc.createRange(); rg.setStart(node, m.index); rg.setEnd(node, m.index + m[0].length);
          const mk = R.doc.createElementNS(XHTML, 'mark'); mk.setAttribute('class', 'sahaf-hit');
          rg.surroundContents(mk);
          return mk;
        }
        count++;
        if (!m[0].length) re.lastIndex++;
      }
    }
    return null;
  }

  // ---------- info bar ----------
  function updateInfo() {
    if (!R.book || !R.rec) return;
    const toc = R.book.tocFor(R.index);
    const chap = toc ? toc.label : '';
    $('#rTitle').textContent = R.rec.title;
    $('#rChap').textContent = chap; $('#fChap').textContent = chap;
    if (!R.geom || !R.doc) return;
    const pct = bookPct(readFrac());
    const g = R.geom;
    $('#fPage').textContent = (g.mode === 'paged' || g.mode === 'vertical') && R.pages > 1
      ? t('pageOf', { p: R.page + 1, n: R.pages }) + ' · ' + fmtPct(pct) : fmtPct(pct);
    if (!sliding) $('#rSlider').value = Math.round(bookPct(currentFrac()) * 1000);
    $('#rMark').classList.toggle('on', !!currentMark());
    $('#rMark').title = currentMark() ? t('removeBookmark') : t('bookmark');
  }

  let sliding = false;
  const slider = $('#rSlider');
  const spineAt = v => { const sp = R.book.spine; let i = sp.findIndex(s => v < s.end); if (i < 0) i = sp.length - 1; return i; };
  slider.addEventListener('input', () => {
    if (!R.book) return; sliding = true;
    const v = slider.value / 1000; const i = spineAt(v); const toc = R.book.tocFor(i);
    $('#fPage').textContent = fmtPct(v); $('#fChap').textContent = toc ? toc.label : '';
  });
  slider.addEventListener('change', () => {
    sliding = false; if (!R.book) return;
    const v = slider.value / 1000; const i = spineAt(v); const s = R.book.spine[i];
    const frac = clamp((v - s.start) / Math.max(1e-9, s.end - s.start), 0, 0.999);
    if (i === R.index && R.doc) { restoreFrac(frac); updateInfo(); saveSoon(); } else loadChapter(i, { frac });
  });

  // ---------- progress ----------
  let saveT;
  function saveSoon() { clearTimeout(saveT); saveT = setTimeout(saveNow, 600); }
  async function saveNow() {
    clearTimeout(saveT);
    if (!R.rec || !R.book || !R.geom || R.rec.temp) return;
    const frac = currentFrac();
    const atEnd = R.index === R.book.spine.length - 1 && readFrac() >= 0.999;
    R.rec.progress = { i: R.index, frac, pct: atEnd ? 1 : bookPct(frac), href: R.book.spine[R.index].href };
    R.rec.opened = Date.now();
    try { await DB.put('books', R.rec); } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
  window.addEventListener('pagehide', () => saveNow());

  // ---------- bookmarks ----------
  function currentMark() {
    if (!R.rec || !R.geom) return null;
    const marks = R.rec.bookmarks || [];
    if (R.geom.mode === 'scroll') { const f = currentFrac(); return marks.find(b => b.i === R.index && Math.abs(b.frac - f) < 0.03) || null; }
    return marks.find(b => b.i === R.index && clamp(Math.floor(b.frac * R.pages + 1e-4), 0, R.pages - 1) === R.page) || null;
  }
  function snippet() {
    try {
      const g = R.geom; const d = R.doc;
      const x = (g.m || 20) + 6, y = (g.tm || 20) + 8;
      let node = null, off = 0;
      if (d.caretPositionFromPoint) { const p = d.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; off = p.offset; } }
      else if (d.caretRangeFromPoint) { const r = d.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; off = r.startOffset; } }
      if (node && node.nodeType === 3) {
        let s = node.data.slice(off);
        let n = node; const all = textNodes(d); let k = all.indexOf(n);
        while (s.replace(/\s+/g, ' ').trim().length < 90 && k >= 0 && ++k < all.length) s += ' ' + all[k].data;
        return s.replace(/\s+/g, ' ').trim().slice(0, 110);
      }
    } catch (e) {}
    return '';
  }
  async function toggleMark() {
    if (!R.rec || !R.doc) return;
    R.rec.bookmarks = R.rec.bookmarks || [];
    const cur = currentMark();
    if (cur) { R.rec.bookmarks = R.rec.bookmarks.filter(b => b !== cur); rtoast(t('bookmarkRemoved')); }
    else {
      const toc = R.book.tocFor(R.index);
      R.rec.bookmarks.push({ i: R.index, frac: currentFrac(), pct: bookPct(currentFrac()), label: toc ? toc.label : '', text: snippet(), ts: Date.now() });
      rtoast(t('bookmarkAdded'));
    }
    updateInfo(); renderMarks();
    if (!R.rec.temp) try { await DB.put('books', R.rec); } catch (e) {}
  }
  function renderMarks() {
    const box = $('#markList'); box.textContent = '';
    const marks = (R.rec && R.rec.bookmarks || []).slice().sort((a, b) => a.i - b.i || a.frac - b.frac);
    if (!marks.length) { box.appendChild(el('div', 'none', t('noBookmarks'))); return; }
    for (const b of marks) {
      const row = el('div', 'bmrow');
      const it = el('button', 'it'); it.appendChild(document.createTextNode(b.text || b.label || fmtPct(b.pct)));
      it.appendChild(el('span', 'sub', [b.label, fmtPct(b.pct)].filter(Boolean).join(' · ')));
      it.onclick = () => { closeOverlays(); if (b.i === R.index && R.doc) { restoreFrac(b.frac); updateInfo(); saveSoon(); } else loadChapter(b.i, { frac: b.frac }); };
      const del = el('button', 'rb'); del.title = t('remove'); del.setAttribute('aria-label', t('remove'));
      del.innerHTML = '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      del.onclick = async () => { R.rec.bookmarks = R.rec.bookmarks.filter(x => x !== b); renderMarks(); updateInfo(); if (!R.rec.temp) try { await DB.put('books', R.rec); } catch (e) {} };
      row.appendChild(it); row.appendChild(del); box.appendChild(row);
    }
  }

  // ---------- table of contents ----------
  function renderToc() {
    const box = $('#tocList'); box.textContent = '';
    if (!R.book) return;
    $('#pBookTitle').textContent = R.rec.title;
    const flat = R.book.flat.filter(x => x.spine >= 0);
    if (!flat.length) {
      // no usable toc: list the spine
      R.book.spine.forEach((s, i) => {
        const b = el('button', 'it', t('section', { n: i + 1 }));
        if (i === R.index) b.classList.add('cur');
        b.onclick = () => { closeOverlays(); go(i, ''); };
        box.appendChild(b);
      });
      return;
    }
    const cur = R.book.tocFor(R.index);
    let curEl = null;
    for (const x of flat) {
      const b = el('button', 'it', x.label);
      b.style.paddingLeft = (16 + Math.min(x.depth, 5) * 16) + 'px';
      if (x === cur) { b.classList.add('cur'); curEl = b; }
      b.onclick = () => { closeOverlays(); go(x.spine, x.frag); };
      box.appendChild(b);
    }
    if (curEl) requestAnimationFrame(() => curEl.scrollIntoView({ block: 'center' }));
  }

  // ---------- search ----------
  async function chapterTexts(i) {
    if (R.texts.has(i)) return R.texts.get(i);
    const { doc } = await R.book.parse(i);
    for (const x of [...doc.querySelectorAll('script, iframe, object, embed, form')]) x.remove();
    const arr = textNodes(doc).map(n => n.data);
    R.texts.set(i, arr);
    return arr;
  }
  async function runSearch(q) {
    const token = ++R.stoken;
    const box = $('#sList'); box.textContent = '';
    q = q.trim(); if (q.length < 2) return;
    const status = el('div', 'none', t('searching')); box.appendChild(status);
    const re = makeRe(q); let total = 0; const MAX = 400;
    for (let i = 0; i < R.book.spine.length && total < MAX; i++) {
      let arr; try { arr = await chapterTexts(i); } catch (e) { continue; }
      if (token !== R.stoken) return;
      let n = 0; const toc = R.book.tocFor(i);
      for (const s of arr) {
        re.lastIndex = 0; let m;
        while ((m = re.exec(s)) && total < MAX) {
          const b = el('button', 'it');
          const pre = s.slice(Math.max(0, m.index - 50), m.index).replace(/\s+/g, ' ');
          const post = s.slice(m.index + m[0].length, m.index + m[0].length + 80).replace(/\s+/g, ' ');
          b.appendChild(document.createTextNode((m.index > 50 ? '…' : '') + pre.trimStart()));
          b.appendChild(el('mark', '', m[0]));
          b.appendChild(document.createTextNode(post.trimEnd() + '…'));
          if (toc) b.appendChild(el('span', 'sub', toc.label));
          const hit = { q, n };
          b.onclick = () => { if (innerWidth < 700) closeOverlays(); if (i === R.index && R.doc) { const mk = highlight(q, hit.n); if (mk) { revealEl(mk); updateInfo(); saveSoon(); } } else loadChapter(i, { hit }); };
          box.appendChild(b);
          n++; total++;
          if (!m[0].length) re.lastIndex++;
        }
      }
      if (i % 8 === 7) await sleep(0);
    }
    status.textContent = total ? t('results', { n: total >= MAX ? MAX + '+' : total }) : t('noResults');
  }
  $('#sForm').onsubmit = e => { e.preventDefault(); runSearch($('#sInput').value); };
  let sT; $('#sInput').oninput = () => { clearTimeout(sT); sT = setTimeout(() => runSearch($('#sInput').value), 450); };

  // ---------- overlays ----------
  const OVER = ['#tocPanel', '#searchPanel', '#aaPop', '#note'];
  function closeOverlays() {
    let any = false;
    for (const id of OVER) if (!$(id).hidden) { $(id).hidden = true; any = true; }
    $('#scrim').hidden = true;
    return any;
  }
  function openOverlay(id) {
    const wasOpen = !$(id).hidden;
    closeOverlays();
    if (wasOpen) return false;
    $(id).hidden = false; $('#scrim').hidden = false;
    return true;
  }
  $('#scrim').onclick = closeOverlays;
  for (const b of document.querySelectorAll('[data-close]')) b.onclick = closeOverlays;
  $('#rToc').onclick = () => { if (openOverlay('#tocPanel')) { renderToc(); renderMarks(); } };
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => {
    for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x === b);
    $('#tocList').hidden = b.dataset.tab !== 'toc'; $('#markList').hidden = b.dataset.tab !== 'marks';
  };
  $('#rSearch').onclick = () => { if (openOverlay('#searchPanel')) setTimeout(() => $('#sInput').focus(), 30); };
  $('#rMark').onclick = toggleMark;
  $('#rAa').onclick = () => { if (openOverlay('#aaPop')) syncSettingsUi(); };
  $('#rFull').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}); };
  $('#edgeL').onclick = () => ((R.book && (R.book.rtl || R.rtl)) ? next() : prev());
  $('#edgeR').onclick = () => ((R.book && (R.book.rtl || R.rtl)) ? prev() : next());

  // ---------- settings ----------
  function syncSettingsUi() {
    const on = (sel, v) => { for (const b of document.querySelectorAll(sel + ' button')) b.classList.toggle('on', b.dataset.v === String(v)); };
    on('#thSel', S.theme); on('#fontSel', S.font); on('#lhSel', S.lh); on('#mgSel', S.margin); on('#lySel', S.layout); on('#spSel', S.spread);
    $('#fsOut').textContent = S.size + '%';
    $('#justify').checked = !!S.justify;
    $('#spreadRow').hidden = S.layout === 'scroll';
  }
  function setS(k, v) {
    const relayoutOnly = k !== 'layout';
    S[k] = v; store.set('settings', S); syncSettingsUi(); applyTheme();
    if (!R.doc) return;
    if (relayoutOnly) { layout(true); saveSoon(); }
    else { const frac = currentFrac(); loadChapter(R.index, { frac }); }
  }
  const segBind = (sel, key, num) => { for (const b of document.querySelectorAll(sel + ' button')) b.onclick = () => setS(key, num ? +b.dataset.v : b.dataset.v); };
  segBind('#thSel', 'theme'); segBind('#fontSel', 'font'); segBind('#lhSel', 'lh', true); segBind('#mgSel', 'margin'); segBind('#lySel', 'layout'); segBind('#spSel', 'spread');
  const stepSize = d => { let i = SIZES.indexOf(S.size); if (i < 0) i = 3; setS('size', SIZES[clamp(i + d, 0, SIZES.length - 1)]); };
  $('#fsMinus').onclick = () => stepSize(-1); $('#fsPlus').onclick = () => stepSize(1);
  $('#justify').onchange = () => setS('justify', $('#justify').checked);
  darkMq.addEventListener('change', () => { if (S.theme === 'auto') { applyTheme(); if (R.doc) layout(true); } });

  // ---------- keyboard ----------
  function onKey(e) {
    if (reader.hidden || !R.book) return;
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) { if (e.key === 'Escape') closeOverlays(); return; }
    if ($('#confirmDlg').open) return;
    const k = e.key; const back = R.book.rtl || R.rtl; const scroll = R.geom && R.geom.mode === 'scroll';
    if ((e.ctrlKey || e.metaKey) && (k === 'f' || k === 'F')) { e.preventDefault(); if ($('#searchPanel').hidden) openOverlay('#searchPanel'); setTimeout(() => $('#sInput').focus(), 30); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'ArrowRight') back ? prev() : next();
    else if (k === 'ArrowLeft') back ? next() : prev();
    else if (k === 'PageDown' || (k === ' ' && !e.shiftKey)) next();
    else if (k === 'PageUp' || (k === ' ' && e.shiftKey)) prev();
    else if (k === 'ArrowDown' && !scroll) next();
    else if (k === 'ArrowUp' && !scroll) prev();
    else if (k === 'Home' && !scroll) goPage(0);
    else if (k === 'End' && !scroll) goPage(R.pages - 1);
    else if (k === 'Escape') { if (!closeOverlays() && document.fullscreenElement) document.exitFullscreen(); }
    else if (k === '+' || k === '=') stepSize(1);
    else if (k === '-') stepSize(-1);
    else if (k === 'f' || k === 'F') $('#rFull').click();
    else if (k === 'b' || k === 'B') toggleMark();
    else if (k === 't' || k === 'T') $('#rToc').click();
    else return;
    e.preventDefault();
  }
  window.addEventListener('keydown', onKey);

  let rsT;
  new ResizeObserver(() => { if (reader.hidden || !R.doc) return; clearTimeout(rsT); rsT = setTimeout(() => layout(true), 120); }).observe(stage);

  // ---------- open / close ----------
  async function openReader(id, temp) {
    if (R.book) closeReader(true);
    closeOverlays();
    reader.hidden = false; applyTheme(); loading(true);
    $('#rErr').hidden = true; $('#rTitle').textContent = ''; $('#rChap').textContent = ''; $('#fChap').textContent = ''; $('#fPage').textContent = '';
    if (!history.state || !history.state.reader) history.pushState({ reader: id }, '', '#read');
    try {
      const rec = temp || await DB.get('books', id);
      const file = temp ? temp.file : await DB.get('files', id);
      if (!rec || !file) throw Object.assign(new Error('missing'), { code: 'badEpub' });
      const book = await openBook(file);
      R.rec = rec; R.book = book; R.texts = new Map(); R.ret = null;
      $('#rTitle').textContent = rec.title;
      $('#sList').textContent = ''; $('#sInput').value = '';
      if (book.title && rec.title !== book.title && !rec.temp) rec.title = book.title;
      const p = rec.progress;
      if (p && p.i < book.spine.length && (!p.href || book.spine[p.i].href === p.href)) await loadChapter(p.i, { frac: p.frac });
      else await loadChapter(0, {});
      frame.focus && setTimeout(() => { try { reader.querySelector('#rBack').blur(); } catch (e) {} }, 0);
    } catch (e) {
      console.error(e);
      loading(false);
      $('#rErr').textContent = errText(e); $('#rErr').hidden = false;
    }
  }
  function closeReader(keepHistory) {
    saveNow();
    closeOverlays();
    R.token++; R.stoken++;
    if (R.book) R.book.close();
    if (R.url) URL.revokeObjectURL(R.url);
    R.book = null; R.rec = null; R.doc = null; R.win = null; R.url = null; R.geom = null;
    frame.onload = null; frameNav('about:blank');
    reader.hidden = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (!keepHistory && history.state && history.state.reader) history.replaceState(null, '', location.pathname + location.search.replace(/[?&]share=1/, ''));
    setTimeout(renderLibrary, 50);
  }
  $('#rBack').onclick = () => { if (history.state && history.state.reader) history.back(); else closeReader(); };
  window.addEventListener('popstate', () => { if (!reader.hidden) closeReader(true); });

  // ---------- launch: file handler, share target ----------
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async p => {
      if (!p.files || !p.files.length) return;
      const files = [];
      for (const h of p.files) { try { files.push(await h.getFile()); } catch (e) {} }
      if (files.length) addFiles(files, true);
    });
  }
  (async () => {
    if (!/[?&]share=1/.test(location.search) || !('caches' in window)) return;
    try {
      const c = await caches.open('sahaf-share'); const files = [];
      for (const req of await c.keys()) {
        const r = await c.match(req);
        files.push(new File([await r.blob()], decodeURIComponent(r.headers.get('x-name') || 'book.epub'), { type: 'application/epub+zip' }));
        await c.delete(req);
      }
      history.replaceState(null, '', location.pathname);
      if (files.length) addFiles(files, true);
    } catch (e) {}
  })();

  // ---------- install ----------
  let deferred = null;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; if (!standalone()) { $('#btnInstall').hidden = false; $('#installTip').hidden = false; } });
  const doInstall = async () => { if (!deferred) return; deferred.prompt(); try { await deferred.userChoice; } catch (e) {} deferred = null; $('#btnInstall').hidden = true; $('#installTip').hidden = true; };
  $('#btnInstall').onclick = doInstall; $('#btnInstall2').onclick = doInstall;
  window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; $('#installTip').hidden = true; });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (location.hash === '#read') history.replaceState(null, '', location.pathname + location.search);

  applyLang();
  window.__sahaf = { R, S, DB, next, prev, goPage, addFiles, openReader, closeReader, layout };
})();
