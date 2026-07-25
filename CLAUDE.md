# ClaudeManager — pilotage programmatique des conversations Claude dans VSCode

## Vision

Donner à un agent Claude la capacité d'**ouvrir, observer et fermer des conversations Claude dans l'UI de l'extension VSCode**, de façon fiable, sans jamais dépendre du focus ni se tromper de fenêtre.

Le besoin naît de la skill `/orchestrer` : elle impose « une conversation orchestratrice = un lot » et doit donc, en fin de lot, **fermer sa conversation et en ouvrir une neuve**. Aujourd'hui cette étape exige un humain passe-plat. ClaudeManager la supprime.

## Stack technique

- **Langage** : TypeScript (strict), Node 20+
- **Monorepo** : npm workspaces
- **Extension VSCode** : API `vscode` ^1.90, packagée en VSIX (`@vscode/vsce`)
- **Tests unitaires/intégration** : Vitest
- **Tests d'extension** : `@vscode/test-electron` (vraie instance VSCode)
- **Couverture** : `@vitest/coverage-v8` (**100 % sur `core`, 90 % global**)
- **Lint** : ESLint flat config + `typescript-eslint`
- **CI** : GitHub Actions (lint, typecheck, tests unitaires avec seuils de couverture). Le **build** et le **packaging VSIX** ne sont pas encore outillés : ils relèvent du **lot E**.

## Principes fondateurs

1. **Jamais de dépendance au focus — ESSENTIEL.** Toute opération doit fonctionner sur une fenêtre **minimisée, masquée, sur un autre bureau virtuel ou derrière d'autres applications**. Sont **interdits** : l'automatisation clavier/souris (`robotjs`, `nut.js`, `SendKeys`, AutoHotkey), l'activation ou la mise au premier plan d'une fenêtre, et toute API exigeant qu'un élément ait le focus. Motif : l'outil s'exécute pendant que l'humain travaille ailleurs ; voler le focus rendrait le poste inutilisable et rendrait le pilotage non déterministe. `vscode.commands.executeCommand` satisfait cette contrainte, aucune automatisation d'UI ne la satisfait.
   Ce principe n'est pas qu'une intention : il a été **éprouvé**. La voie d'ouverture retenue a été mesurée fenêtre **minimisée**, handle de premier plan **identique avant, pendant et après** (`docs/adr/002-ouverture-interactive.md`). Un assouplissement temporaire — autoriser l'emprunt de focus sous conditions — avait été accordé le 2026-07-25 pour juger une voie sur pièce plutôt que sur principe ; il a été **retiré le jour même, sur preuve**, la voie retenue n'empruntant aucun focus. Le principe est donc strict, **sans exception**.

2. **L'isolation de fenêtre est l'invariant du produit.** C'est à ClaudeManager ce que le RLS est à une base multi-tenant. Toute opération est précédée d'une **vérification d'appartenance** : le processus appelant est-il un descendant de cette fenêtre ? Une commande émise depuis la fenêtre A ne doit **jamais** affecter la fenêtre B — **y compris quand A et B ouvrent le même dossier**. `VSCODE_PID` ne discrimine pas les fenêtres (un processus principal en héberge plusieurs) : ne jamais l'utiliser comme clé d'identité.

3. **Adhérence assumée à des API internes.** L'outil s'appuie sur des commandes (`claude-vscode.*`) et des formats de fichiers (`~/.claude/**`) **non documentés et non contractuels**, qui peuvent disparaître à toute mise à jour de l'extension Claude. Conséquences impératives :
   - **Échouer explicitement, jamais dégrader en silence.** Une commande absente est une erreur nommée, pas un `no-op`.
   - Toute dépendance à une API interne est **déclarée dans `docs/compatibilite.md`** avec la version d'extension sur laquelle elle a été vérifiée.
   - `cmgr doctor` vérifie les présupposés et le dit à l'utilisateur.
   - Avant toute évolution, se demander : « que se passe-t-il si l'extension change ce comportement ? »

4. **Le cœur ne connaît pas VSCode.** `packages/core` n'importe **jamais** le module `vscode`. Toute la logique (identité, registre, sessions, transcripts) y vit et est testable en Node pur. `packages/vscode` ne contient que ce qui exige l'API de l'éditeur. Motif : sans cette règle, tester devient impossible sans lancer un éditeur complet.

5. **Pas de mocks du système réel.** Les tests d'intégration tournent contre une **vraie instance VSCode**, jamais contre un faux `vscode.commands`. Les tests unitaires du cœur consomment des **fixtures capturées réelles** (vrais transcripts JSONL, vrais lockfiles, vraies sorties de `claude agents --json`), jamais des doubles inventés. Motif : les bugs de cet outil naissent précisément des écarts entre le comportement supposé et le comportement réel de l'écosystème Claude — un mock reproduit la supposition, pas le réel.

