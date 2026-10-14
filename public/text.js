// Mise en forme du texte : nettoyage OCR, découpage en blocs, assemblage des pages.
//
// Format de texte stocké pour chaque page (produit par l'OCR, modifiable à la main) :
//   - paragraphes séparés par une ligne vide
//   - "# Titre" pour un titre de chapitre, "## Titre" pour un sous-titre
//   - "***" pour un changement de scène
//   - *texte* pour l'italique

const PAGE_NUMBER = /^\s*[-–—]?\s*(\d{1,4}|[ivxlcdm]{1,6})\s*[-–—]?\s*$/i;
const SENTENCE_END = /[.!?…»"”:;)\]]$/;

/** Nettoie la sortie brute d'un OCR (Tesseract ou PaddleOCR) : une ligne par ligne imprimée. */
export function cleanTesseractText(raw) {
  const lines = raw.replace(/\r/g, '').split('\n');
  // Retire les numéros de page isolés en haut ou en bas de page.
  while (lines.length && (lines[0].trim() === '' || PAGE_NUMBER.test(lines[0]))) lines.shift();
  while (lines.length && (lines.at(-1).trim() === '' || PAGE_NUMBER.test(lines.at(-1)))) lines.pop();

  return lines
    // Une ligne sans aucun mot (grain de la photo lu comme « 4 », « | », « ~ »…) est un parasite.
    .filter((line) => !line.trim() || /\p{L}{2,}/u.test(line) || /^\s*(\*\s*){3}$/.test(line))
    // Une courte ligne entièrement en majuscules est traitée comme un titre de chapitre.
    .map((line) => (isCapsTitle(line) ? `\n# ${line.trim()}\n` : line))
    .join('\n')
    .split(/\n\s*\n/)
    .map((para) => joinLines(para))
    .filter(Boolean)
    .join('\n\n');
}

function isCapsTitle(line) {
  const t = line.trim();
  return !t.startsWith('#') && t.length <= 60 && (t.match(/\p{Lu}/gu) || []).length >= 4 && !/\p{Ll}/u.test(t);
}

// Mots composés courants dont le trait d'union doit être conservé en fin de ligne.
const COMPOUND_FIRST = new Set(('peut au aux après avant arrière grand grande belle beau demi semi mi porte garde sous '
  + 'contre non quasi ex vis celui celle ceux celles là ci dix vingt trente quarante cinquante soixante quatre soi '
  + 'moi toi lui elle eux nous vous rendez tête tire chef arc chou haut basse bas sauf sans').split(' '));
const COMPOUND_SECOND = new Set(('il ils elle elles on je tu nous vous moi toi lui leur le la les y en ci là même mêmes '
  + 'être t dire deux trois quatre cinq six sept huit neuf dix vingt un une').split(' '));

/** Recolle les lignes d'un paragraphe et les mots coupés en fin de ligne. */
function joinLines(text) {
  return text
    .trim()
    .replace(/(\p{L}+)[-¬]\s*\n\s*(\p{Ll}+)/gu, (_, first, second) => {
      const keep = COMPOUND_FIRST.has(first.toLowerCase()) || COMPOUND_SECOND.has(second);
      return keep ? `${first}-${second}` : first + second;
    })
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ');
}

/** Découpe le texte d'une page en blocs { type: 'h1' | 'h2' | 'p' | 'sep', text }. */
export function parseBlocks(text) {
  const blocks = [];
  for (const chunk of (text || '').replace(/\r/g, '').split(/\n\s*\n/)) {
    const t = chunk.trim();
    if (!t) continue;
    const heading = t.match(/^(#{1,3})\s+([\s\S]*)$/);
    if (heading) {
      blocks.push({ type: heading[1].length === 1 ? 'h1' : 'h2', text: joinLines(heading[2]) });
    } else if (/^(\*\s*){3}$|^[-–—]{3,}$/.test(t)) {
      blocks.push({ type: 'sep' });
    } else {
      blocks.push({ type: 'p', text: joinLines(t) });
    }
  }
  return blocks;
}

/**
 * Assemble les pages d'un livre en une suite de blocs continue.
 * Un paragraphe coupé par un changement de page est recollé.
 */
export function assembleBook(book) {
  const pages = book.pages.filter((p) => p.status === 'done').map((p) => parseBlocks(p.text));
  const headers = runningHeaders(pages);
  const blocks = [];
  for (const all of pages) {
    const pageBlocks = all.filter((b, i) => !(isHeaderCandidate(b, i) && headers.has(headerKey(b.text))));
    if (!pageBlocks.length) continue;

    const prev = blocks.at(-1);
    const first = pageBlocks[0];
    if (prev?.type === 'p' && first.type === 'p' && !SENTENCE_END.test(prev.text)) {
      if (/\p{L}-$/u.test(prev.text) && /^\p{Ll}/u.test(first.text)) {
        prev.text = prev.text.slice(0, -1) + first.text;
      } else {
        prev.text = `${prev.text} ${first.text}`;
      }
      pageBlocks.shift();
    }
    blocks.push(...pageBlocks);
  }
  return blocks;
}

// Comparaison tolérante : sans accents, majuscules ni ponctuation (l'OCR varie d'une page à l'autre).
const headerKey = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]+/g, '');

/** Bloc qui peut être un titre courant : un titre, ou le premier bloc d'une page, et court. */
const isHeaderCandidate = (block, index) => Boolean(block.text)
  && block.text.length <= 80
  && (index === 0 || block.type === 'h1' || block.type === 'h2');

/**
 * Titres courants : le titre du livre ou du chapitre répété en haut des pages (y compris au milieu
 * du texte d'une photo de double page). On les reconnaît parce qu'ils reviennent sur plusieurs pages.
 */
function runningHeaders(pages) {
  const counts = new Map();
  for (const blocks of pages) {
    const keys = new Set(blocks.filter(isHeaderCandidate).map((b) => headerKey(b.text)).filter((k) => k.length >= 4));
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(3, pages.length * 0.15);
  return new Set([...counts].filter(([, n]) => n >= threshold).map(([key]) => key));
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Texte inline -> HTML (échappement + italique). */
export function inlineHtml(text) {
  return escapeHtml(text).replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}
