// API de la Liseuse. Utilisée par le serveur local (local-server.js) et par Vercel (api/index.js).

import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';

import { storage, configError } from './storage/index.js';
import { engine, engineLabel, recognizeWithClaude } from './ocr.js';
import { authEnabled, requireAuth, login, logout } from './auth.js';
import { assembleBook } from '../public/text.js';
import { buildEpub } from './epub.js';

// Vercel refuse les requêtes de plus de 4,5 Mo : le navigateur réduit les photos avant l'envoi.
const MAX_UPLOAD = Math.floor(4.4 * 1024 * 1024);

export const app = express();
// Derrière le proxy HTTPS de l'hébergeur, pour que les cookies sécurisés fonctionnent.
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

app.get('/api/config', (req, res) => {
  res.json({ engine, engineLabel: engineLabel(), storage: storage.kind, auth: authEnabled, configError });
});

app.use('/api', (req, res, next) => (configError ? res.status(503).json({ error: configError }) : next()));
app.post('/api/login', login);
app.post('/api/logout', logout);
app.use('/api', requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 2 } });

// Les erreurs des routes async sont transmises au gestionnaire d'erreurs par Express 5.
async function loadBook(req, res) {
  const book = await storage.getBook(req.params.id);
  if (!book) res.status(404).json({ error: 'Livre introuvable' });
  return book;
}

async function loadPage(req, res) {
  const book = await loadBook(req, res);
  const page = book?.pages.find((p) => p.id === req.params.pageId);
  if (book && !page) res.status(404).json({ error: 'Page introuvable' });
  return page && { book, page };
}

function summary(book) {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    updatedAt: book.updatedAt,
    pageCount: book.pages.length,
    done: book.pages.filter((p) => p.status === 'done').length,
    cover: book.pages[0] ? `/api/books/${book.id}/pages/${book.pages[0].id}/thumb` : null,
  };
}

const isJpeg = (buffer) => buffer?.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;

// ------------------------------------------------------------------ Livres

app.get('/api/books', async (req, res) => {
  const books = await storage.listBooks();
  books.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json(books.map(summary));
});

app.post('/api/books', async (req, res) => {
  const now = new Date().toISOString();
  const book = await storage.createBook({
    id: crypto.randomUUID(),
    title: String(req.body?.title ?? '').trim() || 'Nouveau livre',
    author: String(req.body?.author ?? '').trim(),
    language: 'fr',
    createdAt: now,
    updatedAt: now,
  });
  res.status(201).json(book);
});

app.get('/api/books/:id', async (req, res) => {
  const book = await loadBook(req, res);
  if (book) res.json(book);
});

app.patch('/api/books/:id', async (req, res) => {
  const book = await loadBook(req, res);
  if (!book) return;
  const { title, author, language, pageOrder } = req.body ?? {};
  const fields = {};
  if (typeof title === 'string') fields.title = title.trim() || 'Sans titre';
  if (typeof author === 'string') fields.author = author.trim();
  if (typeof language === 'string') fields.language = language.trim() || 'fr';
  if (Array.isArray(pageOrder)) {
    const current = book.pages.map((p) => p.id);
    const sameSet = pageOrder.length === current.length && current.every((id) => pageOrder.includes(id));
    if (!sameSet) return res.status(409).json({ error: 'Les pages ont changé entre-temps, recharge la page.' });
    await storage.reorderPages(book.id, pageOrder);
  }
  res.json(Object.keys(fields).length ? await storage.updateBook(book.id, fields) : await storage.getBook(book.id));
});

app.delete('/api/books/:id', async (req, res) => {
  if (!(await loadBook(req, res))) return;
  await storage.deleteBook(req.params.id);
  res.status(204).end();
});

app.get('/api/books/:id/content', async (req, res) => {
  const book = await loadBook(req, res);
  if (!book) return;
  res.json({
    id: book.id,
    title: book.title,
    author: book.author,
    language: book.language,
    updatedAt: book.updatedAt,
    blocks: assembleBook(book),
  });
});

