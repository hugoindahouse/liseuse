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

/** Transcrit une photo de page (JPEG déjà redimensionné par le navigateur). */
export async function recognizeWithClaude(jpeg) {
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
