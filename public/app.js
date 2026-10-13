// Liseuse — interface (bibliothèque, gestion des pages, lecture).

import { escapeHtml as esc, inlineHtml as inline, cleanTesseractText } from './text.js';

const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);

class SilentError extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(path, {
    method,
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body && !isForm ? JSON.stringify(body) : body,
  });
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new SilentError('Non connecté');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Erreur ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function confirmDialog(text, okLabel = 'Supprimer') {
  const dlg = $('#confirm');
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

const storage = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
  },
};

const pageImage = (bookId, page, variant = 'image') => `/api/books/${bookId}/pages/${page.id}/${variant}`;

// ------------------------------------------------------------------ Routage

const config = await fetch('/api/config').then((r) => r.json()).catch(() => ({ configError: 'Serveur injoignable.' }));
let navToken = 0;
let cleanup = null;

function route() {
  cleanup?.();
  cleanup = null;
  const token = ++navToken;
  if (config.configError) return showSetupError();
  const [, view, id] = location.hash.split('/');
  const render = view === 'book' && id ? showBook(id, token)
    : view === 'read' && id ? showReader(id, token)
    : showLibrary(token);
  render.catch((err) => {
    if (err instanceof SilentError) return;
    console.error(err);
    toast(err.message);
  });
}
window.addEventListener('hashchange', route);
route();

function showSetupError() {
  app.innerHTML = `<div class="page"><div class="empty"><p><strong>L'application n'est pas encore prête.</strong></p><p>${esc(config.configError)}</p></div></div>`;
}

function showLogin() {
  cleanup?.();
  cleanup = null;
  navToken++;
  document.title = 'Connexion — Liseuse';
  app.innerHTML = `
    <form class="login" id="login">
      <img src="icon.svg" alt="" width="64" height="64">
      <h1>Liseuse</h1>
      <label class="field">Mot de passe<input type="password" name="password" autocomplete="current-password" required></label>
      <p class="login-error" id="login-error" hidden></p>
      <button class="btn primary">Entrer</button>
    </form>`;
  const form = $('#login');
  form.password.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelector('button').disabled = true;
    try {
      await api('/api/login', { method: 'POST', body: { password: form.password.value } });
      route();
    } catch (err) {
      $('#login-error').textContent = err.message;
      $('#login-error').hidden = false;
      form.querySelector('button').disabled = false;
    }
  });
}

// ------------------------------------------------------------------ Lecture des pages (OCR)
// La file d'attente vit au niveau de l'application : la lecture continue quand on passe
// d'un écran à l'autre, tant que l'onglet reste ouvert.

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
const ocrWaiting = [];
const ocrQueued = new Set(); // pages en attente ou en cours (identifiants)
const ocrRunning = new Set(); // pages en cours de lecture
const freshImages = new Map(); // photos qui viennent d'être envoyées (évite de les re-télécharger)
let ocrActive = 0;

function enqueueOcr(bookId, page) {
  if (page.status !== 'pending' || ocrQueued.has(page.id)) return;
  ocrQueued.add(page.id);
  ocrWaiting.push({ bookId, page });
  pumpOcr();
}

function pumpOcr() {
  const limit = config.engine === 'claude' ? 3 : 1;
  while (ocrActive < limit && ocrWaiting.length) {
    const job = ocrWaiting.shift();
    ocrActive++;
    runOcr(job).finally(() => {
      ocrActive--;
      pumpOcr();
    });
  }
}

function emitPage(bookId, page) {
  window.dispatchEvent(new CustomEvent('liseuse:page', { detail: { bookId, page } }));
}

