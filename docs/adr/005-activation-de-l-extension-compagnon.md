# ADR-005 — Une fenêtre déjà ouverte ne prend jamais une nouvelle version de l'extension compagnon

**Date** : 2026-07-27
**Statut** : accepté
**Incrément** : C4 (`cmgr conversations`, `cmgr close`)
**Remplace** : rien. **Complète** [ADR-003](003-registre-et-serveur-local.md), qui décrit le cycle
de publication d'une fenêtre sans dire quand ce cycle *commence*.

## Contexte

L'extension compagnon ne contribue **aucune commande** et ne déclare qu'un seul événement
d'activation :

```json
"activationEvents": ["onStartupFinished"]
```

**Mesuré deux fois**, et le second cas est le décisif :

| Mesure | Situation | Résultat |
|---|---|---|
| 2026-07-26 (C3) | installation de la **0.4.0** avec trois fenêtres ouvertes, 40 s d'observation | **aucune** n'a republié |
| 2026-07-26 (C3) | l'une de ces trois exécutait déjà l'extension en **0.3.0** | son entrée de registre annonçait toujours **0.3.0** |
| 2026-07-26 (C3) | fenêtre ouverte **après** l'installation | publie en **0.4.0** |

Autrement dit : **ni une première installation, ni une mise à jour ne prennent effet dans une
fenêtre déjà ouverte.** Seule une fenêtre **neuve** sert la version neuve.

La conséquence n'est pas cosmétique. Une CLI à jour qui interroge une fenêtre restée en arrière
obtient `404 NOT_FOUND` sur toute route nouvelle — donc `WINDOW_REQUEST_REFUSED`, dont la
remédiation dit déjà « NOT_FOUND signale une extension compagnon trop ancienne pour cette route ».
L'incrément C4 ajoute deux routes : c'est le premier incrément où ce décalage se constate sur des
commandes que l'utilisateur tape.

**Vérifié le 2026-07-27, sur le poste de référence** : les deux fenêtres enregistrées servaient
l'extension **0.4.0** pendant que la CLI en construction parlait le protocole **0.5.0**. Le chemin
prévu fonctionne bel et bien — `404` → `WINDOW_REQUEST_REFUSED`, avec la remédiation qui nomme la
cause — et il n'a pas fallu l'ajouter : il était déjà là.

**La question que cet ADR tranche** : faut-il un événement d'activation supplémentaire, ou une
surface d'UI, pour qu'une fenêtre déjà ouverte prenne la version neuve ?

## Options examinées

### Option A — ajouter un événement d'activation (`onCommand`, `workspaceContains`, `*`)

**Écartée. Elle ne peut pas résoudre le cas décisif, et le cas décisif est la mise à jour.**

Un événement d'activation décide **quand** VSCode charge le code d'une extension dans un
extension host. Il ne dit rien de la **version** de ce code. Or dans le cas mesuré, l'extension
était **déjà activée** : la fenêtre `11096` exécutait la 0.3.0 depuis son démarrage. Il n'y avait
donc rien à activer — il aurait fallu **remplacer à chaud** du code déjà chargé, ce qui n'est pas
dans le modèle d'extension de VSCode. L'échange de code se fait au redémarrage de l'extension host,
et rien d'autre ne le fait.

Un événement supplémentaire ne pourrait donc aider que la **première** installation, où aucun code
n'est encore chargé. Et même là, il n'y a rien où l'accrocher : l'extension **ne contribue aucune
commande** (`contributes` est absent du manifeste), donc pas de `onCommand:`. Restent
`workspaceContains:` — qui lierait l'activation à la présence d'un fichier dans le projet de
l'utilisateur, c'est-à-dire à un critère étranger au produit — et `"*"`, qui active dans **toutes**
les fenêtres au démarrage, soit exactement ce que `onStartupFinished` fait déjà, en plus tôt et
donc en ralentissant le démarrage de l'éditeur.

*L'hypothèse posée à l'entrée de cet incrément était « aucun événement d'activation ne résout le
cas décisif ». Elle a été cherchée en falsification — quel événement pourrait bien réactiver un
host qui a déjà chargé l'ancien code ? — et aucune voie n'a été trouvée. Ce qui est écrit ici est
donc un raisonnement sur le modèle de VSCode, appuyé sur deux mesures ; ce n'est pas une mesure de
plus.*

### Option B — contribuer une commande, et une surface d'UI pour « recharger le compagnon »

**Écartée, et pour un motif de produit, pas de technique.**

Une commande contribuée serait visible dans la palette, donc une **surface d'UI** — or l'activation
de cette extension est *totalement invisible* par décision : « aucune notification, aucun
`outputChannel.show()`, aucune commande contribuée, aucune vue révélée » (principe fondateur n°1).
Et elle ne résoudrait toujours pas le problème : recharger l'extension compagnon suppose de
redémarrer l'extension host, ce qui **tue les `claude.exe` qui en descendent** — donc la
conversation en cours. C'est exactement ce que le README interdit, et ce que la mesure M1 de cet
incrément confirme : fermer un onglet suffit déjà à tuer le processus de sa session.

Le geste existe déjà, il appartient à l'humain, et il est documenté : **ouvrir une fenêtre neuve,
au moment de son choix**.