6. **Sortie machine-lisible par défaut.** La CLI écrit du **JSON sur stdout** et les diagnostics sur **stderr**, et porte un code de sortie signifiant. Motif : le consommateur principal est un agent, pas un humain.

7. **Rattrapage de l'existant.** Pour **toute** modification, se demander ce que deviennent les états déjà en place : registres de fenêtres écrits par une version antérieure, hooks déjà installés dans `~/.claude/settings.json`, conversations déjà ouvertes. Un changement de format de registre doit lire l'ancien ou le purger explicitement ; `install-hook` doit être **idempotent** et ne jamais écraser une configuration utilisateur sans sauvegarde. En cas de doute sur l'état réel d'une machine, **poser la question** plutôt que supposer.

## Structure du projet

```
ClaudeManager/
├── packages/
│   ├── core/               # @claudemanager/core — logique, ZÉRO import de `vscode`
│   │   └── src/
│   │       ├── identity/   # résolution « ma fenêtre » par chaîne d'ancêtres
│   │       ├── registry/   # registre des fenêtres pilotables, auto-nettoyant
│   │       ├── sessions/   # inventaire des sessions Claude vivantes
│   │       ├── transcript/ # lecture JSONL, fin de tour, extraction de réponse
│   │       └── client/     # client HTTP de l'extension compagnon
│   ├── vscode/             # claudemanager-vscode — extension compagnon
│   ├── cli/                # @claudemanager/cli — binaire `cmgr`
│   └── mcp/                # @claudemanager/mcp — serveur MCP stdio
├── docs/
│   ├── adr/                # décisions structurantes, datées
│   ├── architecture.md
│   └── compatibilite.md    # matrice des API internes utilisées
├── tests/
│   ├── unit/
│   ├── integration/        # vraie instance VSCode
│   ├── e2e/                # scénarios multi-fenêtres
│   └── fixtures/           # captures réelles (JSONL, locks, sorties CLI)
├── .github/workflows/ci.yml
├── CLAUDE.md
├── README.md
└── package.json
```

## Lots

Le chantier est découpé pour la skill `/orchestrer` : **1 incrément = 1 PR**, gate d'audit toutes les 3 PRs mergées et en fin de lot.

| Lot | Contenu |
|---|---|
| **0** | Socle : spike de faisabilité (jetable), squelette, conventions, CI |
| **A** | Trancher le mécanisme d'ouverture interactive : spike comparatif des voies, ADR-002, réalignement du socle documentaire |
| **B** | Noyau : identité, registre, extension compagnon, CLI de lecture, tests d'intégration |
| **C** | Ouverture et fermeture : mécanisme V1 implémenté, `cmgr open`, `cmgr close`, E2E multi-fenêtres |
| **D** | Observabilité : transcript, hook `Stop`, `cmgr read` / `cmgr wait` / `cmgr doctor` |
| **E** | Diffusion : serveur MCP, packaging, README de diffusion, recette bout-en-bout |

## Mécanisme retenu

Arbitré le 2026-07-25 au vu de mesures sur pièce — voir `docs/adr/002-ouverture-interactive.md` (voie V1). Il **remplace** celui de `docs/adr/001-pilotage-des-conversations.md`, rejeté en recette : le tour 1 y était joué en headless, donc **non interactif**.

**Ouvrir une conversation = jouer le tour 1 dans un terminal masqué, puis attacher le panneau à cette session.**

Dans la fenêtre cible, et dans cet ordre :

1. Générer un `uuid`.
2. Créer un terminal **masqué** — `hideFromUser: true`, `show()` **jamais** appelé — dans le workspace de la fenêtre, en **neutralisant les variables d'environnement héritées** de la session Claude appelante (`env: { CLAUDECODE: null, CLAUDE_CODE_CHILD_SESSION: null, … }` — les huit variables recensées dans `docs/compatibilite.md`). **Cette neutralisation fait partie du mécanisme, pas de son implémentation** : sans elle, le `claude` lancé se déclare agent enfant non interactif et cesse d'écrire son transcript, silencieusement.
3. Y jouer le tour 1 dans un vrai pty : `claude --session-id <uuid> "<prompt>"`. Le prompt positionnel est **soumis automatiquement** au démarrage de la session interactive.
4. Attacher le panneau : `claude-vscode.editor.open(<uuid>)`. Le `cwd` de la session doit correspondre au workspace de la fenêtre, faute de quoi la commande **réussit en ouvrant un panneau vide** — l'absence d'erreur ne prouve jamais l'attachement.
5. Faire disparaître le terminal : `terminal.dispose()`. Le `claude` du panneau survit, l'onglet reste intact.

