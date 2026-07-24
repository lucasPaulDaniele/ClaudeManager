# ADR-002 — Ouvrir une conversation Claude interactive dès son premier tour

- **Date** : 2026-07-25
- **Statut** : **proposé — décision en attente d'arbitrage**
- **Remplace** : le mécanisme retenu par [ADR-001](001-pilotage-des-conversations.md), rejeté en recette le 2026-07-25
- **Méthode** : spike de mesure, banc d'essai **jeté** (hors dépôt), toutes les voies exécutées sur pièce

> Cet ADR **ne tranche pas**. Il mesure et compare. La section « Décision » est laissée
> ouverte : elle appartient au propriétaire du projet, au vu des mesures ci-dessous.

## Versions vérifiées

| Élément | Version |
|---|---|
| VSCode | 1.122.1 (`8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e`, x64) |
| Extension `anthropic.claude-code` | 2.1.219 (win32-x64) |
| CLI `claude` | 2.1.219 |
| Windows | 11 Pro 10.0.22000 |
| Node | 24.13.0 |

Dans tout ce document, `<HOME>` remplace le répertoire personnel de l'utilisateur et
`<SPIKE>` le répertoire `%TEMP%\claudemanager-spike-a1`.

## Contexte

### Pourquoi ADR-001 est remis en cause

ADR-001 retenait : amorcer la session en headless (`claude -p --session-id <uuid>`) puis
attacher l'UI par `claude-vscode.editor.open(<uuid>)`. **Rejeté en recette** : la conversation
ainsi ouverte n'est pas interactive à son premier tour. Amorcée par `claude -p`, elle répond en
annonçant elle-même qu'elle ne peut pas lancer de flux OAuth MCP « car cette session n'est pas
interactive ». La session devient bien interactive **après** attachement, mais le tour 1 reste
headless — inacceptable pour l'usage visé.

### Ce qui est établi au niveau du source

Le paramètre `initialPrompt` de `editor.open` **ne soumet jamais**. Vérifié dans le bundle de
l'extension : `claude-vscode.editor.open` est enregistré comme
`(g, x, w) => { ... u.createPanel(g, x, w) }`, et côté webview le prompt ne fait que remplir le
champ de saisie (`if (ge) a.current?.setInputText(ge)`). Le gestionnaire d'URI
`vscode://anthropic.claude-code/open?session=&prompt=` retombe sur le même chemin via
`primaryEditor.open`. **Aucun point d'entrée connu de l'extension ne soumet un prompt.**

### Les deux amendements du 2026-07-25

1. **Le focus peut être emprunté**, à condition d'être **rendu** et **annoncé** par un
   avertissement visuel préalable visible quel que soit l'état de la fenêtre cible. Une voie
   sans emprunt reste préférable, mais l'emprunt n'est plus éliminatoire.
2. **L'état final d'une ouverture est le panneau webview Claude.** Un terminal est acceptable
   comme état **transitoire**, jamais comme surface d'interaction durable.

L'isolation multi-fenêtres n'est pas touchée par ces amendements : elle reste l'invariant.

## Banc d'essai

Jetable, hors dépôt, sous `<SPIKE>` :

- `ext\` — extension VSCode de spike (`package.json` + `extension.js`, JavaScript simple,
  aucune dépendance npm). Elle expose un RPC par fichiers : les scripts déposent
  `inbox\req-<id>.json`, l'extension répond dans `outbox\res-<id>.json`.
  **Adressage par `extHostPid`** : chaque hôte lit *toutes* les requêtes, journalise ce qu'il a
  vu, et n'exécute que celles qui le désignent. Les acquittements des hôtes non désignés
  constituent la preuve d'isolation.
- `ext2\` — copie de `ext\` sous une **identité d'extension distincte**, nécessaire pour faire
  coexister deux fenêtres (voir « Écueils » n°2).
- `ws-a\`, `ws-same\` — dossiers de workspace dédiés ; `ws-same` est une **jonction** vers `ws-a`.
- `scripts\driver.ps1` — RPC + sondes Win32 (`GetForegroundWindow`, `ShowWindow`,
  `PrintWindow`, `SendInput`, `PostMessage`/`SendMessage`).
- `claude-config\` — bac à sable de configuration CLI (voir « Écueils » n°4).

Lancement type d'une fenêtre de test :

```
code --new-window --disable-workspace-trust ^
     --disable-extension claudemanager.claudemanager-vscode ^
     --extensionDevelopmentPath "<SPIKE>\ext" ^
     --folder-uri "file:///<SPIKE>/ws-a"
