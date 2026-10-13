// Protection par mot de passe (activée quand la variable APP_PASSWORD est définie).

import crypto from 'node:crypto';

const PASSWORD = process.env.APP_PASSWORD || '';
const COOKIE = 'liseuse_auth';
const ONE_YEAR = 365 * 24 * 3600 * 1000;

export const authEnabled = Boolean(PASSWORD);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const sessionToken = crypto.createHmac('sha256', PASSWORD).update('liseuse-session-v1').digest('hex');

function hasValidCookie(req) {
  const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  return Boolean(match) && crypto.timingSafeEqual(Buffer.from(match[1]), Buffer.from(sessionToken));
}

export function requireAuth(req, res, next) {
  if (!authEnabled || hasValidCookie(req)) return next();
  res.status(401).json({ error: 'Non connecté' });
}

export async function login(req, res) {
  const given = String(req.body?.password ?? '');
  if (!authEnabled || !crypto.timingSafeEqual(sha256(given), sha256(PASSWORD))) {
    // Ralentit les tentatives de devinette.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  res.cookie(COOKIE, sessionToken, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: ONE_YEAR });
  res.status(204).end();
}

export function logout(req, res) {
  res.clearCookie(COOKIE);
  res.status(204).end();
}
