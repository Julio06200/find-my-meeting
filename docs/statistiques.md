# Statistiques de Find My Meeting

Deux dispositifs **séparés** :

| | 1. Umami (actif dès que l'ID est renseigné) | 2. Compteurs agrégés par candidat (désactivé) |
|---|---|---|
| Rôle | Audience générale : visites, pages, sources, UTM, actions | Classement des meetings / candidats / partis les plus consultés |
| Données politiques | **Aucune** | Uniquement des totaux par meeting, jamais par personne |
| Lien avec un visiteur | Session Umami anonyme (sans cookie) | **Aucun** : envoyé par le serveur, le lendemain, sans IP ni horaire |
| Où lire les chiffres | Dashboard Umami | Le même dashboard Umami (événement `vues-candidat`) |
| Activation | `umamiWebsiteId` dans `site/config.js` | Après la checklist RGPD ci-dessous |

## 1. Umami

### Où est le script ?
Vous n'avez **rien à coller dans le HTML**. Le site charge `site/config.js` puis `site/analytics.js` dans le `<head>` de `index.html` et `confidentialite.html`. `analytics.js` insère lui-même le script Umami avec ces réglages :

```html
<script defer src="https://cloud.umami.is/script.js"
  data-website-id="VOTRE-ID"
  data-auto-track="false"          <!-- aucun envoi automatique : tout passe par fmmStats -->
  data-exclude-hash="true"         <!-- jamais #m=… ni #r=… -->
  data-do-not-track="true"         <!-- respecte « Ne pas me pister » -->
  data-domains="julio06200.github.io"
  data-before-send="fmmUmamiBeforeSend"></script>  <!-- filet de sécurité avant chaque envoi -->
```

`fmmUmamiBeforeSend` réécrit chaque envoi : chemin générique pris dans une liste blanche, seuls les paramètres `utm_*` et `ref` sont conservés, référent réduit au nom de domaine, aucun identifiant visiteur, et seules les propriétés d'événement autorisées passent (tout autre événement est bloqué).

### Ce dont j'ai besoin depuis votre compte Umami Cloud
1. **Website ID** : Settings → Websites → Find My Meeting → *Edit* → identifiant de la forme `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (il apparaît aussi dans le code de suivi).
2. **L'URL du script** indiquée dans le code de suivi (normalement `https://cloud.umami.is/script.js` ; à vérifier si votre compte est sur une autre région).
3. Le **domaine** déclaré lors de la création du site : `julio06200.github.io` (ou votre futur nom de domaine).

L'identifiant n'est pas un secret : il est de toute façon visible dans le code de la page.

### Pages et événements envoyés

| Nom | Quand | Propriétés (valeurs fermées) | Limite / chargement |
|---|---|---|---|
| page vue `/` `/quiz` `/methodologie` `/meeting-partage` `/resultat-partage` `/confidentialite` | changement de vue | — (UTM conservés) | 1 par vue |
| `recherche` | ville choisie, code postal ou « Autour de moi » | `methode` : ville / code-postal / geolocalisation ; `resultats` : 0 / 1-5 / 6+ | 3 |
| `fiche-meeting` | ouverture d'un lien partagé, clic carte, clic source, clic itinéraire | `origine` : lien-partage / carte / source / itineraire | 8 (1 par meeting) |
| `quiz-debut` | clic « Commencer » | — | 1 |
| `quiz-fin` | dernière question validée | — (ni réponses ni score) | 1 |
| `calendrier` | ajout au calendrier | — | 5 |
| `partage` | partage d'un meeting ou du résultat | `objet` : meeting / resultat / site ; `canal` : natif / copie / image / whatsapp / x / linkedin | 5 |

Ni ville saisie, ni candidat, ni parti, ni score ne sont transmis. Plafond global : 25 envois par chargement de page.

### Budget de l'offre gratuite (100 000 événements / mois, 1 site, 6 mois de conservation)
Une visite type envoie 2 à 4 événements (1 page vue + 1 recherche + 1 à 2 actions) : le quota couvre environ **25 000 à 40 000 visites par mois**. Au-delà (pic médiatique), désactiver temporairement certains événements dans `ALLOWED`/`CAPS` de `site/analytics.js`, ou passer à l'offre payante. Les pages vues comptent dans le quota.

### Tester après déploiement
1. **Sans rien envoyer** : ouvrez `https://julio06200.github.io/find-my-meeting/?fmm_debug_stats=1`, ouvrez la console du navigateur (F12) : chaque envoi s'affiche (`[stats] …`) avec l'URL nettoyée.
2. **En réel** : ouvrez le site normalement dans une fenêtre privée, puis Umami → *Realtime* : votre visite apparaît en quelques secondes.
3. Faites une recherche de ville, cliquez « Source » sur une fiche, ajoutez au calendrier, faites le quiz, partagez → Umami → *Events* : `recherche`, `fiche-meeting`, `calendrier`, `quiz-debut`, `quiz-fin`, `partage`.
4. **UTM** : ouvrez `…/find-my-meeting/?utm_source=test&utm_medium=email&utm_campaign=essai` → Umami → *UTM* (ou filtre *Query*) : `test / email / essai`.
5. **Vérifier qu'aucune donnée politique ne part** : F12 → onglet *Réseau* → filtre `api/send` → ouvrez une requête : `url` ne contient jamais `#`, ni nom de candidat, ni score.
6. **Opposition** : page Confidentialité → cochez « Ne pas mesurer mes visites » → plus aucune requête `api/send`.
7. Le bloqueur de publicité du testeur peut bloquer Umami : testez aussi sans.

## 2. Compteurs agrégés par candidat et parti (dossier `worker/`) — DÉSACTIVÉ

### Pourquoi un dispositif séparé
Dans Umami, chaque événement est rattaché à une session (même sans cookie) et le tableau de bord permet de consulter le parcours d'une session. Envoyer « fiche du meeting de X consultée » à Umami depuis le navigateur permettrait donc de relier un intérêt politique à une visite (pays, ville, appareil, horaire). C'est exclu.

### Fonctionnement
1. Le navigateur envoie à un Cloudflare Worker **uniquement l'identifiant public du meeting** (`melenchon-2026-12-05-le-havre-1500`), sans cookie (`credentials: omit`), sans référent (`no-referrer`), une fois par meeting et par chargement de page, lors des mêmes actions que `fiche-meeting` et `calendrier`.
2. Le Worker vérifie que le meeting existe, puis incrémente un compteur `(jour, meeting) +1` en base D1. **Il ne lit ni ne stocke l'IP, le User-Agent ou l'heure.** Les journaux du Worker sont désactivés.
3. Chaque nuit, il agrège la veille avec un **seuil K = 5** : un meeting n'est détaillé que s'il a au moins 5 consultations ; sinon il est regroupé en « Autres meetings » du candidat, puis en « Autres (moins de 5 vues) » ; en dessous de 5 au total, rien n'est publié.
4. Il envoie ces totaux à Umami **depuis le serveur** (événement `vues-candidat` avec `candidat`, `parti`, `meeting`, `jour`), puis **supprime les compteurs**.
5. Dans Umami → *Events* → `vues-candidat` → propriétés `candidat`, `parti` ou `meeting` : classements directs, sans second tableau de bord. Ces envois apparaissent comme une seule « visite » technique par jour (page `/agregats`), à exclure des chiffres d'audience avec un filtre.

L'offre gratuite Umami n'autorise qu'un site : les agrégats partagent donc le site principal. Coût en quota : 1 événement par consultation publiée.

### Checklist RGPD à valider AVANT activation
- [ ] **Registre des traitements** : inscrire « mesure d'audience Umami » et « compteurs agrégés de consultation » (finalité, base légale : intérêt légitime, durée).
- [ ] **Article 9 (opinions politiques)** : faire confirmer par un juriste ou DPO que le dispositif ne traite pas d'opinion politique d'une personne identifiable — seule la requête HTTP transite (l'IP est vue par Cloudflare en transit, non conservée) ; les données stockées sont anonymes et agrégées.
- [ ] **Sous-traitants** : accepter le DPA de Cloudflare et celui d'Umami ; vérifier la localisation (Umami Cloud : serveurs aux États-Unis et en UE ; Cloudflare : réseau mondial) et la base des transferts hors UE (Data Privacy Framework).
- [ ] **Exemption de consentement (CNIL)** : vérifier avec l'outil d'auto-évaluation CNIL (juillet 2025) que la configuration Umami respecte les conditions : finalité strictement limitée à la mesure d'audience, données anonymes, pas de recoupement, conservation ≤ 25 mois (6 mois ici), information et droit d'opposition (case sur la page Confidentialité).
- [ ] **Journaux désactivés** dans le tableau de bord Cloudflare (Workers Logs / Logpush) pour `fmm-compteurs`.
- [ ] **Page Confidentialité** : ajouter un paragraphe décrivant les compteurs agrégés (texte proposé ci-dessous).
- [ ] **Test** du seuil K et de la suppression (le test hors ligne fourni le vérifie : 7 vues publiées, 3 + 1 vues sous le seuil non publiées, base vide après envoi).

Texte à ajouter à la page Confidentialité lors de l'activation :
> « Pour savoir quels meetings intéressent le plus, nous comptons, sans cookie ni identifiant, le nombre de consultations de chaque meeting. Seul l'identifiant public du meeting est envoyé ; ni votre adresse IP ni l'heure ne sont conservées. Les totaux de la veille sont publiés de façon groupée (au moins 5 consultations), puis effacés. »

### Activation (une fois la checklist validée)
```bash
cd worker
npx wrangler login
npx wrangler d1 create fmm-compteurs          # copier database_id dans wrangler.toml
npx wrangler d1 execute fmm-compteurs --remote --file=schema.sql
# renseigner UMAMI_WEBSITE dans wrangler.toml, puis :
npx wrangler deploy                           # affiche l'URL https://fmm-compteurs.<compte>.workers.dev
```
Puis mettre cette URL dans `candidateStatsUrl` de `site/config.js` et ajouter le paragraphe à la page Confidentialité.
