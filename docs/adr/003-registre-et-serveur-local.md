# ADR-003 — Registre des fenêtres pilotables et serveur de contrôle local

- **Date** : 2026-07-25
- **Révisé le** : 2026-07-26 — gate final du lot B. Une affirmation **corrigée** (le port, section « Conséquences »), une garantie **ramenée à ce qu'elle tient** (décision 5), une ligne **ajoutée** au contrat inter-versions (décision 2), un soupçon **consigné comme non mesuré** (décision 8), et les décisions du gate **actées** dans une section datée. Rien n'a été réécrit dans l'histoire du document.
- **Statut** : **accepté**
- **Portée** : lot B (incréments B2 `core/registry` et B3 `vscode/companion`), et les gates d'audit qui les ont corrigés
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

## Décision 2 — le contrat inter-versions tient en deux champs, **et un nom de fichier**

Le schéma courant est `schemaVersion: 1` (`packages/core/src/registry/entry.ts`). Une entrée
porte `extHostPid`, `mainPid`, `port`, `token`, `workspaceFolders`, `isTrusted`,
`extensionVersion`, `startedAt`.

**Ce qu'une version s'engage à ne pas déplacer, et c'est tout :**

| Ce qui est gelé | Sens |
|---|---|
| `schemaVersion` | version du schéma de l'entrée |
| `extHostPid` | PID de l'extension host de la fenêtre |
| **le nom du fichier** | `<extHostPid>.json` (décision 1). Ce n'est pas un champ — et c'est précisément pour cela qu'il manquait ici : le contrat était énoncé en termes de **contenu** alors que le code contrôle aussi le **contenant** |

**Ajout du 2026-07-26 (gate final, finding R6) — la troisième ligne, et pourquoi elle manquait.**
`claimsItsOwnName` (`store.node.ts`) confronte le nom du fichier à l'`extHostPid` de son contenu
**avant** l'aiguillage sur le schéma : il s'applique donc **aussi** aux entrées étrangères. Une
version 2 qui prendrait les deux premières lignes au mot et nommerait ses fichiers autrement
verrait les siennes classées `identity-mismatch` — le motif que la décision 5 réserve à une entrée
**forgée**. `cmgr doctor` accuserait alors une version parfaitement légitime d'usurpation.

Le défaut n'est **pas** destructif, et c'est ce qui le laisse mineur : `identity-mismatch` n'est ni
`dead` ni `pid-reused`, donc la purge conservatrice **garde** ces entrées (décision 3). Le code
tient d'ailleurs déjà ce raisonnement à l'endroit qui compte — la doc de `purgeStaleEntries`
explique qu'on ne conclut **jamais** « ce PID est mort » sur la foi d'un nom de fichier, justement
parce que la convention de nommage n'est pas contractuelle. Ce qui manquait n'était donc pas la
prudence du code, mais **l'aveu, ici, que la version 1 exige tout de même ce nom pour retenir une
entrée**. Une version 2 qui veut être *lue* par la version 1 doit s'y plier ; une version 2 qui
s'en affranchit reste *intacte*, mais mal nommée dans les diagnostics.

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
propre fenêtre.

**Correction du 2026-07-26 (gate final, finding S2) — ce que ce contrôle fait réellement.**
Cet ADR affirmait, à cet endroit, que « le nom du fichier est la seule chose qu'un intrus ne
contrôle pas librement : exiger l'égalité fait de cette contrainte du système de fichiers une
contrainte d'identité ». **L'énoncé était faux**, et c'est un test exécuté qui l'a montré
(`tests/unit/vscode/publication.test.ts`, défaut S2).

Ce que le contrôle interdit, et c'est déjà utile :

- **s'ajouter** au registre sous un nom de son choix. Le `0000.json` ci-dessus est bien mort-né.

Ce qu'il n'empêche **pas**, et il faut le dire :

- **se substituer** à une entrée existante. Un intrus déjà sous le compte de l'utilisateur n'a
  aucun besoin de *choisir* un nom : il **écrase le fichier qui porte déjà le bon**. Le contenu
  forgé n'a qu'à satisfaire `parseWindowEntry` et la garde de vivacité, ce qui est trivial —
  `extHostPid` se lit dans le fichier avant de l'écraser, `mainPid` est public dans la table des
  processus, et `port`/`token` sont ceux de l'attaquant. Le nom est alors **exact**, la lecture ne
  rapporte **aucune** anomalie, et `resolveOwningWindow` rend le canal de l'attaquant.