app.get('/api/books/:id/epub', async (req, res) => {
  const book = await loadBook(req, res);
  if (!book) return;
  const filename = `${book.title || 'livre'}.epub`.replace(/[\\/:*?"<>|]/g, '_');
  res.set({
    'Content-Type': 'application/epub+zip',
    'Content-Disposition': `attachment; filename="livre.epub"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  res.send(await buildEpub(book));
});

// ------------------------------------------------------------------ Pages

/** Ajoute une page : photo + miniature, déjà converties en JPEG par le navigateur. */
app.post('/api/books/:id/pages', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]), async (req, res) => {
  const book = await loadBook(req, res);
  if (!book) return;
  const image = req.files?.image?.[0]?.buffer;
  const thumb = req.files?.thumb?.[0]?.buffer;
  if (!isJpeg(image) || !isJpeg(thumb)) return res.status(400).json({ error: 'Photo manquante ou invalide' });

  const id = crypto.randomUUID();
  const page = {
    id,
    image: await storage.saveImage(book.id, id, 'image', image),
    thumb: await storage.saveImage(book.id, id, 'thumb', thumb),
    status: 'pending',
    text: '',
    error: null,
  };
  await storage.addPage(book.id, page);
  res.status(201).json(page);
});

app.get('/api/books/:id/pages/:pageId/:variant', async (req, res, next) => {
  if (!['image', 'thumb'].includes(req.params.variant)) return next();
  const found = await loadPage(req, res);
  if (!found) return;
  const buffer = await storage.readImage(found.page[req.params.variant]);
  if (!buffer) return res.status(404).json({ error: 'Image introuvable' });
  // Une photo de page ne change jamais : le navigateur peut la garder en cache.
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=604800, immutable' }).send(buffer);
});

/** Enregistre le texte d'une page (OCR du navigateur ou correction manuelle), ou une erreur d'OCR. */
app.patch('/api/books/:id/pages/:pageId', async (req, res) => {
  const found = await loadPage(req, res);
  if (!found) return;
  const { text, error } = req.body ?? {};
  let fields;
  if (typeof text === 'string') fields = { text, status: 'done', error: null };
  else if (typeof error === 'string') fields = { status: 'error', error: error.slice(0, 500) };
  else return res.status(400).json({ error: 'Rien à enregistrer' });
  res.json(await storage.updatePage(found.book.id, found.page.id, fields));
});

app.post('/api/books/:id/pages/:pageId/retry', async (req, res) => {
  const found = await loadPage(req, res);
  if (!found) return;
  res.json(await storage.updatePage(found.book.id, found.page.id, { status: 'pending', error: null }));
});

/** OCR côté serveur avec Claude (seulement quand une clé API est configurée). */
app.post('/api/books/:id/pages/:pageId/ocr', async (req, res) => {
  if (engine !== 'claude') return res.status(400).json({ error: 'OCR serveur désactivé (pas de clé API Claude)' });
  const found = await loadPage(req, res);
  if (!found) return;
  const { book, page } = found;
  let fields;
  try {
    const jpeg = await storage.readImage(page.image);
    if (!jpeg) throw new Error('Photo introuvable');
    fields = { text: await recognizeWithClaude(jpeg), status: 'done', error: null };
  } catch (err) {
    console.error(`OCR échoué (${book.title}, page ${page.id}) :`, err.message);
    fields = { status: 'error', error: err.message };
  }
  res.json(await storage.updatePage(book.id, page.id, fields));
});

app.delete('/api/books/:id/pages/:pageId', async (req, res) => {
  const found = await loadPage(req, res);
  if (!found) return;
  await storage.deletePage(found.book.id, found.page.id);
  await storage.deleteImages([found.page.image, found.page.thumb]);
  res.status(204).end();
});

// ------------------------------------------------------------------ Erreurs

app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Photo trop lourde (4 Mo maximum)' : err.message;
    return res.status(413).json({ error: message });
  }
  console.error(err);
  res.status(500).json({ error: err.message || 'Erreur serveur' });
});
