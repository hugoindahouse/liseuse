// Génération d'un fichier EPUB 3 (compatible liseuses, Apple Livres, Google Play Livres…).

import JSZip from 'jszip';
import { assembleBook, escapeHtml, inlineHtml } from '../public/text.js';

const CSS = `body { font-family: serif; line-height: 1.5; margin: 0 4%; }
h1 { font-size: 1.6em; text-align: center; margin: 2em 0 1em; }
h2 { font-size: 1.25em; margin: 1.5em 0 0.75em; }
p { text-indent: 1.5em; margin: 0; text-align: justify; }
h1 + p, h2 + p, hr + p { text-indent: 0; }
hr { border: 0; text-align: center; margin: 1.5em 0; }
hr::after { content: "* * *"; }`;

function xhtml(title, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="UTF-8"/><title>${escapeHtml(title)}</title><link rel="stylesheet" href="style.css"/></head>
<body>
${body}
</body>
</html>`;
}

function blockXhtml(block) {
  switch (block.type) {
    case 'h1': return `<h1>${inlineHtml(block.text)}</h1>`;
    case 'h2': return `<h2>${inlineHtml(block.text)}</h2>`;
    case 'sep': return '<hr/>';
    default: return `<p>${inlineHtml(block.text)}</p>`;
  }
}

/** Découpe les blocs en chapitres, un nouveau chapitre à chaque titre "h1". */
function splitChapters(blocks, bookTitle) {
  const chapters = [];
  let current = null;
  for (const block of blocks) {
    if (block.type === 'h1' || !current) {
      current = { title: block.type === 'h1' ? block.text.replace(/\*/g, '') : bookTitle, blocks: [] };
      chapters.push(current);
    }
    current.blocks.push(block);
  }
  return chapters.length ? chapters : [{ title: bookTitle, blocks: [] }];
}

export async function buildEpub(book) {
  const title = book.title || 'Sans titre';
  const author = book.author || 'Auteur inconnu';
  const chapters = splitChapters(assembleBook(book), title);
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const zip = new JSZip();
  // Le fichier "mimetype" doit être le premier, non compressé.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.file('OEBPS/style.css', CSS);

  chapters.forEach((chapter, i) => {
    zip.file(`OEBPS/chap${i + 1}.xhtml`, xhtml(chapter.title, chapter.blocks.map(blockXhtml).join('\n')));
  });

  const navItems = chapters
    .map((c, i) => `<li><a href="chap${i + 1}.xhtml">${escapeHtml(c.title)}</a></li>`)
    .join('\n');
  zip.file('OEBPS/nav.xhtml', xhtml('Table des matières',
    `<nav epub:type="toc" id="toc"><h1>Table des matières</h1><ol>\n${navItems}\n</ol></nav>`));

  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:${book.id}"/></head>
<docTitle><text>${escapeHtml(title)}</text></docTitle>
<navMap>
${chapters.map((c, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeHtml(c.title)}</text></navLabel><content src="chap${i + 1}.xhtml"/></navPoint>`).join('\n')}
</navMap>
</ncx>`);

  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${book.id}</dc:identifier>
    <dc:title>${escapeHtml(title)}</dc:title>
    <dc:creator>${escapeHtml(author)}</dc:creator>
    <dc:language>${escapeHtml(book.language || 'fr')}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
${chapters.map((_, i) => `    <item id="chap${i + 1}" href="chap${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine toc="ncx">
${chapters.map((_, i) => `    <itemref idref="chap${i + 1}"/>`).join('\n')}
  </spine>
</package>`);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/epub+zip' });
}
