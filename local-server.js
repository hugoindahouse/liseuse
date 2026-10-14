// Serveur local : `npm start`. En ligne, c'est Vercel qui sert public/ et api/index.js.

import os from 'node:os';
import path from 'node:path';
import express from 'express';
import qrcode from 'qrcode-terminal';

import { app } from './lib/app.js';
import { storage } from './lib/storage/index.js';
import { engineLabel } from './lib/ocr.js';
import { authEnabled } from './lib/auth.js';

const PORT = Number(process.env.PORT) || 3000;

const server = express();
// Isolation cross-origin (comme sur Vercel, voir vercel.json) : permet au moteur de lecture
// d'utiliser plusieurs cœurs du processeur, environ 3,5 fois plus rapide.
server.use((req, res, next) => {
  res.set({ 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
  next();
});
server.use(app);
server.use(express.static(path.resolve('public')));

server.listen(PORT, '0.0.0.0', () => {
  const lanAddresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${PORT}`);

  console.log(`\n📚 Liseuse démarrée — OCR : ${engineLabel()} — stockage : ${storage.kind === 'cloud' ? 'en ligne' : 'local (dossier data/)'}`);
  console.log(authEnabled ? '   🔒 Protégée par mot de passe\n' : '   ⚠️  Aucun mot de passe (définis APP_PASSWORD pour en mettre un)\n');
  console.log(`   Sur cet ordinateur : http://localhost:${PORT}`);
  for (const url of lanAddresses) console.log(`   Sur le téléphone   : ${url}  (même réseau Wi-Fi)`);
  if (lanAddresses[0]) {
    console.log('\n   Scanne ce QR code avec ton téléphone :\n');
    qrcode.generate(lanAddresses[0], { small: true });
  }
});