### Option C — assumer la contrainte, la documenter, et rendre le décalage NON SILENCIEUX

**Retenue.**

La contrainte est **structurelle** : elle tient au modèle d'extension de VSCode, pas à un réglage
qu'on aurait oublié. Ce qui est en notre pouvoir est que le décalage ne soit jamais **silencieux**,
et il ne l'est pas — dans les deux sens :

- une fenêtre restée en arrière fait sortir `cmgr open` en **code 4** (`firstTurnVerified: false`)
  plutôt qu'en `0`, et renvoie à `cmgr windows` pour comparer les versions ;
- une fenêtre restée en arrière refuse les routes nouvelles par `404` → `WINDOW_REQUEST_REFUSED`,
  dont la remédiation nomme la cause. **Vérifié le 2026-07-27** ;
- une CLI restée en arrière refuse la réponse d'une fenêtre à jour — **mais le code qu'elle rend
  dépend de son âge, et c'est le point faible du dispositif**. Une CLI d'aujourd'hui rend
  `WINDOW_OPEN_RESPONSE_UNREADABLE`, qui porte l'avertissement de ne pas relancer à l'aveugle.
  Une CLI **0.2.0 ou 0.3.0 ne connaît pas ce code** — il n'a été introduit qu'à la correction du
  gate de mi-lot C, et il y a **zéro occurrence** dans ces deux versions — et rend
  `WINDOW_RESPONSE_UNREADABLE`, `missing: "firstTurnVerified"` : le code des **routes de lecture**,
  dont la remédiation d'époque dit de **recharger la fenêtre**. **Vérifié le 2026-07-27** en
  rejouant le client 0.2.0 sur la réponse réelle d'une fenêtre à jour (`openSeeded`), contrôle
  positif à l'appui — le même client lit sans broncher la capture de sa propre version.

## Décision

1. **Aucun événement d'activation n'est ajouté**, et l'extension continue de ne contribuer
   **aucune commande**. Le manifeste reste à `["onStartupFinished"]`.
2. **La contrainte est documentée là où l'utilisateur la rencontre** : la procédure d'installation
   du README l'annonce, avec la mesure à l'appui et le geste exact.
3. **Le décalage de version reste détectable et nommé**, jamais silencieux. Toute route nouvelle
   doit pouvoir être refusée par une fenêtre ancienne sans que l'appelant reste sans explication —
   c'est acquis par `404` → `WINDOW_REQUEST_REFUSED`.
4. **Corollaire pour le lot E** : la recette bout-en-bout ne peut pas supposer que l'installation
   d'un artefact met à jour les fenêtres existantes. Elle doit **ouvrir une fenêtre neuve** entre
   l'installation et la vérification, et la publication des deux artefacts (VSIX et npm) doit être
   **simultanée** — un décalage entre eux se paie en refus côté utilisateur.
5. **Une version monte dès que le protocole change de façon observable**, dans l'incrément qui le
   change. Ajouté au gate final du lot C, et ce n'est pas une règle de confort : les deux
   remédiations de désaccord de protocole envoient l'utilisateur **comparer des numéros**, et un
   numéro qui ne bouge pas quand le protocole bouge rend ce geste inapplicable. La dette est
   nommée : l'extension **0.2.0** désigne la surface du lot B — sans aucune route
   `/conversations` — *et* celle de C1/C2 qui la porte ; la CLI **0.3.0** désigne les deux états
   séparés par la correction du gate de mi-lot. `tests/unit/packaging/versions.test.ts` tient
   désormais un plancher pour chacun des deux artefacts.

## Conséquences

- **La version qui compte est celle que l'entrée de registre annonce** (`extensionVersion`), pas
  celle que `code --list-extensions` affiche : la seconde dit ce qui est installé sur le disque, la
  première ce que chaque fenêtre **exécute**. `cmgr windows` rend la première.
- **Aucun rechargement n'est jamais déclenché par l'outil.** C'est l'humain qui choisit quand
  renouveler une fenêtre — un `Developer: Reload Window` tue les conversations en cours.
- **Un trou subsiste, et il ne se referme pas rétroactivement.** Une CLI 0.2.0 ou 0.3.0 déjà
  installée quelque part rend, pour le cas « CLI en retard, fenêtre à jour », une remédiation qui
  prescrit de **recharger la fenêtre** — exactement le geste que cet ADR interdit, et sur une
  conversation qui vient de s'ouvrir. Ces artefacts sont livrés : leur texte ne se corrige plus.
  Ce qui est en notre pouvoir a été fait — la procédure d'installation du README **nomme le
  piège** et donne le geste sûr, et les deux remédiations d'aujourd'hui prescrivent la **fenêtre
  neuve**, jamais le rechargement. C'est aussi ce qui rend la décision n°5 non négociable : la
  seule protection durable est que les numéros disent la vérité.
- Cet ADR est le propriétaire de la question. Y revenir suppose une mesure nouvelle : par exemple
  qu'une version de VSCode se mette à remplacer à chaud le code d'une extension mise à jour, ce qui
  n'est le cas d'aucune version connue à ce jour (1.122.1 mesurée).
