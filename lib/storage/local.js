// Stockage local (utilisé avec `npm start`) : data/books/<id>/book.json + images/ + thumbs/.

import fs from 'node:fs';
import path from 'node:path';

export const kind = 'local';

const BOOKS_DIR = path.resolve(process.env.DATA_DIR || 'data', 'books');
const books = new Map();
let loaded = false;

const bookDir = (id) => path.join(BOOKS_DIR, id);
const clone = (value) => structuredClone(value);

function load() {
  if (loaded) return;
  loaded = true;
  fs.mkdirSync(BOOKS_DIR, { recursive: true });
  for (const id of fs.readdirSync(BOOKS_DIR)) {
    const file = path.join(bookDir(id), 'book.json');
    if (!fs.existsSync(file)) continue;
    const book = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const page of book.pages) {
      // Format de la première version : noms de fichiers seuls et statut "processing".
      if (!page.image.includes('/')) page.image = `${id}/images/${page.image}`;
      if (!page.thumb.includes('/')) page.thumb = `${id}/thumbs/${page.thumb}`;
      if (page.status === 'processing') page.status = 'pending';
    }
    books.set(id, book);
  }
}

function persist(book) {
  book.updatedAt = new Date().toISOString();
  const file = path.join(bookDir(book.id), 'book.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(book, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function find(id) {
  load();
  return books.get(id);
}

export async function listBooks() {
  load();
  return [...books.values()].map(clone);
}

export async function getBook(id) {
  const book = find(id);
  return book ? clone(book) : null;
}

export async function createBook(meta) {
  load();
  const book = { ...meta, pages: [] };
  fs.mkdirSync(bookDir(book.id), { recursive: true });
  books.set(book.id, book);
  persist(book);
  return clone(book);
}

export async function updateBook(id, fields) {
  const book = find(id);
  if (!book) return null;
  Object.assign(book, fields);
  persist(book);
  return clone(book);
}

export async function reorderPages(id, order) {
  const book = find(id);
  const byId = new Map(book.pages.map((p) => [p.id, p]));
  book.pages = order.map((pageId) => byId.get(pageId));
  persist(book);
}

export async function deleteBook(id) {
  books.delete(id);
  fs.rmSync(bookDir(id), { recursive: true, force: true });
}

export async function addPage(id, page) {
  const book = find(id);
  book.pages.push(page);
  persist(book);
}

export async function updatePage(id, pageId, fields) {
  const book = find(id);
  const page = book?.pages.find((p) => p.id === pageId);
  if (!page) return null;
  Object.assign(page, fields);
  persist(book);
  return clone(page);
}

export async function deletePage(id, pageId) {
  const book = find(id);
  book.pages = book.pages.filter((p) => p.id !== pageId);
  persist(book);
}

// Les images sont désignées par une clé relative à data/books (ex. "<id>/images/<page>.jpg").
const imagePath = (key) => {
  const full = path.resolve(BOOKS_DIR, key);
  if (!full.startsWith(BOOKS_DIR + path.sep)) throw new Error('Chemin d\'image invalide');
  return full;
};

/** Enregistre une photo (variant "image") ou sa miniature (variant "thumb") et renvoie sa clé. */
export async function saveImage(bookId, pageId, variant, buffer) {
  const key = `${bookId}/${variant === 'thumb' ? 'thumbs' : 'images'}/${pageId}.jpg`;
  fs.mkdirSync(path.dirname(imagePath(key)), { recursive: true });
  fs.writeFileSync(imagePath(key), buffer);
  return key;
}

export async function readImage(key) {
  return fs.promises.readFile(imagePath(key)).catch(() => null);
}

export async function deleteImages(keys) {
  for (const key of keys) fs.rmSync(imagePath(key), { force: true });
}