La contrainte du système de fichiers empêche donc la **duplication**, pas l'**usurpation**. *Un
blanc honnête vaut mieux qu'une garantie fausse.*

**La parade livrée au gate (PR 2/3) — elle répare, elle n'empêche pas.** Une fenêtre publiée
mémorise désormais l'entrée qu'elle a réellement écrite et **confronte le disque à cette
référence** — `extHostPid`, `mainPid`, `port`, `token`, c'est-à-dire l'identité et le canal
(`WindowPublisher.inspectEntry`). Un remplacement est détecté et **republié sous un motif nommé**,
distinct de celui d'une simple disparition, pour que l'humain le voie passer. Les champs qui
décrivent l'état du workspace sont exclus de la comparaison à dessein : ils changent légitimement
entre deux republications.

**La limite de cette parade est structurelle et doit être écrite** : elle est *a posteriori*. Entre
la substitution et sa détection — l'observateur de fichier, ou la republication suivante — l'entrée
de l'attaquant est en place et sera lue par qui la consulte. La fenêtre **corrige** son registre ;
elle n'a aucun moyen d'**interdire** l'écriture. Rien ici n'est une élévation de privilège :
l'attaquant est déjà dans le compte, et cet ADR assume que le registre est lisible par tout
processus du compte (décision 8). Ce qui est en cause est qu'au lot C l'entrée portera le canal par
lequel on **ouvre et ferme** des conversations : c'est le pilotage qui serait détourné, pas
seulement un diagnostic.

**Et la racine est plus haut que le nom du fichier** : `resolveRegistryDir` s'appuie sur
`os.homedir()`. Un appelant dont l'environnement est contrôlé lit un **registre** contrôlé — le
contrôle du nom ne protège alors plus rien, puisque tout le répertoire est celui de l'attaquant.
Ce n'est pas une décision prise ici, seulement un présupposé qu'on nomme.

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

### Soupçon consigné le 2026-07-26, **NON MESURÉ** — `Host` et `Origin` (DNS rebinding)

Le serveur ne valide **ni l'en-tête `Host`, ni l'en-tête `Origin`**. Une page web visitée par
l'utilisateur peut faire résoudre un nom qu'elle contrôle vers `127.0.0.1` et adresser des requêtes
à la boucle locale depuis le navigateur — c'est le schéma classique du *DNS rebinding*.

**Ce point n'a fait l'objet d'aucune mesure.** Il n'est pas classé « risque », il est classé
« soupçon », et il est écrit ici pour ne pas être redécouvert par hasard au lot C.

**Sans effet au lot B**, et pour trois raisons cumulatives :

- aucune route n'est accessible sans le **jeton porteur**, et l'authentification passe **avant le
  routage** (tableau ci-dessus) ;
- ce jeton n'existe que dans un fichier du disque, en `0600` : un navigateur ne peut pas le lire ;
- **aucun en-tête CORS n'est émis**, donc une page ne lit pas les réponses qu'elle provoquerait.

**Cela change au lot C**, qui ajoutera des routes à **effet de bord** — ouvrir et fermer des
conversations. Une requête aveugle qui n'a pas besoin de *lire* la réponse pour nuire ne se heurte
plus qu'au seul jeton.

**Parade envisagée, à trancher sur mesure au lot C — pas implémentée ici** : refuser tout `Host`
autre que `127.0.0.1:<port effectivement lié>`, et refuser toute requête portant un `Origin`, quel
qu'il soit — un client légitime de ClaudeManager n'est jamais une page web et n'en émet pas. La
mesure devra établir ce qu'un navigateur envoie réellement dans ces deux en-têtes sur ce montage,
plutôt que de le supposer.

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

## Ajouts du 2026-07-26 — ce que le gate final du lot B a décidé

Le gate final a pris, dans son lot de correctifs, des décisions **structurantes** que les sections
ci-dessus ne portaient pas. Elles sont actées ici plutôt que réécrites au-dessus : *ce qui était
vrai à la rédaction de cet ADR le reste, ce qui était faux se corrige en le disant.* Les deux
sources sont les commits `1852593` (cœur) et `02198c0` (extension et harnais).

