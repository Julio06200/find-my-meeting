-- Compteurs agrégés : aucune IP, aucun User-Agent, aucune heure, aucun identifiant de visiteur.
CREATE TABLE IF NOT EXISTS counts (
  day        TEXT NOT NULL,   -- AAAA-MM-JJ (Europe/Paris)
  meeting_id TEXT NOT NULL,
  candidate  TEXT NOT NULL,
  party      TEXT NOT NULL,
  label      TEXT NOT NULL,   -- "Ville — date" du meeting
  n          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, meeting_id)
);
