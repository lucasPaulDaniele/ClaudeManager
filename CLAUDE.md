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
- **Couverture** : `@vitest/coverage-v8`, deux seuils **configurés et vérifiés** dans `vitest.config.ts` — **100 %** sur `packages/core/src/**`, et un seuil global fixé **au plancher entier de ce qui est réellement atteint** (99 % lignes et instructions, 98 % branches, 98 % fonctions — mesure du 2026-07-27, correction du gate C final volet 1 : 99,63 · 99,21 · 99,00 · 99,63, identique sous Windows et sous Linux). Jamais un chiffre d'intention : un seuil qu'on n'atteint pas est un seuil qu'on désactivera. Le seuil se relève quand la couverture monte ; il ne s'abaisse **jamais en silence** — la seule soupape est une justification nommée et datée. **Une exception, nommée et datée, reconduite le 2026-07-27** : les branches restent à 98 pour un réel de 99,21, parce que le compte absolu ne suit pas le pourcentage — 1 006 branches couvertes sur 1 014, quand un seuil à 99 en exige 1 004. La marge serait de **deux branches** (elle était d'une à la mesure précédente, de zéro à celle d'avant) ; un plancher exact mais intenable se contourne au premier incident, et c'est alors la règle entière qui perd son autorité. Les **fonctions** sont dans le même cas, et de façon plus nette : 200 sur 202 font tout juste 99,00 %, et un seuil à 99 en exigerait 200 — la marge y serait de **zéro**, c'est-à-dire qu'une seule fonction non couverte ferait tomber la CI. Le détail du calcul est dans `vitest.config.ts`, avec la localisation des huit branches restantes. Y figurent aussi **les exclusions nommées et datées, énumérées dans `vitest.config.ts`** *(pas de cardinal ici : il serait faux au prochain ajout)*, parce que l'API de l'éditeur en est la substance même et que `npm run test:integration` s'en charge. Toute nouvelle exclusion se justifie au même endroit, avec sa date.
- **Lint** : ESLint flat config + `typescript-eslint`. **Zéro avertissement toléré**, y compris une directive `eslint-disable` devenue inutile.
- **CI** : GitHub Actions (lint, typecheck, tests unitaires avec seuils de couverture). Le **build** est outillé (`build:cli`, `build:vscode`, `build:integration`), et l'**empaquetage** l'est depuis l'incrément C3 (`package:vscode`, `package:cli`, `package:all`, `verify:packaging`) — aucun des deux n'est exécuté par la CI publique. Seule la **publication** — npm, Marketplace — relève encore du **lot E**.

## Principes fondateurs

1. **Jamais de dépendance au focus — ESSENTIEL.** Toute opération doit fonctionner sur une fenêtre **minimisée, masquée, sur un autre bureau virtuel ou derrière d'autres applications**. Sont **interdits** : l'automatisation clavier/souris (`robotjs`, `nut.js`, `SendKeys`, AutoHotkey), l'activation ou la mise au premier plan d'une fenêtre, et toute API exigeant qu'un élément ait le focus. Motif : l'outil s'exécute pendant que l'humain travaille ailleurs ; voler le focus rendrait le poste inutilisable et rendrait le pilotage non déterministe. `vscode.commands.executeCommand` satisfait cette contrainte, aucune automatisation d'UI ne la satisfait.
   Ce principe n'est pas qu'une intention : il a été **éprouvé**. La voie d'ouverture retenue a été mesurée fenêtre **minimisée**, handle de premier plan **identique avant, pendant et après** (`docs/adr/002-ouverture-interactive.md`). Un assouplissement temporaire — autoriser l'emprunt de focus sous conditions — avait été accordé le 2026-07-25 pour juger une voie sur pièce plutôt que sur principe ; il a été **retiré le jour même, sur preuve**, la voie retenue n'empruntant aucun focus. Le principe est donc strict, **sans exception**.

2. **L'isolation de fenêtre est l'invariant du produit.** C'est à ClaudeManager ce que le RLS est à une base multi-tenant. Toute opération est précédée d'une **vérification d'appartenance** : le processus appelant est-il un descendant de cette fenêtre ? Une commande émise depuis la fenêtre A ne doit **jamais** affecter la fenêtre B — **y compris quand A et B ouvrent le même dossier**. `VSCODE_PID` ne discrimine pas les fenêtres (un processus principal en héberge plusieurs) : ne jamais l'utiliser comme clé d'identité.