async function runOcr({ bookId, page }) {
  ocrRunning.add(page.id);
  emitPage(bookId, page);
  let updated;
  try {
    if (config.engine === 'claude') {
      updated = await api(`/api/books/${bookId}/pages/${page.id}/ocr`, { method: 'POST' });
    } else {
      const text = await recognizeInBrowser(bookId, page);
      updated = await api(`/api/books/${bookId}/pages/${page.id}`, { method: 'PATCH', body: { text } });
    }
  } catch (err) {
    if (err instanceof SilentError) return;
    updated = await api(`/api/books/${bookId}/pages/${page.id}`, { method: 'PATCH', body: { error: err.message } })
      .catch(() => ({ ...page, status: 'error', error: err.message }));
  } finally {
    ocrRunning.delete(page.id);
    ocrQueued.delete(page.id);
    freshImages.delete(page.id);
  }
  emitPage(bookId, updated);
}

let tesseractWorker;
function getTesseract() {
  tesseractWorker ??= (async () => {
    if (!window.Tesseract) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = TESSERACT_URL;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Impossible de charger le moteur de lecture (connexion internet ?)'));
        document.head.append(script);
      });
    }
    // Le premier lancement télécharge les données de langue (≈ 15 Mo), ensuite gardées en cache.
    return window.Tesseract.createWorker('fra+eng');
  })().catch((err) => {
    tesseractWorker = null;
    throw err;
  });
  return tesseractWorker;
}

async function recognizeInBrowser(bookId, page) {
  let image = freshImages.get(page.id);
  if (!image) {
    const res = await fetch(pageImage(bookId, page));
    if (!res.ok) throw new Error('Photo introuvable');
    image = await res.blob();
  }
  const worker = await getTesseract();
  const { data } = await worker.recognize(image);
  return cleanTesseractText(data.text);
}

window.addEventListener('beforeunload', (e) => {
  if (ocrQueued.size) e.preventDefault();
});

// ------------------------------------------------------------------ Préparation des photos

/** Charge une image dans un canvas aux dimensions maximales données et la renvoie en JPEG. */
function encodeJpeg(bitmap, maxSize, quality) {
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => (blob ? resolve(blob) : reject(new Error('Conversion de la photo impossible'))),
    'image/jpeg',
    quality,
  ));
}

/** Réduit la photo (limite d'envoi de 4,5 Mo de Vercel) et crée sa miniature. */
async function preparePhoto(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name} : format non pris en charge (sur iPhone, choisis le format « Le plus compatible » dans Réglages > Appareil photo > Formats)`);
  }
  try {
    let image = await encodeJpeg(bitmap, 2400, 0.85);
    if (image.size > 3.5e6) image = await encodeJpeg(bitmap, 1800, 0.75);
    const thumb = await encodeJpeg(bitmap, 300, 0.7);
    return { image, thumb };
  } finally {
    bitmap.close();
  }
}

// ------------------------------------------------------------------ Bibliothèque

async function showLibrary(token) {
  document.title = 'Liseuse';
  const books = await api('/api/books');
  if (token !== navToken) return;

  const cards = books.map((b) => `
    <a class="card" href="#/book/${b.id}">
      <div class="cover">${b.cover ? `<img src="${b.cover}" alt="" loading="lazy">` : `<span class="placeholder">${esc(b.title[0] || '?')}</span>`}</div>
      <div class="card-body">
        <div class="card-title">${esc(b.title)}</div>
        ${b.author ? `<div class="muted small">${esc(b.author)}</div>` : ''}
        <div class="muted small">${b.pageCount} page${b.pageCount > 1 ? 's' : ''}${b.done < b.pageCount ? ` · ${b.done} transcrite${b.done > 1 ? 's' : ''}` : ''}</div>
      </div>
    </a>`).join('');

  app.innerHTML = `
    <div class="page">
      <div class="topbar">
        <h1>Ma bibliothèque</h1>
        <button class="btn primary" id="new">+ Nouveau livre</button>
      </div>
      ${books.length ? `<div class="grid">${cards}</div>` : `
        <div class="empty">
          <p>Aucun livre pour l'instant.<br>Crée un livre puis ajoute les photos de ses pages.</p>
          <button class="btn primary" id="new2">+ Créer mon premier livre</button>
        </div>`}
      <p class="muted small" style="margin-top:24px">
        Reconnaissance du texte : ${esc(config.engineLabel)}
        ${config.auth ? ' · <a href="#" id="logout" class="muted">Se déconnecter</a>' : ''}
      </p>
    </div>`;

  const create = async () => {
    const book = await api('/api/books', { method: 'POST', body: { title: 'Nouveau livre' } });
    location.hash = `#/book/${book.id}`;
  };
  $('#new').onclick = create;
  $('#new2')?.addEventListener('click', create);
  $('#logout')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/api/logout', { method: 'POST' });
    showLogin();
  });
}