```

### Écueils rencontrés, à connaître pour rejouer les mesures

1. **Contamination de l'environnement — l'écueil majeur.** Toute fenêtre VSCode lancée depuis
   une session Claude hérite de 8 variables (`CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION=1`,
   `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, `CLAUDE_AGENT_SDK_VERSION`,
   `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `CLAUDE_CODE_ENABLE_TASKS`). Elles se propagent
   jusqu'aux terminaux de la fenêtre, et un `claude` lancé là se comporte alors en **agent
   enfant non interactif** : il refuse la sauvegarde du transcript
   (`Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`) et se déclare
   non interactif. **Une première mesure de V1 a conclu à tort à l'échec pour cette seule
   raison.** Remède mesuré : passer ces variables à `null` dans
   `createTerminal({env})` — VSCode les **supprime** alors de l'environnement du terminal.
   Vérifié : après suppression, seul `CLAUDE_CODE_SSE_PORT` subsiste (injecté par l'extension
   Claude elle-même, et propre à chaque fenêtre).
2. **`--extensionDevelopmentPath` ne cohabite pas avec lui-même.** Lancer une seconde fenêtre
   avec le **même** chemin d'extension **ferme la première** (observé : hôte 18412 désactivé à
   l'instant du lancement). Pour deux fenêtres simultanées, il faut deux copies de l'extension
   ayant des `name` différents.
3. **VSCode 1.122.1 refuse d'ouvrir un même dossier dans deux fenêtres.** Trois mécanismes
   essayés, tous refusés : `code --new-window --folder-uri` (ouvre une fenêtre **sans
   workspace**), `vscode.openFolder(uri, {forceNewWindow:false})` (route vers la fenêtre
   existante), `workbench.action.duplicateWorkspaceInNewWindow` (sans effet). Le cas
   adverse a donc été construit par **jonction** : `ws-same` pointe physiquement sur `ws-a`.
4. **Le CLI interactif franchit deux portes avant le tour 1** — voir V1, « prérequis ».
5. `terminal.processId` ne se résout **jamais** pour un pty déjà mort. Une boucle de
   traitement qui l'attend se bloque indéfiniment.

## V1 — Terminal transitoire piloté par l'extension compagnon, puis bascule vers le panneau

### Ce qui a été exécuté

```powershell
# 1. fenêtre de test MINIMISÉE (ShowWindow SW_MINIMIZE = 6) — condition de référence
# 2. terminal créé masqué, show() JAMAIS appelé
terminal.create {
  name='SPIKE-A1-V1'; cwd='<SPIKE>\ws-a'; hideFromUser=$true; show=$false
  shellPath='C:\Program Files\PowerShell\7\pwsh.exe'; shellArgs=@('-NoLogo')
  env={ SPIKE_CLAUDE=<claude.exe>; SPIKE_SID=<uuid>; SPIKE_PROMPT=<prompt de sondage>;
        CLAUDE_CONFIG_DIR=<SPIKE>\claude-config;
        CLAUDECODE=null; CLAUDE_CODE_CHILD_SESSION=null; ... (les 8 variables) }
}
# 3. une seule ligne envoyée, aucune frappe clavier système
terminal.send { text = '& $env:SPIKE_CLAUDE --session-id $env:SPIKE_SID $env:SPIKE_PROMPT' }
# 4. attachement
exec { command='claude-vscode.editor.open'; args=[<uuid>] }
# 5. disparition
terminal.dispose { name='SPIKE-A1-V1' }
```

`--session-id <uuid>` **fonctionne en interactif** : l'aide du CLI ne le restreint pas à
`--print` (les options ainsi restreintes le disent explicitement), et le processus observé est
bien `claude.exe --session-id <uuid> "<prompt>"`. Le prompt positionnel est **soumis
automatiquement** au démarrage de la session interactive.

### Ce qui a été observé

**Interactivité du tour 1 — preuve fonctionnelle** (réponse brute, transcript
`<HOME>\.claude\projects\C--...-ws-a\<uuid>.jsonl`) :

```
SPIKE-A1-V1
Oui — je suis une session interactive (Claude Code en CLI, avec un utilisateur présent
qui peut répondre et approuver des actions).
Non — je ne peux pas lancer un flux OAuth MCP moi-même : `/mcp` est une commande CLI
intégrée que seul l'utilisateur peut taper, et l'authentification OAuth exige une
interaction navigateur (consentement, redirection) hors de portée de mes outils.
```

Le motif du refus a changé de nature par rapport à ADR-001 : ce n'est plus « je ne suis pas
interactive », mais « c'est l'utilisateur qui tape `/mcp` » — la réponse normale d'une session
interactive.

**Interactivité du tour 1 — preuve structurelle.** Fichier `<CONFIG>\sessions\<pid>.json` :

```json
{"pid":21448,"sessionId":"<uuid>","cwd":"<SPIKE>\\ws-a","startedAt":...,"version":"2.1.219",
 "peerProtocol":1,"kind":"interactive","entrypoint":"cli","name":"ws-a-99",
 "nameSource":"derived","status":"idle","updatedAt":...,"statusUpdatedAt":...}