3. **Adhérence assumée à des API internes.** L'outil s'appuie sur des commandes (`claude-vscode.*`) et des formats de fichiers (`~/.claude/**`) **non documentés et non contractuels**, qui peuvent disparaître à toute mise à jour de l'extension Claude. Conséquences impératives :
   - **Échouer explicitement, jamais dégrader en silence.** Une commande absente est une erreur nommée, pas un `no-op`. **Le repli V5 ne déroge pas à cette règle** : il intervient **après** l'émission de l'erreur nommée, jamais à sa place. L'appelant apprend toujours que le mécanisme nominal est tombé, et *ensuite* que l'outil a basculé — les couples erreur / repli sont dans `docs/compatibilite.md` (D3, D18).
   - Toute dépendance à une API interne est **déclarée dans `docs/compatibilite.md`** avec la trace de sa vérification : **où** elle a été établie — ADR et voie — ou, quand rien ne l'étaie, un **`— non vérifié` assumé**. Un blanc honnête vaut mieux qu'un tampon global qui date des lignes jamais mesurées.
   - `cmgr doctor` vérifie les présupposés et le dit à l'utilisateur.
   - Avant toute évolution, se demander : « que se passe-t-il si l'extension change ce comportement ? »

4. **Le cœur ne connaît pas VSCode.** `packages/core` n'importe **jamais** le module `vscode`. Toute la logique (identité, registre, sessions, transcripts) y vit et est testable en Node pur. `packages/vscode` ne contient que ce qui exige l'API de l'éditeur. Motif : sans cette règle, tester devient impossible sans lancer un éditeur complet.

5. **Pas de mocks du système réel.** Les tests d'intégration tournent contre une **vraie instance VSCode**, jamais contre un faux `vscode.commands`. Les tests unitaires du cœur consomment des **fixtures capturées réelles** (vrais transcripts JSONL, vrais lockfiles, vraies sorties de `claude agents --json`), jamais des doubles inventés. Motif : les bugs de cet outil naissent précisément des écarts entre le comportement supposé et le comportement réel de l'écosystème Claude — un mock reproduit la supposition, pas le réel.

6. **Sortie machine-lisible par défaut.** La CLI écrit du **JSON sur stdout** et les diagnostics sur **stderr**, et porte un code de sortie signifiant. Motif : le consommateur principal est un agent, pas un humain.

7. **Rattrapage de l'existant.** Pour **toute** modification, se demander ce que deviennent les états déjà en place : registres de fenêtres écrits par une version antérieure, hooks déjà installés dans `~/.claude/settings.json`, conversations déjà ouvertes. Un changement de format de registre doit lire l'ancien ou le purger explicitement ; `install-hook` doit être **idempotent** et ne jamais écraser une configuration utilisateur sans sauvegarde. En cas de doute sur l'état réel d'une machine, **poser la question** plutôt que supposer.

## Structure du projet

Ce qui porte `(lot X)` **n'existe pas encore** : c'est annoncé et rattaché à un lot, pas livré.
Tout le reste est dans le dépôt.

```
ClaudeManager/
├── packages/
│   ├── core/               # @claudemanager/core — logique, ZÉRO import de `vscode`
│   │   └── src/
│   │       ├── identity/   # résolution « ma fenêtre » par chaîne d'ancêtres
│   │       ├── registry/   # registre des fenêtres pilotables, auto-nettoyant
│   │       ├── sessions/   # (lot D) inventaire des sessions Claude vivantes
│   │       ├── transcript/ # (lot D) lecture JSONL, fin de tour, extraction de réponse
│   │       └── client/     # client HTTP de l'extension compagnon, confirmation de canal
│   ├── vscode/             # claudemanager-vscode — extension compagnon
│   ├── cli/                # @claudemanager/cli — binaire `cmgr` (`windows`, `whoami`, `conversations`, `open`, `close`)
│   └── mcp/                # (lot E) @claudemanager/mcp — serveur MCP stdio
├── docs/
│   ├── adr/                # décisions structurantes, datées
│   └── compatibilite.md    # matrice des API internes de l'écosystème Claude
├── tests/
│   ├── unit/
│   ├── integration/        # vraie instance VSCode
│   ├── packaging/          # le contenu RÉEL du VSIX et du tarball npm — artefacts bâtis
│   ├── e2e/                # (lot C) scénarios multi-fenêtres
│   └── fixtures/           # captures réelles (tables de processus, entrées de registre)
├── .github/workflows/ci.yml
├── CLAUDE.md
├── README.md
└── package.json
```

Il n'y a **pas** de `docs/architecture.md` : l'architecture est décrite ici et dans les ADR, et
aucun lot ne porte ce fichier. Le retirer de la cible vaut mieux que l'y laisser en dette muette.

## Lots

Le chantier est découpé pour la skill `/orchestrer` : **1 incrément = 1 PR**, gate d'audit toutes les 3 PRs mergées et en fin de lot.