> **Avertissement de lecture — les lettres de findings ne sont pas des identifiants stables.**
> `C5` et `S6` désignent des défauts **différents** selon le tour de gate : `S6` est ici le masque
> du répertoire personnel (cœur) *et*, dans `publication.ts`, un serveur survivant à la disparition
> de son entrée. Ne jamais citer une lettre seule sans son commit.

### A. La purge est **totale**, et non plus « conservatrice puis interrompue »

La décision 3 disait ce qui n'est pas supprimé. Elle ne disait pas ce qui arrive quand une
suppression **échoue**. Elle échouait bruyamment : une seule défaillance **avortait tout le
balayage** et faisait remonter une erreur `fs` nue, portant le chemin absolu du registre — donc le
nom du compte. Le prix d'un `mkdir` sous le nom d'un temporaire suffisait, pour n'importe quel
processus du compte, à casser **définitivement** le nettoyage du registre de **toutes** les
fenêtres du poste.

Désormais : une suppression refusée devient une entrée `kept` de motif **`removal-failed`**, et le
balayage **va jusqu'au bout**. `REGISTRY_UNREADABLE` — le répertoire existe mais ne se liste pas —
reste la **seule** défaillance qui interrompt la purge.

Le champ `KeptEntry.cause` porte alors **le seul code système** (`systemErrorCode`), jamais le
message ni le chemin, pour la raison constante de ce projet : `kept` part vers un agent et vers des
journaux joints en preuve à des PR d'un dépôt **public**.

**Conséquence de typage, et elle n'est pas cosmétique : `kept` ne contient plus seulement des
entrées.** Les temporaires orphelins y figurent au même titre. Un consommateur qui supposerait
« un élément de `kept` est un `<pid>.json` » se tromperait — le motif `removal-failed` s'applique
aux deux, et un temporaire porte `<pid>.<uuid>.tmp`.

### B. La garde de fraîcheur couvre aussi les **temporaires**

La décision 3 réservait la garde de fraîcheur aux entrées. Le raisonnement qui l'imposait
s'applique pourtant **mot pour mot** au processus qui écrit son temporaire : une fenêtre née après
la capture est absente de la table par construction, donc son temporaire **en cours d'écriture**
passe pour orphelin. L'effacer entre son `write` et son `rename` fait lever `REGISTRY_UNWRITABLE` à
une fenêtre parfaitement vivante — et c'est le cas **nominal** de deux fenêtres qui démarrent à
quelques centaines de millisecondes d'écart, pas un accident de laboratoire.

La garde s'écrit désormais en **un seul endroit** (`removeIfSettled`), pour entrées et temporaires,
afin que les deux ne puissent pas en avoir deux versions divergentes. La troncature à la
**milliseconde** en fait partie : `mtimeMs` porte des fractions de milliseconde sur NTFS quand
`capturedAt` n'en a jamais.

### C. L'ambiguïté d'identité se détecte **par PID**, jamais par profondeur

La décision 5 annonçait `DUPLICATE_WINDOW_IDENTITY` sans dire **sur quoi** l'ambiguïté se constate.
C'était l'égalité de **profondeur** dans la chaîne d'ancêtres — et elle ne se lit que face à deux
fenêtres *distinctes* au même rang. Deux entrées revendiquant **le même `extHostPid`** à des
profondeurs différentes échappaient donc au contrôle, et l'arbitrage retenait la plus proche : la
victoire au premier nom de fichier venu, de façon déterministe pour qui la cherche.

L'indexation se fait désormais **par PID** (`depthByPid`, `owningWindow.ts`). La convention de
nommage rend ce cas normalement impossible — deux fichiers d'un même répertoire ne peuvent pas
porter le même nom —, mais c'est précisément de la **défense en profondeur** : le contrôle ne
dépend plus d'une propriété que le registre pourrait cesser de garantir.

### D. `redactWindowEntry` masque le répertoire personnel — et c'est une fonction d'**affichage**

Deux règles contradictoires régnaient sur le même flux de sortie : `SkippedEntry.file` ne porte
jamais de chemin absolu « parce que ce champ part vers un agent », quand `windows[].workspaceFolders`
rendait `c:\Users\<compte>\…` en clair, au **même destinataire**.

