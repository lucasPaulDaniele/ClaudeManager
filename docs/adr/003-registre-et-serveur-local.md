# ADR-003 — Registre des fenêtres pilotables et serveur de contrôle local

- **Date** : 2026-07-25
- **Statut** : **accepté**
- **Portée** : lot B (incréments B2 `core/registry` et B3 `vscode/companion`), et le gate d'audit qui les a corrigés
- **Méthode** : décisions prises pendant la mise en œuvre, éprouvées par les suites unitaire et d'intégration du dépôt ; cet ADR les **acte après coup** — il ne reconstruit rien qui n'ait été livré

> Cet ADR comble un vide relevé au gate du lot B (finding R11) : le registre est qualifié **dans
> le code** de « contrat entre plusieurs versions potentiellement différentes de l'extension et
> de la CLI » (`packages/core/src/registry/entry.ts`), et le serveur local ouvre une **écoute
> réseau** sur le poste de l'utilisateur avec un **jeton porteur écrit sur disque** — sans qu'un
> seul document ne le dise. Toute la justification vivait en commentaires de code, illisibles
> pour l'auteur d'une version 2.

## Contexte

Un agent qui veut piloter « sa » fenêtre VSCode doit pouvoir **la trouver** et **lui parler**.
Deux besoins distincts, et deux mécanismes :

- **la trouver** — le processus appelant (`claude.exe`, un shell, la CLI `cmgr`) doit résoudre
  l'extension host dont il descend, puis retrouver ce que cette fenêtre publie d'elle-même. C'est
  le **registre** ;
- **lui parler** — une fois la fenêtre identifiée, il faut un canal qui atteigne *cette*
  fenêtre-là, dans un éditeur qui n'expose aucun IPC adressable par fenêtre. C'est le **serveur
  de contrôle local**.

Trois contraintes du projet gouvernent tout ce qui suit :

1. **L'isolation de fenêtre est l'invariant** (principe fondateur n°2). Ni `VSCODE_PID`, ni le
   titre, ni le chemin du workspace ne discriminent une fenêtre — le cas de référence du produit
   est précisément *deux fenêtres sur le même dossier*. Seul l'`extHostPid` fait identité.
2. **Rattrapage de l'existant** (principe fondateur n°7). Le répertoire du registre contient déjà,
   sur des postes en service, des entrées écrites par une version antérieure (0.1.0, sans
   `schemaVersion` ni `mainPid`) — et contiendra un jour celles d'une version ultérieure.
3. **Échouer explicitement, jamais dégrader en silence** (principe fondateur n°3).

## Décision 1 — un fichier par fenêtre, nommé `<extHostPid>.json`

Le registre est le répertoire `~/.claudemanager/windows/`. Chaque fenêtre pilotable y publie
**son propre fichier**, nommé du PID de son extension host.

**Option écartée — un registre unique** (`windows.json`, un objet par fenêtre). Plusieurs
extension hosts écrivent **simultanément et sans aucun moyen de se coordonner** : ils ne
partagent ni processus, ni boucle d'événements, ni canal. Un fichier partagé exigerait donc un
verrou — donc un état à réparer quand un processus meurt en le tenant, exactement le mode de
défaillance des `~/.claude/ide/*.lock` que ce projet a relevé « en nombre, jamais nettoyés ».
Un fichier par PID rend le conflit **structurellement impossible** et fait de la purge une simple
suppression.

**Option écartée — nommer par le chemin du workspace.** Elle viole l'invariant : deux fenêtres
sur le même dossier se collisionneraient, et c'est le cas de référence du produit.

Conséquence directe, exploitée par la décision 5 : le système de fichiers interdit deux fichiers
de même nom, donc **un PID ne peut être revendiqué qu'une fois**.

## Décision 2 — le contrat inter-versions tient en deux champs

Le schéma courant est `schemaVersion: 1` (`packages/core/src/registry/entry.ts`). Une entrée
porte `extHostPid`, `mainPid`, `port`, `token`, `workspaceFolders`, `isTrusted`,
`extensionVersion`, `startedAt`.

