# Matrice de compatibilité

ClaudeManager s'appuie sur des **API internes et non contractuelles** de l'écosystème Claude Code. Elles ne sont ni documentées ni garanties : une mise à jour de l'extension peut les faire disparaître sans préavis.

Ce fichier recense **chaque** point d'adhérence, **où il a été vérifié** — colonne « Vérifié en / sur », ligne par ligne — et la façon dont son absence est détectée. Toute nouvelle dépendance doit y être ajoutée dans la même PR que le code qui l'introduit, avec sa traçabilité ou, à défaut, un `— non vérifié` assumé.

**Règle** : quand un présupposé tombe, ClaudeManager **échoue avec un message nommé**. Il ne dégrade jamais en silence.

**Périmètre — ce fichier ne recense QUE l'écosystème Claude.** Les API `vscode` employées par
l'extension compagnon sont **publiques, documentées et versionnées** par un plancher
`engines.vscode` : elles ne relèvent pas de cette matrice, et les y forcer diluerait ce qu'elle
sert à dire. Elles sont recensées avec leur plancher dans
[ADR-003](adr/003-registre-et-serveur-local.md). Même partage pour les codes d'erreur : ceux qui
portent sur le système d'exploitation ou sur le format du registre — qui est le nôtre — ne
figurent pas ici, `packages/core/src/errors.ts` le dit en tête.

## Environnement de référence

| | Version vérifiée |
|---|---|
| Extension `Anthropic.claude-code` | **2.1.219** (spike A1) · **2.1.220** (increment C1) |
| CLI `claude` (binaire embarqué) | **2.1.219** (spike A1) · **2.1.220** (increment C1) |
| VSCode | **1.122.1** (`8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e`, x64) |
| Système | Windows 11 Pro 10.0.22000 |
| Node | **24.13.0** (socle exigé par le projet : ≥ 20) |

Ce tableau décrit la machine sur laquelle les mesures ont été conduites. La colonne
« Vérifié en / sur » de chaque ligne dit **laquelle** des deux versions d'extension l'étaie :
elles ne valent pas toutes pour la même.

> **Deux versions d'extension coexistent dans cette matrice, et c'est dit ligne par ligne
> (2026-07-26).** Le spike A1 ([ADR-002](adr/002-ouverture-interactive.md)) a été conduit sur
> **2.1.219** ; l'increment **C1** a rejoué D1, D2, D3, D11 et D18 sur **2.1.220**, dans une
> vraie fenêtre `@vscode/test-electron` chargeant l'extension Claude par jonction. Les lignes
> **non re-mesurées** sur 2.1.220 le disent dans leur colonne de traçabilité.
> Le lot B, lui, n'avait touché **aucune** dépendance de cette matrice : son code n'appelait ni
> le CLI `claude`, ni une commande `claude-vscode.*`, ni un fichier de `~/.claude/**`.

**Dernier passage sur ce fichier : 2026-07-26.** Cette date n'atteste rien par elle-même — elle ne
date qu'une relecture. La traçabilité de chaque dépendance est portée **ligne par ligne** par la
colonne « Vérifié en / sur » du tableau ci-dessous ; un `— non vérifié` y signale une dépendance
qu'aucune mesure n'étaie à ce jour.

## Points d'adhérence

Dans ce tableau, `<CONFIG>` désigne la **racine de configuration du CLI `claude`** : `~/.claude`
par défaut, relocalisable par `CLAUDE_CONFIG_DIR` (D17).

