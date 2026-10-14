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
   (quelques secondes par page ; le tout premier lancement télécharge d'abord le moteur). Si tu la fermes, la lecture reprend la prochaine fois que tu ouvres le livre.
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

Par défaut, les pages sont lues **dans ton navigateur** par **PaddleOCR v6** (open source, gratuit,
sans clé ni compte) :

- la photo est nettoyée (ombres, éclairage inégal, contraste) puis lue par les réseaux de neurones
  PP-OCRv6 (détection des lignes + reconnaissance, tous les caractères français) ;
- les paragraphes, titres, dialogues et mots coupés sont reconstruits à partir de la position des lignes
  (y compris sur une photo penchée ou une double page) ; les titres courants répétés en haut des pages
  sont retirés ;
- au premier lancement, le navigateur télécharge les modèles (≈ 45 Mo au total), gardés ensuite en
  cache ; puis environ 5 à 10 s par page sur ordinateur, un peu plus sur téléphone.

Le site envoie les en-têtes `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` (voir
`vercel.json`) : ils permettent au moteur d'utiliser plusieurs cœurs du processeur (≈ 3,5 fois plus
rapide).

### Moteurs en ligne (facultatif)

Si une clé est définie, la lecture passe par une IA en ligne à la place :

| Variable | Moteur | Coût |
|---|---|---|
| `GEMINI_API_KEY` | Gemini (cascade Flash → Flash-Lite → Gemma 3) | gratuit avec quotas quotidiens |
| `ANTHROPIC_API_KEY` | Claude (Haiku 5.5 par défaut) | payant à l'usage |

Pour revenir à PaddleOCR, supprime ces variables dans Vercel puis redéploie. Options : `OCR_ENGINE`
(`browser`, `gemini` ou `claude`), `OCR_MODEL`, `OCR_EFFORT`.

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
| `public/` | interface (bibliothèque, liseuse) |
| `public/ocr-worker.js` | lecture des pages dans le navigateur (PaddleOCR v6) |
| `public/layout.js` | reconstruction des paragraphes à partir des lignes détectées |
| `public/text.js` | mise en forme du texte, partagée entre navigateur et serveur |
| `lib/app.js` | API (Express) |
| `lib/storage/` | stockage : `cloud.js` (Upstash Redis + Vercel Blob privé) ou `local.js` (fichiers) |
| `public/preprocess.js` | nettoyage des photos avant lecture |
| `lib/ocr.js` | OCR serveur avec Gemini ou Claude |
| `lib/epub.js` | export EPUB |
| `api/index.js` | point d'entrée Vercel |
| `local-server.js` | serveur local |