| Lot | Contenu |
|---|---|
| **0** | Socle : spike de faisabilité (jetable), squelette, conventions, CI |
| **A** | Trancher le mécanisme d'ouverture interactive : spike comparatif des voies, ADR-002, réalignement du socle documentaire |
| **B** | Noyau : identité, registre, extension compagnon, CLI de lecture, tests d'intégration |
| **C** | Ouverture, **installabilité**, fermeture : mécanisme V1 (C1), client HTTP du cœur et `cmgr open` (C2), **empaquetage VSIX et installation** (C3), `cmgr conversations` et `cmgr close` (C4) |
| **D** | Observabilité : transcript, hook `Stop`, `cmgr read` / `cmgr wait` / `cmgr doctor` |
| **E** | Diffusion : serveur MCP, **E2E multi-fenêtres**, README de diffusion, recette bout-en-bout |
| **F** | Audits finaux : findings documentaires consignés pendant les lots de livraison |

**Décision n°17 du 2026-07-26 — l'empaquetage remonte du lot E au lot C.** *Tant que l'extension
n'est pas installable, aucun incrément n'est livrable* : ce qui est mergé reste alors invérifiable
ailleurs que sur le poste de développement. La fermeture recule en conséquence (C4), l'E2E
multi-fenêtres passe au lot E — il exige l'extension **installée**, pas seulement compilée —, et
un lot F est créé pour l'ordre du jour ci-dessous.

### Politique de gate — ce qui se corrige, et ce qui se consigne

Le gate d'audit tombe toutes les 3 PR mergées et en fin de lot. **Pendant les lots de
livraison**, il ne traite pas toutes ses dimensions de la même façon :

| Dimension | Traitement |
|---|---|
| **Correctness** — le code fait-il ce qu'il annonce ? | auditée **et corrigée** dans l'incrément |
| **Sécurité** — jeton, chemin personnel, surface d'attaque, isolation de fenêtre | auditée **et corrigée** |
| **Rattrapage de l'existant** — registres, hooks, conversations déjà en place | auditée **et corrigée** |
| **Documentaire** — formulation, complétude, cohérence rédactionnelle | **consignée, pas corrigée** |

Les findings documentaires deviennent l'**ordre du jour du lot F**. Motif : les corriger au fil
de l'eau consomme le temps d'un lot de livraison pour un gain qui ne se voit qu'à la relecture,
et disperse en dix endroits une revue rédactionnelle qui vaut mieux d'un bloc. Consigner n'est
pas taire : un finding non traité reste écrit, daté, et attend son lot.

**Exception non négociable** : une documentation qui **ment sur un fait opératoire** — une
commande à taper, un chemin, un seuil, un présupposé de sécurité — se corrige **immédiatement**,
dans l'incrément qui la rend fausse. Ce n'est pas un finding documentaire, c'est un défaut : un
lecteur le paie en essayant de suivre ce qui est écrit.

## Mécanisme retenu

Arbitré le 2026-07-25 au vu de mesures sur pièce — voir `docs/adr/002-ouverture-interactive.md` (voie V1). Il **remplace** celui de `docs/adr/001-pilotage-des-conversations.md`, rejeté en recette : le tour 1 y était joué en headless, donc **non interactif**.

**Ouvrir une conversation = jouer le tour 1 dans un terminal masqué, puis attacher le panneau à cette session.**

Dans la fenêtre cible, et dans cet ordre :

1. Générer un `uuid`.
2. Créer un terminal **masqué** — `hideFromUser: true`, `show()` **jamais** appelé — dans le workspace de la fenêtre, en **neutralisant les variables d'environnement héritées** de la session Claude appelante (`env: { CLAUDECODE: null, CLAUDE_CODE_CHILD_SESSION: null, … }` — les huit variables recensées dans `docs/compatibilite.md`). **Cette neutralisation fait partie du mécanisme, pas de son implémentation** : sans elle, le `claude` lancé se déclare agent enfant non interactif et cesse d'écrire son transcript, silencieusement.
3. Y jouer le tour 1 dans un vrai pty : `claude --session-id <uuid> "<prompt>"`. Le prompt positionnel est **soumis automatiquement** au démarrage de la session interactive.
   **Transport** : le terminal est créé sur un **shell** (`pwsh`) et la ligne lui est envoyée par `sendText` — **jamais** par un `shellPath` pointant directement sur `claude.exe`. Ce détail fait partie du mécanisme : c'est le shell qui garde un canal ouvert vers le processus, donc qui rend franchissables les deux portes ci-dessous.
   **Deux portes peuvent bloquer cette étape indéfiniment**, et il faut les avoir prévues : l'**onboarding du CLI interactif** (sélecteur de thème au premier lancement — la porte est l'onboarding lui-même, `theme` peut être déjà renseigné, et aucune variable d'environnement ne le court-circuite) et la **confiance du dossier** (`Quick safety check…`, posée **par répertoire**). Les deux se franchissent par `sendText`, fenêtre minimisée et sans focus, et ne se présentent qu'une fois par machine et par dossier — mais **leur libellé n'est pas contractuel** : `cmgr doctor` doit les **vérifier et les nommer**, jamais les franchir à l'aveugle.
