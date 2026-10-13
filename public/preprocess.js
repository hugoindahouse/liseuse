// Nettoyage d'une photo de page avant l'OCR Tesseract : niveaux de gris, suppression des ombres
// et de l'éclairage inégal, puis renforcement du contraste.
// Fonction pure sur des pixels RGBA ({ data, width, height }, comme ImageData) : utilisable dans le
// navigateur (canvas) comme dans Node (tests).

/** Valeur du percentile p (0–1) d'un histogramme de 256 cases contenant `total` pixels. */
function percentile(hist, total, p) {
  let count = 0;
  const target = total * p;
  for (let v = 0; v < 256; v++) {
    count += hist[v];
    if (count >= target) return v;
  }
  return 255;
}

export function enhanceForOcr({ data, width, height }) {
  const n = width * height;
  const gray = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  // 1. Estime la couleur du papier par blocs (percentile haut : l'encre est plus sombre que le papier).
  //    Les blocs sont plus grands qu'une lettre pour que le texte n'assombrisse pas l'estimation.
  const block = Math.max(16, Math.round(Math.max(width, height) / 40));
  const cols = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  const paper = new Float32Array(cols * rows);
  const hist = new Uint32Array(256);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      hist.fill(0);
      const x1 = Math.min(width, (bx + 1) * block);
      const y1 = Math.min(height, (by + 1) * block);
      for (let y = by * block; y < y1; y++) {
        for (let x = bx * block; x < x1; x++) hist[gray[y * width + x]]++;
      }
      paper[by * cols + bx] = Math.max(1, percentile(hist, (x1 - bx * block) * (y1 - by * block), 0.9));
    }
  }

  // Zones bien plus sombres que le papier (table, fond autour du livre) : effacées, sinon leur
  // grain devient des caractères parasites.
  const sorted = Float32Array.from(paper).sort();
  const notPaper = sorted[Math.floor(sorted.length * 0.75)] * 0.35;

  // 2. Divise chaque pixel par la couleur du papier interpolée (bilinéaire) : les ombres disparaissent.
  const out = new Uint8ClampedArray(n);
  const total = new Uint32Array(256);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(rows - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(rows - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(cols - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(cols - 1, x0 + 1);
      const tx = fx - x0;
      const bg = (paper[y0 * cols + x0] * (1 - tx) + paper[y0 * cols + x1] * tx) * (1 - ty)
        + (paper[y1 * cols + x0] * (1 - tx) + paper[y1 * cols + x1] * tx) * ty;
      const v = bg < notPaper ? 255 : (gray[y * width + x] / bg) * 255;
      out[y * width + x] = v;
      total[out[y * width + x]]++;
    }
  }

  // 3. Étire le contraste : l'encre la plus sombre devient noire, le papier blanc.
  const black = percentile(total, n, 0.01);
  const white = Math.max(black + 1, percentile(total, n, 0.5) - 8);
  const scale = 255 / (white - black);
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(255, Math.round((out[i] - black) * scale)));
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
}
