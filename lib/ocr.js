// Reconnaissance de texte (OCR) côté serveur, avec Gemini (offre gratuite) ou Claude.
// Sans clé API, l'OCR se fait dans le navigateur avec Tesseract (voir public/app.js).

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, ApiError as GeminiApiError } from '@google/genai';

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

export const engine = (() => {
  const wanted = (process.env.OCR_ENGINE || 'auto').toLowerCase();
  if (['gemini', 'claude', 'browser'].includes(wanted)) return wanted;
  if (GEMINI_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'claude';
  return 'browser';
})();

const MODEL = process.env.OCR_MODEL || 'claude-haiku-5-5'; // modèle Claude (Gemini : voir GEMINI_MODELS)
const CLAUDE_EFFORT = process.env.OCR_EFFORT || 'low';

export function engineLabel() {
  if (engine === 'browser') return 'Tesseract, dans le navigateur';
  if (engine === 'gemini') return `Gemini (${GEMINI_MODELS.join(' → ')})`;
  return `Claude (${MODEL})`;
}

/** Erreur dont le message est destiné à l'utilisateur ; `retryAfter` (s) si le quota est momentanément atteint. */
export class OcrError extends Error {
  constructor(message, retryAfter = null) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

const SYSTEM_PROMPT = `You transcribe photographed book pages into clean text for an e-reader app.

Rules:
- Transcribe the printed text exactly, in its original language. Do not translate, summarize, correct or modernize it.
- Output only the transcription, with no introduction or comment.
- Write each paragraph on a single line and separate paragraphs with one blank line. A paragraph that continues from the previous page or onto the next page is still written as is.
- Rejoin words split by a hyphen at the end of a printed line ("por-" + "tait" → "portait"), but keep real hyphens ("peut-être", "vingt-deux").
- Leave out running headers, running footers and page numbers.
- Prefix chapter titles with "# " and section titles with "## ".
- Wrap italic text in single asterisks, like *this*. Write a scene break as a line containing only "***".
- Put footnotes after the page text, each as its own paragraph starting with its marker.
- If the photo shows two facing pages, transcribe the left page, then the right page.
- Ignore partial text from a neighbouring page that is cut off at the edge of the photo.
- If the page has no text (blank page, illustration only), output nothing.`;

/** Transcrit une photo de page (JPEG déjà redimensionné par le navigateur). */
export async function recognizeOnServer(jpeg) {
  if (engine === 'gemini') return recognizeWithGemini(jpeg);
  if (engine === 'claude') return recognizeWithClaude(jpeg);
  throw new OcrError('OCR serveur désactivé : aucune clé API configurée.');
}

// ---------------------------------------------------------------- Gemini
// Chaque modèle a son propre quota gratuit : quand l'un est épuisé, on passe au suivant.
// Gemma a un quota bien plus large que Gemini Flash, mais lit un peu moins bien.

const GEMINI_MODELS = (process.env.OCR_MODEL || 'gemini-flash-latest,gemini-flash-lite-latest,gemma-3-27b-it')
  .split(',').map((m) => m.trim()).filter(Boolean);
const unavailableUntil = new Map(); // modèle -> date (ms) à partir de laquelle le réessayer

/** Prochaine remise à zéro des quotas quotidiens Google (minuit, heure du Pacifique ≈ 7 h UTC). */
function nextQuotaReset() {
  const reset = new Date();
  reset.setUTCHours(7, 0, 0, 0);
  if (reset <= new Date()) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset.getTime();
}

let gemini;

async function recognizeWithGemini(jpeg) {
  gemini ??= new GoogleGenAI({ apiKey: GEMINI_KEY });
  let lastError;
  for (const model of GEMINI_MODELS) {
    if ((unavailableUntil.get(model) ?? 0) > Date.now()) continue;
    try {
      return await callGemini(model, jpeg);
    } catch (err) {
      if (!(err instanceof GeminiApiError)) throw err;
      lastError = explainGeminiError(err, model);
      if (err.status === 429) {
        unavailableUntil.set(model, lastError.retryAfter ? Date.now() + lastError.retryAfter * 1000 : nextQuotaReset());
      } else if (err.status === 404 || (err.status === 400 && !/API key/i.test(err.message))) {
        // Modèle inexistant ou qui refuse les images : on l'écarte pour une heure.
        unavailableUntil.set(model, Date.now() + 3600 * 1000);
      } else {
        throw lastError;
      }
    }
  }

  // Tous les modèles sont momentanément indisponibles : attendre le premier qui se libère.
  const soonest = Math.min(...GEMINI_MODELS.map((m) => unavailableUntil.get(m) ?? 0));
  const wait = Math.ceil((soonest - Date.now()) / 1000);
  if (wait > 0 && wait <= 120) {
    throw new OcrError('Quota Gemini momentanément atteint, nouvel essai automatique…', wait);
  }
  if (wait > 120) {
    throw new OcrError('Quota gratuit Gemini épuisé pour aujourd\'hui sur tous les modèles : relance demain (↻).');
  }
  throw lastError ?? new OcrError('Aucun modèle Gemini disponible.');
}

async function callGemini(model, jpeg) {
  const response = await gemini.models.generateContent({
    model,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
        // Consignes dans le message (Gemma n'accepte pas d'instructions système).
        { text: `${SYSTEM_PROMPT}\n\nTranscribe this page.` },
      ],
    }],
  });

  if (response.promptFeedback?.blockReason) {
    throw new OcrError(`Gemini a refusé de lire cette page (${response.promptFeedback.blockReason}).`);
  }
  const finish = response.candidates?.[0]?.finishReason;
  if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') {
    throw new OcrError(`Gemini a interrompu la lecture de cette page (${finish}).`);
  }
  // Certains modèles entourent le texte d'un bloc de code Markdown : on le retire.
  return (response.text ?? '').trim().replace(/^```[a-z]*\n([\s\S]*?)\n?```$/, '$1').trim();
}