```

> **Attention — `kind` n'est pas un discriminant.** Une session `claude -p` purement headless
> porte elle aussi `"kind":"interactive"`. Comparaison faite sur la même machine :
> headless → `{... "kind":"interactive","entrypoint":"claude-vscode", ...}` **sans** `status` ;
> terminal interactif → `"entrypoint":"cli"` **avec** `status`/`updatedAt`/`statusUpdatedAt`.
> Les champs exploitables sont donc **`entrypoint`** et la **présence de `status`**, pas `kind`.
> C'est une information à reporter pour le lot D.

**Attachement réellement effectif** — diff des onglets, fenêtre **minimisée** :

| | avant | après |
|---|---|---|
| onglets | `Welcome` (1) | `Welcome`, `Vérifier les capacités d…` (2) |
| `viewType` du nouvel onglet | — | `mainThreadWebview-claudeVSCodePanel` |

Le libellé de l'onglet est **dérivé du contenu de la conversation** : la preuve que le panneau
a chargé la session et n'est pas un panneau vide (écueil connu : `editor.open` réussit sans
rien attacher quand le `cwd` ne correspond pas). La capture montre le tour 1 complet — prompt
et réponse — et un champ de saisie actif.

**Processus.** Le panneau démarre un **second** `claude.exe`, enfant de l'hôte d'extension
(`--output-format stream-json --input-format stream-json`). Les deux coexistent le temps de la
bascule.

**Disparition du terminal.** `terminal.dispose()` suffit : ni `/exit` ni Ctrl-D. Après
suppression, le `claude` du terminal et le pty sont morts, **le `claude` du panneau survit** et
l'onglet reste intact. L'attachement préalable n'est pas empêché par la suppression ultérieure.

**Focus** — relevés `GetForegroundWindow()` (handle, PID, titre) :

| moment | handle | PID | titre |
|---|---|---|---|
| avant | `0xB9044C` | 16196 | fenêtre de travail de l'utilisateur |
| pendant (`sendText`) | `0xB9044C` | 16196 | *identique* |
| après (`editor.open`) | `0xB9044C` | 16196 | *identique* |

La fenêtre de test est restée **minimisée** du début à la fin (`IsIconic` = `True` à chaque
relevé). `show()` n'a jamais été appelé ; `hideFromUser: true` fait que le terminal
**n'apparaît même pas** dans la liste des terminaux. **Durée de visibilité pour l'humain :
nulle.**

### Prérequis découverts — deux portes avant le tour 1

Ces deux points ne sont pas des défauts de V1 mais des **conditions d'exécution** à vérifier :

1. **Onboarding première utilisation.** Sur une machine où l'humain n'utilise que le panneau,
   le CLI interactif ouvre le sélecteur de thème et **attend**. `theme` est pourtant déjà
   renseigné dans `<HOME>\.claude\settings.json` : la porte est l'onboarding lui-même, pas la
   valeur du thème. Aucune variable d'environnement ne le court-circuite (balayage exhaustif
   des `CLAUDE_*` du binaire : ni `SKIP_ONBOARDING` ni équivalent).
2. **Confiance du dossier.** Le CLI demande ensuite
   `Quick safety check: Is this a project you created or one you trust?`, par répertoire.

Les deux se franchissent par `sendText` (une simple validation), **fenêtre minimisée, sans
focus** — ce qui démontre au passage que le terminal est pilotable de bout en bout sans
interaction humaine. En production elles ne se présentent qu'une fois par machine et par
dossier ; `cmgr doctor` doit les vérifier et le dire.

### Verdict V1

| Critère | Verdict |
|---|---|
| 1. Interactif au tour 1 | ✅ prouvé, deux preuves indépendantes |
| 2. État final = panneau, aucun terminal durable | ✅ terminal jamais visible, supprimé après bascule |
| 3. Autonomie complète | ✅ aucun geste humain (hors prérequis, une fois par machine) |
| 4. Emprunt de focus | ✅ **aucun**, fenêtre minimisée d'un bout à l'autre |
| 5. Isolation | ✅ voir section dédiée |
| 6. Surface d'adhérence | ⚠️ une commande interne (`editor.open`) + `--session-id` + format `sessions/<pid>.json` |

## V2 — Mode terminal officiel de l'extension

### Ce qui a été exécuté

```powershell
config.get { section='claudeCode'; key='useTerminal' }
config.set { section='claudeCode'; key='useTerminal'; value=$true; target='workspace' }
exec { command='claude-vscode.terminal.open'
       args=['<prompt de sondage>', ['--session-id','<uuid>'], 'bottom'] }
