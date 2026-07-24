# Matrice de compatibilité

ClaudeManager s'appuie sur des **API internes et non contractuelles** de l'écosystème Claude Code. Elles ne sont ni documentées ni garanties : une mise à jour de l'extension peut les faire disparaître sans préavis.

Ce fichier recense **chaque** point d'adhérence, la version sur laquelle il a été vérifié, et la façon dont son absence est détectée. Toute nouvelle dépendance doit y être ajoutée dans la même PR que le code qui l'introduit.

**Règle** : quand un présupposé tombe, ClaudeManager **échoue avec un message nommé**. Il ne dégrade jamais en silence.

## Environnement de référence

| | Version vérifiée |
|---|---|
| Extension `Anthropic.claude-code` | **2.1.219** |
| CLI `claude` (binaire embarqué) | **2.1.219** |
| VSCode | 1.122.1 |
| Système | Windows 11 (26100 / 22000) |
| Node | 20+ |

## Points d'adhérence

| # | Dépendance | Nature | Utilisé pour | Détection de l'absence |
|---|---|---|---|---|
| D1 | Commande `claude-vscode.editor.open(sessionId?, prompt?, viewColumn?)` | Commande VSCode interne | Attacher un panneau UI à une session existante | `vscode.commands.getCommands(true)` ne la contient pas → erreur `CLAUDE_COMMAND_MISSING` |
| D2 | `viewType` d'onglet contenant `claudeVSCodePanel` | Détail d'implémentation de la webview | Énumérer et fermer les conversations | Aucun onglet ne correspond alors qu'une conversation est attendue → erreur `CLAUDE_PANEL_VIEWTYPE_UNKNOWN` |
| D3 | `claude -p --session-id <uuid> --output-format json` | Contrat CLI | Amorcer une session avec un identifiant choisi | `session_id` absent du JSON, ou différent de l'uuid demandé → erreur `SEED_SESSION_ID_MISMATCH` |
| D4 | `claude agents --json` | Contrat CLI | Inventorier les sessions vivantes | Sortie non-JSON ou schéma inattendu → repli sur D5, puis erreur |
| D5 | `~/.claude/sessions/<pid>.json` | Fichier d'état interne | Repli d'inventaire des sessions | Répertoire absent → l'inventaire se limite à D4 |
| D6 | `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | Transcript interne | Lire une réponse, détecter la fin de tour | Fichier introuvable ou lignes non parsables → repli sur le hook `Stop`, sinon erreur `TRANSCRIPT_UNREADABLE` |
| D7 | Slugification du cwd (`:` et `\` → `-`) | Convention de nommage interne | Localiser le transcript d'une session | Aucun répertoire ne correspond → balayage complet de `projects/`, puis erreur |
| D8 | Hook `Stop` de `~/.claude/settings.json` | Point d'extension documenté | Signal de fin de tour | Optionnel — repli automatique sur D6 |
| D9 | `claude.exe.ppid` = PID de l'extension host de sa fenêtre | Comportement du système d'exploitation | Résoudre « ma fenêtre » | Aucune fenêtre enregistrée ne revendique le PID → erreur `OWNING_WINDOW_NOT_FOUND` |

## Modes de défaillance connus de l'environnement

Ces situations ne sont pas des bugs de ClaudeManager, mais elles doivent être **diagnostiquées et nommées** par `cmgr doctor`.

### Workspace Trust — le piège silencieux

Dans une fenêtre ouverte en **Restricted Mode**, les commandes de l'extension Claude **n'existent tout simplement pas** ; `executeCommand` échoue par `command not found`, sans aucune indication de la cause réelle.

`cmgr doctor` doit vérifier `vscode.workspace.isTrusted` et le signaler explicitement, avec la remédiation (accorder la confiance au dossier).

### Verrous IDE périmés

`~/.claude/ide/` accumule des fichiers `<port>.lock` jamais nettoyés — plus d'une centaine observés sur la machine de référence, remontant à plusieurs mois. Ne jamais considérer la présence d'un lock comme la preuve d'une fenêtre vivante : toujours vérifier que le PID est vivant. Le registre propre à ClaudeManager doit être **auto-nettoyant**.

### `VSCODE_PID` n'identifie pas une fenêtre

Un unique processus principal VSCode héberge plusieurs fenêtres. Deux verrous portant `pid: 16196` ont été observés pour deux dossiers différents. **Ne jamais utiliser `VSCODE_PID` comme clé d'identité** — utiliser le PID de l'extension host (D9).

### Panneau Claude restauré au démarrage

Une fenêtre peut rouvrir automatiquement un panneau Claude à son lancement. Ne jamais supposer qu'un seul onglet Claude existe, ni que le premier trouvé est celui qu'on vient d'attacher : diffuser l'état des onglets avant/après l'opération.