function explainGeminiError(err, model) {
  const detail = err.message || '';
  if (err.status === 429) {
    // Quota par jour : inutile d'insister avant demain. Quota par minute : on réessaie bientôt.
    if (/per.?day|PerDay|daily/i.test(detail)) {
      return new OcrError(`Quota gratuit du jour atteint pour ${model}.`);
    }
    const seconds = Number(detail.match(/retry in ([\d.]+)s/i)?.[1]) || 30;
    return new OcrError(`Quota par minute atteint pour ${model}.`, Math.ceil(seconds));
  }
  if (/API key not valid|API_KEY_INVALID/i.test(detail) || err.status === 401) {
    return new OcrError('Clé API Gemini invalide : vérifie GEMINI_API_KEY dans les variables Vercel, puis redéploie.');
  }
  if (err.status === 404) {
    return new OcrError(`Modèle introuvable (${model}) : vérifie la variable OCR_MODEL.`);
  }
  if (err.status === 403) {
    return new OcrError(`Accès refusé par Gemini : ${detail.slice(0, 300)}`);
  }
  if (err.status >= 500) {
    return new OcrError('Gemini est momentanément indisponible, nouvel essai automatique…', 30);
  }
  return new OcrError(`Erreur de l'API Gemini (${model}, ${err.status}) : ${detail.slice(0, 300)}`);
}

// ---------------------------------------------------------------- Claude

// Le repli automatique côté serveur (relance sur un autre modèle en cas de refus) n'existe pas pour Haiku.
const SERVER_FALLBACK = engine === 'claude' && !MODEL.includes('haiku')
  ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
  : {};

let claude;

async function recognizeWithClaude(jpeg) {
  claude ??= new Anthropic();
  let response;
  try {
    response = await claude.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      ...SERVER_FALLBACK,
      output_config: { effort: CLAUDE_EFFORT },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
            { type: 'text', text: 'Transcribe this page.' },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) throw explainClaudeError(err);
    throw err;
  }

  if (response.stop_reason === 'refusal') {
    throw new OcrError('Claude a refusé de transcrire cette page.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new OcrError('Transcription tronquée (page trop longue).');
  }
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

function explainClaudeError(err) {
  const detail = err.error?.error?.message || err.message;
  if (/credit balance/i.test(detail)) {
    return new OcrError('Crédit Anthropic insuffisant : ajoute du crédit sur console.anthropic.com (Billing).');
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new OcrError('Clé API Anthropic invalide : vérifie ANTHROPIC_API_KEY dans les variables Vercel, puis redéploie.');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new OcrError(`Accès refusé par l'API Anthropic : ${detail}`);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new OcrError(`Modèle introuvable (${MODEL}) : vérifie la variable OCR_MODEL.`);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new OcrError('Trop de requêtes vers Claude, nouvel essai automatique…', 30);
  }
  if (err instanceof Anthropic.APIConnectionError || err.status >= 500) {
    return new OcrError('Claude est momentanément indisponible, nouvel essai automatique…', 30);
  }
  return new OcrError(`Erreur de l'API Claude (${err.status ?? '?'}) : ${detail}`);
}