4. **Constater que le tour 1 a eu lieu** : le transcript de la session — `<sessionId>.jsonl` — existe, **cherché par son nom** sous les racines de projets du CLI. *Cette étape n'est pas une vérification de confort : `dispose()` **tue** le `claude` du tour 1, et elle est la seule chose qui empêche de le tuer avant qu'il ait joué. Mesuré le 2026-07-26 : sans elle, le terminal était supprimé **2,1 s** après l'envoi et le panneau s'attachait sur une conversation **vide** — sans prompt ni réponse — pendant que la route rendait un succès complet.* Aucun transcript dans le délai = **erreur nommée** (`SEED_TRANSCRIPT_NOT_FOUND`), et le terminal est supprimé quand même. **Le fichier apparaît AVANT la réponse** (+2,5 s contre +6,4 s, mesuré) : une **grâce bornée** attend donc que sa sortie ait été écrite, puis qu'elle se soit tue, sans jamais lever d'erreur.
5. Attacher le panneau : `claude-vscode.editor.open(<uuid>)`. Le `cwd` de la session doit correspondre au workspace de la fenêtre, faute de quoi la commande **réussit en ouvrant un panneau vide** — l'absence d'erreur ne prouve jamais l'attachement. Et **un onglet apparu ne le prouve pas davantage** : la commande ouvre un panneau même pour une session jamais amorcée (`docs/compatibilite.md`, D19). Le diff d'onglets est un **relevé**, la preuve du tour est l'étape 4.
6. Faire disparaître le terminal : `terminal.dispose()`. Le `claude` du panneau survit, l'onglet reste intact.

Durée de visibilité du terminal pour l'humain : **nulle**. Mesuré fenêtre minimisée, sans aucun emprunt de focus.

**Deux couches de transport du prompt — à ne jamais confondre.** L'**interface de `cmgr` vis-à-vis de son appelant** passe le prompt **par fichier** (`--prompt-file`), jamais en argument : l'échappement des prompts longs en shell est une source de bugs inépuisable. Le **transport interne vers le pty**, lui, est celui de l'étape 3 — prompt **positionnel** sur la ligne de commande, la seule forme mesurée par ADR-002. Les deux règles coexistent parce qu'elles ne portent pas sur la même couche.
**Question ouverte, à trancher au lot C** : cette forme positionnelle ne tient pas à l'échelle visée — la ligne de commande Windows plafonne autour de 32 Ko, quand un prompt d'orchestration en pèse couramment 15 à 25. Aucune solution n'est arrêtée à ce jour ; seule la question l'est. La trancher supposera une mesure, pas une intuition.

**Fermer** = `vscode.window.tabGroups.close(tab, true)` sur l'onglet dont le `viewType` contient `claudeVSCodePanel`. `preserveFocus: true` n'est **pas** un détail d'implémentation : le paramètre est optionnel dans l'API, et l'omettre fait reporter le focus sur un autre onglet — donc enfreindre le principe fondateur n°1. Un test de source l'impose.

**Mais l'onglet ne se désigne pas.** `vscode.Tab` **ne porte aucun identifiant**, et aucun de ses champs n'est stable : le `viewType` est le même pour tous les panneaux Claude (D2), le `label` est dérivé du **contenu** de la conversation et change en cours de route (D24, mesuré le 2026-07-27), la position bouge au premier déplacement. La fermeture est donc un **contrat en deux temps** : `GET /conversations` **synthétise** une poignée opaque par onglet et retient l'état relevé ; `POST /conversations/close` **ré-énumère** et exige que l'onglet désigné corresponde encore — sinon il refuse **sans rien fermer**. `cmgr close` exige donc un `cmgr conversations` préalable, dans la même session de fenêtre, et c'est le prix d'un identifiant qui ne mente pas. Le succès n'est rendu qu'après avoir **constaté** que l'onglet a quitté `tabGroups` : le booléen que `close` résout est un relevé, jamais la preuve.

**Et « correspondre » a deux sens, parce qu'un seul ne suffisait pas — corrigé au gate final du lot C.** Les quatre champs relevés ne discriminent pas : deux panneaux fraîchement attachés ne diffèrent que par leur **rang**, et fermer le premier fait **glisser** le second sur le rang libéré. Le voisin devenait alors, dans ses quatre champs, la poignée du disparu — et le produit fermait *sa* conversation en rendant `ok: true` (prouvé par exécution). Deux règles ferment ce chemin, et elles sont **du mécanisme**, pas de son implémentation :