**Ce qu'une version s'engage à ne pas déplacer, et c'est tout :**

| Champ | Sens gelé |
|---|---|
| `schemaVersion` | version du schéma de l'entrée |
| `extHostPid` | PID de l'extension host de la fenêtre |

**Tous les autres champs peuvent changer de sens sans préavis** — `mainPid` au premier chef : une
version 2 pourrait y mettre un identifiant de fenêtre, un parent relevé à un autre instant, ou
tout autre chose. C'est exactement ce qu'une version ultérieure a le droit de faire, et c'est
pourquoi `schemaVersion` existe.

**Corollaire, et il n'est pas cosmétique** : face à une entrée de schéma étranger, la seule
question qu'on s'autorise est « ce PID existe-t-il encore dans la table des processus ? ».
Absent ⇒ morte (un processus mort ne revient pas, quelle que soit la version qui l'a inscrit).
Présent, ou illisible ⇒ **on ne conclut pas**. Appliquer la sémantique v1 de `mainPid` à un schéma
qu'on ne possède pas reviendrait à supprimer l'entrée **vivante** d'une version ultérieure — le
finding R1 du gate, qui était précisément ce défaut.

Le code le porte dans deux fonctions distinctes et nommées comme telles :
`judgeCurrentSchemaLiveness` et `judgeForeignLiveness` (`store.node.ts`).

## Décision 3 — la purge est conservatrice : on ne supprime que ce qui est mort

Ne sont supprimées que les entrées jugées `dead` ou `pid-reused`. **Jamais** une entrée étrangère
vivante. Jamais une entrée illisible ou corrompue dont on n'a pas pu lire le PID : on ignore si sa
fenêtre est morte, et supprimer par défaut reviendrait à nettoyer à l'aveugle le registre
d'autrui.

**Garde de fraîcheur, propre à la purge.** `dead` ne signifie que « absent de **cet**
instantané ». Une entrée publiée après la capture en est absente par construction — et c'est le
cas **nominal** quand deux fenêtres démarrent à quelques centaines de millisecondes d'écart. Un
fichier plus récent que l'instantané n'est donc jamais supprimé : il est **rapporté** (`kept`,
motif `younger-than-snapshot`). Lire à tort est réparable ; supprimer à tort ne l'est pas.

**Ce que la purge rapporte.** `PurgeResult` rend `removed`, `removedTemporaries` **et** `kept`
avec le motif exact. Une entrée héritée dont le PID a été recyclé n'est ni pilotable ni purgeable
— elle est donc *immortelle*, et `cmgr doctor` doit pouvoir la montrer à l'utilisateur plutôt que
de la taire (principe n°3).

## Décision 4 — la lecture n'a aucun effet de bord

`readRegistry` **classe et rapporte**, elle ne supprime rien. Elle est donc sûre à appeler depuis
n'importe quel processus, y compris plusieurs à la fois. Tout ce qui n'a pas donné une fenêtre
pilotable ressort dans `skipped`, avec son motif (`unreadable`, `unparsable`, `invalid`,
`foreign-schema`, `identity-mismatch`, `dead`, `pid-reused`).

La purge (`purgeStaleEntries`) est une **opération explicite et distincte**, appelée à
l'activation de l'extension compagnon — jamais depuis la lecture.

**Aucun tri n'est appliqué.** Ordonner supposerait un critère, et le seul disponible serait le
chemin du workspace : précisément ce que l'invariant d'isolation interdit d'utiliser.

## Décision 5 — le nom du fichier vaut l'identité revendiquée

La lecture **confronte** le nom du fichier à l'`extHostPid` de son contenu. En cas d'écart :
motif `identity-mismatch`, l'entrée n'est jamais retenue.

**Motif.** Sans ce contrôle, n'importe quel processus tournant sous le compte de l'utilisateur
dépose un `0000.json` déclarant l'`extHostPid` et le `mainPid` **réels** d'une fenêtre. L'entrée
passe toute la validation, est jugée vivante, et l'emporte à égalité de profondeur **par le seul
ordre de `readdir`** — le client s'adresse alors au serveur de l'attaquant en croyant parler à sa
propre fenêtre. Le nom du fichier est la seule chose qu'un intrus ne contrôle pas librement
(décision 1) : exiger l'égalité fait de cette contrainte du système de fichiers une contrainte
d'identité.

**Deux fenêtres réclamant le même extension host sont une anomalie nommée, pas un départage.**
`resolveOwningWindow` lève `DUPLICATE_WINDOW_IDENTITY` plutôt que de trancher — surtout pas par
l'ordre d'énumération, qui donnerait la victoire au premier nom de fichier venu, donc de façon
**déterministe** à qui la cherche.

Quand plusieurs fenêtres légitimes figurent dans la chaîne — une fenêtre VSCode ouverte depuis le
terminal intégré d'une autre —, on retient la **plus proche** du processus appelant : les autres
ne sont que ses aïeules, agir sur elles violerait l'isolation.

## Décision 6 — la garde anti-réemploi de PID est double, et sa moitié POSIX manque

Un PID vivant ne prouve pas que la fenêtre l'est : un PID libéré puis réattribué désignerait un
processus quelconque, et le registre prétendrait piloter une fenêtre qui n'en est pas une.

1. **Par le parent** — `mainPid`, le `ppid` de l'extension host relevé à l'enregistrement. Un
   processus réattribué n'a presque jamais le même parent que l'extension host qu'il remplace.
2. **Par la date de création** — parce que la première **se franchit** : sous Windows le parent
   enregistré est le `Code.exe` principal, qui engendre des enfants en permanence (ptyHost, shared
   process, file watchers, autres extension hosts). Un PID recyclé par l'un d'eux a *exactement*
   le même parent et passe. La capture versionnée en porte le contre-exemple **trouvé, non
   fabriqué** : le PID `16872`, enfant du même `16196`, né longtemps après l'écriture des entrées
   (`tests/fixtures/identity/windows-process-table.roles.json`). Seule sa date de création le
   trahit. La comparaison est **stricte, sans marge** : un extension host est créé bien avant que
   l'extension qui publie son entrée ne s'active, la marge est structurelle.

**Limite assumée, et déclarée plutôt que subie : la date de création n'est portée que par la table
Windows.** `parsePosixProcessTable` ne la lit pas. `ps` l'expose (`-o lstart=`, `-o etimes=`), mais
l'ajouter impose de **recapturer** la fixture POSIX sur une vraie machine — le dépôt n'accepte
aucune fixture fabriquée (principe fondateur n°5), et l'environnement de capture documenté
(Docker Desktop, conteneur `--pid=host`) n'a pas pu être démarré sur le poste de référence. **Hors
Windows, seule la garde par le `ppid` s'applique** ; elle, s'applique partout. Deux points restent
à trancher **par la mesure** le jour de la recapture : `etimes` ne rend que des secondes entières,
et sa prise en charge par le `ps` de BusyBox n'est pas vérifiée
(`tests/fixtures/identity/README.md`).

## Décision 7 — l'écriture est atomique, et le secret ne traîne pas

Écriture par **temporaire du même répertoire puis `rename`**, jamais en place : un lecteur
concurrent — il y en a, par construction — ne doit jamais tomber sur un JSON tronqué. Le
temporaire est nommé `<pid>.<uuid>.tmp` ; le PID en préfixe n'est pas décoratif, c'est ce qui rend
un temporaire **orphelin** identifiable, donc effaçable par la purge. Il ne porte pas l'extension
des entrées : il ne serait pas lu même s'il était aperçu — mais il porte le **jeton complet**,
d'où son ramassage explicite.

La publication est **idempotente** : republier remplace le fichier, sans doublon ni erreur. L'entrée
écrite est celle **reconstruite champ à champ** — un champ inconnu toléré à la lecture n'est jamais
réécrit, sans quoi le registre accumulerait des champs que plus personne ne comprend.

Une défaillance d'écriture est une **erreur nommée** (`REGISTRY_UNWRITABLE`), symétrique de
`REGISTRY_UNREADABLE` côté lecture, **sans détail hors du code système** : un message `fs` de Node
porte le chemin, donc le nom du compte.

## Décision 8 — le serveur de contrôle local

Chaque fenêtre publiée ouvre un serveur HTTP **qui ne pilote qu'elle**. Le lot B n'y expose qu'une
route de diagnostic, `GET /health` ; ouvrir et fermer relèvent du lot C.

| Choix | Décision | Motif |
|---|---|---|
| Interface | **`127.0.0.1` exclusivement** | Une fenêtre VSCode n'a aucune raison d'être joignable depuis le réseau. Le jeton ne protège que ce qui a déjà franchi la couche réseau |
| Port | **éphémère** (`listen(0)`), relevé sur la socket réelle | Plusieurs fenêtres coexistent : un port fixe les mettrait en concurrence, et le chercher par tâtonnement serait une course entre fenêtres qui démarrent ensemble |
| Authentification | **jeton porteur** en `Authorization: Bearer`, propre à la fenêtre **et à la session** | Le registre est lisible par tout processus du compte : sans jeton, la lecture d'une entrée suffirait à piloter la fenêtre |
| Comparaison | **temps constant** (`timingSafeEqual`) | Les longueurs sont comparées d'abord, `timingSafeEqual` levant sinon — cette comparaison-là ne révèle que la longueur d'un identifiant aléatoire |
| Ordre | **authentification AVANT routage** | Un `404` sur une route inconnue apprendrait à un appelant non authentifié **quelles routes existent** |
| Réponses d'erreur | ni la route demandée, ni trace de pile, ni chemin | La réponse ne reflète rien de ce qu'on lui a envoyé |
| Droits | **`0700`** sur le répertoire, **`0600`** sur l'entrée *et* sur le temporaire | Sans `mode`, Node applique l'umask — 0755/0644 : sur un poste POSIX multi-utilisateurs, n'importe quel autre compte lit le jeton et le port de chaque fenêtre. Sous Windows ces bits n'ont pas de sens et l'ACL héritée protège déjà ; les poser n'y coûte rien |
| Journalisation | le jeton n'est **jamais** journalisé, ni rendu par `/health` | Les journaux de fenêtre sont joints en preuve à des PR d'un dépôt **public** |

Un `chmod` idempotent est réappliqué au répertoire **à chaque publication** : le `mode` de
`mkdirSync` ne s'applique qu'à la création, et un répertoire créé par une version antérieure — il
en existe sur des postes en service — resterait sinon en 0755 (principe n°7).

`/health` rend ce que la fenêtre dit d'elle-même (`schemaVersion`, `extensionVersion`,
`extHostPid`, `mainPid`, `isTrusted`, `workspaceFolders`, `logDirectory`) **plus** l'adresse
réellement liée, relue sur la socket. Cette dernière rend la liaison à la boucle locale
**vérifiable de l'extérieur** : sans elle, un client ne peut que constater qu'il n'obtient pas de
réponse ailleurs — ce qu'un pare-feu produit tout aussi bien.