| # | Dépendance | Nature | Utilisé pour | Vérifié en / sur | Détection de l'absence |
|---|---|---|---|---|---|
| D1 | Commande `claude-vscode.editor.open(sessionId?, prompt?, viewColumn?)` | Commande VSCode interne | Attacher un panneau UI à une session existante | ADR-002 (V1, V5) · ADR-001 §1 · **re-mesurée C1 sur 2.1.220** : présente dans `getCommands(true)` après activation | `vscode.commands.getCommands(true)` ne la contient pas → erreur `CLAUDE_COMMAND_MISSING`. **Aucun repli n'est alors possible** : le repli V5 *est* cette commande |
| D2 | `viewType` d'onglet contenant `claudeVSCodePanel` | Détail d'implémentation de la webview | Énumérer et fermer les conversations | ADR-002 (V1) · ADR-001 §3 pour la fermeture · **re-mesuré C1 sur 2.1.220** : `mainThreadWebview-claudeVSCodePanel`, relevé tel quel dans le rapport d'intégration | Aucun onglet ne correspond alors qu'une conversation est attendue → erreur `CLAUDE_PANEL_VIEWTYPE_UNKNOWN`. **Comparer par « contient », jamais par égalité** : VSCode préfixe le `viewType` |
| D3 | Drapeau CLI `--session-id <uuid>` **en mode interactif** : `claude --session-id <uuid> "<prompt>"` | Contrat CLI | Jouer le tour 1 dans un vrai pty, sur un identifiant choisi par l'appelant | ADR-002 (V1) · **`claude --help` relevé C1 sur 2.1.220** : `--session-id <uuid>` présent, `[prompt]` **positionnel seul** | `claude --help` ne liste plus `--session-id` → erreur `SEED_SESSION_ID_MISMATCH`, **puis** bascule sur le repli V5. **⚠️ C1 ne vérifie PAS ce code** : le constater suppose de lire `sessions/<pid>.json` ou le transcript, donc le lot D. En C1, un `--session-id` refusé se manifeste comme un échec de démarrage (`SEED_PROCESS_NOT_STARTED`) ou d'attachement |
| D4 | `claude agents --json` | Contrat CLI | Inventorier les sessions vivantes | ADR-001 §1, **mention incidente** — non exercé par le spike A1 | Sortie non-JSON ou schéma inattendu → repli sur D5, puis erreur |
| D5 | `<CONFIG>/sessions/<pid>.json` (par défaut `~/.claude/sessions/`) | Fichier d'état interne | Repli d'inventaire des sessions | ADR-002 (V1) — lu sous la racine du bac à sable, voir D17 | Répertoire absent → l'inventaire se limite à D4 |
| D6 | `<CONFIG>/projects/<cwd-slug>/<sessionId>.jsonl` (par défaut `~/.claude/projects/`) | Transcript interne | Lire une réponse, détecter la fin de tour | ADR-002 (V1) — lu sous la racine **par défaut**, voir D17 | Fichier introuvable ou lignes non parsables → repli sur le hook `Stop`, sinon erreur `TRANSCRIPT_UNREADABLE` |
| D7 | Slugification du cwd (`:` et `\` → `-`) | Convention de nommage interne | Localiser le transcript d'une session | ADR-002 (V1) — observée sur le chemin du transcript relevé | Aucun répertoire ne correspond → balayage complet de `projects/`, puis erreur |
| D8 | Hook `Stop` de `~/.claude/settings.json` | Point d'extension documenté | Signal de fin de tour | **— non vérifié.** Aucune mesure ne l'étaie : ADR-001 ne le cite qu'au titre de ce dont le mécanisme d'alors se passait, ADR-002 pas du tout. **Dette du lot D** | Optionnel — repli automatique sur D6 |
| D9 | L'extension host de la fenêtre figure dans la **chaîne d'ancêtres** du processus appelant, **à une profondeur non contractuelle** | Comportement du système d'exploitation | Résoudre « ma fenêtre » | **B1** · `tests/fixtures/identity/windows-process-table.roles.json` (capture du 2026-07-25, trois sauts mesurés) · ADR-002 (isolation multi-fenêtres) | **Remonter toute la chaîne**, jamais le seul `ppid`. Aucune fenêtre enregistrée ne figure dans la chaîne du processus appelant → erreur `OWNING_WINDOW_NOT_FOUND` ; deux fenêtres à la même profondeur → erreur `DUPLICATE_WINDOW_IDENTITY` |
| D10 | Le `cwd` de la session doit correspondre au workspace de la fenêtre | Comportement non documenté de `editor.open` | Garantir que le panneau attache bien **la** session visée | ADR-002 (V1) — **cas nominal seul** : le cas d'échec est rapporté comme écueil connu, il n'a pas été rejoué. **C1 le rend impossible PAR CONSTRUCTION** : le `cwd` du terminal masqué **est** un dossier de travail de la fenêtre | **Aucune erreur n'est levée** : `editor.open` **réussit** en ouvrant un panneau **vide**. La détection annoncée — « vérifier le libellé, dérivé du contenu de la conversation » — **est mise en défaut par D19** : mesuré C1, le libellé reste `Claude Code` pendant 45 s. `PANEL_ATTACHED_EMPTY` n'est donc **implémenté nulle part**, et c'est dit : sa détection appartient au lot D, qui lit le transcript |
| D11 | `initialPrompt` de `editor.open` **pré-remplit sans soumettre** | Comportement de la webview | **Rien dans la voie nominale** — recensé comme comportement sur lequel on ne peut pas s'appuyer ; c'est en revanche le socle du repli V5 | ADR-001 §1 · ADR-002 (lecture du source, puis V5) · **exercé C1 sur 2.1.220** : `editor.open(null, <40 000 caractères>)` ouvre bien un panneau supplémentaire, la route rend `humanActionRequired: true` | Prouvé au source (`setInputText`, rien d'autre) et par mesure. **La NON-soumission n'est pas re-mesurée en C1** — l'observer supposerait de lire le contenu de la webview : `— non vérifié` sur 2.1.220, la trace d'ADR-002 tient. S'il se mettait à soumettre, le repli V5 deviendrait autonome : changement à détecter, jamais à supposer |
| D12 | Commande `claude-vscode.terminal.open(command?, args[]?, location?)` | Commande VSCode interne | **Non utilisée par la voie retenue** — recensée comme voie de repli technique connue | ADR-002 (V2) | `vscode.commands.getCommands(true)` ne la contient pas |
| D13 | Réglage `claudeCode.useTerminal` | Réglage de l'extension Claude | **Non utilisé par la voie retenue** — recensé pour son effet de bord | ADR-002 (V2) | Le réglage n'apparaît plus dans la configuration de l'extension |
| D14 | Champs de `sessions/<pid>.json` : `entrypoint`, `status`, `sessionId`, `cwd` | Format de fichier interne (précise D5) | Distinguer une session **réellement interactive** d'une session headless | ADR-002 (V1, preuve structurelle) | `entrypoint` absent, ou ne valant plus jamais `cli` → erreur `SESSION_INTERACTIVITY_UNKNOWN`. **`kind` n'est pas un discriminant** — voir ci-dessous |
| D15 | `CLAUDE_CODE_SSE_PORT`, injectée dans les terminaux par `EnvironmentVariableCollection` | Variable injectée par l'extension Claude, **propre à chaque fenêtre** | **Rien aujourd'hui** — mais **délibérément CONSERVÉE** par la neutralisation d'environnement du mécanisme V1 : elle désigne CETTE fenêtre, la supprimer couperait le terminal de sa propre fenêtre | ADR-002 (V1, écueil n°1) · **re-mesurée C1 sur 2.1.220, configuration complète** : journal `Set CLAUDE_CODE_SSE_PORT=<port> in terminal environment (in-memory)`, et le terminal masqué reçoit **119 clés dont une seule `CLAUDE*`** — celle-ci | Variable absente de l'environnement du terminal. **Structurellement inatteignable par une énumération de `process.env`** : elle n'y figure pas. L'ancrage d'identité reste l'`extHostPid` (D9) ; cette piste ne le remplace pas |
| D16 | Emplacement du binaire `claude` embarqué + résolution de `claude` sur le `PATH` par l'extension | Arborescence du bundle / comportement de l'extension | Localiser le binaire à lancer dans le terminal | ADR-002 (V1 : chemin absolu donné au terminal ; V2 : refus de l'extension faute de `claude` sur le `PATH`) | Aucun `claude.exe` sous `resources/native-binary/` du répertoire d'extension résolu |
| D17 | Variable d'environnement `CLAUDE_CONFIG_DIR` | Comportement du CLI `claude` | **Localiser la racine de configuration** — donc `sessions/` (D5) et, sauf jonction, `projects/` (D6) | **— non mesuré directement.** Déduction du montage du spike A1, où elle pointait sur un bac à sable dont `projects/` était jonctionné vers la racine par défaut ([ADR-002](adr/002-ouverture-interactive.md), « Erratum »). **Dette du lot D** | Variable absente → racine par défaut `~/.claude`. Variable présente → **ne jamais supposer** que `sessions/` et `projects/` sont sous la même racine : les résoudre séparément et vérifier leur existence. `cmgr doctor` doit rendre compte des deux racines effectives |
| D18 | Le paramètre `sessionId` de `claude-vscode.editor.open` **attache une session existante** | Contrat implicite de la commande interne (précise D1) | Étape 4 du mécanisme retenu — c'est ce qui distingue V1 de V5 | ADR-002 (V1) pour le comportement nominal ; **la perte de ce paramètre n'est toujours pas observée**, c'est un scénario de rupture anticipé | La commande existe (D1 passe) mais l'appel avec un `sessionId` valide ouvre un panneau qui n'est pas celui de la session. **⚠️ NON DÉTECTABLE EN C1** — voir D19 : la commande ouvre un panneau **même pour une session jamais amorcée**, le diff d'onglets ne discrimine donc pas. Détection reportée au lot D (transcript) |
| D19 | `claude-vscode.editor.open(<uuid>)` ouvre un panneau **même quand aucune session ne porte cet uuid** | Comportement non documenté de la commande interne (précise D1, D10, D18) | **Rien** — c'est une LIMITE, recensée pour qu'on cesse de croire le contraire | **Mesurée C1 le 2026-07-26 sur 2.1.220, par falsification** : appel avec `00000000-0000-4000-8000-0000000c1c1c`, jamais amorcé → un onglet `claudeVSCodePanel` apparaît (`ghostSessionOpensAPanel: true`). Le libellé reste `Claude Code` pendant 45 s, **sans jamais devenir dérivé du contenu** | **Conséquence directe** : le diff d'onglets prouve que la commande a répondu, **jamais** que la session est chargée. Il ne peut donc servir ni d'horloge, ni de preuve d'attachement réel. Le mécanisme attend à la place un **fait observé dans la table des processus** (D20) |
| D20 | Le shell du terminal masqué engendre le processus du tour 1, observable dans la **table des processus** | Comportement du système d'exploitation, **pas** une API interne Claude | Savoir que le tour 1 a **démarré** avant d'attacher puis de supprimer le terminal | **Mesuré C1 le 2026-07-26** : `seedProcessObserved: true`, une seule lecture de table suffisant en pratique (ouverture complète en **1 733 ms**) | Aucun processus n'est né du shell dans l'échelle bornée → erreur `SEED_PROCESS_NOT_STARTED`. **Ce que cela n'établit PAS, et c'est un blanc ASSUMÉ** : que le tour soit **terminé**. Le terminal est supprimé ~1,7 s après, et sa suppression tue le `claude` du tour 1 (ADR-002). Trancher suppose le transcript ou le hook `Stop` — **dette du lot D** |
| D22 | **L'onboarding du CLI (`showSetupScreens`) bloque toute session interactive tant qu'il n'a pas été franchi une fois** | Comportement du CLI au démarrage | **Rien** — c'est une **précondition de la machine**, recensée parce qu'elle rend le tour 1 impossible sans que rien ne le signale | **Mesurée C1 (reprise 1) le 2026-07-26 sur 2.1.220**, cinq variantes, `--debug-file` à l'appui. Dernière ligne du journal du CLI : `[STARTUP] Running showSetupScreens()...`, jamais suivie d'autre chose — **87 s** plus tard le processus vit toujours et n'a écrit **aucun** transcript | **Aucune erreur n'est levée, aucune sortie n'est produite.** Le processus `claude` existe, porte la ligne de commande exacte attendue (vérifié sur `Win32_Process.CommandLine`) et **ne fait rien**. Aucun signal n'est disponible depuis `packages/**` : la détection appartient à `cmgr doctor` (lot D), qui doit la **vérifier et la nommer** — jamais la franchir |
| D21 | Plafond de `lpCommandLine` (~32 767 unités UTF-16) atteint par le **prompt positionnel** | Limite du système d'exploitation, rendue atteignable par le **contrat CLI** (D3) | Refuser AVANT d'envoyer un prompt que la ligne ne peut pas porter | **Mesuré le 2026-07-26** ([ADR-004](adr/004-transport-du-prompt.md)) : 32 000 passe, 32 600 échoue, **identiquement** pour un prompt littéral et pour un prompt lu depuis un fichier (lignes de pty de 32 744 et 236 caractères) | **L'échec est SILENCIEUX** : aucune sortie, aucune erreur, aucun processus. La garde du cœur pèse la ligne du processus fils et lève `PROMPT_TOO_LARGE`, **puis** bascule sur le repli V5 — lequel passe le prompt en mémoire, sans ligne de commande |

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
  un présupposé à vérifier au démarrage. **L'increment C1 ne s'y appuie sur aucun point** : ni
  `CLAUDE_CONFIG_DIR`, ni `sessions/<pid>.json`, ni `projects/` n'entrent dans une décision du
  mécanisme — c'est la table des processus qui porte l'observation (D20).
- **D19 + D20 — ce que « la conversation est ouverte » veut dire en C1, exactement.** La
  conjonction des deux lignes délimite une capacité, et il vaut mieux la lire que la deviner :
  C1 établit que **le tour 1 a démarré** (processus observé) et que **la commande d'attachement
  a répondu par un panneau** (diff d'onglets). Il n'établit **pas** que le panneau porte la
  session, ni que le tour soit allé à son terme. `cmgr open --wait` (lot D) est la seule voie
  vers cette garantie, et ce n'est donc pas une commodité d'affichage.
- **D21 — la limite est du système, sa portée vient du CLI.** Le jour où `[prompt]` accepterait
  un fichier ou une variable d'environnement, cette ligne cesserait de s'appliquer sans que
  Windows ait changé. C'est pourquoi elle figure dans cette matrice et non parmi les
  dépendances au système d'exploitation.

> **D3 a changé de nature le 2026-07-25.** Il portait sur `claude -p --session-id <uuid>
> --output-format json`, c'est-à-dire le mode `--print`. C'est désormais `--session-id` **en mode
> interactif**, seul mode qui rend le tour 1 réellement interactif
> ([ADR-002](adr/002-ouverture-interactive.md)). Le drapeau n'est pas restreint à `--print` : les
> options ainsi restreintes le disent explicitement dans l'aide du CLI, pas celle-ci.
> **Conséquence** : le JSON de sortie du mode `--print` n'est plus disponible, et la réponse du
> tour 1 ne s'obtient plus que par D6 (transcript) ou D8 (hook `Stop`).

> **D9 a changé de nature le 2026-07-25.** Il énonçait « `claude.exe.ppid` = PID de l'extension
> host de sa fenêtre », sur la trace `ADR-001 §4`. Cet énoncé est **faux dans la configuration de
> production**, et c'est le lot B qui l'a mesuré : entre le `claude.exe` appelant et l'extension
> host de sa fenêtre, la capture versionnée compte **trois sauts**, pas un —
> `claude.exe 18408 → pwsh.exe 16016 → claude.exe 22352 → extHost 11172 → Code.exe 16196`
> (`tests/fixtures/identity/windows-process-table.roles.json`, qui l'écrit en toutes lettres :
> « il faut **remonter la chaîne**, pas se contenter du `ppid` »).
> **Ce qui s'est passé** : ADR-001 §4 décrivait une **autre topologie** — un `claude.exe` attaché
> au panneau, donc enfant direct de l'extension host. Le relevé était juste ; c'est sa
> **généralisation en règle** qui ne l'était pas, et c'est cette matrice qui l'a généralisée.
> ADR-001 reste un document historique, non réécrit.
> **Conséquence** : la profondeur n'est **pas contractuelle** — elle dépend de la façon dont la
> session appelante a été lancée (terminal intégré, shell intermédiaire, agent enfant). Une
> implémentation qui comparerait le seul `ppid` reproduirait exactement le défaut que B1 a évité ;
> `resolveOwningWindow` parcourt donc toute la chaîne et retient la fenêtre **la plus proche** de
> l'appelant.

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

**Le compte varie, et la règle est donc une FAMILLE de préfixes, jamais une liste nommée** : le poste de référence en portait **19 le 2026-07-25** et **21 le 2026-07-26** (`tests/fixtures/environment/claude-session-env-names.json`). Une liste nommée aurait laissé passer les deux nouvelles sans que rien ne le signale.

**Remède mesuré** : mapper chaque nom de la famille à `null` dans `createTerminal({ env })` — VSCode les **supprime** alors de l'environnement du terminal.

**Deux formes voisines ne font PAS ce qu'elles ont l'air de faire, et c'est mesuré le 2026-07-26** ([ADR-004](adr/004-transport-du-prompt.md)) : `env: { X: undefined }` **compile et n'agit pas** (la variable reste `PRESENT=1`), `env: { X: '' }` laisse la variable **présente et vide** — or le CLI teste la *présence*. `strictEnv: true` supprime bien, mais fait perdre `TERM_PROGRAM`, `COLORTERM`, `LANG`, `GIT_ASKPASS` et l'intégration shell (79 clés contre 89) : c'est le plus mauvais des choix.

**Vérifié en fenêtre réelle, configuration complète (increment C1, 2026-07-26)** : avec **10** noms `CLAUDE*` réinjectés à dessein dans l'extension host, le terminal masqué en reçoit **zéro**. Sur ses **119** clés, une seule est `CLAUDE*` — `CLAUDE_CODE_SSE_PORT` (D15), qui n'est pas héritée mais injectée par l'extension Claude de la fenêtre elle-même. L'affirmation juste est donc **« aucun `CLAUDE*` hérité de la session appelante »**, jamais « aucun `VSCODE_*` » : VSCode **réinjecte** dans ses terminaux des variables absentes du `process.env` de l'extension host (`VSCODE_GIT_ASKPASS_*`, `VSCODE_INJECTION`, `TERM_PROGRAM`, `COLORTERM`), qu'aucune énumération bâtie sur `process.env` ne peut atteindre.

C'est le piège qui a fait conclure **à tort** à l'échec de la voie retenue lors de la première mesure ([ADR-002](adr/002-ouverture-interactive.md), « Écueils » n°1). `cmgr doctor` doit le détecter et le nommer ; les tests de non-régression le couvrent désormais à deux niveaux — deux tests unitaires, un par forme fautive, et le scénario d'intégration `open-conversation`.

### Deux portes avant le tour 1 — onboarding CLI et confiance du dossier

> **MESURE DU 2026-07-26 (incrément C1, reprise 1) — la porte n°1 est confirmée, et son
> périmètre est resserré.** Cinq variantes jouées dans une vraie fenêtre, avec `--debug-file` :
>
> | Variante | `cwd` | Terminal | Transcript écrit | Dernière ligne du journal CLI |
> |---|---|---|---|---|
> | A | temporaire neuf | masqué | **non** | *(sans debug)* |
> | B | temporaire neuf | masqué | **non** | `[STARTUP] Running showSetupScreens()...` |
> | C | **racine du dépôt** (connue du CLI) | masqué | **non** | idem |
> | D | temporaire neuf | **révélé** | **non** | idem, mais `OSC 11 response=… detected=dark` |
> | E | **racine du dépôt** | **révélé** | **non** | idem |
>
> Ce que ces cinq lignes établissent, et qu'aucune ne pouvait établir seule :
> - **ce n'est pas la porte de confiance du dossier** — A/B et C/E ne diffèrent pas ;
> - **ce n'est pas la détection du thème** — révélé, le terminal répond bien à `OSC 11`
>   (`detected=dark`), et le CLI bloque **quand même**. La formule d'ADR-002 « la porte est
>   l'onboarding lui-même, pas la valeur du thème » est confirmée, et il faut y ajouter : ni sa
>   **détection** ;
> - **le transport est hors de cause** — `Win32_Process.CommandLine` montre la ligne exacte
>   attendue : binaire du bundle, `--session-id <uuid>`, prompt intact.
>
> **Conséquence opérationnelle** : sur une machine dont l'onboarding CLI n'a jamais été franchi
> en session interactive, `POST /conversations` ouvre un panneau et amorce un processus, mais
> **le tour 1 n'a pas lieu** — sans la moindre erreur. C'est pourquoi la réponse de la route
> porte `firstTurnVerified: false` plutôt que de laisser croire à un succès complet.

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
