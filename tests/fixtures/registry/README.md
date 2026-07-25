# Fixtures du registre — captures réelles

Principe fondateur n°5 : *pas de mocks du système réel*. Les fichiers de ce dossier sont de
**vraies entrées de registre**, copiées telles quelles depuis une machine réelle. Aucune n'a
été écrite à la main.

Le dépôt est **public** : jetons et chemins personnels y sont neutralisés. Ce qui l'a été et
ce qui ne l'a pas été est énuméré ci-dessous, ligne à ligne.

---

## `legacy-0.1.0/` — les entrées héritées de l'extension fantôme

| | |
|---|---|
| Origine | `~/.claudemanager/windows/11172.json` et `17544.json` |
| Écrites par | Extension `claudemanager.claudemanager-vscode` **0.1.0**, issue d'un travail hors process qui ne sera jamais livré |
| Où | Poste de développement Windows 11 Pro 10.0.22000, VSCode 1.122.1 |
| Quand | Écrites le 2026-07-24 à 22:01 UTC, copiées le 2026-07-25 |
| État à la copie | L'extension 0.1.0 était **installée ET active** ; les deux `extHostPid` étaient **vivants** |

### Pourquoi elles sont conservées

Elles sont la **preuve du cas de rattrapage** (principe fondateur n°7). Une lecture naïve du
registre y trouverait deux entrées bien formées, aux PID vivants, et les déclarerait
pilotables — `cmgr windows` semblerait fonctionner en s'adressant au serveur d'une version
fantôme. C'est exactement ce que la classification `foreign-schema` empêche.

Elles n'ont **ni `schemaVersion` ni `mainPid`**. Ce n'est pas un oubli de la capture : c'est
la forme réelle du schéma 0.1.0, et c'est ce que la fixture doit prouver.

### Ce qui a été neutralisé

| Champ | Réel | Fixture |
|---|---|---|
| `token` (11172) | UUID v4 émis par l'extension | `00000000-0000-0000-0000-000000000000` |
| `token` (17544) | UUID v4 émis par l'extension | `11111111-1111-1111-1111-111111111111` |
| `workspaceFolders` | `c:\Users\<utilisateur>\OneDrive\Documents\Github\<dépôt>` | `c:\Users\user\OneDrive\Documents\Github\workspace-a` / `workspace-b` |

Deux jetons **distincts** ont été substitués à deux jetons distincts : chaque fenêtre porte
bien le sien, et un test qui les confondrait ne passerait pas pour la mauvaise raison.

La **forme** des chemins est préservée intégralement : lettre de lecteur en **minuscule**
(`c:`, tel que VSCode le rend), séparateurs Windows, profondeur identique. C'est cette forme
qui est réelle, et le module ne doit jamais l'interpréter.

### Ce qui n'a **pas** été touché

- les `extHostPid` — `11172` et `17544`, les mêmes que ceux relevés dans
  `tests/fixtures/identity/windows-process-table.roles.json`, tous deux enfants du `Code.exe`
  principal `16196` ;
- les `port` — `50933` et `50934` ;
- les `startedAt`, à la milliseconde ;
- `isTrusted`, `extensionVersion` ;
- l'**absence** de `schemaVersion` et de `mainPid` ;
- l'indentation, l'ordre des champs, et l'absence de saut de ligne final.

### Ce qu'elles permettent de vérifier

Croisées avec la table de processus réelle de `tests/fixtures/identity/`, elles prouvent sur
des PID **mesurés** — jamais inventés — que :

1. les deux entrées sont classées `foreign-schema` et n'entrent **jamais** dans les fenêtres
   pilotables, alors même que leurs PID sont vivants dans la table ;
2. `purgeStaleEntries` **ne les supprime pas** tant que leurs PID sont vivants — une version
   ultérieure de ClaudeManager écrira un schéma 2, et la version 1 n'a pas à détruire ses
   entrées ;
3. elle les supprime en revanche dès que leurs PID ont disparu de la table : un processus
   mort ne revient pas, sa version importe peu.

### Ce que les tests font du registre réel du poste

Les deux niveaux de test **ne se comportent pas de la même façon**, et cette page a longtemps
affirmé le contraire pour les deux — finding **C8** du gate du lot B.

**Tests unitaires — jamais le registre réel.** Ces fixtures sont copiées dans un répertoire
temporaire réel (`mkdtempSync` sous `os.tmpdir()`, voir `tests/unit/registry/fixtures.ts`) avant
chaque scénario, et tout s'y joue. Aucun test unitaire ne lit ni n'écrit
`~/.claudemanager/windows/` ; le seul endroit qui nomme ce chemin
(`tests/unit/vscode/registry.test.ts`) vérifie la **valeur de chaîne** rendue par défaut, sans
toucher au disque.

**Harnais d'intégration — le registre réel, délibérément.** `tests/integration/src/suite.ts`
appelle `resolveRegistryDir()` **sans surcharge de répertoire** : il travaille dans
`~/.claudemanager/windows`. Ce n'est pas un oubli, c'est la condition qui donne son sens au test
d'isolation — prouver qu'une fenêtre ne revendique pas les autres dans un registre vide et dédié
ne prouverait rien. La fenêtre sous test publie donc son entrée par le chemin de **production**,
au milieu des entrées héritées du poste.

Ce qui rend cela sûr, tel que le code le fait aujourd'hui :

- **l'entrée étrangère de la preuve est fabriquée à l'exécution**, jamais un fichier
  préexistant : `plantForeignEntry` la nomme d'après `process.ppid` — vivant par construction,
  et jamais un extension host — et **renonce** (`undefined`, le point est perdu) si un fichier
  porte déjà ce nom ; son contenu est la fixture 0.1.0 ci-dessus, seul l'`extHostPid` étant
  repointé ;
- **elle n'est retirée que si son contenu est inchangé depuis l'écriture** :
  `unplantForeignEntry` relit le fichier et le compare octet pour octet à ce qu'il a écrit ; s'il
  a changé, il n'est plus le nôtre et la suite le **laisse en place** ;
- **aucun chemin de la suite ne supprime les entrées héritées du poste.** `11172.json` et
  `17544.json` y sont **observées** — leur présence et leur classification sont rapportées comme
  un renseignement sur l'état du poste — et ne portent plus aucune assertion (finding C6) ;
- l'entrée de la fenêtre de test, elle, est retirée par le `deactivate` de l'extension, ce que le
  lanceur constate après la fermeture de la fenêtre (`runTests.ts`, point 8).

**Ce que la suite ne maîtrise pas, et qu'il faut savoir** : le **balayage** joué à l'activation
supprime bel et bien des entrées **mortes** du registre du poste. C'est le comportement de
production de l'extension — pas un acte du test — et c'est précisément ce que le harnais éprouve.
Une entrée dont le PID est vivant n'en est jamais la cible.
