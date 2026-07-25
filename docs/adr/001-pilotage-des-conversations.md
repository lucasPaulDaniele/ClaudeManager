# ADR-001 — Comment piloter une conversation Claude dans VSCode

- **Date** : 2026-07-24
- **Statut** : **remplacé par [ADR-002](002-ouverture-interactive.md)** le **2026-07-25**
- **Vérifié contre** : extension `Anthropic.claude-code` **2.1.219**, VSCode 1.122.1, Windows 11
- **Méthode** : spike jeté (extension VSCode minimale lancée via `--extensionDevelopmentPath`), 7 itérations, preuves conservées dans le corps de cet ADR

> ### ⚠️ Document historique — le mécanisme décidé ici a été remplacé
>
> **Ce qui est invalidé.** La décision ci-dessous — amorcer la session par
> `claude -p --session-id <uuid>` puis attacher le panneau — a été **rejetée en recette le
> 2026-07-25** : la conversation ainsi ouverte **n'est pas interactive à son premier tour**.
> Amorcée par `claude -p`, elle répond en annonçant elle-même qu'elle ne peut pas lancer de flux
> OAuth MCP « car cette session n'est pas interactive ». Tombe avec elle la conséquence favorable
> « la réponse du tour d'amorçage est obtenue gratuitement » : le tour 1 étant désormais joué dans
> un terminal dont la sortie n'est pas capturée, sa réponse se lit dans le transcript ou par le
> hook `Stop`.
>
> **Ce qui reste valide**, et sur quoi le projet continue de s'appuyer :
>
> - `initialPrompt` **pré-remplit sans soumettre** (§1) — reconfirmé au source *et* par mesure.
>   **Incise (2026-07-25)** : §1 se conclut par « Cette voie est écartée » — cette conclusion-là
>   ne vaut plus telle quelle. Le constat technique reste intact, mais la voie qu'il décrit —
>   ouvrir avec un prompt pré-rempli et laisser l'humain valider — est depuis devenue le **repli
>   officiel du projet** (voie V5 d'[ADR-002](002-ouverture-interactive.md)). Elle est écartée
>   comme voie **nominale**, retenue comme voie de **repli** ;
> - la **fermeture** par `vscode.window.tabGroups.close(tab)` sur l'onglet dont le `viewType`
>   contient `claudeVSCodePanel` ;
> - l'**indépendance au focus** de `editor.open` et de `tabGroups.close` (§3) ;
> - l'**identité de fenêtre** par **chaîne d'ancêtres**, et le fait que `VSCODE_PID` ne discrimine
>   rien (§4).
>   **Incise (2026-07-25)** : §4 conclut « `claude.exe.ppid` est le PID de l'extension host de sa
>   fenêtre ». Cela reste vrai **de la topologie qu'il a mesurée** — un `claude.exe` attaché au
>   panneau, donc enfant direct de l'extension host — mais ce n'est pas une règle générale, et
>   c'est ici, dans cet encadré, que la généralisation avait été faite. Le lot B a mesuré **trois
>   sauts** entre le `claude.exe` appelant et son extension host. L'énoncé en vigueur et sa trace
>   de mesure sont désormais portés par **D9** de [`docs/compatibilite.md`](../compatibilite.md) :
>   remonter **toute** la chaîne, jamais le seul `ppid` ;
> - le piège du **Workspace Trust**, qui fait disparaître les commandes `claude-vscode.*` sans le
>   moindre message (§5).
>
> **Le corps de cet ADR n'a pas été réécrit** : un ADR remplacé se conserve tel quel, c'est un
> document historique. Pour le mécanisme en vigueur, voir
> [ADR-002](002-ouverture-interactive.md).

## Contexte

La skill `/orchestrer` doit pouvoir **fermer sa conversation et en ouvrir une neuve** en fin de lot. Aucun mécanisme public ne le permet : l'extension Claude n'exporte pas d'API (`activate()` ne retourne rien) et le serveur WebSocket de `~/.claude/ide/<port>.lock` ne transporte que des outils d'éditeur (`openFile`, `openDiff`, `getDiagnostics`) — c'est le sens agent → IDE, pas un canal de contrôle.

Le seul levier identifié était la commande interne `claude-vscode.editor.open(sessionId?, initialPrompt?, viewColumn?)`. Restait à savoir ce qu'elle fait réellement.

## Ce que le spike a mesuré

### 1. `initialPrompt` **pré-remplit** le champ de saisie, il ne le soumet pas

C'est le résultat le plus important, et il invalide l'hypothèse initiale.

Après `executeCommand('claude-vscode.editor.open', undefined, "Reponds uniquement par SPIKEV6-TRUST-R4 et rien d'autre.")` :

- un onglet `claudeVSCodePanel` apparaît, intitulé « Untitled » ;
- un processus `claude.exe` démarre (visible dans `claude agents --json`, cwd = workspace de la fenêtre) ;
- **aucun fichier de transcript n'est créé** dans `~/.claude/projects/<slug>/` ;
- la capture d'écran montre le texte du prompt **assis dans le composer**, non envoyé.

Conclusion : le prompt attend une action humaine (Entrée / clic). Une automatisation clavier serait nécessaire — donc le focus, donc l'incompatibilité avec l'exigence « fenêtre cachée ». **Cette voie est écartée.**

### 2. L'attachement à une session préexistante fonctionne, et il résout tout

`claude.exe -p --session-id <uuid>` crée une session avec un identifiant **choisi par l'appelant** et exécute réellement le tour :

```
is_error=False
session_id=b0fc8264-1b95-449f-a01b-52be42b372dd
result=ATTACH-OK-88
```

Puis `executeCommand('claude-vscode.editor.open', '<uuid>')` **attache un panneau UI à cette session** : un onglet est apparu, intitulé `Respond with specific co…` — un titre dérivé du contenu réel de la conversation, preuve que l'UI a bien chargé le tour déjà joué.

### 3. Aucune opération ne réclame le focus

Le spike attend explicitement que la fenêtre perde le focus (`vscode.window.state.focused === false`, obtenue en minimisant la fenêtre depuis un script externe) **avant** de tirer. Résultats sur fenêtre minimisée :

| Sonde | Résultat |
|---|---|
| `editor.open(sessionId)` | `error: null`, `focusedRightAfter: false` |
| observation 25 s | onglet présent, `windowFocused: false` en continu |
| `tabGroups.close(tab)` | `closeReturn: true`, onglet disparu, `windowFocused: false` |

**La fenêtre n'a jamais été réveillée ni activée.** L'exigence fondatrice n°1 est tenue.

### 4. L'identité de fenêtre repose sur le PID de l'extension host

Cinq lancements successifs ont donné les extension hosts `1124`, `1392`, `3572`, `5260`, `20028` — tous avec `ppid = 16196`, le processus principal partagé.

Et la chaîne d'ancêtres d'une conversation existante est directe :

```
claude.exe (17816)  →  extension host (11172)  →  Code.exe main (16196)
```

Donc : **`claude.exe.ppid` est le PID de l'extension host de sa fenêtre**, et ce PID est unique par fenêtre. `VSCODE_PID` ne l'est pas (deux locks portent `pid: 16196` pour des dossiers différents) et **ne doit jamais servir de clé d'identité**.

### 5. Le Workspace Trust désactive tout, silencieusement

Dans une fenêtre en **Restricted Mode**, `claude-vscode.editor.open` **n'existe pas** : `command 'claude-vscode.editor.open' not found`. Aucun message ne l'explique côté appelant. Trois itérations du spike ont été perdues sur ce piège avant qu'une capture d'écran ne révèle le dialogue de confiance.

C'est un mode de défaillance à part entière, à détecter et à nommer explicitement.

## Décision

**Ouvrir une conversation = amorcer la session en headless, puis attacher l'UI.**

1. Générer un `uuid`.
2. Exécuter le premier tour en headless dans le workspace de la fenêtre cible :
   `claude -p --session-id <uuid> --output-format json` (prompt fourni **par stdin**, jamais en argument).
3. Demander à l'extension compagnon d'exécuter `claude-vscode.editor.open(<uuid>)`.

**Fermer une conversation** = `vscode.window.tabGroups.close(tab)` sur l'onglet dont `viewType` contient `claudeVSCodePanel`.

## Conséquences

**Favorables**
- Autonomie complète : aucune frappe clavier, aucune interaction humaine.
- Indépendance au focus démontrée pour les deux opérations.
- **La réponse du tour d'amorçage est obtenue gratuitement**, dans le JSON du headless (`result`, `is_error`, `session_id`) — sans dépendre du parsing du transcript ni du hook `Stop` pour ce premier tour.
- L'extension compagnon se réduit à deux gestes (attacher, fermer) ; toute la logique reste dans le cœur, testable en Node pur.

**Défavorables et limites assumées**
- **Le tour d'amorçage s'exécute hors UI.** L'utilisateur ne le voit se dérouler qu'une fois attaché. Pour un prompt long (`/orchestrer` lit un fichier d'état de plusieurs centaines de kilo-octets), l'attente précède l'affichage.
- **Écrire dans une conversation déjà attachée reste impossible.** Décision de périmètre, inchangée.
- **Un onglet n'expose pas son `sessionId`.** Identifier « notre » onglet impose de diffuser l'état des onglets avant/après l'attachement. Le spike a de plus observé qu'une fenêtre peut **restaurer automatiquement** un panneau Claude à son démarrage : ne jamais supposer qu'un seul onglet Claude existe.
- **Adhérence à des API internes** : `claude-vscode.editor.open`, le `viewType` `claudeVSCodePanel`, et le contrat de `claude -p --session-id`. Voir `docs/compatibilite.md`.

## Options écartées

| Option | Motif du rejet |
|---|---|
| Automatisation clavier (frappe Entrée dans la webview) | Exige le focus — incompatible avec l'exigence fondatrice n°1. |
| Serveur MCP de `~/.claude/ide/<port>.lock` | Sens inverse : n'expose que des outils d'éditeur, aucun contrôle de conversation. |
| API exportée par l'extension Claude | Elle n'exporte rien. |
| `claude-vscode.newConversation` | N'accepte aucun argument ; ne permet ni de choisir la session ni de fournir un prompt. |
| Réouverture d'un onglet fermé pour réinjecter un prompt | Ne résout rien : le prompt serait de toute façon seulement pré-rempli. |
