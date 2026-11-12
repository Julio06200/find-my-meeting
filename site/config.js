/* Réglages de Find My Meeting — seul fichier à modifier pour configurer le site. */
window.FMM_CONFIG = {
  siteUrl: "https://julio06200.github.io/find-my-meeting/",

  /* Signalement d'erreur : adresse e-mail (recommandé). Vide = signalement via une issue GitHub. */
  reportEmail: "",
  reportGithub: "https://github.com/Julio06200/find-my-meeting/issues/new",

  /* Statistiques Umami Cloud (sans cookie). Vide = aucune statistique envoyée. Voir docs/statistiques.md */
  umamiWebsiteId: "",
  umamiScript: "https://cloud.umami.is/script.js",
  umamiDomains: "julio06200.github.io",

  /* Compteurs agrégés par meeting / candidat / parti (service séparé, dossier worker/).
     NE PAS renseigner avant d'avoir validé la checklist RGPD de docs/statistiques.md. */
  candidateStatsUrl: ""
};
