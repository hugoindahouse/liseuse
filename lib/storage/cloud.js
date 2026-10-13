// Stockage en ligne (Vercel) : métadonnées et textes dans Upstash Redis, photos dans Vercel Blob (privé).
//
// Clés Redis :
//   liseuse:books          ensemble des identifiants de livres
//   liseuse:book:<id>      métadonnées du livre (titre, auteur…)
//   liseuse:updated:<id>   date de dernière modification (ms)
//   liseuse:order:<id>     liste ordonnée des identifiants de pages
//   liseuse:pages:<id>     hash identifiant de page -> page
// Les pages sont des champs séparés : deux pages lues en même temps ne s'écrasent pas.

import { Redis } from '@upstash/redis';
import { put, get, del } from '@vercel/blob';

export const kind = 'cloud';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const K = {
  books: 'liseuse:books',
  meta: (id) => `liseuse:book:${id}`,
  updated: (id) => `liseuse:updated:${id}`,
  order: (id) => `liseuse:order:${id}`,
  pages: (id) => `liseuse:pages:${id}`,
};

const touch = (id) => redis.set(K.updated(id), Date.now());

function assemble(meta, updated, order, pages) {
  if (!meta) return null;
  return {
    ...meta,
    updatedAt: new Date(Number(updated) || Date.parse(meta.createdAt)).toISOString(),
    pages: (order ?? []).map((pageId) => pages?.[pageId]).filter(Boolean),
  };
}

async function fetchBooks(ids) {
  if (!ids.length) return [];
  const pipe = redis.pipeline();
  for (const id of ids) {
    pipe.get(K.meta(id));
    pipe.get(K.updated(id));
    pipe.lrange(K.order(id), 0, -1);
    pipe.hgetall(K.pages(id));
  }
  const results = await pipe.exec();
  return ids.map((_, i) => assemble(...results.slice(i * 4, i * 4 + 4)));
}

export async function listBooks() {
  const ids = await redis.smembers(K.books);
  return (await fetchBooks(ids.map(String))).filter(Boolean);
}

export async function getBook(id) {
  const [book] = await fetchBooks([id]);
  return book;
}

export async function createBook(meta) {
  await redis.pipeline().set(K.meta(meta.id), meta).set(K.updated(meta.id), Date.now()).sadd(K.books, meta.id).exec();
  return { ...meta, pages: [] };
}

export async function updateBook(id, fields) {
  const meta = await redis.get(K.meta(id));
  if (!meta) return null;
  await redis.pipeline().set(K.meta(id), { ...meta, ...fields }).set(K.updated(id), Date.now()).exec();
  return getBook(id);
}

export async function reorderPages(id, order) {
  await redis.multi().del(K.order(id)).rpush(K.order(id), ...order).set(K.updated(id), Date.now()).exec();
}

export async function deleteBook(id) {
  const book = await getBook(id);
  if (book?.pages.length) await deleteImages(book.pages.flatMap((p) => [p.image, p.thumb]));
  await redis.pipeline()
    .del(K.meta(id), K.updated(id), K.order(id), K.pages(id))
    .srem(K.books, id)
    .exec();
}

export async function addPage(id, page) {
  await redis.pipeline().hset(K.pages(id), { [page.id]: page }).rpush(K.order(id), page.id).exec();
  await touch(id);
}

export async function updatePage(id, pageId, fields) {
  const page = await redis.hget(K.pages(id), pageId);
  if (!page) return null;
  const updated = { ...page, ...fields };
  await redis.hset(K.pages(id), { [pageId]: updated });
  await touch(id);
  return updated;
}

export async function deletePage(id, pageId) {
  await redis.pipeline().hdel(K.pages(id), pageId).lrem(K.order(id), 0, pageId).exec();
  await touch(id);
}

/** Enregistre une photo (variant "image") ou sa miniature (variant "thumb") et renvoie sa clé. */
export async function saveImage(bookId, pageId, variant, buffer) {
  const blob = await put(`books/${bookId}/${pageId}${variant === 'thumb' ? '-thumb' : ''}.jpg`, buffer, {
    access: 'private',
    contentType: 'image/jpeg',
    allowOverwrite: true,
  });
  return blob.pathname;
}

export async function readImage(key) {
  const result = await get(key, { access: 'private' });
  if (!result?.stream) return null;
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

export async function deleteImages(keys) {
  if (keys.length) await del(keys);
}