Le masque vit maintenant dans le **cœur** (`registry/redaction.node.ts`), et non plus dans le seul
harnais de test où un producteur de sortie sur trois pouvait s'en servir. Il remplace le **préfixe**
du répertoire personnel par `~`, la coupure devant tomber sur un séparateur, en comparaison
**insensible à la casse** sur toutes les plateformes — sous Windows le même chemin s'écrit
`c:\Users\…` ou `C:\Users\…` selon qui le rend.

**La distinction est impérative pour le lot C : c'est de l'affichage, jamais de la persistance.**
L'entrée écrite dans le registre et ce que `GET /health` rend à qui détient le jeton portent le
chemin **réel**. Le lot C doit y comparer le `cwd` d'une session au workspace de la fenêtre, faute
de quoi `claude-vscode.editor.open` **réussit en ouvrant un panneau vide** — et un chemin masqué ne
se compare pas.

### E. La convention de nommage est **exportée par le cœur**, et reste **hors contrat**

`<extHostPid>.json` était réécrit à la main partout : dans le cœur, dans l'extension, et — sans
aucune garde — dans le harnais d'intégration, qui réencodait à la fois le répertoire et le nom. Le
cœur est gardé de toutes parts ; le harnais, lui, ne faisait qu'un `existsSync` sur un chemin qui
n'aurait alors jamais rien porté, et aurait imprimé « l'entrée a DISPARU : `deactivate` a bien
retiré cette fenêtre » — une preuve **fausse** dans un journal joint à une PR, donc dans un critère
de merge.

Le cœur exporte désormais `windowEntryFileName` et `windowEntryPath`. Le jour où la convention
change, elle change en un seul endroit.

**Cela ne la fait pas entrer dans le contrat inter-versions** — voir la décision 2 et son ajout du
même jour. Les deux énoncés coexistent sans se contredire : la version 1 **exige** ce nom pour
retenir une entrée, et **s'interdit** d'en conclure quoi que ce soit sur la vivacité d'une entrée
étrangère qui ne le respecterait pas.

### F. Cycle de vie du serveur — le serveur et l'entrée vont ensemble, **dans les deux sens**

La décision 8 décrivait un serveur qu'on ouvre. Elle ne disait rien de ce qui arrive quand l'un des
deux disparaît sans l'autre. Deux défauts symétriques ont été corrigés, et l'invariant s'énonce
maintenant en une phrase : **un serveur ouvert que plus aucune entrée ne décrit n'est joignable par
personne ; une entrée qui annonce un port mort envoie le jeton de la fenêtre à qui a récupéré ce
port.**

**Défaillance d'écriture → le serveur est GARDÉ, la reprise est bornée.** Tout échec de
`writeWindowEntry` était traité pareil : journaliser, puis se retirer. Or le retrait efface l'état
que l'unique chemin de reprise autonome teste avant d'agir — la fenêtre restait utilisable pour
l'humain et **définitivement injoignable** pour `cmgr`, qui rendait `OWNING_WINDOW_NOT_FOUND` en
invitant à vérifier une extension parfaitement installée. Les deux classes de refus sont désormais
distinguées **par le code stable de l'erreur nommée**, jamais par un contrôle local rejoué :

- `REGISTRY_ENTRY_INVALID` — impubliable **par nature** (fenêtre sans dossier de travail). Retrait
  juste, serveur fermé : il n'aurait rien à servir. La reprise viendra de l'événement qui change
  cet état.
- `REGISTRY_UNWRITABLE` — l'état du workspace n'a **pas** bougé et aucun événement ne viendra. Le
  serveur **reste ouvert** et la reprise est programmée sur une échelle **bornée et croissante**
  (250 ms, 1 s, 5 s, 30 s). Au-delà, la défaillance n'était pas transitoire : la fenêtre se retire
  pour de bon, plutôt que d'entretenir une écoute que plus aucune entrée ne décrit.

Une défaillance qu'on ne reconnaît pas est traitée comme un refus : **on ne suppose transitoire que
ce qui l'est nommément.**

