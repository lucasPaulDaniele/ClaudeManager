# Fixtures d'environnement — capture réelle

Principe fondateur n°5 : *pas de mocks du système réel*. Le fichier de ce dossier est une **vraie
capture**, prise dans le contexte exact qui compte — un shell lancé par une session Claude Code
s'exécutant dans le terminal intégré de VSCode, c'est-à-dire la configuration **de production**
de ClaudeManager, et non un cas limite.

---

## `claude-session-env-names.json`

| | |
|---|---|
| Commande | `Object.keys(process.env)`, filtré par `INHERITED_ENVIRONMENT` (`tests/integration/src/environment.ts`) |
| Où | Poste de développement Windows 11 Pro 10.0.22000, VSCode 1.122.1, session Claude Code dans le terminal intégré |
| Quand | 2026-07-26 |
| Contenu | 21 **noms** de variables héritées, triés — aucune valeur |

**Seuls les noms sont versionnés.** Les valeurs portent des chemins personnels (`VSCODE_CWD`,
`CLAUDE_CODE_EXECPATH`), des noms de tubes nommés (`CHROME_CRASHPAD_PIPE_NAME`,
`VSCODE_IPC_HOOK`) et des identifiants de session. Le dépôt est public : cette forme est une
contrainte, pas un choix esthétique. Un nom de variable suffit d'ailleurs à ce qu'elle prouve —
l'assainissement se juge sur la **présence**, jamais sur le contenu.

**Pourquoi 21 et non 19.** Le lanceur d'intégration en a supprimé **19** le 2026-07-25 et **21**
ici : le compte varie d'une session à l'autre. C'est exactement pourquoi le lanceur filtre par
**famille de préfixes** (`CLAUDECODE`, `CLAUDE_`, `VSCODE_`, `ELECTRON_`, `CHROME_`) plutôt que
par liste nommée — une liste nommée aurait laissé passer les deux nouvelles. La fixture ne sert
donc pas de liste de référence à comparer champ à champ : elle sert de **jeu d'entrée réel**,
dont on vérifie qu'aucun nom n'échappe au filtre.

**`knownFatalToElectron`** distingue ce qui est **mesuré** de ce qui ne l'est pas :

- `ELECTRON_RUN_AS_NODE` — **mesuré**. Le binaire VSCode démarre en Node et traite le premier
  argument de lancement comme un script (`Cannot find module <dossier de travail>`), sans qu'aucun
  message n'en indique la cause. Identique, l'appel passe depuis un shell propre.
- `VSCODE_IPC_HOOK`, `VSCODE_ESM_ENTRYPOINT` — retirées par la **même règle de famille**, mais
  leur symptôme propre **n'a pas été mesuré isolément**. C'est écrit tel quel plutôt que rangé
  sous un « fatal » global qui prétendrait davantage.
