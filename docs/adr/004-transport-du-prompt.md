# ADR-004 — Transport du prompt jusqu'au tour 1, et plafond de la ligne de commande

- **Statut** : accepté
- **Date** : 2026-07-26
- **Lot / incrément** : C1
- **Complète** : [ADR-002](002-ouverture-interactive.md), qui reste **inchangé**. ADR-002 arbitre
  *quelle voie* ouvre une conversation ; celui-ci arbitre *comment le prompt y arrive*, et ce
  qui se passe quand il est trop gros.

## Contexte

Le `CLAUDE.md` posait la question sans la trancher :

> Cette forme positionnelle ne tient pas à l'échelle visée — la ligne de commande Windows
> plafonne autour de 32 Ko, quand un prompt d'orchestration en pèse couramment 15 à 25.
> Aucune solution n'est arrêtée à ce jour ; seule la question l'est. La trancher supposera une
> mesure, pas une intuition.

Les mesures ont été conduites le **2026-07-26**, dans une vraie fenêtre VSCode 1.122.1 lancée
par `@vscode/test-electron`, avec un terminal masqué monté exactement comme celui du mécanisme.
`claude.exe` y est remplacé par un programme témoin qui rend compte de ce qu'il reçoit
(longueur et SHA-256) : la contrainte mesurée est celle de ConPTY, de PSReadLine et de
`CreateProcess`, pas celle du CLI.

**Le CLI ne laisse aucun choix sur la forme de soumission.** `claude --help`, relevé sur la
version **2.1.220** le 2026-07-26 : `[prompt]` n'existe qu'en **positionnel**. Aucune option de
prompt par fichier, aucune par variable d'environnement — `--system-prompt` et
`--append-system-prompt` ne portent que le prompt *système*. La question n'est donc pas
« par quoi remplacer le positionnel », mais « comment l'alimenter, et jusqu'où ».

## Mesures

### M2-a — Plafond, voie par voie

Trois voies, mesurées dans le vrai chemin (terminal VSCode masqué → `pwsh` → processus) :

| Voie | 32 000 | 32 600 | 33 000 | 64 000 | 131 072 | Longueur de la **ligne envoyée au pty** |
|---|---|---|---|---|---|---|
| **L1** — prompt écrit littéralement dans la ligne | OK | **ÉCHEC** | ÉCHEC | — | — | = taille du prompt (32 744 à 32 600) |
| **L2** — fichier lu par le shell, variable passée en argument | OK | **ÉCHEC** | ÉCHEC | — | — | **236 caractères, constante** |
| **L3** — variable d'environnement (portage seul) | OK | OK | OK | OK | OK | 243 caractères |

**Ce que cette table établit** : L1 et L2 échouent aux **mêmes tailles**, avec des lignes de
pty de **32 744** et **236** caractères. Le plafond n'est donc **pas** la ligne envoyée au
terminal — raccourcir celle-ci ne relève rien. C'est `CreateProcess`, dont `lpCommandLine`
est borné à **~32 767 caractères**.

**L'échec est SILENCIEUX** : aucune sortie, aucune erreur, aucun processus. C'est *cela*
l'inacceptable au regard du principe fondateur n°3 — pas le plafond lui-même.

### M2-b — Échappement, à taille modeste

Le vrai départageur, et il agit **bien avant** le plafond. Contenu hostile réaliste — sauts de
ligne, `"` et `'`, backticks, `$(Get-Date)`, `$env:PATH`, tubes, `;`, `&`, non-ASCII, bloc de
code encadré, 295 caractères :

| Voie | Verdict | Reçu / attendu |
|---|---|---|
| **L2** | **INTACT**, SHA-256 identique | 295 / 295 |
| **L1 sans échappement** | **ÉCHEC (aucune sortie)** | — / 295 |

Dans L2, le contenu **ne traverse jamais l'analyseur du shell** : il est lu en **donnée**
(`[IO.File]::ReadAllText`), puis passé nu en argument.

### M2-c — Plafond propre au pty, **borné mais non établi**

Ligne envoyée au terminal **sans lancer de processus** :

| Longueur de ligne | Verdict |
|---|---|
| 32 000 | OK |
| 64 000 | OK |
| 131 072 | **ÉCHEC (aucune sortie)** |

La frontière exacte et la couche responsable (ConPTY ? PSReadLine ? la file d'envoi de
VSCode ?) **ne sont pas établies**. Ce blanc est **dit**, il n'est pas comblé : la seule chose
qu'on en retient est que le pty porte au moins 64 000 caractères, donc qu'il n'est pas le
facteur limitant de L2, dont la ligne pèse 236.

### M1 — Neutralisation de l'environnement du terminal

Rappelée ici parce qu'elle conditionne la même étape du mécanisme :

