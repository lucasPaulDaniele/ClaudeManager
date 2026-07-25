# Matrice de compatibilité

ClaudeManager s'appuie sur des **API internes et non contractuelles** de l'écosystème Claude Code. Elles ne sont ni documentées ni garanties : une mise à jour de l'extension peut les faire disparaître sans préavis.

Ce fichier recense **chaque** point d'adhérence, **où il a été vérifié** — colonne « Vérifié en / sur », ligne par ligne — et la façon dont son absence est détectée. Toute nouvelle dépendance doit y être ajoutée dans la même PR que le code qui l'introduit, avec sa traçabilité ou, à défaut, un `— non vérifié` assumé.

**Règle** : quand un présupposé tombe, ClaudeManager **échoue avec un message nommé**. Il ne dégrade jamais en silence.

## Environnement de référence

| | Version vérifiée |
|---|---|
| Extension `Anthropic.claude-code` | **2.1.219** (win32-x64) |
| CLI `claude` (binaire embarqué) | **2.1.219** |
| VSCode | **1.122.1** (`8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e`, x64) |
| Système | Windows 11 Pro 10.0.22000 |
| Node | **24.13.0** (socle exigé par le projet : ≥ 20) |

Ce tableau décrit la machine sur laquelle le spike A1 a été conduit
([ADR-002](adr/002-ouverture-interactive.md)).

**Dernier passage sur ce fichier : 2026-07-25.** Cette date n'atteste rien par elle-même — elle ne
date qu'une relecture. La traçabilité de chaque dépendance est portée **ligne par ligne** par la
colonne « Vérifié en / sur » du tableau ci-dessous ; un `— non vérifié` y signale une dépendance
qu'aucune mesure n'étaie à ce jour.

## Points d'adhérence

Dans ce tableau, `<CONFIG>` désigne la **racine de configuration du CLI `claude`** : `~/.claude`
par défaut, relocalisable par `CLAUDE_CONFIG_DIR` (D17).