**Mort de l'écoute → RETRAIT D'ABORD, réouverture ensuite.** Après le démarrage, toute défaillance
de la socket n'était que journalisée, et l'entrée continuait d'annoncer `port` **et** `token`. Le
port éphémère revient au système, un processus local le réobtient — la plage éphémère est réutilisée
agressivement —, et le client du lot C présenterait alors `Authorization: Bearer <jeton de la
fenêtre>` à l'occupant. **L'ordre est le fond du correctif** : l'inverse laisserait le couple port
mort + jeton exploitable pendant toute la durée d'une réouverture. La réouverture est bornée à
**cinq** pertes, après quoi la fenêtre le **dit** et reste non publiée jusqu'à rechargement.

Toutes les transitions passent par une **file d'attente d'un seul rang** : cinq sources peuvent les
déclencher, et deux transitions concurrentes ouvriraient deux serveurs dont un seul serait retenu —
soit exactement l'écoute orpheline que tout ceci corrige.

## Conséquences

**Ce que les lots suivants doivent supposer :**

- **`resolveOwningWindow` peut lever.** `DUPLICATE_WINDOW_IDENTITY` sur une ambiguïté,
  `OWNING_WINDOW_NOT_FOUND` sur une absence (`requireOwningWindow`). Ce n'est jamais un `undefined`
  silencieux : B4 (CLI de lecture), C et D doivent les rendre à l'appelant tels quels.
- **Un port ne se mémorise jamais : il se relit dans l'entrée à chaque usage.** La règle est
  inchangée ; **sa justification était fausse et a été corrigée le 2026-07-26** (gate final,
  finding R1).

  Cet ADR affirmait ici, **sans condition**, que « la republication rouvre le serveur sur un port
  différent ». **Mesuré en fenêtre réelle, c'est faux d'une republication ordinaire** : un octroi
  de confiance ou un changement de dossiers de workspace **conserve le port ET le jeton** — une
  seule écoute sur toute la vie de la fenêtre (`tests/integration/src/scenarios/nominal.ts`, §2,
  qui assertait déjà littéralement le contraire de ce que ce document énonçait).

  Le serveur n'est rouvert que là où `publishNow` le trouve fermé, c'est-à-dire **après un
  retrait**. Les cas sont énumérables, et les voici **tous** :

  | Le port change quand… | Trace |
  |---|---|
  | une publication est **refusée à la validation** (`REGISTRY_ENTRY_INVALID` — typiquement une fenêtre sans dossier de travail) : retrait, serveur fermé, puis reprise sur un changement d'état du workspace | `tests/integration/src/scenarios/emptyWorkspace.ts`, §2 — mesuré |
  | une **défaillance d'écriture** (`REGISTRY_UNWRITABLE`) épuise l'échelle de reprise bornée : la fenêtre garde son serveur pendant les quatre échelons, puis se retire pour de bon | `tests/unit/vscode/publication.test.ts` (défaut C2) |
  | l'**écoute meurt sans qu'on l'ait demandé** : retrait **d'abord**, réouverture ensuite, bornée à cinq pertes — **ajouté au gate, PR 2/3** | `tests/unit/vscode/publication.test.ts` (défaut S5) |

  Hors de ces trois cas, **le port ne bouge pas**. Le jeton, lui, ne change **jamais** en cours de
  vie : il est propre à la fenêtre *et à la session*, et ne se renouvelle qu'à un rechargement.

  **Pourquoi la correction est majeure plutôt que cosmétique** : cette section s'intitule « ce que
  les lots suivants doivent supposer ». Un auteur du lot C qui câblerait sa relecture de port sur
  les **événements de republication** raterait précisément les cas où le port change réellement —
  et s'adresserait à une socket fermée. Le déclencheur correct n'est pas la republication, c'est
  **l'écriture de l'entrée** : on relit le port dans le fichier, à chaque usage, sans jamais
  chercher à prédire quand il a bougé.

  Le commentaire de `packages/vscode/src/publication.ts` était, lui, **correctement conditionnel**
  depuis l'origine (« le serveur est rouvert *s'il ne l'est plus* ») : c'est bien ce document qui
  avait durci une condition en fait général.

- **`WindowPublisher.withdraw` n'a aucun appelant aujourd'hui.** L'extension n'appelle que
  `ensurePublished`, `republishIfEntryLost` et `close`. Un lot ultérieur qui s'en servirait
  ajouterait un quatrième cas de changement de port à la liste ci-dessus.
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