1. **Le relevé d'ensemble.** Une poignée ne désigne pas un onglet, elle désigne **une place dans un arrangement** : elle retient le **placement** de toutes les conversations — `viewType` et coordonnée, jamais le libellé des *autres* —, et la fermeture exige qu'il n'ait pas bougé. Le libellé de l'onglet **désigné**, lui, reste comparé : c'est la vérification qu'impose D24. Exclure celui des voisins n'est pas une commodité : un libellé change tout seul quelques centaines de millisecondes après l'attachement, et l'y faire entrer périmerait toutes les poignées **pendant** qu'une conversation voisine répond.
2. **Une poignée ne ferme qu'une fois.** Dès que l'éditeur a été sollicité avec elle, elle est **dépensée** — que la fermeture aboutisse ou non. C'est ce qui rend « relancer » réellement sûr : une seconde fermeture sur la même poignée ne peut **rien** fermer.

**Ce que cela impose à l'appelant, et c'est un fait opératoire** : fermer **aussitôt** après avoir listé. Toute conversation qui s'ouvre, se ferme ou se déplace périme **toutes** les poignées de la fenêtre. Corollaire pour le renouvellement de `/orchestrer` : **ouvrir la neuve → lister → fermer l'ancienne**. Lister avant d'ouvrir rendrait une poignée que l'ouverture périmerait aussitôt.

**Ce qui reste ouvert, nommé** : deux onglets identiques en tous leurs champs relevés qui **permutent** sans que le placement change — un glisser-déposer humain entre les deux temps. Aucun champ ne les sépare ; aucune règle bâtie sur `vscode.Tab` ne peut le fermer. **Propriétaire : lot E.**

**Ce que fermer un onglet fait à la session — mesuré le 2026-07-27, et ce n'est pas anodin** : le `claude.exe` de la conversation **meurt** avec son onglet. Le transcript, lui, **survit intact**, et une réouverture sur le même `sessionId` retrouve la conversation *et son historique* (le libellé redevient dérivé du contenu). **Conséquence pour `/orchestrer`** : l'ordre est **ouvrir la neuve d'abord, fermer l'ancienne ensuite** — jamais l'inverse. Une conversation qui fermerait son propre onglet tuerait le processus qui attend la réponse de `cmgr close`.

**Et les deux opérations s'enchaînent, elles ne se chevauchent pas.** La confirmation de fermeture exige **deux faits** : que le **nombre** d'onglets de conversation ait diminué, **et** qu'il y en ait un de moins portant le relevé `viewType` + `label` de celui qu'on a fermé (voir `removalConfirmed`). Une ouverture qui aboutirait *pendant* l'attente de la fermeture ramènerait le premier compte à son point de départ et ferait sortir une fermeture pourtant réussie en `CONVERSATION_CLOSE_FAILED`. Séquentiellement — l'ouverture rendue **avant** que la fermeture ne commence —, le cas ne se présente pas : le panneau neuf est déjà compté dans l'état d'avant. Les deux routes ont des files distinctes, rien ne l'empêche donc mécaniquement : c'est une règle d'appel. Elle est d'autant plus impérative depuis le gate final : une ouverture concurrente périme aussi le **relevé d'ensemble**, donc la poignée elle-même.

**La fenêtre borne son propre travail, en entier.** Deux budgets de 5 s : l'**appel** à `tabGroups.close` — qu'une invite de sauvegarde peut faire pendre indéfiniment — et la **confirmation** par ré-énumération. Ils sont déclarés **une seule fois**, dans le cœur (`protocol.ts`), parce que les délais du client s'en **déduisent** au lieu de les redire : `cmgr conversations` doit dépasser ce qu'une fermeture retient de la file d'un rang que les deux routes partagent, sans quoi une énumération parfaitement servie sort en `WINDOW_UNREACHABLE`.

**Repli officiel — la voie V5.** Si `claude-vscode.editor.open` perd son paramètre de session, ou si toute autre évolution de l'extension Claude rend V1 inopérant **avant que le terminal d'amorçage n'existe**, l'outil **émet l'erreur nommée correspondante, puis bascule sur `claude-vscode.editor.open(null, <prompt>)`** plutôt que d'échouer sans recours. **Passé la création du terminal, il n'y a plus de repli, et c'est délibéré** : un `claude` tourne peut-être déjà, et ouvrir par-dessus une seconde conversation pré-remplie serait pire que l'échec qu'on répare. C'est précisément le cas d'un `--session-id` qui cesserait d'être accepté en mode interactif : sous V1 la sortie du terminal n'est jamais capturée, ce refus ne se constate donc que par l'absence de démarrage (`SEED_PROCESS_NOT_STARTED`) ou de transcript (`SEED_TRANSCRIPT_NOT_FOUND`) — deux erreurs nommées **sans repli** (`docs/compatibilite.md`, D3). **L'ordre n'est pas négociable** : le repli s'ajoute à l'erreur, il ne la remplace pas — sans quoi le principe fondateur n°3 serait contredit et l'appelant croirait le mécanisme nominal intact. Le résultat, lui, est le même pour l'humain : la conversation est ouverte, le prompt pré-rempli, l'humain n'a plus qu'à valider. Perte d'autonomie assumée — mieux vaut un geste humain qu'une conversation non ouverte. C'est une **exigence de conception des lots B et C**, pas un simple classement au tableau.