// ------------------------------------------------------------------ Livre (gestion des pages)

const STATUS_LABELS = { pending: 'en attente', processing: 'lecture…', done: 'transcrite', error: 'erreur' };

async function showBook(id, token) {
  let book;
  try {
    book = await api(`/api/books/${id}`);
  } catch (err) {
    if (err instanceof SilentError) throw err;
    location.hash = '#/';
    return;
  }
  if (token !== navToken) return;
  document.title = `${book.title} — Liseuse`;

  app.innerHTML = `
    <div class="page">
      <div class="topbar"><a class="back" href="#/">‹ Bibliothèque</a></div>
      <div class="meta">
        <label class="field">Titre<input id="title" autocomplete="off"></label>
        <label class="field">Auteur<input id="author" autocomplete="off"></label>
      </div>
      <div class="actions">
        <label class="btn file primary">📷 Photographier<input type="file" accept="image/*" capture="environment" id="camera"></label>
        <label class="btn file">🖼️ Ajouter des photos<input type="file" accept="image/*" multiple id="files"></label>
        <span class="spacer"></span>
        <a class="btn" href="#/read/${id}">📖 Lire</a>
        <a class="btn" href="/api/books/${id}/epub" download>⬇ EPUB</a>
        <button class="btn" id="retry-all" title="Relancer la lecture de toutes les pages">↻ Tout relire</button>
        <button class="btn danger" id="delete">Supprimer</button>
      </div>
      <div class="dropzone" id="drop">Glisse tes photos de pages ici — elles seront ajoutées à la fin, triées par nom de fichier.</div>
      <div id="upload" hidden><span class="small" id="upload-text"></span><div class="progress"><div id="upload-bar" style="width:0"></div></div></div>
      <p class="muted small" id="status"></p>
      <ol class="pages" id="pages"></ol>
    </div>`;

  $('#title').value = book.title;
  $('#author').value = book.author;

  const patchBook = async (body) => {
    book = await api(`/api/books/${id}`, { method: 'PATCH', body });
    document.title = `${book.title} — Liseuse`;
  };
  $('#title').addEventListener('change', (e) => patchBook({ title: e.target.value }));
  $('#author').addEventListener('change', (e) => patchBook({ author: e.target.value }));

  $('#retry-all').onclick = async () => {
    if (!book.pages.length) return;
    const ok = await confirmDialog(
      `Relire les ${book.pages.length} pages avec ${config.engineLabel} ? Les corrections faites à la main seront remplacées.`,
      'Tout relire',
    );
    if (!ok) return;
    book = await api(`/api/books/${id}/retry-all`, { method: 'POST' });
    render();
    for (const page of book.pages) enqueueOcr(id, page);
  };

  $('#delete').onclick = async () => {
    if (!(await confirmDialog(`Supprimer « ${book.title} » et toutes ses photos ?`))) return;
    await api(`/api/books/${id}`, { method: 'DELETE' });
    location.hash = '#/';
  };

  // --- Liste des pages
  const statusOf = (p) => (ocrRunning.has(p.id) ? 'processing' : p.status);

  function render() {
    const counts = { pending: 0, processing: 0, done: 0, error: 0 };
    for (const p of book.pages) counts[statusOf(p)]++;
    const busy = counts.pending + counts.processing;
    $('#status').textContent = book.pages.length
      ? `${book.pages.length} page${book.pages.length > 1 ? 's' : ''} · ${counts.done} transcrite${counts.done > 1 ? 's' : ''}`
        + (busy ? ` · ${busy} en cours de lecture (garde cette fenêtre ouverte)` : '')
        + (counts.error ? ` · ${counts.error} en erreur` : '')
      : 'Aucune page. Photographie les pages du livre dans l\'ordre, ou ajoute plusieurs photos d\'un coup.';

    $('#pages').innerHTML = book.pages.map((p, i) => {
      const status = statusOf(p);
      const excerpt = status === 'error' ? p.error : p.text.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').slice(0, 140);
      return `
        <li class="page-row" data-id="${p.id}">
          <img src="${pageImage(id, p, 'thumb')}" alt="" loading="lazy">
          <div class="page-info">
            <div>Page ${i + 1}<span class="badge ${status}">${STATUS_LABELS[status]}</span></div>
            <div class="excerpt${status === 'error' ? ' error' : ''}">${esc(excerpt || (status === 'done' ? '(page sans texte)' : ''))}</div>
          </div>
          <div class="page-tools">
            <button class="btn icon ghost" data-act="up" title="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn icon ghost" data-act="down" title="Descendre" ${i === book.pages.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn icon ghost" data-act="edit" title="Voir / corriger le texte">✎</button>
            ${status === 'error' || status === 'done' ? '<button class="btn icon ghost" data-act="retry" title="Relancer la lecture">↻</button>' : ''}
            <button class="btn icon ghost danger" data-act="del" title="Supprimer la page">🗑</button>
          </div>
        </li>`;
    }).join('');
  }

  function onPageEvent(e) {
    const { bookId, page } = e.detail;
    if (bookId !== id || token !== navToken) return;
    const index = book.pages.findIndex((p) => p.id === page.id);
    if (index >= 0) book.pages[index] = page;
    render();
  }
  window.addEventListener('liseuse:page', onPageEvent);
  cleanup = () => window.removeEventListener('liseuse:page', onPageEvent);

  $('#pages').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const pageId = btn.closest('[data-id]').dataset.id;
    const index = book.pages.findIndex((p) => p.id === pageId);
    const page = book.pages[index];
    try {
      switch (btn.dataset.act) {
        case 'up':
        case 'down': {
          const other = index + (btn.dataset.act === 'up' ? -1 : 1);
          const order = book.pages.map((p) => p.id);
          [order[index], order[other]] = [order[other], order[index]];
          await patchBook({ pageOrder: order });
          render();
          break;
        }
        case 'edit':
          openEditor(id, page, index, async (text) => {
            book.pages[index] = await api(`/api/books/${id}/pages/${pageId}`, { method: 'PATCH', body: { text } });
            render();
            toast('Texte enregistré');
          });
          break;
        case 'retry':
          book.pages[index] = await api(`/api/books/${id}/pages/${pageId}/retry`, { method: 'POST' });
          enqueueOcr(id, book.pages[index]);
          render();
          break;
        case 'del':
          if (!(await confirmDialog(`Supprimer la page ${index + 1} ?`))) return;
          await api(`/api/books/${id}/pages/${pageId}`, { method: 'DELETE' });
          book.pages.splice(index, 1);
          render();
          break;
      }
    } catch (err) {
      if (!(err instanceof SilentError)) toast(err.message);
    }
  });

  // --- Ajout de photos : une requête par photo (limite de taille de Vercel)
  async function addFiles(fileList) {
    const files = [...fileList]
      .filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!files.length) return;

    const errors = [];
    let added = 0;
    $('#upload').hidden = false;
    for (const [i, file] of files.entries()) {
      $('#upload-text').textContent = `Envoi des photos… ${i + 1}/${files.length}`;
      $('#upload-bar').style.width = `${(i / files.length) * 100}%`;
      try {
        const { image, thumb } = await preparePhoto(file);
        const form = new FormData();
        form.append('image', image, 'page.jpg');
        form.append('thumb', thumb, 'thumb.jpg');
        const page = await api(`/api/books/${id}/pages`, { method: 'POST', body: form });
        freshImages.set(page.id, image);
        book.pages.push(page);
        added++;
        enqueueOcr(id, page);
        if (token === navToken) render();
      } catch (err) {
        if (err instanceof SilentError) return;
        errors.push(err.message);
      }
    }
    $('#upload').hidden = true;
    if (errors.length) toast(`Problème : ${errors.join(' ; ')}`);
    else toast(`${added} photo${added > 1 ? 's ajoutées' : ' ajoutée'}`);
  }

  for (const input of [$('#camera'), $('#files')]) {
    input.addEventListener('change', async () => {
      await addFiles(input.files);
      input.value = '';
    });
  }

  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    addFiles(e.dataTransfer.files);
  });

  render();
  // Reprend la lecture des pages restées en attente (envoyées depuis un autre appareil, onglet fermé…).
  for (const page of book.pages) enqueueOcr(id, page);
}

