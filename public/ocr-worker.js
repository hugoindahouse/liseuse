// Lecture des pages dans le navigateur avec PaddleOCR v6 (gratuit, open source, sans clé ni serveur).
// Tourne dans un worker pour ne pas figer l'interface. Messages :
//   reçu   { id, image: Blob }
//   envoyé { id, text } | { id, error } | { type: 'status', message }

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm.min.mjs';
import { PaddleOcrService } from 'https://cdn.jsdelivr.net/npm/paddleocr@1.2.0/dist/index.mjs';
import { enhanceForOcr } from './preprocess.js';
import { layoutText } from './layout.js';
import { cleanTesseractText } from './text.js';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';

// Modèles officiels PP-OCRv6 « small » (versions figées). Le dictionnaire couvre tous les caractères français.
const HF = 'https://huggingface.co';
const MODELS = [
  { key: 'det', url: `${HF}/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/28fe5895c24fd108c19eb3e8479f4ab385fbfc62/inference.onnx` },
  { key: 'rec', url: `${HF}/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/b8f84f0b80c529de40b4fbb3544b84fa7233a513/inference.onnx` },
  { key: 'dict', url: `${HF}/x3zvawq/paddleocr-js-onnx/resolve/51c2133b5a7ea27b795fa8c400fdbfbd5337dd6a/ppocr_v6_small/ppocrv6_dict.txt` },
];
const CACHE = 'liseuse-ocr-v1';
const TARGET_SIZE = 2400; // les petites photos sont agrandies : le texte est mieux lu

const status = (message) => self.postMessage({ type: 'status', message });

/** Télécharge un fichier une seule fois (cache du navigateur), en signalant la progression. */
async function download(url, onBytes) {
  const cache = self.caches ? await self.caches.open(CACHE).catch(() => null) : null;
  const cached = await cache?.match(url);
  if (cached) return cached.arrayBuffer();

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Téléchargement du moteur de lecture impossible (${res.status})`);
  const reader = res.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes(value.length);
  }
  const blob = new Blob(chunks);
  await cache?.put(url, new Response(blob)).catch(() => {});
  return blob.arrayBuffer();
}

let engine;
function getEngine() {
  engine ??= (async () => {
    const total = 31.1e6; // taille approximative des modèles, pour la progression
    let loaded = 0;
    let shown = -1;
    const onBytes = (n) => {
      loaded += n;
      const pct = Math.min(99, Math.floor((loaded / total) * 100));
      if (pct !== shown) status(`Premier lancement : téléchargement du moteur de lecture (31 Mo, une seule fois)… ${(shown = pct)} %`);
    };
    const [det, rec, dict] = await Promise.all(MODELS.map((m) => download(m.url, onBytes)));
    status('Préparation du moteur de lecture…');
    const characters = new TextDecoder().decode(dict).trimEnd().split(/\r?\n/);
    const ocr = await PaddleOcrService.createInstance({
      ort,
      modelPreset: 'PP-OCRv6_small',
      detection: { modelBuffer: det },
      // Le modèle prévoit une classe de plus que le dictionnaire : l'espace.
      recognition: { modelBuffer: rec, charactersDictionary: [...characters, ' '] },
    });
    status('');
    return ocr;
  })().catch((err) => {
    engine = null;
    throw err;
  });
  return engine;
}

async function readPage(ocr, image) {
  const bitmap = await createImageBitmap(image);
  const scale = Math.min(2, TARGET_SIZE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // Nettoyage (ombres, éclairage, contraste) : nettement moins d'erreurs sur les photos difficiles.
  const pixels = ctx.getImageData(0, 0, width, height);
  enhanceForOcr(pixels);

  const results = await ocr.recognize({ width, height, data: new Uint8Array(pixels.data.buffer) });
  const { lines } = ocr.processRecognition(results);
  return cleanTesseractText(layoutText(lines, width));
}

// Une page à la fois.
let queue = Promise.resolve();
self.onmessage = ({ data: { id, image } }) => {
  queue = queue.then(async () => {
    try {
      const ocr = await getEngine();
      self.postMessage({ id, text: await readPage(ocr, image) });
    } catch (err) {
      self.postMessage({ id, error: err?.message || String(err) });
    }
  });
};