```

### Ce qui a été observé

**La commande existe** et sa signature, lue dans le bundle, est
`terminal.open(command?: string, args?: string[], location?: 'bottom'|'window'|'beside')`.
La ligne de commande construite est `<claude> <args...> <command>` — c'est-à-dire que le
premier paramètre est **ajouté en dernier**, ce qui permettrait exactement
`claude --session-id <uuid> "<prompt>"`, la ligne de V1.

**Mais l'appel échoue sur cette machine.** Aucun terminal n'est créé et l'utilisateur voit :

```
Failed to run Claude Code: Error: Could not locate the Claude CLI on P...
```

Le bundle contient le message complet : *« Could not locate the Claude CLI on PATH. Launching by
name in a PowerShell terminal would run a 'claude' from the open folder instead of the installed
CLI, so the launch was blocked. »* L'extension **résout `claude` sur le `PATH`** et refuse de
démarrer sinon. Or le binaire vit dans le bundle de l'extension
(`<HOME>\.vscode\extensions\anthropic.claude-code-2.1.219-win32-x64\resources\native-binary\claude.exe`)
et n'est pas sur le `PATH` de cette machine. V1 n'a pas ce problème : il donne le chemin absolu.

**Autres contraintes lues au source**, qui pèsent même si le `PATH` était corrigé :

- `createTerminal({... isTransient:true, env:{NoDefaultCurrentDirectoryInExePath:'1'}})` —
  **aucun `cwd`** n'est passé : le répertoire de travail n'est pas contrôlable.
- `l.show()` est appelé **inconditionnellement** : le terminal s'affiche, on ne peut pas
  l'empêcher.
- Une notification `« Claude Code launching... »` s'affiche 2 secondes.
- Le terminal s'auto-supprime quand la commande se termine
  (`onDidEndTerminalShellExecution` → `dispose()`).

**Le réglage est modifiable par fenêtre** : `ConfigurationTarget.Workspace` fonctionne
(`workspaceValue: true`) et **ne touche pas la configuration utilisateur**. Effet de bord
mesuré : il écrit `<dossier>\.vscode\settings.json` dans le projet de l'utilisateur.

### Verdict V2

| Critère | Verdict |
|---|---|
| 1. Interactif au tour 1 | ⚠️ non mesurable ici (échec `PATH`) ; la ligne construite est celle de V1 |
| 2. État final = panneau | ❌ termine dans un terminal **visible**, `show()` non contournable |
| 3. Autonomie | ❌ échoue sans `claude` sur le `PATH` — condition hors du contrôle de l'outil |
| 4. Focus | ⚠️ `show()` déplace le focus dans VSCode |
| 5. Isolation | ✅ la commande s'exécute dans la fenêtre appelante |
| 6. Adhérence | ❌ la plus forte : commande + réglage + résolution `PATH` + `.vscode/settings.json` |

## V3 — Pré-remplissage puis soumission par injection clavier

### V3-a — Injection **sans** focus

```powershell
# fenêtre minimisée ; PostMessage ET SendMessage, WM_KEYDOWN/WM_CHAR/WM_KEYUP (VK_RETURN)
# sur la fenêtre de haut niveau ET sur toutes ses fenêtres enfants
```

Énumération des fenêtres enfants de la fenêtre VSCode : **une seule**, de classe
`Intermediate D3D Window`. Aucun `Chrome_RenderWidgetHostHWND` adressable.

**Résultat : aucun effet.** Le prompt pré-rempli n'est pas soumis (nombre de transcripts
inchangé, libellé d'onglet inchangé). Chromium ne consomme pas l'entrée par messages fenêtre :
mesuré, pas supposé.

### V3-b — Emprunt de focus

Séquence : relevé de l'état, `ShowWindow(SW_RESTORE)`, `SetForegroundWindow`, **garde-fou par
comparaison de handle**, `claude-vscode.focus`, `SendInput`, puis restitution
(re-minimisation + `SetForegroundWindow` sur la fenêtre précédente).

**La mécanique de l'emprunt fonctionne** :

| | handle | titre |
|---|---|---|
| avant | `0xB9044C` | fenêtre de travail de l'utilisateur |
| pendant | `0x100418` | fenêtre de test (**garde-fou satisfait**) |
| après | `0xB9044C` | fenêtre de travail — **état rendu à l'identique** |

Durée mesurée : **2611 ms** (variante minimale), **5211 ms** avec captures intermédiaires. La
fenêtre restaurée est bien re-minimisée.

**Mais la soumission n'a pas lieu.** Et la mesure décisive : en injectant le marqueur
`SPIKEA1KBD` alors que la fenêtre est au premier plan et que `claude-vscode.focus` vient d'être
appelé, **aucun caractère n'apparaît dans le champ de saisie**. Les frappes synthétiques
`SendInput` **n'atteignent pas le champ du webview**, ni pour saisir, ni pour valider.

Rendre V3 fiable supposerait de placer le curseur dans le champ, donc de l'**automatisation
souris** positionnelle sur un webview dont la mise en page n'est pas contractuelle. Cela n'a pas
été tenté : hors de l'enveloppe autorisée, et d'une fragilité disqualifiante.

> Les 10 répétitions prévues pour mesurer un taux d'échec n'ont pas été conduites : elles
> auraient chiffré la fiabilité d'un mécanisme dont l'étape utile ne fonctionne pas du tout.
> Le taux d'échec de la soumission est de **100 % (2 essais sur 2)**, avec la cause identifiée.

### Verdict V3

| Critère | Verdict |
|---|---|
| 1. Interactif au tour 1 | ⚠️ le serait par construction — mais le tour 1 n'est jamais soumis |
| 2. État final = panneau | ✅ le panneau est bien la surface |
| 3. Autonomie | ❌ **la soumission n'a jamais lieu** |
| 4. Focus | ❌ emprunt obligatoire (mécanique OK, réversible, ~2,6 s) |
| 5. Isolation | ⚠️ l'injection frappe la fenêtre au premier plan : garde-fou par handle obligatoire |
| 6. Adhérence | ⚠️ `editor.open` + `claude-vscode.focus` + mise en page du webview |

## V4 — Remote Control

### Ce qui a été exécuté

```powershell
terminal.send { text = '& $env:SPIKE_CLAUDE --remote-control' }
```

### Ce qui a été observé

Sortie du terminal :

```
/remote-control is active · Continue here, on your phone, or at
https://claude.ai/code/session_<REDACTED>
```

Le drapeau existe bien (`--remote-control [name]` — *« Start an interactive session with Remote
Control enabled »*). Mais le canal **passe par claude.ai** : réseau, compte, surface cloud. Le
bundle le confirme — le réglage `disableRemoteControl` est décrit comme désactivant *« Remote
Control (claude.ai/code, `claude remote-control`, `--remote-control`/`--rc`, auto-start… ) »*, et
`isolatePeerMachines` comme exigeant *« explicit approval before SendMessage can reach a peer
session on another machine via Remote Control »*.

C'est donc un pont **de session à session, potentiellement inter-machines, médié par le cloud**,
et non une primitive locale pour ouvrir une conversation dans une fenêtre VSCode désignée. La
surface d'interaction obtenue est le terminal ou claude.ai, jamais le panneau webview.

> Effet de bord constaté : l'activation a fait apparaître une bannière
> `Remote Control is active` dans une **autre** session Claude du même compte. L'état est donc
> au moins partiellement **global au compte**, pas local à la session — à retenir.

### Verdict V4

| Critère | Verdict |
|---|---|
| 1. Interactif au tour 1 | ✅ la session est interactive |
| 2. État final = panneau | ❌ terminal ou claude.ai |
| 3. Autonomie | ❌ suppose un appairage hors du poste |
| 4. Focus | ✅ aucun |
| 5. Isolation | ❌ état global au compte, franchit la frontière machine |
| 6. Adhérence | ❌ dépendance réseau + compte + service distant, hors périmètre |

## V5 — Pré-remplissage puis validation humaine (repli)

### Ce qui a été exécuté

```powershell
exec { command='claude-vscode.editor.open'; args=[null, '<prompt de sondage>'] }
```

### Ce qui a été observé

Un panneau `Claude Code` s'ouvre, intitulé `Untitled`, **le prompt intégralement pré-rempli dans
le champ de saisie, non soumis**, la flèche d'envoi en attente. Confirmation empirique de la
lecture du source : `initialPrompt` remplit, ne soumet pas.

Coût pour l'humain : **un geste** (Entrée ou clic sur la flèche), mais surtout un **délai non
borné** — la conversation reste en attente jusqu'à ce qu'il revienne. Ce que l'on perd est
précisément ce que `/orchestrer` vise : l'enchaînement de bout en bout sans passe-plat. Le gain
subsiste néanmoins : l'humain n'a plus ni à créer la conversation, ni à retrouver la fenêtre, ni
à recopier le prompt.

### Verdict V5

| Critère | Verdict |
|---|---|
| 1. Interactif au tour 1 | ✅ la session est interactive dès la soumission |
| 2. État final = panneau | ✅ |
| 3. Autonomie | ❌ un geste humain, délai non borné |
| 4. Focus | ✅ aucun |
| 5. Isolation | ✅ |
| 6. Adhérence | ✅ la plus faible : une seule commande, aucun format de fichier |

## Exigence transverse T — l'avertissement visuel préalable

La décision n°5 conditionne tout emprunt de focus à un avertissement visible **même quand VSCode
est en arrière-plan**. Trois surfaces mesurées.

### T1 — `window.showWarningMessage`

Appelée depuis une fenêtre **minimisée**. La capture plein écran prise 3 secondes après ne
montre **rien** : la notification est rendue à l'intérieur d'une fenêtre invisible.
**Insuffisant**, comme pressenti — c'est désormais mesuré.

### T2 — Fenêtre WPF `Topmost` dans un processus séparé

Prototype `overlay.ps1` : `WindowStyle=None`, `AllowsTransparency`, `Topmost=$true`,
**`ShowActivated=$false`**, `ShowInTaskbar=$false`, décompte piloté par un `DispatcherTimer`.

| Mesure | Résultat |
|---|---|
| Visible par-dessus les autres fenêtres | ✅ (capture) |
| Vol de focus | ✅ **aucun** — handle de premier plan identique avant/pendant |
| Délai d'affichage | ~2,0 s (dominé par le démarrage de `pwsh`) |
| Auto-fermeture | ✅ 0 fenêtre visible à t+8 s pour une consigne de 4 s |
| Dépendance nouvelle | **aucune** — WPF est dans le .NET de Windows |

> **Piège mesuré** : lancer le processus hôte sans `-WindowStyle Hidden` fait voler le focus
> — non par la fenêtre WPF, mais par la **console `pwsh`** qui l'héberge. Avec
> `-WindowStyle Hidden`, le focus ne bouge pas.
>
> Réserve : le processus hôte survit à la fermeture de la fenêtre (il manque un
> `Dispatcher.InvokeShutdown()`), et la visibilité **par-dessus une application plein écran
> exclusif** n'a pas été éprouvée faute d'application de ce type sous la main.

### T3 — Notification système Windows native

`[Windows.UI.Notifications.ToastNotificationManager, ContentType=WindowsRuntime]` **n'est pas
chargeable** depuis PowerShell 7 (`Unable to find type`). Sans `BurntToast` ni dépendance npm,
cette voie exige un pont WinRT — coût disproportionné, et un toast système est de toute façon
discret et écartable.

### Verdict T

**La condition posée par la décision n°5 est tenable**, par la surface T2 : fenêtre `Topmost`
non activante dans un processus séparé, sans aucune dépendance nouvelle, sans vol de focus, avec
auto-fermeture. Prix : un script hôte à maintenir, ~2 s de latence, et un correctif d'une ligne
pour l'arrêt du processus.

**Mais** : si la voie retenue n'emprunte pas le focus, l'exigence T devient **sans objet**.

## Isolation multi-fenêtres

### Configuration adverse construite

VSCode refusant deux fenêtres sur un même dossier (trois mécanismes essayés, cf. Écueils n°3),
le cas a été construit par jonction :

| | fenêtre A | fenêtre B |
|---|---|---|
| `extHostPid` | 17224 | 12608 |
| workspace | `ws-a` | `ws-same` |
| répertoire physique | **le même** (jonction) | **le même** |
| `Code.exe` principal | **16196** | **16196** |

Les deux fenêtres partagent le **même processus principal**. `Get-WindowsOfPid` renvoie
d'ailleurs **la même liste de fenêtres** pour les deux hôtes : la preuve directe qu'un PID ne
discrimine pas une fenêtre — seul l'`extHostPid` le fait.

### Mesure

Deux opérations adressées **exclusivement** à A : `claude-vscode.editor.open(<uuid>)` et
`terminal.create('ISO-A')`.

| | A (17224) | B (12608) |
|---|---|---|
| onglets avant | `Welcome` | `Welcome` |
| onglets après | `Welcome`, `Vérifier les capacités d…`[`…claudeVSCodePanel`] | `Welcome` — **inchangé** |
| terminaux avant | `pwsh`, `pwsh` | *(aucun)* |
| terminaux après | `pwsh`, `pwsh`, **`ISO-A`** | *(aucun)* — **inchangé** |
| `claude.exe` | +1 (12444, enfant de l'hôte A) | aucun |

Acquittements — **les deux hôtes ont vu chaque requête**, seul le destinataire l'a exécutée :

```
requête editor.open    : extHostPid=12608 cible=17224 revendiquée=False
                         extHostPid=17224 cible=17224 revendiquée=True
