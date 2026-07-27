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
> **C3-FIX** a ajouté **D23** et re-mesuré **D19, D20 et D22** sur **2.1.220**, deux fois : par
> sonde hors éditeur et dans une vraie fenêtre, **après** l'autorisation OAuth du CLI — laquelle
> change ce que D22 dit, et c'est écrit sur sa ligne.
> Le lot B, lui, n'avait touché **aucune** dépendance de cette matrice : son code n'appelait ni
> le CLI `claude`, ni une commande `claude-vscode.*`, ni un fichier de `~/.claude/**`.

**Dernier passage sur ce fichier : 2026-07-27** (correction du gate C final, volet 1 : **D24** précisée — le libellé ne suffit pas à désigner un onglet, et c'est prouvé par exécution. Incrément C4 : **D24** ajoutée, **D2** re-mesurée). Cette date n'atteste rien par elle-même — elle ne
date qu'une relecture. La traçabilité de chaque dépendance est portée **ligne par ligne** par la
colonne « Vérifié en / sur » du tableau ci-dessous ; un `— non vérifié` y signale une dépendance
qu'aucune mesure n'étaie à ce jour.

## Points d'adhérence

Dans ce tableau, `<CONFIG>` désigne la **racine de configuration du CLI `claude`** : `~/.claude`
par défaut, relocalisable par `CLAUDE_CONFIG_DIR` (D17).

| # | Dépendance | Nature | Utilisé pour | Vérifié en / sur | Détection de l'absence |
|---|---|---|---|---|---|
| D1 | Commande `claude-vscode.editor.open(sessionId?, prompt?, viewColumn?)` | Commande VSCode interne | Attacher un panneau UI à une session existante | ADR-002 (V1, V5) · ADR-001 §1 · **re-mesurée C1 sur 2.1.220** : présente dans `getCommands(true)` après activation | `vscode.commands.getCommands(true)` ne la contient pas → erreur `CLAUDE_COMMAND_MISSING`. **Aucun repli n'est alors possible** : le repli V5 *est* cette commande |
| D2 | `viewType` d'onglet contenant `claudeVSCodePanel` | Détail d'implémentation de la webview | Énumérer et fermer les conversations | ADR-002 (V1) · ADR-001 §3 pour la fermeture · **re-mesuré C1 sur 2.1.220** : `mainThreadWebview-claudeVSCodePanel`, relevé tel quel dans le rapport d'intégration · **re-mesuré C4 le 2026-07-27** : c'est la seule règle de reconnaissance de la fermeture, et elle est partagée avec l'ouverture (`isClaudePanel`) | Aucun onglet ne correspond alors qu'une conversation est attendue → erreur `CLAUDE_PANEL_VIEWTYPE_UNKNOWN`. **Comparer par « contient », jamais par égalité** : VSCode préfixe le `viewType`. **Il ne DISCRIMINE RIEN** : il est identique pour tous les panneaux Claude, le préfixe ne portant aucun numéro d'instance — d'où la poignée synthétisée de C4, et D24 |
| D3 | Drapeau CLI `--session-id <uuid>` **en mode interactif** : `claude --session-id <uuid> "<prompt>"` | Contrat CLI | Jouer le tour 1 dans un vrai pty, sur un identifiant choisi par l'appelant | ADR-002 (V1) · **`claude --help` relevé C1 sur 2.1.220** : `--session-id <uuid>` présent, `[prompt]` **positionnel seul** | `claude --help` ne liste plus `--session-id` → **aucun code du produit ne peut le constater**, et ce n'était déjà plus possible depuis ADR-002 : sous V1 la sortie du terminal n'est **jamais capturée**. `SEED_SESSION_ID_MISMATCH`, qui portait cette détection, a été **supprimé à la correction du gate C** — inatteignable *par construction*, il laissait croire qu'un cas avait été prévu. **Ce qui est réellement observé** : un `--session-id` refusé fait échouer le démarrage (`SEED_PROCESS_NOT_STARTED`) ou l'apparition du transcript (`SEED_TRANSCRIPT_NOT_FOUND` — il est cherché **par ce nom**). **Aucun repli V5 dans ces deux cas**, contrairement à ce que cette ligne annonçait : le repli n'est disponible que **jusqu'à la création du terminal** (`conversations.ts` : « à partir d'ici, plus aucun repli » — une seconde conversation pré-remplie par-dessus une session qui tourne serait pire que l'échec). Nommer la cause *comme telle* supposera de lire le transcript ou `sessions/<pid>.json`, donc le **lot D** |
| D4 | `claude agents --json` | Contrat CLI | Inventorier les sessions vivantes | ADR-001 §1, **mention incidente** — non exercé par le spike A1 | Sortie non-JSON ou schéma inattendu → repli sur D5, puis erreur |
| D5 | `<CONFIG>/sessions/<pid>.json` (par défaut `~/.claude/sessions/`) | Fichier d'état interne | Repli d'inventaire des sessions | ADR-002 (V1) — lu sous la racine du bac à sable, voir D17 | Répertoire absent → l'inventaire se limite à D4 |
| D6 | `<CONFIG>/projects/<cwd-slug>/<sessionId>.jsonl` (par défaut `~/.claude/projects/`) | Transcript interne | Lire une réponse, détecter la fin de tour | ADR-002 (V1) — lu sous la racine **par défaut**, voir D17 | Fichier introuvable ou lignes non parsables → repli sur le hook `Stop`, sinon erreur `TRANSCRIPT_UNREADABLE` |
| D7 | Slugification du cwd (`:` et `\` → `-`) | Convention de nommage interne | **Rien, et c'est une décision (C3-FIX).** Localiser le transcript se fait par **balayage + nom de fichier** (D23), jamais par ce calcul : le nom du fichier est l'identifiant que **nous** imposons, le slug est une convention que rien ne garantit | ADR-002 (V1) — observée sur le chemin du transcript relevé | Sans objet : aucun code du produit ne dérive ce slug. Un test d'unité vérifie même que le fichier est trouvé sous un slug **fantaisiste** |
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
| D20 | Le shell du terminal masqué engendre le processus du tour 1, observable dans la **table des processus** | Comportement du système d'exploitation, **pas** une API interne Claude | **Distinguer « rien n'a démarré du tout » de « démarré, mais aucun tour »** — deux causes, deux remédiations. Ce n'est **plus** ce qui autorise à attacher puis supprimer le terminal : c'est D23 | **Mesuré C1 le 2026-07-26** : `seedProcessObserved: true`, une lecture de table suffisant en pratique. **Re-mesuré C3-FIX** en vraie fenêtre : processus observé à **+1,6 s** après l'envoi, deux lectures | Aucun processus n'est né du shell dans l'échelle bornée → erreur `SEED_PROCESS_NOT_STARTED`. **LE BLANC QUI ÉTAIT ASSUMÉ ICI EST COMBLÉ, ET IL A COÛTÉ UN DÉFAUT DE RECETTE** : « le tour est prouvé démarré, pas terminé » a été lu comme une limite acceptable ; le terminal était donc supprimé ~2,1 s après l'envoi, et sa suppression **tue** le `claude` du tour 1 (ADR-002) — panneau vide, succès rendu. C'est D23 qui porte désormais la preuve du tour |
| D22 | **`showSetupScreens()` bloque une session interactive — et ce qui reste à franchir, une fois l'OAuth accordé, est la CONFIANCE DU DOSSIER, posée PAR RÉPERTOIRE** | Comportement du CLI au démarrage | **Rien** — c'est une **précondition de la machine**, recensée parce qu'elle rend le tour 1 impossible sans que rien ne le signale. Depuis C3-FIX, elle est néanmoins **NOMMÉE** à l'appelant : faute de transcript, la route rend `SEED_TRANSCRIPT_NOT_FOUND` | **Mesurée C1 (reprise 1)** : `[STARTUP] Running showSetupScreens()...` jamais suivie d'autre chose, **87 s**, aucun transcript. **RE-MESURÉE C3-FIX le 2026-07-26, APRÈS l'autorisation OAuth**, et c'est ce qui la précise : dans un dossier **neuf**, même arrêt, **180 s** sans une ligne (`hasCompletedOnboarding` valant pourtant **vrai**) ; dans un dossier dont `projects.<chemin>.hasTrustDialogAccepted` vaut **vrai**, le **même** binaire, la **même** ligne et le **même** prompt écrivent leur transcript en **2 533 ms**. Le discriminant est donc le **répertoire**, pas le compte | **Aucune erreur n'est levée, aucune sortie n'est produite** : le processus `claude` existe, porte la ligne exacte attendue et **ne fait rien**. **La conclusion « le dossier est hors de cause » de C1 (reprise 1) EST DÉSORMAIS FAUSSE**, et son erreur est instructive : elle mesurait en amont, quand l'OAuth bloquait **partout** — deux causes superposées se lisent comme une. Franchir ces portes reste **interdit** (leur libellé n'est pas contractuel) : `cmgr doctor` (lot D) doit les vérifier et les nommer |
| D23 | **Le transcript d'une session est nommé `<sessionId>.jsonl`, et il n'existe QUE si un tour a eu lieu** | Convention de nommage + comportement du CLI (précise D6) | **Le seul fait qui établisse que le tour 1 a eu lieu** : le mécanisme le cherche PAR NOM sous les racines de projets, avant d'attacher le panneau et avant de supprimer le terminal amorceur | **Mesuré C3-FIX le 2026-07-26**, deux fois. Sonde hors éditeur, dossier approuvé : apparition à **+2 533 ms** (8 enregistrements, `user` présent, `assistant` ABSENT), réponse écrite à **+6 417 ms** (11 enregistrements). Vraie fenêtre `test-electron`, journal de l'extension : apparition **+2,0 s**, sortie retombée **+5,5 s**, panneau attaché **+62 ms**, transcript final **12 lignes / 15 353 octets**, types `user` **et** `assistant` | Aucun fichier de ce nom sous aucune racine dans les 45 s → erreur `SEED_TRANSCRIPT_NOT_FOUND`, **puis** suppression du terminal. **Ce que l'existence n'établit PAS** : que la réponse soit complète — le fichier apparaît AVANT elle. D'où la grâce bornée accordée à la sortie du tour (croissance depuis l'apparition, puis silence de 3 s, plafond 30 s), qui ne lève jamais. **Aucune ligne n'est lue** : existence et taille seules |
| D24 | **Le `label` d'un onglet de conversation est dérivé du CONTENU de la conversation, et il CHANGE en cours de route** | Détail d'implémentation de la webview (précise D2, D10) | **Vérifier, au moment de fermer, que l'onglet désigné est bien celui qui avait été listé.** Il n'est PAS un identifiant : il entre dans la poignée synthétisée par la fenêtre comme élément de *vérification*, jamais comme clé | **Mesuré C4 le 2026-07-27, en vraie fenêtre, sur 2.1.220** : à l'attachement le libellé vaut `Claude Code`, puis il devient `Confirm session response` — dérivé du prompt joué — en moins de 20 s. Une réouverture sur le même `sessionId` rejoue la même séquence (`Claude Code`, puis le libellé dérivé), ce qui en fait aussi le seul indice, côté `vscode`, que la session a bien été **chargée**. Relevé C3-FIX cohérent : `Respond with OK exactly`, **511 ms** après l'attachement | **Aucune erreur n'est levée : le libellé change, tout simplement.** La fermeture le CONSTATE et refuse — `CONVERSATION_HANDLE_STALE`, aucun onglet fermé, la remédiation renvoyant à `cmgr conversations`. Le coût d'un changement de convention est donc une poignée à relister, jamais une fermeture au mauvais endroit. **Deux états sont indiscernables par ce champ** — l'onglet parti dont le voisin a glissé, et l'onglet vivant renommé sur place — et le produit répond `STALE` aux deux : voir `packages/vscode/src/tabs.ts`. **⚠️ CE CHAMP NE SUFFIT PAS, ET C'EST PROUVÉ PAR EXÉCUTION (gate final du lot C, 2026-07-27, VSCode 1.130.0)** : sur deux panneaux fraîchement attachés le libellé vaut `Claude Code` **des deux côtés**, et fermer le premier fait glisser le second sur son rang — le voisin devient alors identique au disparu dans les quatre champs relevés, et la fermeture fermait *sa* conversation en rendant `ok: true`. La poignée retient donc **en plus** le PLACEMENT de toutes les conversations, et n'est **valable qu'une fois** |
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
- **D17 — dette du lot D, et ce que C3-FIX en consomme exactement.** La sémantique de
  `CLAUDE_CONFIG_DIR` reste **non mesurée** et doit l'être au lot D. Le mécanisme n'en dépend
  toujours pas pour **décider** : il **balaie** les deux racines possibles — celle par défaut
  d'abord, puis `<CLAUDE_CONFIG_DIR>/projects` si la variable est posée — et reconnaît le fichier
  par son **nom**. Une racine fausse ne produit donc qu'un `readdir` inutile, jamais une
  conclusion fausse. `sessions/<pid>.json` n'est toujours lu **nulle part**.
  **Raisonnement, non mesure, et il est écrit comme tel** : la session amorcée ne peut de toute
  façon pas voir `CLAUDE_CONFIG_DIR`, puisqu'elle commence par `CLAUDE_` et que la neutralisation
  d'environnement du mécanisme la **supprime** du terminal. Les deux racines sont balayées quand
  même — un raisonnement sur notre propre code ne vaut pas une mesure.
- **D19 + D20 + D23 — ce que « la conversation est ouverte » veut dire, exactement, depuis
  C3-FIX.** La conjonction des trois lignes délimite la capacité réelle, et il vaut mieux la lire
  que la deviner. **Ce qui est établi** : le tour 1 a **eu lieu** — son transcript existe (D23) —,
  et la commande d'attachement a **répondu** par un panneau. **Ce qui ne l'est pas** : que le
  panneau porte bien cette session (D19 : il s'ouvre même pour un identifiant jamais amorcé), et
  que la **réponse** du tour soit complète — le transcript apparaît **avant** elle, d'où la grâce
  bornée accordée à sa sortie. Restituer la réponse reste `cmgr open --wait` (lot D), et ce n'est
  donc pas une commodité d'affichage.
  **Un indice nouveau, relevé et non asserté (C3-FIX)** : sur une ouverture dont le tour a eu
  lieu, le libellé de l'onglet est devenu `Respond with OK exactly` — dérivé du **contenu** de la
  conversation — **511 ms** après l'attachement. C'est exactement le discriminant que D10
  annonçait et que C1 n'avait jamais vu autrement que figé à `Claude Code`. Il n'est **pas**
  asserté : il dépend de la latence du service, et un critère de merge ne s'y adosse pas.
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

> **MESURE DU 2026-07-26 (C3-FIX) — LA SECONDE PORTE EST CONFIRMÉE, ET C'EST DÉSORMAIS ELLE QUI
> BLOQUE.** L'autorisation OAuth a été accordée sur le poste de référence entre C1 et cet
> incrément. Deux sondes, même binaire (`2.1.220`), même ligne, même prompt, environnement hérité
> neutralisé de la même façon :
>
> | Sonde | `cwd` | `hasTrustDialogAccepted` | Transcript | Dernière ligne du journal CLI |
> |---|---|---|---|---|
> | 1 | dossier **neuf** | **absent** | **aucun en 180 s** | `[STARTUP] Running showSetupScreens()...` |
> | 2 | dossier **déjà approuvé** | **vrai** | **+2 533 ms**, réponse à **+6 417 ms** | `[engine] turn 1 end (… stop=end_turn)` |
>
> Ce que ces deux lignes établissent, et qu'aucune ne pouvait établir seule : **le discriminant
> est le RÉPERTOIRE**, pas le compte ni la machine. `hasCompletedOnboarding` vaut **vrai** dans les
> deux cas — l'onboarding global est franchi. Ce qui reste est la question de confiance, posée
> **par répertoire** et **jamais héritée**.
>
> **Ce que cela ne dit pas, et c'est un blanc nommé** : le **libellé exact** de ce qui s'affiche
> dans la sonde 1 n'a **pas** été observé — la sortie d'un pty masqué n'est pas capturée, et
> révéler le terminal pour la lire est interdit (vol de focus). L'attribution à la confiance du
> dossier repose sur la **corrélation** du tableau ci-dessus et sur le nom du drapeau que le CLI
> écrit lui-même. **Propriétaire de ce blanc : `cmgr doctor`, lot D**, dont c'est précisément la
> raison d'être — vérifier et **nommer** ces portes, jamais les franchir.
>
> **Conséquence outillée** : le scénario d'intégration `open-conversation` **relève** cet état
> avant d'agir et choisit son assertion en conséquence — tour vérifié d'un côté, erreur **nommée**
> de l'autre. Aucun des deux côtés n'accepte le succès muet. Pour éprouver la voie complète, le
> harnais accepte `CMGR_OPEN_WS=<dossier déjà approuvé>`.

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
> **Conséquence opérationnelle, TELLE QU'ELLE ÉTAIT EN C1 — et elle ne suffisait pas.** La route
> ouvrait un panneau et amorçait un processus sans que le tour ait lieu, en portant
> `firstTurnVerified: false`. **Mesuré en recette le 2026-07-26** : ce champ n'a pas empêché le
> défaut, parce qu'un `HTTP 200` accompagné d'un panneau attaché **se lit comme un succès**. La
> route **refuse** désormais : `SEED_TRANSCRIPT_NOT_FOUND`, aucun panneau attaché (D23).

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