| # | Dépendance | Nature | Utilisé pour | Vérifié en / sur | Détection de l'absence |
|---|---|---|---|---|---|
| D1 | Commande `claude-vscode.editor.open(sessionId?, prompt?, viewColumn?)` | Commande VSCode interne | Attacher un panneau UI à une session existante | ADR-002 (V1, V5) · ADR-001 §1 | `vscode.commands.getCommands(true)` ne la contient pas → erreur `CLAUDE_COMMAND_MISSING` |
| D2 | `viewType` d'onglet contenant `claudeVSCodePanel` | Détail d'implémentation de la webview | Énumérer et fermer les conversations | ADR-002 (V1, observé `mainThreadWebview-claudeVSCodePanel`) · ADR-001 §3 pour la fermeture | Aucun onglet ne correspond alors qu'une conversation est attendue → erreur `CLAUDE_PANEL_VIEWTYPE_UNKNOWN` |
| D3 | Drapeau CLI `--session-id <uuid>` **en mode interactif** : `claude --session-id <uuid> "<prompt>"` | Contrat CLI | Jouer le tour 1 dans un vrai pty, sur un identifiant choisi par l'appelant | ADR-002 (V1) | `claude --help` ne liste plus `--session-id`, ou le processus démarre sans qu'aucun `sessions/<pid>.json` ni transcript ne porte l'uuid demandé → erreur `SEED_SESSION_ID_MISMATCH`, **puis** bascule sur le repli V5 (dans cet ordre : l'erreur est toujours émise) |
| D4 | `claude agents --json` | Contrat CLI | Inventorier les sessions vivantes | ADR-001 §1, **mention incidente** — non exercé par le spike A1 | Sortie non-JSON ou schéma inattendu → repli sur D5, puis erreur |
| D5 | `<CONFIG>/sessions/<pid>.json` (par défaut `~/.claude/sessions/`) | Fichier d'état interne | Repli d'inventaire des sessions | ADR-002 (V1) — lu sous la racine du bac à sable, voir D17 | Répertoire absent → l'inventaire se limite à D4 |
| D6 | `<CONFIG>/projects/<cwd-slug>/<sessionId>.jsonl` (par défaut `~/.claude/projects/`) | Transcript interne | Lire une réponse, détecter la fin de tour | ADR-002 (V1) — lu sous la racine **par défaut**, voir D17 | Fichier introuvable ou lignes non parsables → repli sur le hook `Stop`, sinon erreur `TRANSCRIPT_UNREADABLE` |
| D7 | Slugification du cwd (`:` et `\` → `-`) | Convention de nommage interne | Localiser le transcript d'une session | ADR-002 (V1) — observée sur le chemin du transcript relevé | Aucun répertoire ne correspond → balayage complet de `projects/`, puis erreur |
| D8 | Hook `Stop` de `~/.claude/settings.json` | Point d'extension documenté | Signal de fin de tour | **— non vérifié.** Aucune mesure ne l'étaie : ADR-001 ne le cite qu'au titre de ce dont le mécanisme d'alors se passait, ADR-002 pas du tout. **Dette du lot D** | Optionnel — repli automatique sur D6 |
| D9 | `claude.exe.ppid` = PID de l'extension host de sa fenêtre | Comportement du système d'exploitation | Résoudre « ma fenêtre » | ADR-001 §4 · ADR-002 (isolation multi-fenêtres) | Aucune fenêtre enregistrée ne revendique le PID → erreur `OWNING_WINDOW_NOT_FOUND` |
| D10 | Le `cwd` de la session doit correspondre au workspace de la fenêtre | Comportement non documenté de `editor.open` | Garantir que le panneau attache bien **la** session visée | ADR-002 (V1) — **cas nominal seul** : le cas d'échec est rapporté comme écueil connu, il n'a pas été rejoué | **Aucune erreur n'est levée** : `editor.open` **réussit** en ouvrant un panneau **vide**. L'absence d'erreur ne prouve jamais l'attachement — diffuser l'état des onglets avant/après et vérifier le libellé, dérivé du contenu de la conversation → erreur `PANEL_ATTACHED_EMPTY` |
| D11 | `initialPrompt` de `editor.open` **pré-remplit sans soumettre** | Comportement de la webview | **Rien dans la voie nominale** — recensé comme comportement sur lequel on ne peut pas s'appuyer ; c'est en revanche le socle du repli V5 | ADR-001 §1 · ADR-002 (lecture du source, puis V5) | Prouvé au source (`setInputText`, rien d'autre) et par mesure. S'il se mettait à soumettre, le repli V5 deviendrait autonome : changement à détecter, jamais à supposer |
| D12 | Commande `claude-vscode.terminal.open(command?, args[]?, location?)` | Commande VSCode interne | **Non utilisée par la voie retenue** — recensée comme voie de repli technique connue | ADR-002 (V2) | `vscode.commands.getCommands(true)` ne la contient pas |
| D13 | Réglage `claudeCode.useTerminal` | Réglage de l'extension Claude | **Non utilisé par la voie retenue** — recensé pour son effet de bord | ADR-002 (V2) | Le réglage n'apparaît plus dans la configuration de l'extension |
| D14 | Champs de `sessions/<pid>.json` : `entrypoint`, `status`, `sessionId`, `cwd` | Format de fichier interne (précise D5) | Distinguer une session **réellement interactive** d'une session headless | ADR-002 (V1, preuve structurelle) | `entrypoint` absent, ou ne valant plus jamais `cli` → erreur `SESSION_INTERACTIVITY_UNKNOWN`. **`kind` n'est pas un discriminant** — voir ci-dessous |
| D15 | `CLAUDE_CODE_SSE_PORT` | Variable injectée par l'extension Claude, **propre à chaque fenêtre** | **Rien aujourd'hui** — recensée comme piste d'identité de fenêtre alternative, à explorer au lot B | ADR-002 (V1, écueil n°1 : seule variable subsistant après neutralisation) | Variable absente de l'environnement du terminal. L'ancrage retenu reste l'`extHostPid` (D9) : cette piste ne le remplace pas tant qu'elle n'a pas été mesurée |
| D16 | Emplacement du binaire `claude` embarqué + résolution de `claude` sur le `PATH` par l'extension | Arborescence du bundle / comportement de l'extension | Localiser le binaire à lancer dans le terminal | ADR-002 (V1 : chemin absolu donné au terminal ; V2 : refus de l'extension faute de `claude` sur le `PATH`) | Aucun `claude.exe` sous `resources/native-binary/` du répertoire d'extension résolu |
| D17 | Variable d'environnement `CLAUDE_CONFIG_DIR` | Comportement du CLI `claude` | **Localiser la racine de configuration** — donc `sessions/` (D5) et, sauf jonction, `projects/` (D6) | **— non mesuré directement.** Déduction du montage du spike A1, où elle pointait sur un bac à sable dont `projects/` était jonctionné vers la racine par défaut ([ADR-002](adr/002-ouverture-interactive.md), « Erratum »). **Dette du lot D** | Variable absente → racine par défaut `~/.claude`. Variable présente → **ne jamais supposer** que `sessions/` et `projects/` sont sous la même racine : les résoudre séparément et vérifier leur existence. `cmgr doctor` doit rendre compte des deux racines effectives |
| D18 | Le paramètre `sessionId` de `claude-vscode.editor.open` **attache une session existante** | Contrat implicite de la commande interne (précise D1) | Étape 3 du mécanisme retenu — c'est ce qui distingue V1 de V5 | ADR-002 (V1) pour le comportement nominal ; **la perte de ce paramètre n'est pas observée**, c'est un scénario de rupture anticipé | La commande existe (D1 passe) mais l'appel avec un `sessionId` valide ouvre un panneau qui n'est pas celui de la session — alors que le `cwd` correspond (D10) : diffuser les onglets avant/après et vérifier le libellé → erreur `PANEL_SESSION_PARAM_LOST`, **puis** bascule sur le repli V5 |

**Notes de conception** — consignes qui découlent des lignes ci-dessus, et qui ne sont pas des
moyens de détection :

- **D12 — convention d'ordre inversée.** La ligne construite par `terminal.open` est
  `<claude> <args…> <command>` : le premier paramètre est ajouté **en dernier**.
- **D13 — effet de bord à ne jamais provoquer sans consentement.** Le réglage est modifiable au
  scope `Workspace` sans toucher la configuration utilisateur, mais il **écrit
  `.vscode/settings.json` dans le projet de l'utilisateur**.
- **D16 — chemin versionné.** Le binaire vit sous
  `<HOME>/.vscode/extensions/anthropic.claude-code-<version>-win32-x64/resources/native-binary/claude.exe` :
  le chemin **change à chaque mise à jour de l'extension — ne jamais le coder en dur**. Corollaire
  mesuré : quand c'est l'extension qui lance (D12), elle exige `claude` sur le `PATH` et **refuse
  explicitement** de démarrer sinon.
- **D17 — dette du lot D.** Toute la localisation des transcripts en dépend. La sémantique exacte
  de `CLAUDE_CONFIG_DIR` doit être **mesurée** au lot D, pas déduite ; jusque-là, la traiter comme
  un présupposé à vérifier au démarrage.

> **D3 a changé de nature le 2026-07-25.** Il portait sur `claude -p --session-id <uuid>
> --output-format json`, c'est-à-dire le mode `--print`. C'est désormais `--session-id` **en mode
> interactif**, seul mode qui rend le tour 1 réellement interactif
> ([ADR-002](adr/002-ouverture-interactive.md)). Le drapeau n'est pas restreint à `--print` : les
> options ainsi restreintes le disent explicitement dans l'aide du CLI, pas celle-ci.
> **Conséquence** : le JSON de sortie du mode `--print` n'est plus disponible, et la réponse du
> tour 1 ne s'obtient plus que par D6 (transcript) ou D8 (hook `Stop`).

### `kind` n'est pas un discriminant d'interactivité

Piège coûteux, à ne pas redécouvrir : une session `claude -p` purement headless porte **elle
aussi** `"kind":"interactive"` dans `sessions/<pid>.json`. Comparaison faite sur la machine de
référence :

| Session | `kind` | `entrypoint` | `status` / `updatedAt` |
|---|---|---|---|
| headless (`claude -p`) | `interactive` | `claude-vscode` | **absents** |
| terminal interactif (voie retenue) | `interactive` | `cli` | **présents** |

Les seuls champs exploitables sont donc **`entrypoint`** et la **présence de
`status`/`updatedAt`**. Détail et relevés bruts : [ADR-002](adr/002-ouverture-interactive.md).

## Modes de défaillance connus de l'environnement

Ces situations ne sont pas des bugs de ClaudeManager, mais elles doivent être **diagnostiquées et nommées** par `cmgr doctor`.

### Contamination de l'environnement — le piège le plus coûteux

Toute fenêtre VSCode lancée **depuis** une session Claude hérite de huit variables :

`CLAUDECODE` · `CLAUDE_CODE_CHILD_SESSION` · `CLAUDE_CODE_ENTRYPOINT` · `CLAUDE_CODE_SESSION_ID` · `CLAUDE_PID` · `CLAUDE_AGENT_SDK_VERSION` · `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` · `CLAUDE_CODE_ENABLE_TASKS`

Elles se propagent **jusqu'aux terminaux** de la fenêtre. Un `claude` lancé là se comporte alors en **agent enfant non interactif** : il se déclare non interactif et **coupe la sauvegarde du transcript** (`Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`).

**Symptôme** : la session paraît démarrer normalement, mais le tour 1 n'est pas interactif et aucun transcript n'est écrit — `cmgr read` et `cmgr wait` n'ont donc rien à lire. **Aucune erreur n'est levée.**

**Remède mesuré** : passer ces huit variables à `null` dans `createTerminal({ env })` — VSCode les **supprime** alors de l'environnement du terminal. Vérifié : après suppression, seul `CLAUDE_CODE_SSE_PORT` subsiste (D15).

C'est le piège qui a fait conclure **à tort** à l'échec de la voie retenue lors de la première mesure ([ADR-002](adr/002-ouverture-interactive.md), « Écueils » n°1). `cmgr doctor` doit le détecter et le nommer ; un test de non-régression doit le couvrir.

### Deux portes avant le tour 1 — onboarding CLI et confiance du dossier

Sur une machine où l'humain n'utilise que le panneau, le **CLI interactif** ouvre le sélecteur de thème au premier lancement et **attend** — alors même que `theme` est déjà renseigné dans `<HOME>/.claude/settings.json` : la porte est l'onboarding lui-même, pas la valeur du thème, et aucune variable d'environnement ne le court-circuite. Le CLI demande ensuite `Quick safety check: Is this a project you created or one you trust?`, **par répertoire**.

Les deux se franchissent sans focus, mais leur libellé n'est **pas contractuel**. `cmgr doctor` doit les **vérifier et les nommer** plutôt que les franchir à l'aveugle. En production elles ne se présentent qu'une fois par machine et par dossier.

### Workspace Trust — le piège silencieux

Dans une fenêtre ouverte en **Restricted Mode**, les commandes de l'extension Claude **n'existent tout simplement pas** ; `executeCommand` échoue par `command not found`, sans aucune indication de la cause réelle.

`cmgr doctor` doit vérifier `vscode.workspace.isTrusted` et le signaler explicitement, avec la remédiation (accorder la confiance au dossier).

### Verrous IDE périmés

`~/.claude/ide/` accumule des fichiers `<port>.lock` jamais nettoyés — observés **en nombre** sur la machine de référence. Ne jamais considérer la présence d'un lock comme la preuve d'une fenêtre vivante : toujours vérifier que le PID est vivant. Le registre propre à ClaudeManager doit être **auto-nettoyant**.

### `VSCODE_PID` n'identifie pas une fenêtre

Un unique processus principal VSCode héberge plusieurs fenêtres. Deux verrous portant `pid: 16196` ont été observés pour deux dossiers différents. **Ne jamais utiliser `VSCODE_PID` comme clé d'identité** — utiliser le PID de l'extension host (D9).

### Panneau Claude restauré au démarrage

Une fenêtre peut rouvrir automatiquement un panneau Claude à son lancement. Ne jamais supposer qu'un seul onglet Claude existe, ni que le premier trouvé est celui qu'on vient d'attacher : diffuser l'état des onglets avant/après l'opération.

### VSCode refuse d'ouvrir un même dossier dans deux fenêtres

VSCode 1.122.1 **refuse** d'ouvrir un même dossier dans deux fenêtres. Trois mécanismes ont été essayés, tous refusés : `code --new-window --folder-uri` (ouvre une fenêtre **sans workspace**), `vscode.openFolder(uri, { forceNewWindow: false })` (route vers la fenêtre existante) et `workbench.action.duplicateWorkspaceInNewWindow` (sans effet).

Conséquence directe pour les tests E2E : le cas adverse « deux fenêtres, même dossier » se construit par **jonction de répertoire**. C'est le **seul montage possible**, les trois autres étant refusés.

**Ce que le montage couvre** : le **répertoire physique commun** et le **processus `Code.exe` principal commun**. Ce dernier n'est pas un effet de la jonction — deux fenêtres quelconques d'une même instance le partagent déjà ([ADR-001](adr/001-pilotage-des-conversations.md), §4 : cinq extension hosts distincts, tous de `ppid` 16196). Il n'en reste pas moins la preuve directe qu'un PID ne discrimine pas une fenêtre (voir « `VSCODE_PID` n'identifie pas une fenêtre » ci-dessus).

**Ce que le montage ne couvre pas** : l'identité de **chemin de workspace**. Les deux fenêtres du relevé d'[ADR-002](adr/002-ouverture-interactive.md) portent des chemins distincts (`ws-a` et `ws-same`). C'est un **angle mort explicite** du scénario E2E : une implémentation qui indexerait l'identité sur le chemin du workspace y passerait sans être correcte pour autant. Le scénario du lot C doit donc l'exclure explicitement.
