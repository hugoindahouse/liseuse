# 📚 Liseuse

Photographie les pages d'un livre avec ton téléphone ou ton ordinateur : l'application lit le texte (OCR),
recolle les paragraphes coupés d'une page à l'autre et te le présente en mode liseuse, lisible sur
ordinateur comme sur mobile. Tu peux aussi exporter le livre en **EPUB** (Kindle, Kobo, Apple Livres…).

## Mise en ligne sur Vercel (gratuit)

### 1. Créer le projet

1. Mets ce dossier sur un dépôt GitHub (privé de préférence).
2. Sur [vercel.com](https://vercel.com), connecte-toi avec GitHub → **Add New… → Project** → importe le dépôt.
   Laisse les réglages par défaut (le fichier `vercel.json` s'en charge) → **Deploy**.

### 2. Ajouter le stockage (dans le projet Vercel, onglet **Storage**)

1. **Create Database → Blob** → crée le store → **Connect** au projet.
2. **Create Database → Upstash for Redis** (Marketplace, offre gratuite) → **Connect** au projet.

Vercel ajoute tout seul les variables `BLOB_STORE_ID` (ou `BLOB_READ_WRITE_TOKEN`), `KV_REST_API_URL` et `KV_REST_API_TOKEN`.

### 3. Choisir un mot de passe

**Settings → Environment Variables** → ajoute `APP_PASSWORD` avec le mot de passe de ton choix.

### 4. Redéployer

**Deployments** → menu « ⋯ » du dernier déploiement → **Redeploy**. C'est en ligne !
S'il manque quelque chose, l'application affiche ce qu'il reste à configurer.

Ensuite, chaque modification poussée sur GitHub est déployée automatiquement.

## Utilisation

1. **+ Nouveau livre**, puis renseigne le titre et l'auteur.
2. **📷 Photographier** (ouvre l'appareil photo, une page à la fois) ou **🖼️ Ajouter des photos**
   (plusieurs d'un coup, triées par nom de fichier, donc dans l'ordre de prise de vue).
3. Les pages sont lues **dans ton navigateur** : garde la page du livre ouverte pendant la lecture
   (quelques secondes par page). Si tu la fermes, la lecture reprend la prochaine fois que tu ouvres le livre.
   **✎** permet de comparer la photo et le texte, et de corriger. **↑ ↓** pour réordonner,
   **↻** pour relancer la lecture d'une page.
4. **📖 Lire** : touche le bord droit ou gauche (ou glisse) pour tourner les pages. Sur ordinateur, utilise
   les flèches du clavier ou la molette. Touche le centre pour afficher le menu : sommaire, taille du texte,
   police, interligne, thème clair/sépia/sombre, mode pages ou défilement.
5. **⬇ EPUB** pour lire le livre dans n'importe quelle application de lecture.

Astuce : sur le téléphone, « Ajouter à l'écran d'accueil » donne une icône comme une vraie appli.

Conseils photo : page bien à plat, bonne lumière sans reflet, cadrage serré sur la page.
Sur iPhone, si une photo est refusée : Réglages → Appareil photo → Formats → « Le plus compatible ».

## Moteur de reconnaissance (OCR)

| Moteur | Qualité | Coût | Activation |
|---|---|---|---|
| **Tesseract**, dans le navigateur (par défaut) | correcte sur photos nettes | gratuit | rien à faire |
| **Claude** (vision), sur le serveur | excellente : mise en page, titres, italiques | payant à l'usage (API Anthropic) | variable `ANTHROPIC_API_KEY` |

Avec la variable `ANTHROPIC_API_KEY`, Claude est utilisé automatiquement. Les requêtes activent le repli
automatique côté serveur (`fallbacks: "default"`) : si le modèle refuse une requête, l'API la relance
avec un autre modèle.

Variables optionnelles : `OCR_ENGINE` (`claude` ou `browser`), `CLAUDE_MODEL` (défaut `claude-opus-5-5`),
`CLAUDE_EFFORT` (défaut `low`).

## En local (sur ton ordinateur)

Double-clique sur **`Lancer Liseuse.bat`**, ou :

```bash
npm install
npm start
```

Puis ouvre <http://localhost:3000>. Sans les variables Vercel, les livres sont stockés dans le dossier
`data/`. Variables utiles : `APP_PASSWORD`, `PORT` (défaut 3000), `DATA_DIR` (défaut `./data`).

## Organisation du code

| Fichier | Rôle |
|---|---|
| `public/` | interface (bibliothèque, liseuse, OCR Tesseract dans le navigateur) |
| `public/text.js` | mise en forme du texte, partagée entre navigateur et serveur |
| `lib/app.js` | API (Express) |
| `lib/storage/` | stockage : `cloud.js` (Upstash Redis + Vercel Blob privé) ou `local.js` (fichiers) |
| `lib/ocr.js` | OCR avec Claude |
| `lib/epub.js` | export EPUB |
| `api/index.js` | point d'entrée Vercel |
| `local-server.js` | serveur local |