Le paramètre `initialPrompt` de `editor.open` **n'est jamais utilisé pour soumettre** : il se contente de pré-remplir le champ de saisie. C'est prouvé **deux fois** — au source (il appelle `setInputText`, rien d'autre) et par mesure. Et la frappe qui manque n'est pas rattrapable : mesuré aussi, les frappes synthétiques n'atteignent pas le champ du webview, avec ou sans focus. **Ne pas y revenir sans ADR.** Le repli V5 s'appuie sur ce même paramètre, mais en assumant la validation humaine.

**Contrainte induite — la réponse du tour 1 n'est pas rendue à l'appelant.** Le tour 1 étant joué dans un terminal dont la sortie n'est pas capturée, sa réponse ne s'obtient que par le **transcript** (`~/.claude/projects/<slug>/<sessionId>.jsonl`) ou par le **hook `Stop`**, c'est-à-dire par le **lot D**. `cmgr open --wait` n'est donc pas une commodité d'affichage : c'est le **seul** moyen d'obtenir la réponse du premier tour, et il dépend du lot D.

**Ce que le mécanisme emprunte au lot D, et rien de plus.** Depuis l'étape 4, il **cherche un nom de fichier** et **relève sa taille** — jamais une ligne de contenu. La frontière du lot D est donc, précisément : **lire** le transcript (enregistrements, fin de tour, extraction de la réponse). Elle n'a pas bougé d'un pouce pour ce qui compte, et l'emprunt est le minimum strict sans lequel `dispose()` tue le tour qu'on vient de lancer. Corollaire, écrit parce qu'il est contre-intuitif : `firstTurnVerified: true` signifie « le transcript de cette session existe », pas « la réponse est complète ».

## Périmètre — ce que l'outil ne fait pas

Ces exclusions sont des **décisions**, pas des manques. Ne pas les réintroduire sans ADR.

- **Écrire dans une conversation déjà attachée.** Aucun canal **local et dans le périmètre** ne le permet. Pour la frappe, ce n'est plus une supposition : **mesuré**, même avec le focus, la soumission n'a pas lieu — les frappes synthétiques n'atteignent pas le champ de saisie du webview, ni par injection sans focus (Chromium n'expose aucune fenêtre enfant adressable), ni fenêtre au premier plan (`docs/adr/002-ouverture-interactive.md`, voie V3). Un canal de session à session **existe** en revanche — `SendMessage` via Remote Control — mais il passe par `claude.ai` (réseau, compte, machine tierce) et son état est au moins partiellement global au compte : il est écarté **sur des motifs de périmètre**, pas d'impossibilité (voie V4).
- **Arrêter un prompt en cours.** **Décision de périmètre, non impossibilité mesurée** : aucune primitive propre n'a été identifiée, et le point n'a **pas été mesuré** — aucun spike ne l'a exploré. Livrer un `stop` bancal serait pire que ne rien livrer ; le rouvrir suppose d'abord une mesure, donc un ADR.
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
- **Ne jamais publier une branche `archive/*`.** Elles ne sont conservées qu'en **local**, comme sauvegarde d'un travail hors règles ; elles portent des données du poste qui n'ont rien à faire sur un dépôt public.

### Garde-fous outillés — `.githooks/`

Deux règles ci-dessus n'étaient tenues par **rien** d'autre que l'attention de l'auteur, et l'une
des deux a effectivement été enfreignée : **les 9 commits du lot B portaient un trailer
`Co-authored-by`**, injecté par le squash-merge de GitHub — pas par l'auteur. Une règle qu'aucun
outil ne vérifie n'est pas une règle, c'est un vœu.

Le dépôt versionne donc deux hooks. **Ils ne sont pas actifs par défaut** : Git n'exécute jamais un
hook versionné tant qu'on ne le lui a pas dit. Activation, une fois par clone :

```bash
git config core.hooksPath .githooks
```

