// Reconnaissance de texte (OCR) côté serveur avec Claude (vision).
// Sans clé API, l'OCR se fait dans le navigateur avec Tesseract (voir public/app.js).

import Anthropic from '@anthropic-ai/sdk';

const CLAUDE_MODEL = process.env.OCR_MODEL || 'claude-haiku-5-5';
const CLAUDE_EFFORT = process.env.OCR_EFFORT || 'low';
// Le repli automatique côté serveur (relance sur un autre modèle en cas de refus) n'existe pas pour Haiku.
const SERVER_FALLBACK = !CLAUDE_MODEL.includes('haiku')
  ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
  : {};

export const engine = (() => {
  const wanted = (process.env.OCR_ENGINE || 'auto').toLowerCase();
  if (wanted === 'claude' || wanted === 'browser') return wanted;
  return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? 'claude' : 'browser';
})();

export function engineLabel() {
  return engine === 'claude' ? `Claude (${CLAUDE_MODEL})` : 'Tesseract, dans le navigateur';
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

let client;

/** Transforme une erreur de l'API Claude en message clair pour l'utilisateur. */
function explainApiError(err) {
  const detail = err.error?.error?.message || err.message;
  if (/credit balance/i.test(detail)) {
    return 'Crédit Anthropic insuffisant : ajoute du crédit sur console.anthropic.com (Billing).';
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Clé API Anthropic invalide : vérifie ANTHROPIC_API_KEY dans les variables Vercel, puis redéploie.';
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return `Accès refusé par l'API Anthropic : ${detail}`;
  }
  if (err instanceof Anthropic.NotFoundError) {
    return `Modèle introuvable (${CLAUDE_MODEL}) : vérifie la variable OCR_MODEL.`;
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Trop de requêtes vers Claude pour le moment : relance la page (↻) dans une minute.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Impossible de joindre l\'API Claude : relance la page (↻).';
  }
  return `Erreur de l'API Claude (${err.status ?? '?'}) : ${detail}`;
}

/** Transcrit une photo de page (JPEG déjà redimensionné par le navigateur). */
export async function recognizeWithClaude(jpeg) {
  try {
    return await callClaude(jpeg);
  } catch (err) {
    if (err instanceof Anthropic.APIError) throw new Error(explainApiError(err));
    throw err;
  }
}

async function callClaude(jpeg) {
  client ??= new Anthropic();

  const response = await client.beta.messages.create({
    model: CLAUDE_MODEL,
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

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude a refusé de transcrire cette page.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Transcription tronquée (page trop longue).');
  }
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}