| Variante | `CLAUDECODE` | Témoin mis à `''` | Nombre de clés |
|---|---|---|---|
| témoin, aucune option `env` | `PRESENT=1` | `PRESENT=original` | 91 |
| `env: { X: null }` | **`ABSENT`** | `PRESENT-ET-VIDE` | 89 |
| `strictEnv: true` + environnement reconstruit | `ABSENT` | `PRESENT=original` | **79** |
| **`env: { X: undefined }`** | **`PRESENT=1`** | `PRESENT=original` | 91 |
| forme de production (famille → `null`) | `ABSENT` | — | 88 |

Diff clé à clé de la variante `null` : **exactement 2 clés disparues, aucune collatérale,
aucune apparue**.

**Trois enseignements, et deux sont des pièges :**

1. `null` **supprime** — c'est la forme retenue.
2. `undefined` **ne fait rien**. `TerminalOptions.env` est typé
   `{ [key: string]: string | null | undefined }` : la forme **compile**, passe le typecheck,
   se relit très bien, et laisse la variable intacte.
3. `''` laisse la variable **présente et vide**. Or le CLI teste la **présence** :
   l'assainissement serait sans effet tout en ayant l'air d'avoir eu lieu.

`strictEnv: true` est **le plus mauvais choix, et c'est mesuré** : il fait perdre
`TERM_PROGRAM`, `COLORTERM`, `LANG`, `GIT_ASKPASS` et l'intégration shell (79 clés contre 89).

## Décision

### 1. Le prompt reste **positionnel**, et il est alimenté par la **voie L2**

La ligne unique envoyée au shell par `sendText` est :

```powershell
$p = [IO.File]::ReadAllText('<fichier>'); Remove-Item -LiteralPath '<fichier>' -Force; if ($p) { & '<claude>' --session-id <uuid> $p }
```

**Pourquoi L2 et non la forme par variable d'environnement d'ADR-002** — et ce n'est **pas**
la taille : les deux ont **exactement le même plafond**, celui de `CreateProcess`. L'argument
est que **L2 est la forme mesurée jusqu'au plafond ET sur contenu hostile**, quand faire
transiter 25 Ko par `TerminalOptions.env` n'est mesuré nulle part. *On n'implémente pas une
forme non mesurée quand on en a une mesurée.*

Trois détails font partie de la décision, pas de son implémentation :

- **La suppression du fichier appartient à la même ligne**, avant que `claude` ne démarre :
  c'est ce qui borne à la milliseconde la durée de vie du prompt sur le disque. L'extension
  garde néanmoins un filet en `finally`, pour le cas où la ligne n'aurait jamais pu s'exécuter.
- **La garde `if ($p)`** : une exception de `ReadAllText` termine la *statement*, pas la ligne.
  Sans elle, `claude` démarrerait **sans argument** — session interactive **sans tour 1**,
  panneau attaché, route en succès. Une conversation vide rendue comme un succès est
  précisément la dégradation silencieuse que le principe fondateur n°3 interdit.
- **Le chemin est cité en littéral simple**, l'apostrophe doublée : un répertoire personnel
  peut en porter une, et le reste du chemin deviendrait alors du **code**.

### 2. Le plafond est **vérifié avant l'envoi**, par une erreur nommée

`PROMPT_TOO_LARGE`, levée par le cœur (`packages/core/src/commandLine.ts`) **avant qu'aucun
terminal n'existe**. Elle pèse la ligne du **processus fils** — exécutable, `--session-id`,
uuid, séparateurs, prompt **cité** — jamais la ligne envoyée au pty, qui n'est pas ce qui
plafonne.

- Limite retenue : **32 767 unités UTF-16**. C'est la valeur documentée par Microsoft, et elle
  **tombe dans l'encadrement mesuré** (32 144 passe, 32 744 échoue). Un encadrement assumé,
  pas une frontière inventée.
- **Unités UTF-16, pas octets** : c'est ce que compte `String.prototype.length` en JavaScript
  et c'est l'unité de `lpCommandLine`. Compter des octets refuserait à tort tout prompt
  non-ASCII.
- Marge de sécurité **explicite** : 256 unités, pour le terminateur NUL et pour la règle de
  re-citation de `pwsh`, qui n'est pas contractuelle.
