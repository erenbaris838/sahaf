/* Sahaf: EPUB reading core. Reads the ZIP container, the package (OPF) and the table of contents,
   and turns chapters into safe, self-contained documents. No third-party code. */
(function () {
  'use strict';

  class BookError extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }

  // ---------- ZIP ----------
  const td = new TextDecoder('utf-8');
  const latin = new TextDecoder('windows-1252');

  async function readZip(blob) {
    const size = blob.size;
    if (size < 22) throw new BookError('notZip');
    const tailLen = Math.min(size, 65557);
    const tail = new DataView(await blob.slice(size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new BookError('notZip');
    let count = tail.getUint16(eocd + 10, true);
    let cdSize = tail.getUint32(eocd + 12, true);
    let cdOff = tail.getUint32(eocd + 16, true);
    if (cdOff === 0xFFFFFFFF || count === 0xFFFF) {
      // ZIP64: the locator sits right before the classic end record
      const loc = eocd - 20;
      if (loc >= 0 && tail.getUint32(loc, true) === 0x07064b50) {
        const z64off = Number(tail.getBigUint64(loc + 8, true));
        const z = new DataView(await blob.slice(z64off, z64off + 56).arrayBuffer());
        if (z.getUint32(0, true) === 0x06064b50) {
          count = Number(z.getBigUint64(32, true));
          cdSize = Number(z.getBigUint64(40, true));
          cdOff = Number(z.getBigUint64(48, true));
        }
      }
    }
    const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const entries = new Map();
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
      if (cd.getUint32(p, true) !== 0x02014b50) break;
      const flags = cd.getUint16(p + 8, true);
      const method = cd.getUint16(p + 10, true);
      let csize = cd.getUint32(p + 20, true);
      let usize = cd.getUint32(p + 24, true);
      const nlen = cd.getUint16(p + 28, true), xlen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true);
      let off = cd.getUint32(p + 42, true);
      const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen);
      let name;
      try { name = (flags & 0x800) ? td.decode(nameBytes) : new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); }
      catch (e) { name = latin.decode(nameBytes); }
      if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || off === 0xFFFFFFFF) {
        let x = p + 46 + nlen; const xe = x + xlen;
        while (x + 4 <= xe) {
          const id = cd.getUint16(x, true), len = cd.getUint16(x + 2, true); let q = x + 4;
          if (id === 1) {
            if (usize === 0xFFFFFFFF) { usize = Number(cd.getBigUint64(q, true)); q += 8; }
            if (csize === 0xFFFFFFFF) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
            if (off === 0xFFFFFFFF) { off = Number(cd.getBigUint64(q, true)); }
          }
          x += 4 + len;
        }
      }
      if (!name.endsWith('/')) entries.set(name, { name, method, csize, usize, off, flags });
      p += 46 + nlen + xlen + clen;
    }
    if (!entries.size) throw new BookError('notZip');
    const lower = new Map();
    for (const k of entries.keys()) lower.set(k.toLowerCase(), k);

    function find(path) {
      if (entries.has(path)) return entries.get(path);
      const k = lower.get(path.toLowerCase());
      return k ? entries.get(k) : null;
    }
    async function raw(e) {
      const h = new DataView(await blob.slice(e.off, e.off + 30).arrayBuffer());
      if (h.getUint32(0, true) !== 0x04034b50) throw new BookError('badZip');
      const start = e.off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
      const data = blob.slice(start, start + e.csize);
      if (e.method === 0) return data;
      if (e.method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new BookError('oldBrowser');
        const out = await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
        return out;
      }
      throw new BookError('badZip', 'method ' + e.method);
    }
    return {
      names: () => [...entries.keys()],
      has: path => !!find(path),
      size: path => { const e = find(path); return e ? e.usize : 0; },
      async blob(path, type) {
        const e = find(path);
        if (!e) return null;
        const b = await raw(e);
        return type ? new Blob([b], { type }) : b;
      },
      async text(path) {
        const e = find(path);
        if (!e) return null;
        const buf = await (await raw(e)).arrayBuffer();
        return decodeText(new Uint8Array(buf));
      }
    };
  }

  function decodeText(u8) {
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8);
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8);
    const head = latin.decode(u8.subarray(0, 200));
    const m = head.match(/encoding=["']([\w-]+)["']/i);
    let enc = m ? m[1].toLowerCase() : 'utf-8';
    try { return new TextDecoder(enc).decode(u8); } catch (e) { return td.decode(u8); }
  }

  // ---------- paths ----------
  function dirOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }
  function resolvePath(base, href) {
    if (!href) return '';
    href = href.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null; // external
    let frag = '';
    const h = href.indexOf('#');
    if (h >= 0) { frag = href.slice(h); href = href.slice(0, h); }
    const q = href.indexOf('?'); if (q >= 0) href = href.slice(0, q);
    let path;
    try { href = decodeURIComponent(href); } catch (e) {}
    if (!href) path = base; else path = href.startsWith('/') ? href.slice(1) : dirOf(base) + href;
    const out = [];
    for (const seg of path.split('/')) {
      if (seg === '..') out.pop(); else if (seg !== '.' && seg !== '') out.push(seg);
    }
    return out.join('/') + frag;
  }
  const splitFrag = p => { const i = p.indexOf('#'); return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]; };

  // ---------- XML helpers ----------
  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    return doc;
  }
  const byLocal = (root, name) => root ? [...root.getElementsByTagName('*')].filter(e => e.localName === name) : [];
  const firstLocal = (root, name) => byLocal(root, name)[0] || null;
  const attr = (el, name) => {
    if (!el) return null;
    if (el.hasAttribute(name)) return el.getAttribute(name);
    for (const a of el.attributes) if (a.localName === name) return a.value;
    return null;
  };
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  // ---------- open ----------
  async function openBook(file) {
    const zip = await readZip(file);
    const containerTxt = await zip.text('META-INF/container.xml');
    let opfPath = null;
    if (containerTxt) {
      const c = parseXml(containerTxt);
      const rf = c && firstLocal(c, 'rootfile');
      opfPath = rf && attr(rf, 'full-path');
    }
    if (!opfPath || !zip.has(opfPath)) opfPath = zip.names().find(n => /\.opf$/i.test(n)) || null;
    if (!opfPath) throw new BookError(zip.has('mimetype') ? 'badEpub' : 'notEpub');

    // DRM check: encryption.xml that covers more than embedded fonts means the book is locked
    const encTxt = await zip.text('META-INF/encryption.xml');
    if (encTxt) {
      const enc = parseXml(encTxt);
      const fontAlgs = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];
      const items = byLocal(enc, 'EncryptedData');
      const locked = items.some(d => {
        const m = firstLocal(d, 'EncryptionMethod');
        const uri = attr(firstLocal(d, 'CipherReference'), 'URI') || '';
        return !(m && fontAlgs.includes(attr(m, 'Algorithm'))) && !/\.(otf|ttf|woff2?)$/i.test(uri);
      });
      if (locked || zip.has('META-INF/rights.xml')) throw new BookError('drm');
    }

    const opf = parseXml(await zip.text(opfPath));
    if (!opf) throw new BookError('badEpub');
    const pkg = opf.documentElement;
    const version = attr(pkg, 'version') || '2.0';
    const md = firstLocal(opf, 'metadata');
    const dc = n => clean(byLocal(md, n)[0]?.textContent);
    const metas = byLocal(md, 'meta');
    const metaProp = p => clean(metas.find(m => attr(m, 'property') === p)?.textContent);
    const metaName = n => attr(metas.find(m => attr(m, 'name') === n), 'content');

    const manifest = new Map(); const byHref = new Map();
    for (const it of byLocal(firstLocal(opf, 'manifest'), 'item')) {
      const href = resolvePath(opfPath, attr(it, 'href') || '');
      if (href == null) continue;
      const item = { id: attr(it, 'id'), href, type: (attr(it, 'media-type') || '').toLowerCase(), props: (attr(it, 'properties') || '').split(/\s+/) };
      manifest.set(item.id, item); byHref.set(href, item);
    }
    const spineEl = firstLocal(opf, 'spine');
    const spine = [];
    for (const ir of byLocal(spineEl, 'itemref')) {
      const it = manifest.get(attr(ir, 'idref'));
      if (!it || !zip.has(it.href)) continue;
      if (!/x?html|xml|svg/.test(it.type) && !/\.(x?html?|xml|svg)$/i.test(it.href)) continue;
      spine.push({ href: it.href, type: it.type, linear: attr(ir, 'linear') !== 'no', size: Math.max(400, zip.size(it.href)) });
    }
    if (!spine.length) throw new BookError('badEpub', 'empty spine');
    let rtl = attr(spineEl, 'page-progression-direction') === 'rtl';
    const fixed = metaProp('rendition:layout') === 'pre-paginated';

    // cover
    let cover = [...manifest.values()].find(i => i.props.includes('cover-image'));
    if (!cover) { const id = metaName('cover'); if (id) cover = manifest.get(id) || byHref.get(resolvePath(opfPath, id)); }
    if (cover && !/^image\//.test(cover.type)) cover = null;
    if (!cover) cover = [...manifest.values()].find(i => /^image\//.test(i.type) && /cover/i.test(i.id + ' ' + i.href));

    // toc
    let toc = [];
    const navItem = [...manifest.values()].find(i => i.props.includes('nav'));
    if (navItem) {
      try {
        const txt = await zip.text(navItem.href);
        const doc = parseXml(txt) || new DOMParser().parseFromString(txt, 'text/html');
        const navs = byLocal(doc, 'nav');
        const nav = navs.find(n => (attr(n, 'type') || '').split(/\s+/).includes('toc')) || navs[0];
        const walk = ol => byLocal(ol, 'li').filter(li => li.parentNode === ol).map(li => {
          const a = [...li.children].find(c => c.localName === 'a' || c.localName === 'span');
          const sub = [...li.children].find(c => c.localName === 'ol' || c.localName === 'ul');
          const href = a && attr(a, 'href') ? resolvePath(navItem.href, attr(a, 'href')) : null;
          return { label: clean(a ? a.textContent : li.textContent) || '•', href, children: sub ? walk(sub) : [] };
        });
        const ol = nav && [...nav.getElementsByTagName('*')].find(e => e.localName === 'ol' || e.localName === 'ul');
        if (ol) toc = walk(ol);
      } catch (e) { toc = []; }
    }
    if (!toc.length) {
      const ncxItem = manifest.get(attr(spineEl, 'toc')) || [...manifest.values()].find(i => i.type === 'application/x-dtbncx+xml');
      if (ncxItem) {
        try {
          const ncx = parseXml(await zip.text(ncxItem.href));
          const walk = parent => [...parent.children].filter(c => c.localName === 'navPoint').map(np => ({
            label: clean(firstLocal(np, 'text')?.textContent) || '•',
            href: resolvePath(ncxItem.href, attr(firstLocal(np, 'content'), 'src') || ''),
            children: walk(np)
          }));
          const map = firstLocal(ncx, 'navMap');
          if (map) toc = walk(map);
        } catch (e) { toc = []; }
      }
    }
    // attach spine index to toc entries
    const spineIndex = new Map(spine.map((s, i) => [s.href, i]));
    const flat = [];
    (function tag(list, depth) {
      for (const t of list) {
        if (t.href) { const [p, f] = splitFrag(t.href); t.spine = spineIndex.has(p) ? spineIndex.get(p) : -1; t.frag = f; }
        else t.spine = -1;
        t.depth = depth; flat.push(t);
        tag(t.children, depth + 1);
      }
    })(toc, 0);

    const total = spine.reduce((a, s) => a + s.size, 0);
    let acc = 0; for (const s of spine) { s.start = acc / total; acc += s.size; s.end = acc / total; }

    const lang = dc('language') || '';
    return new Book(zip, {
      version, opfPath, title: dc('title'), author: byLocal(md, 'creator').map(e => clean(e.textContent)).filter(Boolean).join(', '),
      lang, publisher: dc('publisher'), description: clean((dc('description') || '').replace(/<[^>]+>/g, ' ')),
      spine, toc, flat, manifest, byHref, cover: cover ? cover.href : null, coverType: cover ? cover.type : null, rtl, fixed
    });
  }

  // ---------- chapters ----------
  const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
    css: 'text/css', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', ogg: 'audio/ogg' };
  const mimeOf = (path, fallback) => {
    if (fallback && fallback !== 'application/octet-stream') return fallback;
    return MIME[(path.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
  };

  class Book {
    constructor(zip, meta) { Object.assign(this, meta); this.zip = zip; this.urls = new Map(); this.texts = new Map(); }

    async resourceUrl(path) {
      if (this.urls.has(path)) return this.urls.get(path);
      const p = (async () => {
        const item = this.byHref.get(path);
        const type = mimeOf(path, item && item.type);
        if (type === 'text/css') {
          const css = await this.zip.text(path);
          if (css == null) return '';
          const fixed = await this.rewriteCss(css, path);
          return URL.createObjectURL(new Blob([fixed], { type: 'text/css' }));
        }
        const b = await this.zip.blob(path, type);
        return b ? URL.createObjectURL(b) : '';
      })();
      this.urls.set(path, p);
      return p;
    }

    async rewriteCss(css, base) {
      const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g;
      const jobs = []; let m;
      while ((m = re.exec(css))) {
        const href = m[2] || m[4];
        const path = resolvePath(base, href);
        if (path && !href.startsWith('data:')) jobs.push([m[0], path.split('#')[0], !!m[4]]);
      }
      for (const [whole, path, imp] of jobs) {
        const u = this.zip.has(path) ? await this.resourceUrl(path) : '';
        css = css.split(whole).join(imp ? `@import "${u}"` : `url("${u}")`);
      }
      return css;
    }

    async coverBlob() {
      if (this.cover) return this.zip.blob(this.cover, this.coverType || mimeOf(this.cover));
      // fall back to the first picture in the first chapter
      try {
        const href = this.spine[0].href;
        const txt = await this.zip.text(href);
        const m = txt && txt.match(/<(?:img|image)\b[^>]*?(?:src|href)\s*=\s*["']([^"']+)["']/i);
        if (m) { const p = resolvePath(href, m[1]); if (p && this.zip.has(p)) return this.zip.blob(p, mimeOf(p)); }
      } catch (e) {}
      return null;
    }

    async parse(index) {
      const s = this.spine[index];
      const txt = await this.zip.text(s.href);
      if (txt == null) throw new BookError('badEpub', 'missing ' + s.href);
      let doc = null, xhtml = false;
      if (!/html/.test(s.type) || /xhtml|xml/.test(s.type) || /\.xhtml$/i.test(s.href)) {
        doc = parseXml(txt);
        xhtml = !!doc && !!doc.documentElement && (doc.documentElement.localName === 'html' || doc.documentElement.localName === 'svg');
        if (!xhtml) doc = null;
      }
      if (!doc) doc = new DOMParser().parseFromString(txt, 'text/html');
      return { doc, xhtml };
    }

    async text(index) {
      if (this.texts.has(index)) return this.texts.get(index);
      const { doc } = await this.parse(index);
      const body = doc.body || doc.documentElement;
      for (const el of [...body.querySelectorAll('script,style')]) el.remove();
      const t = (body.textContent || '').replace(/\s+/g, ' ');
      this.texts.set(index, t);
      return t;
    }

    // Returns a blob URL for a sanitized chapter that loads only its own resources
    async chapter(index, injectCss) {
      const s = this.spine[index];
      let { doc, xhtml } = await this.parse(index);
      const root = doc.documentElement;
      // strip active content
      for (const el of [...doc.querySelectorAll('script, iframe, object, embed, form, base, meta[http-equiv]')]) el.remove();
      for (const el of doc.querySelectorAll('*')) {
        for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
      }
      const jobs = [];
      const fix = (el, name) => {
        const v = el.getAttribute(name) ?? attr(el, name);
        if (!v || v.startsWith('data:') || v.startsWith('#')) return;
        const path = resolvePath(s.href, v);
        if (!path) return;
        const [p] = splitFrag(path);
        jobs.push((async () => {
          const u = this.zip.has(p) ? await this.resourceUrl(p) : '';
          if (el.hasAttribute(name)) el.setAttribute(name, u);
          else for (const a of [...el.attributes]) if (a.localName === name) el.setAttributeNS(a.namespaceURI, a.name, u);
        })());
      };
      for (const el of doc.querySelectorAll('img, audio, video, source, track, input')) fix(el, 'src');
      for (const el of doc.querySelectorAll('video')) fix(el, 'poster');
      for (const el of doc.querySelectorAll('img[srcset], source[srcset]')) el.removeAttribute('srcset');
      for (const el of doc.getElementsByTagName('*')) if (el.localName === 'image' || el.localName === 'use' || el.localName === 'feImage') fix(el, 'href');
      for (const el of doc.querySelectorAll('link')) {
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        if (rel.includes('stylesheet')) fix(el, 'href'); else el.remove();
      }
      for (const el of doc.querySelectorAll('style')) {
        jobs.push(this.rewriteCss(el.textContent, s.href).then(c => { el.textContent = c; }));
      }
      for (const el of doc.querySelectorAll('[style*="url("]')) {
        jobs.push(this.rewriteCss(el.getAttribute('style'), s.href).then(c => el.setAttribute('style', c)));
      }
      // links: keep the original target in data-href so the reader can route clicks
      for (const a of doc.querySelectorAll('a[href]')) {
        const v = a.getAttribute('href');
        const path = resolvePath(s.href, v);
        a.setAttribute('data-href', path == null ? v : path);
        a.setAttribute('href', path == null ? v : '#');
        a.removeAttribute('target');
      }
      await Promise.all(jobs);
      let head = doc.head || [...root.children].find(c => c.localName === 'head');
      if (!head && root.localName === 'html') {
        head = doc.createElementNS(root.namespaceURI || 'http://www.w3.org/1999/xhtml', 'head');
        root.insertBefore(head, root.firstChild);
      }
      if (head) {
        const ns = root.namespaceURI || 'http://www.w3.org/1999/xhtml';
        const meta = doc.createElementNS(ns, 'meta');
        meta.setAttribute('http-equiv', 'Content-Security-Policy');
        meta.setAttribute('content', "default-src 'none'; img-src blob: data:; media-src blob: data:; style-src blob: 'unsafe-inline'; font-src blob: data:");
        head.insertBefore(meta, head.firstChild);
        const st = doc.createElementNS(ns, 'style');
        st.setAttribute('id', 'sahaf-style');
        st.textContent = injectCss || '';
        head.appendChild(st);
      }
      if (!root.getAttribute('lang') && !root.getAttribute('xml:lang') && this.lang) root.setAttribute('lang', this.lang);
      const html = xhtml ? new XMLSerializer().serializeToString(doc) : '<!DOCTYPE html>\n' + root.outerHTML;
      return URL.createObjectURL(new Blob([html], { type: xhtml ? 'application/xhtml+xml' : 'text/html' }));
    }

    spineOf(path) { const [p] = splitFrag(path); return this.spine.findIndex(s => s.href === p); }

    tocFor(index) {
      let best = null;
      for (const t of this.flat) if (t.spine >= 0 && t.spine <= index && (!best || t.spine > best.spine)) best = t;
      return best;
    }

    close() {
      for (const p of this.urls.values()) p.then(u => u && URL.revokeObjectURL(u)).catch(() => {});
      this.urls.clear();
    }
  }

  window.SahafBook = { openBook, BookError, resolvePath, splitFrag };
})();