requête terminal.create: extHostPid=12608 cible=17224 revendiquée=False
                         extHostPid=17224 cible=17224 revendiquée=True
```

**L'isolation par `extHostPid` tient**, y compris quand le dossier physique, le titre et le
processus principal sont communs.

## Tableau comparatif

Critères : **1** interactif au tour 1 · **2** état final = panneau, aucun terminal durable ·
**3** autonomie complète · **4** pas d'emprunt de focus · **5** isolation préservée ·
**6** faible adhérence aux API internes.

| Voie | 1 | 2 | 3 | 4 | 5 | 6 |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| **V1** terminal transitoire → panneau | ✅ | ✅ ⁽ᵃ⁾ | ✅ ⁽ᵇ⁾ | ✅ ⁽ᶜ⁾ | ✅ | ⚠️ ⁽ᵈ⁾ |
| **V2** mode terminal officiel | ⚠️ ⁽ᵉ⁾ | ❌ ⁽ᶠ⁾ | ❌ ⁽ᵍ⁾ | ⚠️ | ✅ | ❌ |
| **V3** pré-remplissage + injection clavier | ⚠️ | ✅ | ❌ ⁽ʰ⁾ | ❌ ⁽ⁱ⁾ | ⚠️ ⁽ʲ⁾ | ⚠️ |
| **V4** Remote Control | ✅ | ❌ | ❌ | ✅ | ❌ ⁽ᵏ⁾ | ❌ |
| **V5** pré-remplissage + validation humaine | ✅ | ✅ | ❌ ⁽ˡ⁾ | ✅ | ✅ | ✅ |

⁽ᵃ⁾ `hideFromUser:true` et `show()` jamais appelé : durée de visibilité **nulle**, aucune trace.
⁽ᵇ⁾ Sous réserve des deux prérequis (onboarding, confiance du dossier), une fois par machine et par dossier.
⁽ᶜ⁾ Vérifié fenêtre **minimisée**, handle de premier plan identique avant/pendant/après.
⁽ᵈ⁾ `claude-vscode.editor.open` + `--session-id` + format `sessions/<pid>.json` + suppression des variables héritées.
⁽ᵉ⁾ Non mesurable sur cette machine : échec avant tout démarrage. La ligne construite est celle de V1.
⁽ᶠ⁾ `l.show()` inconditionnel dans le source, non contournable.
⁽ᵍ⁾ Exige `claude` sur le `PATH` système, condition hors du contrôle de l'outil.
⁽ʰ⁾ La soumission n'a **jamais** lieu : les frappes synthétiques n'atteignent pas le webview.
⁽ⁱ⁾ Emprunt mécaniquement fiable et réversible (~2,6 s), mais inutile puisque sans effet.
⁽ʲ⁾ L'injection frappe la fenêtre au premier plan : sûre uniquement avec garde-fou par handle.
⁽ᵏ⁾ État au moins partiellement global au compte, franchit la frontière machine.
⁽ˡ⁾ Un geste humain, délai non borné.

## Surface d'adhérence, voie par voie

Matériau destiné à `docs/compatibilite.md` (mise à jour hors de cet incrément).

**V1**
- Commande interne `claude-vscode.editor.open(sessionId, initialPrompt?, viewColumn?)` — vérifiée sur 2.1.219. Absence détectable par `vscode.commands.getCommands(true)`.
- Drapeau CLI `--session-id <uuid>` en mode interactif — vérifié sur 2.1.219.
- Onglet reconnu par `viewType` contenant `claudeVSCodePanel` (observé : `mainThreadWebview-claudeVSCodePanel`).
- Format `<CONFIG>\sessions\<pid>.json`, champs `entrypoint`, `status`, `sessionId`, `cwd`. **`kind` inutilisable comme discriminant.**
- Emplacement du binaire dans le bundle de l'extension (chemin versionné : change à chaque mise à jour).
- Variables d'environnement héritées à neutraliser (les 8 listées).
- API VSCode publiques (non adhérentes) : `createTerminal`, `sendText`, `dispose`, `tabGroups`.

**V2** — tout V1, plus : commande `claude-vscode.terminal.open(command, args[], location)` et sa convention d'ordre des arguments ; réglage `claudeCode.useTerminal` ; résolution de `claude` sur le `PATH` ; écriture de `.vscode/settings.json`.

**V3** — `claude-vscode.editor.open`, `claude-vscode.focus`, **et la mise en page interne du webview** (la plus fragile : rien ne la rend contractuelle).

**V4** — CLI `--remote-control`, service `claude.ai/code`, réglages `disableRemoteControl` / `remoteControlAtStartup` / `isolatePeerMachines`.

**V5** — `claude-vscode.editor.open` seule. Aucun format de fichier, aucun réglage.

## Recommandation

**V1**, avec **V5 comme repli documenté**.

V1 est la seule voie mesurée qui satisfait les deux critères éliminatoires *et* l'autonomie
complète : le tour 1 est interactif (deux preuves indépendantes), l'état final est le panneau
webview, aucun terminal n'est jamais visible, aucun geste humain n'est requis, et — bénéfice
non exigé mais acquis — **aucun focus n'est emprunté**, fenêtre minimisée comprise. L'exigence
transverse T devient alors sans objet, ce qui retire du périmètre le prototype d'avertissement
et sa maintenance.

**Risques portés par V1**

1. **Adhérence** : `editor.open` et `--session-id` peuvent disparaître à toute mise à jour. Le
   principe fondateur n°3 s'applique — échouer explicitement, déclarer la dépendance, la
   vérifier dans `cmgr doctor`.
2. **Deux processus sur une même session** pendant la bascule. Non problématique dans la mesure,
   mais la fenêtre temporelle mérite d'être resserrée et surveillée.
3. **Prérequis machine** (onboarding CLI, confiance du dossier) : franchissables par `sendText`,
   mais c'est une porte de plus, et son libellé n'est pas contractuel. `cmgr doctor` doit la
   vérifier plutôt que de la franchir à l'aveugle.
4. **Contamination de l'environnement** : oubli de neutraliser les variables héritées ⇒ session
   silencieusement non interactive. C'est le piège qui a fait conclure à tort à l'échec de V1
   lors de la première mesure ; il doit être couvert par un test de non-régression.

**Coût d'implémentation estimé (lot C)** : l'extension compagnon existe déjà en substance ;
il s'agit d'y ajouter la création de terminal assainie, l'appel `editor.open` et la suppression
du terminal, puis de piloter l'enchaînement. L'essentiel de l'effort est ailleurs : le
`doctor`, la détection d'absence des commandes, et les tests E2E multi-fenêtres.

## Décision

**À TRANCHER par le propriétaire du projet au vu des mesures ci-dessus.**

## Options écartées, et le motif prouvé de leur écartement

- **Mécanisme d'ADR-001 (amorçage headless `claude -p` puis attachement)** — écarté : le tour 1
  n'est pas interactif ; rejeté en recette le 2026-07-25.
- **V2, mode terminal officiel** — écarté : `l.show()` inconditionnel dans le source, donc
  terminal nécessairement visible (critère 2) ; et échec systématique sur cette machine faute de
  `claude` sur le `PATH`, message d'erreur à l'appui.
- **V3, injection clavier** — écarté : sans focus, Chromium n'expose aucune fenêtre enfant
  adressable et les messages fenêtre restent sans effet ; avec focus, le marqueur `SPIKEA1KBD`
  **n'atteint même pas le champ de saisie**. La soumission n'a jamais eu lieu.
- **V4, Remote Control** — écarté : passe par `claude.ai/code` (réseau, compte, machine tierce),
  état au moins partiellement global au compte, et surface finale terminal/cloud plutôt que
  panneau.
- **Automatisation souris positionnelle sur le webview** — non tentée : hors de l'enveloppe
  autorisée, et fragilité disqualifiante (mise en page non contractuelle).
- **`initialPrompt` comme moyen de soumission** — écarté par preuve au source *et* par mesure :
  il remplit le champ, rien de plus.

## Comment rejouer ces mesures

1. Reconstituer `<SPIKE>` (structure ci-dessus) ; l'extension de spike tient en deux fichiers.
2. Lancer la fenêtre de test avec `--disable-workspace-trust` (sans quoi les commandes
   `claude-vscode.*` **n'existent pas**, sans le moindre message l'expliquant) et
   `--disable-extension claudemanager.claudemanager-vscode`.
3. **Neutraliser les 8 variables héritées** dans `createTerminal({env})` — sans quoi toute
   mesure d'interactivité est faussée.
4. Utiliser le prompt de sondage à trois questions et joindre la réponse brute.
5. Ne jamais conclure à l'attachement sur l'absence d'erreur : diffuser les onglets avant/après
   et vérifier le `viewType` **et** le libellé.