Durée de visibilité du terminal pour l'humain : **nulle**. Mesuré fenêtre minimisée, sans aucun emprunt de focus.

**Fermer** = `vscode.window.tabGroups.close(tab)` sur l'onglet dont le `viewType` contient `claudeVSCodePanel`.

**Repli officiel — la voie V5.** Si `claude-vscode.editor.open` perd son paramètre de session, si `--session-id` cesse d'être accepté en mode interactif, ou si toute autre évolution de l'extension Claude rend V1 inopérant, l'outil **bascule sur `claude-vscode.editor.open(null, <prompt>)`** plutôt que d'échouer sans recours : la conversation est ouverte, le prompt pré-rempli, l'humain n'a plus qu'à valider. Perte d'autonomie assumée — mieux vaut un geste humain qu'une conversation non ouverte. C'est une **exigence de conception des lots B et C**, pas un simple classement au tableau.

Le paramètre `initialPrompt` de `editor.open` **n'est jamais utilisé pour soumettre** : il se contente de pré-remplir le champ de saisie. C'est prouvé **deux fois** — au source (il appelle `setInputText`, rien d'autre) et par mesure. Et la frappe qui manque n'est pas rattrapable : mesuré aussi, les frappes synthétiques n'atteignent pas le champ du webview, avec ou sans focus. **Ne pas y revenir sans ADR.** Le repli V5 s'appuie sur ce même paramètre, mais en assumant la validation humaine.

**Contrainte induite — la réponse du tour 1 n'est plus rendue à l'appelant.** Le tour 1 étant joué dans un terminal dont la sortie n'est pas capturée, sa réponse ne s'obtient que par le **transcript** (`~/.claude/projects/<slug>/<sessionId>.jsonl`) ou par le **hook `Stop`**, c'est-à-dire par le **lot D**. `cmgr open --wait` n'est donc pas une commodité d'affichage : c'est le **seul** moyen d'obtenir la réponse du premier tour, et il dépend du lot D.

## Périmètre — ce que l'outil ne fait pas

Ces exclusions sont des **décisions**, pas des manques. Ne pas les réintroduire sans ADR.

- **Écrire dans une conversation déjà attachée.** Aucun canal ne le permet — et ce n'est plus une supposition : **mesuré**, même avec le focus et la frappe, la soumission n'a pas lieu. Les frappes synthétiques n'atteignent pas le champ de saisie du webview, ni par injection sans focus (Chromium n'expose aucune fenêtre enfant adressable), ni fenêtre au premier plan. Voir `docs/adr/002-ouverture-interactive.md`, voie V3.
- **Arrêter un prompt en cours.** Aucune primitive propre n'existe. Livrer un `stop` bancal serait pire que ne rien livrer.
- **Piloter une autre fenêtre que la sienne.** Volontaire : l'enjeu est l'isolation stricte, pas le pilotage croisé.

## Conventions de code

