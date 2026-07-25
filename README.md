<div align="center">

# ClaudeManager

**Ouvrir, observer et fermer des conversations Claude dans VSCode — depuis un agent, sans jamais voler le focus.**

[![CI](https://github.com/lucasPaulDaniele/ClaudeManager/actions/workflows/ci.yml/badge.svg)](https://github.com/lucasPaulDaniele/ClaudeManager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)
![Statut](https://img.shields.io/badge/statut-en%20construction-orange)

</div>

---

## Le problème

Un agent Claude ne peut pas ouvrir une conversation Claude.

Cela paraît anecdotique jusqu'à ce qu'on automatise un vrai workflow. Prenons un orchestrateur qui enchaîne des incréments de développement en autonomie, avec une règle simple : **une conversation = un lot de travail**. Quand le lot est terminé, il faut repartir sur un contexte neuf.

À cet instant précis, l'agent s'arrête et écrit :

> « Merci de fermer cette conversation et d'en ouvrir une nouvelle avec `/orchestrer mon-chantier`. »

L'humain fait deux clics et colle un prompt. Aucune valeur ajoutée, mais la boucle autonome est cassée — et elle le reste jusqu'à ce que quelqu'un soit devant l'écran.

**ClaudeManager supprime ce passe-plat.**

## Ce que ça fait

```bash
# Depuis une conversation Claude, dans sa propre fenêtre VSCode :
cmgr open --prompt-file ./amorce.md --wait
```

Une nouvelle conversation apparaît dans la fenêtre, son premier tour déjà joué. La fenêtre peut être **minimisée, masquée, sur un autre bureau virtuel** : rien ne bouge à l'écran, rien ne prend le focus — c'est [mesuré](docs/adr/002-ouverture-interactive.md), pas espéré. Avec `--wait`, la commande rend la main avec la réponse du premier tour, qu'elle relit dans le transcript de la session.

| Opération | État |
|---|---|
| Ouvrir une conversation avec un prompt d'amorçage | ✅ mécanisme **mesuré** — [voie V1](docs/adr/002-ouverture-interactive.md) |
| Fermer une conversation | ✅ mécanisme **mesuré** — `tabGroups.close` sur l'onglet `claudeVSCodePanel` |
| Cibler la bonne fenêtre parmi plusieurs, même identiques | ✅ mécanisme **mesuré** en configuration adverse — [deux fenêtres, même répertoire physique, même `Code.exe` principal](docs/adr/002-ouverture-interactive.md) |
| Lire une réponse / attendre la fin d'un tour | 🚧 **conçu, pas encore mesuré** — c'est la condition d'obtention de la réponse du tour 1, et elle relève du lot D |
| Écrire dans une conversation déjà ouverte | ❌ hors périmètre — [pourquoi](docs/adr/002-ouverture-interactive.md) |
| Arrêter un prompt en cours | ❌ hors périmètre — [pourquoi](docs/adr/001-pilotage-des-conversations.md) |

« Mesuré » qualifie le **mécanisme**, pas la livraison : aucun paquet n'est encore publié. Voir la [feuille de route](#feuille-de-route).

## Comment ça marche

L'extension Claude pour VSCode n'expose aucune API publique. Elle expose en revanche une commande interne, `claude-vscode.editor.open(sessionId, prompt)` — et le premier réflexe est de lui passer un prompt.

**C'est un piège**, et il est prouvé deux fois : la lecture du bundle montre que ce paramètre se contente d'appeler `setInputText`, et la mesure le confirme — le prompt s'assoit dans le champ de saisie, la flèche d'envoi attend. Rien n'est envoyé. Il faudrait simuler une frappe clavier ; or les frappes synthétiques **n'atteignent même pas le champ du webview**, avec ou sans focus ([mesuré](docs/adr/002-ouverture-interactive.md)).

ClaudeManager prend donc le problème autrement : **on joue le premier tour dans un vrai terminal, jamais affiché, puis on attache le panneau à la session ainsi créée.**

```mermaid
flowchart LR
    A["cmgr open<br/>--prompt-file"] --> B["terminal masqué<br/>hideFromUser, jamais show()"]
    B --> C["claude --session-id &lt;uuid&gt;<br/>tour 1 dans un vrai pty"]
    C --> D["editor.open(&lt;uuid&gt;)<br/>panneau attaché"]
    D --> E["terminal.dispose()<br/>plus aucune trace"]
```

1. On génère un identifiant de session.
2. L'**extension compagnon** crée dans la fenêtre cible un terminal **masqué** — `hideFromUser: true`, `show()` jamais appelé — en **neutralisant les variables d'environnement héritées** de la session Claude appelante. Sans cette précaution, le `claude` lancé là se croit agent enfant, se déclare non interactif et cesse d'écrire son transcript. Silencieusement.
3. Le premier tour y est joué par un vrai `claude --session-id <uuid> "<prompt>"` : une session **réellement interactive**, dans un pty.
4. `claude-vscode.editor.open(<uuid>)` attache un panneau à cette session, puis `terminal.dispose()` fait disparaître le terminal.

Le résultat est une conversation normale, visible, reprenable à la main — dont le premier tour a été joué par un agent. Durée de visibilité du terminal pour l'humain : **nulle**.

### Si l'extension change — le repli

`editor.open` et `--session-id` ne sont contractuels ni l'un ni l'autre. Le projet a donc un **repli officiel, lui aussi mesuré** : `editor.open(null, <prompt>)` ouvre la conversation avec le prompt **pré-rempli**, et l'humain valide d'un geste. On perd l'autonomie complète ; on garde l'essentiel — il n'a ni à créer la conversation, ni à retrouver la fenêtre, ni à recopier le prompt. Mieux vaut un geste humain qu'une conversation non ouverte. Détail dans [l'ADR-002](docs/adr/002-ouverture-interactive.md).

### Pourquoi une extension compagnon

Parce que c'est la seule voie. L'extension Claude n'exporte rien depuis `activate()`, et ses commandes ne sont appelables que **depuis l'intérieur de VSCode** — tout comme la création d'un terminal **dans une fenêtre désignée**. C'est aussi ce qui rend le pilotage indépendant du focus : `executeCommand` et `createTerminal` n'ont jamais besoin qu'une fenêtre soit visible, là où toute automatisation clavier l'exige.

### Comment on ne se trompe pas de fenêtre

C'est l'invariant du produit. Une commande émise depuis une fenêtre ne doit **jamais** affecter une autre — y compris quand deux fenêtres ouvrent le même dossier.

L'ancrage n'est ni le titre de la fenêtre, ni le dossier, ni `VSCODE_PID` (un seul processus principal héberge toutes les fenêtres, cette variable ne discrimine rien). C'est la **chaîne d'ancêtres du processus** :

```
claude.exe  →  extension host  →  processus principal VSCode
   17816          11172                  16196
                    ↑
        unique par fenêtre : voilà la clé
```

Chaque instance de l'extension compagnon connaît son propre extension host et peut donc répondre avec certitude : « ce processus est-il un des miens ? »

Ce n'est pas une intuition d'architecture : c'est mesuré dans la configuration la plus adverse possible — deux fenêtres pointant sur le **même répertoire physique** et partageant le **même `Code.exe` principal**. Les opérations adressées à l'une n'ont créé dans l'autre ni onglet, ni terminal, ni processus. Relevés dans [l'ADR-002](docs/adr/002-ouverture-interactive.md).

## Installation

> **Statut** : le socle et la conception sont posés, les paquets ne sont pas encore publiés.
> Voir la [feuille de route](#feuille-de-route). Les commandes ci-dessous décrivent la cible.

```bash
npm install -g @claudemanager/cli
code --install-extension claudemanager-vscode
cmgr doctor
```

## Utilisation

### En ligne de commande

```bash
cmgr whoami                              # quelle fenêtre, quelle conversation
cmgr conversations                       # les conversations ouvertes ici
cmgr open --prompt-file ./amorce.md      # ouvrir, avec un prompt d'amorçage
cmgr open --prompt-file ./a.md --wait    # ... et attendre la réponse
cmgr close <id>                          # fermer une conversation
cmgr read <sessionId>                    # relire la dernière réponse
cmgr doctor                              # diagnostiquer l'environnement
```

Toutes les commandes écrivent du **JSON sur stdout** et les diagnostics sur stderr : le consommateur visé est un agent, pas un humain.

Le prompt passe **toujours par fichier**, jamais en argument — l'échappement des prompts longs en shell (a fortiori PowerShell) est une source de bugs inépuisable.

`--wait` relit la réponse du premier tour dans le transcript de la session : il dépend du lot D (voir la [feuille de route](#feuille-de-route)).

### Comme serveur MCP

C'est le mode recommandé pour un agent : les prompts multi-lignes deviennent un champ JSON, plus aucun échappement.

```json
{
  "mcpServers": {
    "claudemanager": { "command": "npx", "args": ["-y", "@claudemanager/mcp"] }
  }
}
```

Outils exposés : `claude_whoami`, `claude_list_conversations`, `claude_open_conversation`, `claude_close_conversation`, `claude_read_response`, `claude_wait_for_idle`.

## Limites et risques — à lire avant d'adopter

Ce projet repose sur des **API internes non documentées** de l'extension Claude Code. C'est un choix assumé, pas un angle mort : il n'existe aucune API publique pour ce besoin.

- **Une mise à jour de l'extension peut tout casser.** Chaque point d'adhérence est recensé dans [`docs/compatibilite.md`](docs/compatibilite.md) avec la version sur laquelle il a été vérifié. `cmgr doctor` vérifie les présupposés et **échoue explicitement** — jamais de dégradation silencieuse.
- **Le tour d'amorçage se joue dans un terminal invisible.** La session est **réellement interactive** — c'est mesuré, pas déduit — mais le terminal n'est jamais affiché : vous ne voyez le premier tour qu'une fois le panneau attaché.
- **La réponse du premier tour n'est pas rendue directement.** La sortie du terminal n'étant pas capturée par l'appelant, cette réponse se lit dans le transcript de la session ou via le hook `Stop` : c'est ce que fait `--wait`, et cela dépend du lot D.
- **Le Workspace Trust désactive tout.** Dans une fenêtre en Restricted Mode, les commandes de l'extension Claude *n'existent pas*, sans le moindre message d'explication. `cmgr doctor` le détecte et le nomme.
- **Les tests bout-en-bout exigent l'extension Claude authentifiée** : ils sont donc impossibles en CI publique. La CI couvre lint, typecheck, tests unitaires et packaging ; les preuves d'exécution locale sont jointes aux PR.

## Architecture

```
packages/core      logique pure — identité, registre, sessions, transcripts
                   (n'importe jamais `vscode` : c'est ce qui la rend testable)
packages/vscode    extension compagnon — attache et ferme, rien de plus
packages/cli       binaire `cmgr`
packages/mcp       serveur MCP
```

Deux règles gouvernent ce découpage : **le cœur ne connaît pas VSCode**, et **aucune opération ne dépend du focus**. Elles sont détaillées, avec leurs justifications, dans [`CLAUDE.md`](CLAUDE.md).

## Feuille de route

| Lot | Contenu | État |
|---|---|---|
| **0** | Socle : spike de faisabilité, conventions, CI | ✅ |
| **A** | Trancher le mécanisme d'ouverture interactive ([ADR-002](docs/adr/002-ouverture-interactive.md)) | ✅ |
| **B** | Noyau : identité, registre, extension compagnon, CLI de lecture | ⏳ |
| **C** | Ouverture et fermeture : `cmgr open`, `cmgr close`, E2E multi-fenêtres | ⏳ |
| **D** | Observabilité : transcript, hook `Stop`, `cmgr read` / `wait` / `doctor` | ⏳ |
| **E** | Diffusion : serveur MCP, packaging, release | ⏳ |

## Contribuer

Les conventions du projet sont dans [`CLAUDE.md`](CLAUDE.md) — elles sont exigeantes et assumées : 100 % de couverture sur le cœur, aucun mock du système réel (les tests d'intégration tournent contre une vraie fenêtre VSCode), et tout correctif de bug embarque un test qui **échoue avant le correctif**.

Les décisions structurantes sont tracées dans [`docs/adr/`](docs/adr/). Commencez par [l'ADR-002](docs/adr/002-ouverture-interactive.md) : il compare cinq voies d'ouverture toutes mesurées sur pièce, et justifie celle qui est retenue. Puis, si les fausses pistes vous intéressent — elles sont instructives, et il y en a maintenant deux couches — [l'ADR-001](docs/adr/001-pilotage-des-conversations.md), remplacé, raconte les sept itérations de spike qui avaient mené au mécanisme précédent, et pourquoi il a fini par être rejeté en recette.

## Licence

[MIT](LICENSE)
