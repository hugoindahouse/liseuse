// Choisit le stockage : en ligne si Upstash Redis et Vercel Blob sont configurés, sinon fichiers locaux.

const hasRedis = Boolean(
  (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)
  && (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
);
// Un store Blob connecté au projet fournit soit un jeton (BLOB_READ_WRITE_TOKEN), soit son identifiant
// (BLOB_STORE_ID) : le SDK s'authentifie alors automatiquement via OIDC sur Vercel.
const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
const onVercel = Boolean(process.env.VERCEL);

/** Message d'erreur de configuration à afficher, ou null si tout va bien. */
export const configError = (() => {
  if (!onVercel) return null;
  const missing = [];
  if (!hasRedis) missing.push('une base Upstash Redis (variables KV_REST_API_URL et KV_REST_API_TOKEN introuvables)');
  if (!hasBlob) missing.push('un stockage Vercel Blob (variable BLOB_STORE_ID ou BLOB_READ_WRITE_TOKEN introuvable)');
  if (!process.env.APP_PASSWORD) missing.push('la variable APP_PASSWORD (mot de passe)');
  return missing.length
    ? `Configuration Vercel incomplète : ajoute ${missing.join(', ')} au projet, puis redéploie.`
    : null;
})();

export const storage = hasRedis && hasBlob ? await import('./cloud.js') : await import('./local.js');