function openEditor(bookId, page, index, onSave) {
  const dlg = $('#editor');
  const src = pageImage(bookId, page);
  $('#editor-title').textContent = `Page ${index + 1}`;
  $('#editor-image').src = src;
  $('#editor-image-link').href = src;
  $('#editor-text').value = page.text;
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'save') onSave($('#editor-text').value).catch((err) => toast(err.message));
  }, { once: true });
}

// ------------------------------------------------------------------ Liseuse

const DEFAULT_SETTINGS = { size: 19, leading: 1.6, theme: 'sepia', font: 'serif', mode: 'pages' };

function seg(key, options, current) {
  return `<div class="seg">${options.map(([val, label]) =>
    `<button data-key="${key}" data-val="${val}" class="${String(val) === String(current) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}

async function showReader(id, token) {
  const content = await api(`/api/books/${id}/content`);
  if (token !== navToken) return;
  document.title = `${content.title} — Liseuse`;

  const settings = { ...DEFAULT_SETTINGS, ...storage.get('liseuse:settings', {}) };
  const posKey = `liseuse:pos:${id}`;
  const headings = [];

  const body = content.blocks.map((b, i) => {
    switch (b.type) {
      case 'h1':
      case 'h2':
        headings.push({ id: `h${i}`, level: b.type === 'h1' ? 1 : 2, text: b.text.replace(/\*/g, '') });
        return `<${b.type} id="h${i}">${inline(b.text)}</${b.type}>`;
      case 'sep': return '<hr>';
      default: return `<p>${inline(b.text)}</p>`;
    }
  }).join('');

  app.innerHTML = `
    <div class="reader" id="reader">
      <header class="reader-bar">
        <a class="btn icon" href="#/book/${id}" title="Retour au livre">‹</a>
        <div class="title">${esc(content.title)}</div>
        <button class="btn icon" id="btn-toc" title="Sommaire">☰</button>
        <button class="btn icon" id="btn-settings" title="Affichage"><b>Aa</b></button>
      </header>
      <div class="viewport" id="viewport">
        <article class="book" id="book" lang="${esc(content.language || 'fr')}">
          <div class="book-head"><div class="t">${esc(content.title)}</div>${content.author ? `<div class="a">${esc(content.author)}</div>` : ''}</div>
          ${body || '<p class="the-end">Aucune page transcrite pour l\'instant.</p>'}
          ${body ? '<p class="the-end">— Fin des pages transcrites —</p>' : ''}
        </article>
      </div>
      <div class="nav-zone prev" id="zprev">‹</div>
      <div class="nav-zone next" id="znext">›</div>
      <footer class="reader-foot"><span id="pg"></span><div class="bar"><div id="bar"></div></div><span id="pct"></span></footer>
      <div class="panel" id="toc-panel" hidden>
        <h3>Sommaire</h3>
        ${headings.length ? `<ul class="toc">
          <li><a href="#" data-target="start">Début du livre</a></li>
          ${headings.map((h) => `<li class="lvl${h.level}"><a href="#" data-target="${h.id}">${esc(h.text)}</a></li>`).join('')}
        </ul>` : '<p>Aucun titre de chapitre détecté.</p>'}
      </div>
      <div class="panel" id="settings-panel" hidden></div>
    </div>`;

  const reader = $('#reader');
  const viewport = $('#viewport');
  const bookEl = $('#book');
  let pageWidth = 1;
  let pageCount = 1;
  let current = 0;

  // --- Position de lecture
  function fraction() {
    if (settings.mode === 'scroll') {
      const max = viewport.scrollHeight - viewport.clientHeight;
      return max > 0 ? viewport.scrollTop / max : 0;
    }
    return pageCount > 1 ? current / (pageCount - 1) : 0;
  }

  function updateFooter() {
    const f = fraction();
    $('#pg').textContent = settings.mode === 'pages' ? `${current + 1} / ${pageCount}` : '';
    $('#pct').textContent = `${Math.round(f * 100)} %`;
    $('#bar').style.width = `${f * 100}%`;
    storage.set(posKey, f);
  }

  function goTo(n, animate = true) {
    current = Math.max(0, Math.min(pageCount - 1, n));
    bookEl.classList.toggle('animate', animate);
    bookEl.style.transform = `translateX(${-current * pageWidth}px)`;
    updateFooter();
  }
  const next = () => { setChrome(false); goTo(current + 1); };
  const prev = () => { setChrome(false); goTo(current - 1); };

  // --- Mise en page
  function applySettings() {
    reader.classList.remove('theme-light', 'theme-sepia', 'theme-dark', 'font-serif', 'font-sans');
    reader.classList.add(`theme-${settings.theme}`, `font-${settings.font}`);
    reader.classList.toggle('scroll', settings.mode === 'scroll');
    reader.style.setProperty('--r-size', `${settings.size}px`);
    reader.style.setProperty('--r-leading', settings.leading);
  }

  function layout(targetFraction = fraction()) {
    applySettings();
    if (settings.mode === 'pages') {
      const width = viewport.clientWidth;
      const pad = width < 500 ? 20 : 40;
      bookEl.style.setProperty('--r-pad', `${pad}px`);
      bookEl.style.columnWidth = `${width - 2 * pad}px`;
      bookEl.style.columnGap = `${2 * pad}px`;
      pageWidth = width;
      pageCount = Math.max(1, Math.ceil((bookEl.scrollWidth - 2) / width));
      goTo(Math.round(targetFraction * (pageCount - 1)), false);
    } else {
      bookEl.style.removeProperty('--r-pad');
      bookEl.style.columnWidth = '';
      bookEl.style.columnGap = '';
      viewport.scrollTop = targetFraction * (viewport.scrollHeight - viewport.clientHeight);
      updateFooter();
    }
  }

  // --- Barres d'outils et panneaux
  function setChrome(visible) {
    reader.classList.toggle('chrome-hidden', !visible);
    if (!visible) closePanels();
  }
  function closePanels() {
    $('#toc-panel').hidden = true;
    $('#settings-panel').hidden = true;
  }
  function togglePanel(panel) {
    const open = panel.hidden;
    closePanels();
    panel.hidden = !open;
  }

  function renderSettings() {
    $('#settings-panel').innerHTML = `
      <h3>Affichage</h3>
      <div class="row"><span>Taille du texte</span>
        <div class="seg"><button data-size="-1">A−</button><button disabled>${settings.size}</button><button data-size="1">A+</button></div></div>
      <div class="row"><span>Interligne</span>${seg('leading', [[1.4, 'Serré'], [1.6, 'Normal'], [1.9, 'Aéré']], settings.leading)}</div>
      <div class="row"><span>Police</span>${seg('font', [['serif', '<span style="font-family:Literata,Georgia,serif">Serif</span>'], ['sans', 'Sans']], settings.font)}</div>
      <div class="row"><span>Thème</span>${seg('theme', [
        ['light', '<span class="swatch" style="background:#fff"></span>'],
        ['sepia', '<span class="swatch" style="background:#f4ecd8"></span>'],
        ['dark', '<span class="swatch" style="background:#141414"></span>']], settings.theme)}</div>
      <div class="row"><span>Lecture</span>${seg('mode', [['pages', 'Pages'], ['scroll', 'Défilement']], settings.mode)}</div>`;
  }

  $('#settings-panel').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    const f = fraction();
    if (btn.dataset.size) {
      settings.size = Math.max(13, Math.min(32, settings.size + Number(btn.dataset.size)));
    } else if (btn.dataset.key) {
      const val = btn.dataset.val;
      settings[btn.dataset.key] = btn.dataset.key === 'leading' ? Number(val) : val;
    }
    storage.set('liseuse:settings', settings);
    renderSettings();
    layout(f);
  });

  $('#btn-settings').onclick = () => { renderSettings(); togglePanel($('#settings-panel')); };
  $('#btn-toc').onclick = () => togglePanel($('#toc-panel'));

  $('#toc-panel').addEventListener('click', (e) => {
    const link = e.target.closest('a[data-target]');
    if (!link) return;
    e.preventDefault();
    closePanels();
    const target = link.dataset.target === 'start' ? bookEl.firstElementChild : document.getElementById(link.dataset.target);
    if (settings.mode === 'scroll') {
      viewport.scrollTop = target.offsetTop - 8;
    } else {
      const offset = target.getBoundingClientRect().left - bookEl.getBoundingClientRect().left;
      goTo(Math.floor(offset / pageWidth), false);
    }
  });

  // --- Navigation : clic, glisser, clavier, molette
  let suppressClick = false;
  viewport.addEventListener('click', (e) => {
    if (suppressClick || getSelection().toString()) return;
    if (!$('#toc-panel').hidden || !$('#settings-panel').hidden) {
      closePanels();
      return;
    }
    const x = e.clientX / window.innerWidth;
    if (settings.mode === 'pages' && x < 0.3) prev();
    else if (settings.mode === 'pages' && x > 0.7) next();
    else setChrome(reader.classList.contains('chrome-hidden'));
  });
  $('#zprev').onclick = prev;
  $('#znext').onclick = next;

  let touch = null;
  viewport.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    touch = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  viewport.addEventListener('touchend', (e) => {
    if (!touch || settings.mode !== 'pages') return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      dx < 0 ? next() : prev();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 400);
    }
  }, { passive: true });

  let wheelLock = 0;
  viewport.addEventListener('wheel', (e) => {
    if (settings.mode !== 'pages' || Math.abs(e.deltaY) < 10) return;
    e.preventDefault();
    if (Date.now() < wheelLock) return;
    wheelLock = Date.now() + 350;
    e.deltaY > 0 ? next() : prev();
  }, { passive: false });

  function onKey(e) {
    if (e.target.closest('input, textarea') || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') { closePanels(); return; }
    if (settings.mode !== 'pages') return;
    if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); next(); }
    if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); prev(); }
  }

  let scrollTimer;
  viewport.addEventListener('scroll', () => {
    if (settings.mode !== 'scroll') return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(updateFooter, 150);
  });

  let resizeTimer;
  function onResize() {
    const f = fraction();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => layout(f), 150);
  }

  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  cleanup = () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
  };

  const saved = storage.get(posKey, 0);
  layout(saved);
  // La police web arrive parfois après le premier rendu : on recalcule la pagination.
  document.fonts?.ready.then(() => { if (token === navToken) layout(); });
}
