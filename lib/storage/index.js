// Choisit le stockage : en ligne si Upstash Redis et Vercel Blob sont configurés, sinon fichiers locaux.

const hasRedis = Boolean(
  (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)
  && (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
);
const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const onVercel = Boolean(process.env.VERCEL);

/** Message d'erreur de configuration à afficher, ou null si tout va bien. */
export const configError = (() => {
  if (!onVercel) return null;
  const missing = [];
  if (!hasRedis) missing.push('une base Upstash Redis');
  if (!hasBlob) missing.push('un stockage Vercel Blob');
  if (!process.env.APP_PASSWORD) missing.push('la variable APP_PASSWORD (mot de passe)');
  return missing.length
    ? `Configuration Vercel incomplète : ajoute ${missing.join(', ')} au projet, puis redéploie.`
    : null;
})();

export const storage = hasRedis && hasBlob ? await import('./cloud.js') : await import('./local.js');
