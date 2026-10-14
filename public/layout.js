// Reconstruit le texte d'une page (paragraphes, titres) à partir des lignes détectées par PaddleOCR.
// Chaque segment : { text, box: { x, y, width, height, points }, confidence }.
// Fonction pure, utilisable dans le navigateur (worker) comme dans Node (tests).

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};

/**
 * Redresse les positions selon l'inclinaison de la photo (estimée sur les lignes de texte) :
 * sans cela, sur une photo penchée, la fin d'une ligne se retrouve à la hauteur de la suivante.
 * Renvoie des segments { text, x0, x1, cy, h } en coordonnées redressées.
 */
function deskew(segments) {
  const geometry = segments.map((s) => {
    const p = s.box.points;
    if (p?.length === 4) {
      return {
        angle: Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x),
        length: Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y),
        h: Math.hypot(p[3].x - p[0].x, p[3].y - p[0].y),
        cx: (p[0].x + p[1].x + p[2].x + p[3].x) / 4,
        cy: (p[0].y + p[1].y + p[2].y + p[3].y) / 4,
      };
    }
    return { angle: 0, length: s.box.width, h: s.box.height, cx: s.box.x + s.box.width / 2, cy: s.box.y + s.box.height / 2 };
  });
  const angle = median(geometry.filter((g) => g.length > g.h * 3).map((g) => g.angle));
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return segments.map((s, i) => {
    const g = geometry[i];
    const cx = g.cx * cos + g.cy * sin;
    return { text: s.text, h: g.h, cy: g.cy * cos - g.cx * sin, x0: cx - g.length / 2, x1: cx + g.length / 2 };
  });
}

/** Cherche une gouttière verticale vide au milieu de l'image (photo de deux pages côte à côte). */
function findGutter(segments, width) {
  const bins = 100;
  const coverage = new Array(bins).fill(0);
  for (const s of segments) {
    const from = Math.max(0, Math.floor((s.x0 / width) * bins));
    const to = Math.min(bins - 1, Math.floor((s.x1 / width) * bins));
    for (let b = from; b <= to; b++) coverage[b]++;
  }
  const limit = Math.max(...coverage) * 0.05;
  let best = null;
  let start = null;
  for (let b = 30; b <= 70; b++) {
    if (coverage[b] <= limit) {
      start ??= b;
      if (!best || b - start > best.end - best.start) best = { start, end: b };
    } else {
      start = null;
    }
  }
  return best && best.end - best.start >= 1 ? ((best.start + best.end + 1) / 2 / bins) * width : null;
}

/** Regroupe les segments en lignes (même hauteur), triées de haut en bas. */
function groupLines(segments) {
  const sorted = [...segments].sort((a, b) => a.cy - b.cy);
  const lines = [];
  for (const s of sorted) {
    const line = lines.at(-1);
    if (line && Math.abs(s.cy - line.cy) < Math.min(line.h, s.h) * 0.5) {
      line.segments.push(s);
      line.x0 = Math.min(line.x0, s.x0);
      line.x1 = Math.max(line.x1, s.x1);
    } else {
      lines.push({ segments: [s], cy: s.cy, h: s.h, x0: s.x0, x1: s.x1 });
    }
  }
  for (const line of lines) {
    line.text = line.segments.sort((a, b) => a.x0 - b.x0).map((seg) => seg.text.trim()).join(' ');
  }
  return lines.filter((l) => l.text);
}

/** Transforme une colonne de lignes en texte : paragraphes séparés par une ligne vide, titres en "# ". */
function columnToText(lines) {
  if (!lines.length) return '';
  const h = median(lines.map((l) => l.h));
  const left = quantile(lines.map((l) => l.x0), 0.2);
  const right = quantile(lines.map((l) => l.x1), 0.8);
  const center = (left + right) / 2;
  const gaps = lines.slice(1).map((l, i) => l.cy - lines[i].cy);
  const gap = median(gaps) || h * 1.5;

  const out = [];
  lines.forEach((line, i) => {
    const prev = lines[i - 1];
    const next = lines[i + 1];
    const gapBefore = prev ? line.cy - prev.cy : Infinity;
    const gapAfter = next ? next.cy - line.cy : Infinity;
    const short = line.x1 - line.x0 < (right - left) * 0.7;
    const centered = Math.abs((line.x0 + line.x1) / 2 - center) < h * 1.5 && line.x0 - left > h * 2;
    const isolated = gapBefore > gap * 1.4 && gapAfter > gap * 1.4;
    // Titre : ligne courte, centrée et séparée du texte (ou nettement plus grande que le texte).
    const heading = short && (centered || line.h > h * 1.4) && (isolated || line.h > h * 1.4);

    const newParagraph = !prev
      || heading
      || out.at(-1)?.heading
      || gapBefore > gap * 1.5 // espace vertical
      || line.x0 - left > h * 0.8 // retrait de première ligne
      || prev.x1 < right - h * 2.5; // la ligne précédente s'arrêtait avant la marge

    if (newParagraph) out.push({ heading, lines: [] });
    out.at(-1).lines.push(line.text);
  });

  return out
    .map((p) => (p.heading && !/^#/.test(p.lines[0]) ? `# ${p.lines.join(' ')}` : p.lines.join('\n')))
    .join('\n\n');
}

/**
 * Lignes PaddleOCR (RecognitionResult[][] ou segments à plat) -> texte au format de la Liseuse
 * (paragraphes séparés par une ligne vide, mots coupés recollés plus tard par cleanTesseractText).
 */
export function layoutText(results, width) {
  const segments = deskew(results.flat().filter((s) => s.text?.trim() && (s.confidence ?? 1) > 0.5));
  if (!segments.length) return '';
  const gutter = findGutter(segments, width);
  const columns = gutter == null
    ? [segments]
    : [
      segments.filter((s) => (s.x0 + s.x1) / 2 < gutter),
      segments.filter((s) => (s.x0 + s.x1) / 2 >= gutter),
    ];
  return columns.map((col) => columnToText(groupLines(col))).filter(Boolean).join('\n\n');
}