`logDirectory` mérite sa ligne : le canal de journal est **désigné** comme la source de diagnostic
de `cmgr doctor`, mais son chemin comporte deux segments indevinables (l'horodatage de session et
l'index `window<N>`) et rien ne relie cet index à un `extHostPid`. Il est publié **sur la route
authentifiée**, et non dans l'entrée de registre — dont le contenu est un contrat entre versions
qu'on n'élargit pas pour un besoin de diagnostic.

## API `vscode` dont dépend l'extension compagnon

Elles sont **publiques et documentées** — elles ne relèvent donc pas de
[`docs/compatibilite.md`](../compatibilite.md), qui recense l'écosystème Claude. Elles sont
recensées ici, avec ce qui les garde.

| API | Utilisée pour | Plancher |
|---|---|---|
| `window.createOutputChannel(name, { log: true })` | canal de journal **persisté** par VSCode — l'activation devient mesurable de l'extérieur. `show()` n'est **jamais** appelé (principe n°1) | 1.90 (plancher du manifeste) |
| `ExtensionContext.logUri` | localiser ce journal et le publier sur `/health` | 1.90 |
| `RelativePattern(Uri, pattern)` + `workspace.createFileSystemWatcher` | observer **le seul** fichier d'entrée de cette fenêtre, dans un répertoire **hors du workspace** | 1.90 — la base `Uri` et le cas « hors workspace » sont documentés dans `@types/vscode` 1.90.0 (`index.d.ts`, « Out of workspace file watching »). La version d'introduction exacte n'a **pas** été vérifiée dans le dépôt |
| `workspace.onDidGrantWorkspaceTrust` · `onDidChangeWorkspaceFolders` | republier quand l'état de la fenêtre change | 1.90 |
| `workspace.isTrusted` · `workspace.workspaceFolders` | ce que seule une fenêtre sait d'elle-même | 1.90 |

**Le plancher est désormais tenu par quelque chose.** Il était annoncé `^1.90.0` au manifeste
pendant que la vérification de types s'appuyait sur `@types/vscode` **1.125.0** : `npm run
typecheck` ne pouvait donc pas détecter l'usage d'une API postérieure (mesuré — un appel à
`vscode.lm.registerMcpServerDefinitionProvider`, API MCP de 1.101, compilait sans un mot). Les
types sont alignés sur le plancher (`~1.90.0`, paquet **et** racine) et un test unitaire empêche
les deux de se désolidariser à nouveau (`tests/unit/vscode/manifest.test.ts`). La création du
`FileSystemWatcher` reste **gardée** : rien ne garantit qu'un observateur soit possible partout
hors workspace — s'il ne l'est pas, on le **dit**, et la fenêtre perd la reprise tardive, pas la
publication.

## Conséquences

**Ce que les lots suivants doivent supposer :**

- **`resolveOwningWindow` peut lever.** `DUPLICATE_WINDOW_IDENTITY` sur une ambiguïté,
  `OWNING_WINDOW_NOT_FOUND` sur une absence (`requireOwningWindow`). Ce n'est jamais un `undefined`
  silencieux : B4 (CLI de lecture), C et D doivent les rendre à l'appelant tels quels.
- **La republication rouvre le serveur sur un port différent.** Un port n'est donc **jamais**
  mémorisable : il se relit dans l'entrée à chaque usage. C'est sans conséquence — l'entrée qui le
  porte est réécrite dans la foulée, et personne ne connaît un port autrement que par elle.
- **Une entrée peut disparaître sous les pieds de sa fenêtre.** C'est un simple fichier, que
  n'importe quoi peut effacer. La fenêtre **republie** plutôt que de se retirer : elle est vivante,
  et enterriner une suppression qui est une erreur de tiers laisserait l'humain sans recours autre
  qu'un rechargement complet.
- **Le répertoire du registre n'est surchargeable que côté cœur** (`dir`), pas côté extension.
  Conséquence connue et non corrigée : `npm run test:integration` **publie et purge dans le
  registre réel du poste**, à côté des vraies fenêtres de l'utilisateur (finding C8 du gate —
  `tests/integration/src/suite.ts`, `packages/vscode/src/extension.ts`). Une surcharge lisible par
  l'extension reste à introduire.
- **`readProcessTable` coûte de 700 ms à 1,3 s** sur un poste réel. Le cœur ne cache rien : il
  reçoit l'instantané, et la mise en cache appartient à l'appelant, seul à savoir quand le sien a
  vieilli.
- **Un jeton ne survit pas à un rechargement de fenêtre**, et un `extHostPid` non plus. Rien de ce
  qui est lu dans le registre ne doit être conservé d'une invocation à l'autre.

**Ce qui reste ouvert :** le registre ne dit rien des conversations d'une fenêtre — c'est le lot C
qui l'ouvrira, et le client HTTP du cœur (`packages/core/src/client`) qui le consommera.