| Hook | Refuse | Motif |
|---|---|---|
| `.githooks/commit-msg` | tout message portant un trailer `Co-authored-by` (**insensible à la casse**) | La règle est posée depuis le lot 0 et a été enfreinte 9 fois sans que rien ne le signale |
| `.githooks/pre-push` | toute référence poussée dont le nom commence par `archive/` | `archive/bootstrap-hors-regles` a été retirée d'`origin`, mais **un seul `git push --all` ou `--mirror` la republierait sans avertissement** |

Les deux sont du `sh` portable, sans aucune dépendance : sur un poste sans outillage particulier,
ils s'exécutent ou ne font rien — jamais ils ne cassent un `git commit` pour une raison étrangère à
la règle qu'ils portent. Un contournement ponctuel reste possible par `--no-verify`, et c'est
voulu : ces hooks sont un garde-fou contre l'inattention, pas un dispositif de sécurité.

**La copie locale d'`archive/bootstrap-hors-regles` ne se supprime pas** — c'est la seule
sauvegarde de ce travail. Le hook protège sa **publication**, pas son existence.

## Tests

- **Unitaires** (`tests/unit/`) : tout `core`, contre des fixtures capturées — couverture exigée **100 %**. Y figure aussi tout ce que `packages/vscode` peut éprouver **sans éditeur** : serveur local, cycle de publication, plomberie de registre, mise en forme des défaillances. Ce qui exige une vraie fenêtre est exclu **nommément et avec sa date** dans `vitest.config.ts`, jamais laissé hors mesure en silence.
- **Intégration** (`tests/integration/`) : une **vraie fenêtre VSCode** via `@vscode/test-electron`, avec l'extension compagnon chargée. Valide le serveur local, le registre, l'**énumération** de `tabGroups` et, depuis l'incrément C4, sa **fermeture**. `tabGroups.close` est appelé à **un seul endroit du dépôt** — le port des onglets de `extension.ts` — et deux garde-fous mécaniques le tiennent : un test de **source** échoue si un appel omet `preserveFocus: true` ou reçoit un tableau, et un test de **décision** échoue si un chemin ferme plus d'un onglet ou un onglet non reconnu Claude. Le scénario `close-conversation` l'éprouve sur de vrais onglets, sans l'extension Claude : il crée ses propres panneaux dont le `viewType` **contient** `claudeVSCodePanel` — **le même pour tous**, comme sur une vraie fenêtre, et il ferme un onglet **qui a un voisin de chaque côté**. Les deux points sont des corrections du gate final : des `viewType` distincts et la fermeture du **dernier** onglet rendaient ce montage moins adverse que le réel, et c'est ce qui a laissé passer une fermeture au mauvais endroit.
- **Empaquetage** (`tests/packaging/`) : le contenu **réel** des deux archives que `npm run package:all` vient de produire — jamais `.vscodeignore`, jamais `files`, jamais ce que `vsce ls` *prédit*. Un empaquetage se casse **en silence** : tout compile, la CI est verte, et l'archive livrée est inutilisable. On y **lance** aussi `cmgr --version` depuis le tarball extrait, hors de l'arbre de travail. **Local uniquement** — il exige des artefacts bâtis. La **règle** est isolée dans `rules.ts`, sans accès au disque, et `tests/unit/packaging/` l'éprouve à chaque CI, y compris sur des relevés qu'elle doit **refuser**.
- **E2E** (`tests/e2e/`) : scénarios multi-fenêtres réels, avec l'extension Claude authentifiée. **Scénario de référence, non négociable** : deux fenêtres ouvrant **le même répertoire physique**, **A minimisée** — A étant la fenêtre **cible et agissante**, c'est la condition mesurée à l'ADR-002 → une commande émise depuis A n'affecte jamais B, et **A ne prend jamais le focus**.
  **Construction imposée : par jonction de répertoire.** VSCode 1.122.1 **refuse** d'ouvrir un même dossier dans deux fenêtres — trois mécanismes essayés, tous refusés (`docs/adr/002-ouverture-interactive.md`, « Écueils » n°3). Le second workspace doit donc être une **jonction** pointant sur le premier : c'est le **seul montage possible**, pas un montage choisi.
  **Ce que ce montage couvre** : le **répertoire physique commun** et le **processus `Code.exe` principal commun**. Ce dernier n'est d'ailleurs pas un effet de la jonction — deux fenêtres quelconques d'une même instance le partagent déjà (`docs/adr/001-pilotage-des-conversations.md`, §4 : cinq extension hosts distincts, tous de `ppid` 16196). Il n'en reste pas moins la preuve directe qu'un PID ne discrimine pas une fenêtre — seul l'`extHostPid` le fait.
  **Ce que ce montage ne couvre pas — angle mort explicite** : l'identité de **chemin de workspace**. La jonction laisse **deux chemins distincts** (`ws-a` et `ws-same` dans les relevés d'ADR-002). Une implémentation qui indexerait — à tort — l'identité sur le chemin du workspace **passerait** ce test et **échouerait** dans le vrai cas « même dossier ».
  **Exigence induite pour le lot C** : le scénario E2E doit **en plus** vérifier que l'identité n'est jamais indexée sur le chemin du workspace, ni sur le titre de la fenêtre, ni sur le dossier — seul l'`extHostPid` fait foi.