- **Langue du code** : anglais (identifiants, types, messages d'erreur techniques).
- **Langue des docs, ADR, commentaires d'intention et README** : français.
- **TypeScript strict** : `strict: true`, pas de `any` implicite ni explicite non justifié par un commentaire.
- **Pas de `console.log` en librairie** : `core` ne journalise pas, il retourne des résultats. Seules la CLI et l'extension écrivent des sorties.
- **Erreurs typées** : toute défaillance prévisible (commande absente, fenêtre introuvable, session inconnue) est une erreur nommée avec un code stable, jamais une chaîne libre — la CLI et le MCP les rendent tels quels à l'appelant.
- **Chemins** : jamais de séparateur codé en dur, toujours `node:path`. L'outil cible Windows en premier mais ne doit pas s'y enfermer.
- **Aucun secret ni token en clair dans les logs** : les tokens du registre sont masqués à l'affichage.

## Workflow Git

### Branches

| Branche | Rôle | Protégée |
|---|---|---|
| `main` | Version publiée, taguée | Oui |
| `develop` | Intégration des lots terminés | Oui |
| `integration/<lot>` | Branche d'intégration d'un lot | Non |
| `feature/<lot>/<nom>` | Développement d'un incrément | Non |
| `fix/<description>` | Correction de bug | Non |

### Cycle de développement

1. Créer la branche depuis la branche d'intégration du lot : `git checkout integration/lot-a && git pull && git checkout -b feature/lot-a/identity`
2. Commits conventionnels `<type>(<scope>): <description>` — types `feat, fix, refactor, test, docs, chore, ci` ; scope = paquet (`core`, `vscode`, `cli`, `mcp`, `docs`).
   Exemples : `feat(core): resolve owning window by process ancestry` · `fix(cli): keep UTF-8 when reading prompt files on Windows` · `test(core): add captured JSONL fixtures for turn detection`
3. `git push -u origin feature/lot-a/identity` puis `gh pr create --base integration/lot-a`
4. **Critères de merge (PR → branche d'intégration)** : `npm run ci` vert · tests d'intégration locaux verts avec **log de preuve joint à la PR** · pas de régression de couverture · self-review documentée.
5. **Fin de lot** : PR `integration/<lot>` → `develop`, en **merge commit** (jamais squash — la traçabilité de chaque incrément est conservée).
6. **Release** : `develop` → `main`, tag, publication du VSIX.

### Règles

- **Ne jamais commiter directement sur `main` ou `develop`.**
- **Ne jamais force-push** sur les branches protégées.
- **Ne jamais ajouter `Co-Authored-By`** dans les commits.
- **Un commit = un changement logique.**
- **Toujours inclure les tests** dans le même commit que le code qu'ils couvrent.
- **Supprimer la branche** après merge.

## Tests

- **Unitaires** (`tests/unit/`) : tout `core`, contre des fixtures capturées. Couverture exigée **100 %**.
- **Intégration** (`tests/integration/`) : une **vraie fenêtre VSCode** via `@vscode/test-electron`, avec l'extension compagnon chargée. Valide le serveur local, le registre, `tabGroups`.
- **E2E** (`tests/e2e/`) : scénarios multi-fenêtres réels, avec l'extension Claude authentifiée. **Scénario de référence, non négociable** : deux fenêtres dont une **minimisée**, ouvrant **le même répertoire physique** → une commande émise depuis A n'affecte jamais B, et **A ne prend jamais le focus**.
  **Construction imposée : par jonction de répertoire.** VSCode 1.122.1 **refuse** d'ouvrir un même dossier dans deux fenêtres — trois mécanismes essayés, tous refusés (`docs/adr/002-ouverture-interactive.md`, « Écueils » n°3). Le second workspace doit donc être une **jonction** pointant sur le premier. Le cas ainsi obtenu est **plus exigeant** que « le même dossier » : les deux fenêtres partagent alors le **même processus `Code.exe` principal**, ce qui prouve directement qu'un PID ne discrimine pas une fenêtre — seul l'`extHostPid` le fait.
- **Fixtures** : capturées depuis une machine réelle et versionnées dans `tests/fixtures/`, **anonymisées** (chemins et tokens neutralisés). Ne jamais fabriquer une fixture à la main pour faire passer un test.

### Garde-fou de non-régression (règle impérative)

Tout incrément de **correction de bug** embarque un test qui **reproduit le bug** et **échoue avant le correctif** (fails-before / passes-after), avec la preuve du fails-before dans la PR. Niveau du test : le plus proche du défaut ; **E2E dès que le symptôme est observable par l'utilisateur**.
**Un bug corrigé sans garde-fou reproductible = incrément incomplet**, même si tout le reste est vert.

## CI et vérification

```bash
npm run ci                 # lint + typecheck + tests unitaires  (exécutable partout)
npm run test:integration   # vraie instance VSCode               (local + CI sous xvfb)
npm run test:e2e           # multi-fenêtres, extension Claude     (LOCAL UNIQUEMENT)
```

Seul `npm run ci` existe à ce jour ; les deux autres commandes décrivent la cible et seront outillées aux lots B et C.

**Limite assumée** : les tests E2E exigent l'extension Claude propriétaire **authentifiée**. Ils sont **impossibles en CI publique**. La CI GitHub exécute `npm run lint`, `npm run typecheck` et `npm run test:coverage`, puis publie le rapport de couverture — **rien de plus** : il n'existe à ce jour ni script `build` ni étape de packaging VSIX, l'un et l'autre relevant du **lot E**. Les résultats E2E locaux sont joints en preuve à la PR — ne jamais prétendre qu'une PR est vérifiée sans ce log.

## Documentation obligatoire

- **Toute décision structurante donne un ADR daté** dans `docs/adr/`, numéroté, qui énonce le contexte, les options écartées et la décision.
- **Toute dépendance nouvelle à une API interne de l'écosystème Claude** est inscrite dans `docs/compatibilite.md` avec la version vérifiée et la façon dont l'absence est détectée.
- **Le README est la vitrine du projet** : il expose le problème, la démonstration, l'installation, les limites et les risques. Il est mis à jour à chaque changement de périmètre.
- **Ne jamais considérer une tâche comme terminée sans avoir mis à jour la documentation.**