- Le coût du prompt cité est une **borne supérieure** (`2 + longueur + nombre de `"` et de `\`).
  Majorer est le sens sûr : une borne trop haute refuse un prompt qui serait passé **et le
  dit** ; une borne trop basse laisse tenter un envoi qui échouera **sans bruit**.
- **Jamais de troncature.** Un prompt tronqué produit une conversation qui a l'air normale et
  qui demande autre chose que ce qu'on lui a demandé.

**Portée de plateforme — un blanc dit.** La valeur est celle de Windows, seule plateforme
mesurée, et elle est appliquée **partout**. Sous POSIX la limite réelle est différente
(`MAX_ARG_STRLEN`, `ARG_MAX`) et **n'a pas été mesurée ici** : un prompt qui serait peut-être
passé y est refusé, avec un code stable et les deux nombres en `details`. L'inverse — laisser
tenter sous une limite inconnue — reproduirait l'échec silencieux que la garde supprime.

### 3. Le dépassement bascule sur le **repli V5**

`PROMPT_TOO_LARGE` survient **avant** toute création de terminal : le repli y est donc
autorisé. L'erreur nommée est **émise d'abord**, le repli s'exécute **ensuite**, et la réponse
porte **les deux**. Pour un prompt trop grand c'est le comportement le plus utile qui soit :
`editor.open(null, <prompt>)` passe le prompt **en mémoire**, sans aucune ligne de commande —
la limite ne s'y applique pas. L'humain valide, la conversation est ouverte.

### 4. La neutralisation de l'environnement se fait par **famille**, chaque nom mappé à `null`

Jamais `undefined`, jamais `''`, jamais `strictEnv` — voir M1. Deux tests unitaires gardent ce
point, **un par forme fautive** : une intention en commentaire n'aurait rien empêché.

`CLAUDE_CODE_SSE_PORT` est **gardée**, délibérément. Elle n'est pas héritée de la session
appelante : elle est injectée par l'extension Claude **de cette fenêtre**, par
`EnvironmentVariableCollection`, et désigne **cette fenêtre**. La supprimer couperait le
terminal de sa propre fenêtre — l'inverse de l'invariant d'isolation. Relevé en fenêtre réelle,
configuration complète : le terminal reçoit **119 clés**, dont **une seule** `CLAUDE*`, et
c'est elle.

## Options écartées, avec leur motif mesuré

| Option | Motif de l'écartement |
|---|---|
| **L1 — prompt littéral dans la ligne** | **Échoue sur contenu hostile réaliste** (295 caractères, aucune sortie), et n'a aucun avantage de taille sur L2 : même plafond. |
| **L3 — variable d'environnement** | **Pas de consommateur**, et c'est le motif — pas « trop petite ». Elle porte 131 072 caractères sans broncher, mais le CLI n'offre **aucune** option de prompt par variable d'environnement : le portage illimité ne mène nulle part. |
| **`strictEnv: true`** | Mesuré : fait perdre `TERM_PROGRAM`, `COLORTERM`, `LANG`, `GIT_ASKPASS` et l'intégration shell (79 clés contre 89). Le plus mauvais des choix. |
| **Frapper le prompt dans la TUI après démarrage** | Non retenue, et **bornée plutôt que jugée** : le pty porte **au moins 64 000** caractères et échoue à **131 072** ; la frontière exacte et la couche responsable **ne sont pas établies**. S'y appuyer supposerait de mesurer d'abord. Rappel indépendant : les frappes **synthétiques** n'atteignent pas le champ du webview (ADR-002, voie V3) — il s'agit ici du pty du terminal, pas du panneau. |
| **Découper un prompt trop grand en plusieurs tours** | Écartée pour C1 : elle change la **sémantique** de ce que l'appelant demande, ce qui appelle sa propre décision. Le repli V5 rend la main à l'humain sans rien inventer. |

## Conséquence découverte à l'implémentation — l'attachement ne peut pas servir d'horloge

Mesuré le 2026-07-26 dans la fenêtre de preuve, par **falsification** :
`claude-vscode.editor.open(<uuid jamais amorcé>)` **ouvre un panneau tout de même**
(`ghostSessionOpensAPanel: true`). Le diff d'onglets aboutissait donc en **moins de 200 ms**,
`terminal.dispose()` suivait aussitôt — et la suppression du terminal **tue le `claude` du
tour 1** (ADR-002). Le tour était interrompu à la naissance, et la route rendait un succès.

Le mécanisme attend donc désormais un **fait observé** entre l'envoi de la ligne et
l'attachement : le shell du terminal a **réellement engendré un processus**, constaté dans la
**table des processus du système** — jamais dans un fichier d'état du CLI, dont la sémantique
porte un `— non vérifié` assumé (D17). L'absence de ce processus est nommée
(`SEED_PROCESS_NOT_STARTED`), et c'est aussi le premier signal dont disposent les **deux
portes** du CLI : quand l'une attend, rien n'est engendré.

**Ce qui reste ouvert, et c'est écrit plutôt que comblé** : cette attente établit que le tour a
**démarré**, pas qu'il soit **terminé**. Le savoir suppose de lire le transcript ou le hook
`Stop` — donc le **lot D**. Voir D20 dans [`../compatibilite.md`](../compatibilite.md).