- **Fixtures** : capturées depuis une machine réelle et versionnées dans `tests/fixtures/`, **anonymisées** (chemins et tokens neutralisés). Ne jamais fabriquer une fixture à la main pour faire passer un test.

### Garde-fou de non-régression (règle impérative)

Tout incrément de **correction de bug** embarque un test qui **reproduit le bug** et **échoue avant le correctif** (fails-before / passes-after), avec la preuve du fails-before dans la PR. Niveau du test : le plus proche du défaut ; **E2E dès que le symptôme est observable par l'utilisateur**.
**Un bug corrigé sans garde-fou reproductible = incrément incomplet**, même si tout le reste est vert.

## CI et vérification

```bash
npm run ci                 # lint + typecheck + tests unitaires  (exécutable partout)
npm run package:all        # le VSIX et le tarball de la CLI     (exécutable partout)
npm run verify:packaging   # empaquette PUIS juge les archives   (LOCAL UNIQUEMENT)
npm run test:integration   # vraie instance VSCode               (LOCAL UNIQUEMENT)
npm run test:e2e           # multi-fenêtres, extension Claude     (LOCAL UNIQUEMENT — lot C)
```

`npm run ci` et `npm run test:integration` **existent et s'exécutent** ; le second compile d'abord l'extension et le harnais (`build:vscode`, `build:integration`) puis lance une vraie instance VSCode via `@vscode/test-electron`. `npm run test:e2e` décrit la cible et sera outillé au **lot C**.

`npm run verify:packaging` est **local** pour une raison propre à ce qu'il juge : il exige des artefacts **bâtis** — un `.vsix` produit par `vsce`, un `.tgz` produit par `npm pack` — et il **lance le binaire empaqueté**. Un test unitaire qui en dépendrait échouerait dans la CI publique, ou — bien pire — s'y ignorerait tout seul et ne prouverait plus rien. La **règle** d'empaquetage, elle, vit dans `tests/packaging/src/rules.ts` sans aucun accès au disque, et `tests/unit/packaging/` l'éprouve à **chaque CI** contre des relevés d'archives réels **et contre des relevés qu'elle doit refuser** : une seule règle, deux appelants, aucune dérive possible entre eux.

**Deux limites assumées, et ce sont des choix :**

- **`test:integration` n'est pas exécuté par la CI publique.** Elle téléchargerait une instance VSCode complète à chaque exécution et exige un affichage ; la commande est donc **locale**, et son log est joint en preuve à la PR. Ce n'est pas un manque d'outillage : la commande existe.
- **`test:e2e` sera impossible en CI publique**, définitivement : il exige l'extension Claude propriétaire **authentifiée**.

La CI GitHub exécute `npm run lint`, `npm run typecheck` et `npm run test:coverage`, puis publie le rapport de couverture — **rien de plus**. Le build de la CLI, de l'extension et du harnais est outillé (`build:cli`, `build:vscode`, `build:integration`), et l'**empaquetage** l'est depuis C3 (`package:all`), avec sa vérification (`verify:packaging`) — **locale**, comme `test:integration` et pour la même raison : elle exige des artefacts bâtis et lance le binaire empaqueté. Seule la **publication** — npm, Marketplace — relève encore du **lot E**. Les résultats d'intégration, d'empaquetage et E2E locaux sont joints en preuve à la PR — ne jamais prétendre qu'une PR est vérifiée sans ce log.

## Documentation obligatoire

- **Toute décision structurante donne un ADR daté** dans `docs/adr/`, numéroté, qui énonce le contexte, les options écartées et la décision.
- **Toute dépendance nouvelle à une API interne de l'écosystème Claude** est inscrite dans `docs/compatibilite.md` avec sa traçabilité ligne à ligne (colonne « Vérifié en / sur », ou `— non vérifié`) et la façon dont l'absence est détectée. L'environnement de référence — versions d'extension, de CLI et de VSCode — est en tête du fichier. Les API **`vscode` publiques**, elles, n'y entrent pas : elles sont versionnées par le plancher `engines.vscode` et recensées dans [`docs/adr/003-registre-et-serveur-local.md`](docs/adr/003-registre-et-serveur-local.md).
- **Le README est la vitrine du projet** : il expose le problème, la démonstration, l'installation, les limites et les risques. Il est mis à jour à chaque changement de périmètre.
- **Ne jamais considérer une tâche comme terminée sans avoir mis à jour la documentation.**
