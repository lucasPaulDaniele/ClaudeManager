/**
 * LE PLAN D'OUVERTURE — tout ce que le mecanisme V1 decide SANS editeur.
 *
 * AUCUN IMPORT DE `vscode`, AUCUNE E/S, et c'est la raison d'etre du module : la carte
 * d'environnement du terminal, la ligne envoyee au shell, la resolution des executables et
 * la reconnaissance d'un onglet de conversation sont des decisions PURES. Les laisser dans
 * le module qui parle a l'editeur les rendrait inverifiables autrement qu'en lancant un
 * VSCode complet — c'est exactement le decoupage qui a rendu `publication.ts` et
 * `diagnostics.ts` mesurables au lot B, et il est repris tel quel.
 *
 * Ce qui reste ailleurs : l'ORCHESTRATION (`conversations.ts`) et le contact avec l'editeur
 * (`extension.ts`).
 */

import path from 'node:path';

/** Identifiant de l'extension Claude Code — `docs/compatibilite.md`, D1. */
export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

/** La commande qui attache un panneau a une session — D1, D18. */
export const CLAUDE_OPEN_COMMAND = 'claude-vscode.editor.open';

/**
 * Le `viewType` d'un onglet de conversation Claude — D2.
 *
 * RECONNU PAR « CONTIENT », JAMAIS PAR EGALITE, et ce n'est plus une intuition : VSCode
 * PREFIXE le viewType d'une webview (`mainThreadWebview-…`, mesure au lot B,
 * `tests/integration/src/scenarios/nominal.ts`). Une comparaison par egalite ne
 * reconnaitrait donc JAMAIS le panneau Claude.
 */
export const CLAUDE_PANEL_VIEW_TYPE = 'claudeVSCodePanel';

/**
 * Familles de variables qu'une session Claude propage a tout ce qu'elle lance.
 *
 * PAR FAMILLE DE PREFIXES, JAMAIS PAR LISTE NOMMEE — c'est mesure : le poste de reference en
 * portait 19 le 2026-07-25 et 21 le 2026-07-26
 * (`tests/fixtures/environment/claude-session-env-names.json`). Une liste nommee aurait
 * laisse passer les deux nouvelles sans que rien ne le signale, et il suffit d'UNE variable
 * oubliee pour que le tour 1 cesse d'etre interactif.
 *
 * CE QUE LEUR PRESENCE PROVOQUE, ET POURQUOI C'EST LE PIEGE MAJEUR DU CHANTIER : un `claude`
 * qui en herite se declare AGENT ENFANT NON INTERACTIF et coupe la sauvegarde de son
 * transcript — sans lever la moindre erreur. La session parait demarrer normalement, et le
 * lot D n'a rien a lire. ClaudeManager etant pilote PAR une session Claude, c'est sa
 * configuration de PRODUCTION, pas un cas limite.
 *
 * Le motif est identique a celui du harnais d'integration
 * (`tests/integration/src/environment.ts`), qui assainit le processus AVANT de lancer un
 * VSCode. Les deux couvrent la meme famille pour la meme raison, a deux etages differents,
 * et un test unitaire confronte les deux a la MEME fixture capturee.
 */
export const INHERITED_CLAUDE_ENVIRONMENT = /^(CLAUDECODE|CLAUDE_|VSCODE_|ELECTRON_|CHROME_)/;

/**
 * Construit la carte d'environnement du terminal masque : chaque nom herite, mappe a `null`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * `null`, ET RIEN D'AUTRE. Les trois formes voisines ont ete mesurees le 2026-07-26, et
 * DEUX D'ENTRE ELLES NE FONT PAS CE QU'ELLES ONT L'AIR DE FAIRE (ADR-004) :
 *
 *   `env: { X: null }`       → la variable est SUPPRIMEE de l'environnement du terminal ✅
 *   `env: { X: undefined }`  → la variable est INTACTE. `TerminalOptions.env` accepte
 *                              `undefined` dans son type : la forme COMPILE, passe le
 *                              typecheck, se relit tres bien — et n'agit pas.
 *   `env: { X: '' }`         → la variable est PRESENTE ET VIDE. Or le CLI teste la
 *                              PRESENCE : l'assainissement serait sans effet tout en ayant
 *                              l'air d'avoir eu lieu.
 *   `strictEnv: true`        → supprime bien, mais fait perdre `TERM_PROGRAM`, `COLORTERM`,
 *                              `LANG`, `GIT_ASKPASS` et l'integration shell (79 cles contre
 *                              89). Le plus mauvais des choix, et c'est mesure.
 *
 * Deux tests unitaires gardent ce point, un par forme fautive : une intention en commentaire
 * n'aurait rien empeche.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * CE QUE CETTE ENUMERATION NE PEUT PAS ATTEINDRE, ET C'EST DIT PLUTOT QUE TU : elle part de
 * `process.env` de l'extension host. Or l'environnement du TERMINAL n'est pas celui de
 * l'extension host — VSCode y injecte des variables absentes d'ici (`VSCODE_GIT_ASKPASS_*`,
 * `VSCODE_INJECTION`, `TERM_PROGRAM`, `COLORTERM`), et l'extension Claude y injecte
 * `CLAUDE_CODE_SSE_PORT` par `EnvironmentVariableCollection`. Aucune enumeration batie sur
 * `process.env` ne peut les voir, donc les neutraliser.
 *
 * `CLAUDE_CODE_SSE_PORT` EST GARDEE, ET C'EST UNE DECISION, PAS UN OUBLI. Elle n'est pas
 * heritee de la session APPELANTE : elle est injectee par l'extension Claude de CETTE
 * fenetre, et designe CETTE fenetre — c'est le canal d'integration IDE normal. La supprimer
 * reviendrait a couper le terminal de sa propre fenetre, soit l'inverse de l'invariant
 * d'isolation. Il faudrait de surcroit la nommer une par une, c'est-a-dire revenir a la liste
 * nommee que la famille remplace. Le releve de ce que le terminal recoit reellement fait
 * partie de la preuve d'execution.
 *
 * L'affirmation juste, celle que les tests portent, est donc : « aucun `CLAUDE*` HERITE DE LA
 * SESSION APPELANTE », jamais « aucun `VSCODE_*` ».
 */
export function neutralizedTerminalEnvironment(
  env: NodeJS.ProcessEnv
): Readonly<Record<string, null>> {
  const map: Record<string, null> = {};
  for (const name of Object.keys(env)) {
    if (INHERITED_CLAUDE_ENVIRONMENT.test(name)) map[name] = null;
  }
  return map;
}

/**
 * Cite une valeur en litteral SIMPLE de PowerShell.
 *
 * Un litteral entre apostrophes n'interprete RIEN — ni `$`, ni backtick, ni `$(...)`. La
 * seule sequence a traiter est l'apostrophe elle-meme, doublee. C'est ce qui rend sur d'y
 * mettre un chemin : le repertoire personnel d'un compte peut parfaitement porter une
 * apostrophe, et sans ce doublement la ligne se refermerait au milieu du chemin — le reste
 * du chemin devenant du CODE.
 */
export function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface SeedCommandLineDraft {
  /** Chemin absolu du binaire `claude` resolu. */
  readonly claudeBinary: string;
  readonly sessionId: string;
  /** Fichier transitoire portant le prompt, ecrit par l'extension juste avant. */
  readonly promptFile: string;
}

/**
 * Construit LA SEULE LIGNE envoyee au shell — forme L2, mesuree (ADR-004).
 *
 * ```
 * $p = [IO.File]::ReadAllText('<fichier>'); Remove-Item -LiteralPath '<fichier>' -Force;
 * if ($p) { & '<claude>' --session-id <uuid> $p }
 * ```
 *
 * POURQUOI L2 PLUTOT QUE LE PROMPT ECRIT DANS LA LIGNE (L1), ET CE N'EST PAS LA TAILLE : les
 * deux ont EXACTEMENT le meme plafond, celui de `CreateProcess` — mesure, elles echouent aux
 * memes tailles avec des lignes de 32 744 et 236 caracteres. Le departageur est
 * l'ECHAPPEMENT : sur un contenu hostile realiste (sauts de ligne, `"` et `'`, backticks,
 * `$(Get-Date)`, `$env:PATH`, tubes, `;`, `&`, non-ASCII, bloc de code), L2 transporte le
 * contenu INTACT (SHA-256 identique) quand L1 sans echappement ECHOUE purement et simplement.
 * Dans L2, le contenu ne traverse JAMAIS l'analyseur du shell : il est lu en DONNEE.
 *
 * POURQUOI PAS LA VARIABLE D'ENVIRONNEMENT DE L'ADR-002 : parce que c'est L2 qui a ete
 * mesuree jusqu'au plafond et sur contenu hostile. Faire transiter 25 Ko par
 * `TerminalOptions.env` n'est mesure nulle part, et on n'implemente pas une forme non
 * mesuree quand on en a une mesuree.
 *
 * LA SUPPRESSION APPARTIENT A LA MEME LIGNE, et avant que `claude` ne demarre : c'est ce qui
 * borne la duree de vie du prompt sur le disque a la milliseconde. L'extension garde
 * neanmoins un filet, pour le cas ou la ligne n'aurait jamais pu s'executer.
 *
 * LA GARDE `if ($p)` N'EST PAS COSMETIQUE. Une exception de `ReadAllText` termine la
 * STATEMENT, pas la ligne : sans elle, `claude` demarrerait avec un argument absent, donc
 * une session interactive SANS TOUR 1. Le panneau s'attacherait, la route rendrait un
 * succes, et la conversation serait vide — une degradation silencieuse, exactement ce que le
 * principe fondateur n.3 interdit. Avec la garde, rien ne demarre, l'attachement n'aboutit
 * pas, et l'appelant recoit une erreur nommee.
 *
 * `&` — l'operateur d'appel — parce que le chemin du binaire est cite : sans lui, PowerShell
 * lirait la chaine comme une donnee et se contenterait de l'afficher.
 */
export function buildSeedCommandLine(draft: SeedCommandLineDraft): string {
  const file = quotePowerShellLiteral(draft.promptFile);
  return (
    `$p = [IO.File]::ReadAllText(${file}); ` +
    `Remove-Item -LiteralPath ${file} -Force; ` +
    `if ($p) { & ${quotePowerShellLiteral(draft.claudeBinary)} --session-id ${draft.sessionId} $p }`
  );
}

/**
 * Les arguments qui precedent le prompt sur la ligne REELLE — ceux que la garde de plafond
 * doit compter.
 *
 * C'est `CreateProcess` qui plafonne, pas le shell : la ligne pesee est donc celle du
 * PROCESSUS FILS (`claude.exe --session-id <uuid> <prompt>`), jamais celle envoyee au pty.
 */
export function seedLeadingArguments(sessionId: string): readonly string[] {
  return ['--session-id', sessionId];
}

export interface ExecutableSearch {
  /** Chemins complets essayes en premier, dans l'ordre — le bundle de l'extension. */
  readonly preferred: readonly string[];
  /** Noms a chercher sur le `PATH`, dans l'ordre. */
  readonly names: readonly string[];
  /** Le `PATH` de la fenetre, deja decoupe par l'appelant. */
  readonly pathEntries: readonly string[];
  /** Sonde d'existence — injectee, ce qui garde ce module sans E/S. */
  readonly exists: (candidate: string) => boolean;
}

/**
 * Resout un executable EXPLICITEMENT, et dit d'ou il vient.
 *
 * NE JAMAIS SUPPOSER LE `PATH` : sur le poste de reference, `claude` n'y est pas dans tous
 * les shells (constate). Le bundle de l'extension est donc essaye d'abord — son chemin
 * porte le NUMERO DE VERSION et change a chaque mise a jour, il est donc derive du
 * repertoire que VSCode rend pour l'extension resolue, jamais code en dur (D16).
 *
 * Rend `undefined` plutot que de lever : c'est l'appelant qui sait quelle erreur nommee
 * correspond a l'executable manquant — le binaire `claude` et le shell n'ont ni la meme
 * remediation ni la meme consequence.
 */
export function resolveExecutable(search: ExecutableSearch): string | undefined {
  for (const candidate of search.preferred) {
    if (search.exists(candidate)) return candidate;
  }
  for (const entry of search.pathEntries) {
    // Une entree vide de `PATH` designerait le repertoire courant : jamais.
    if (entry.length === 0) continue;
    for (const name of search.names) {
      const candidate = path.join(entry, name);
      if (search.exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Decoupe un `PATH` selon la convention de la plateforme.
 *
 * `path.delimiter` plutot qu'un separateur code en dur : `;` sous Windows, `:` ailleurs.
 * Les guillemets qu'un `PATH` Windows peut porter autour d'une entree sont retires — ils
 * font partie de la syntaxe de la variable, pas du chemin.
 */
export function splitPathVariable(value: string | undefined): readonly string[] {
  if (value === undefined || value.length === 0) return [];
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0);
}

/** Le nom du binaire `claude` selon la plateforme, dans l'ordre d'essai. */
export function claudeBinaryNames(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
}

/** Le nom de `pwsh` selon la plateforme, dans l'ordre d'essai. */
export function shellNames(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32' ? ['pwsh.exe'] : ['pwsh'];
}

/**
 * Ou chercher le binaire `claude` dans le bundle de l'extension Claude — D16.
 *
 * `node:path` de bout en bout : jamais de separateur code en dur. Le repertoire de
 * l'extension est RENDU par l'editeur, jamais reconstruit — il porte la version.
 */
export function bundledClaudeCandidates(
  extensionPath: string,
  platform: NodeJS.Platform
): readonly string[] {
  return claudeBinaryNames(platform).map((name) =>
    path.join(extensionPath, 'resources', 'native-binary', name)
  );
}

/** Un onglet, reduit a ce que la reconnaissance demande. */
export interface PanelTabLike {
  readonly viewType: string | undefined;
  readonly label: string;
}

/** Reconnait un onglet de conversation Claude — par « contient », voir `CLAUDE_PANEL_VIEW_TYPE`. */
export function isClaudePanel(tab: PanelTabLike): boolean {
  return tab.viewType !== undefined && tab.viewType.includes(CLAUDE_PANEL_VIEW_TYPE);
}

/**
 * Cle d'un onglet pour le diff. `\u0000` : aucun libelle ne le contient, la concatenation
 * ne peut donc pas confondre deux onglets par un decoupage malheureux.
 */
function tabKey(tab: PanelTabLike): string {
  // Appelee UNIQUEMENT sur un onglet deja reconnu Claude, dont le `viewType` est donc
  // defini. Aucun repli n est ecrit ici : un repli inatteignable laisse croire qu un cas
  // a ete prevu, et ne se verifie jamais.
  return `${tab.viewType}\u0000${tab.label}`;
}

/**
 * L'onglet de conversation APPARU depuis le releve precedent — la preuve d'attachement.
 *
 * L'ABSENCE D'ERREUR NE PROUVE JAMAIS L'ATTACHEMENT : `editor.open` REUSSIT en ouvrant un
 * panneau VIDE quand le `cwd` de la session ne correspond pas au workspace de la fenetre
 * (D10). Seul un onglet APPARU vaut preuve, d'ou le diff.
 *
 * PAR MULTI-ENSEMBLE DE CLES, ET NON PAR IDENTITE D'OBJET : rien ne documente que
 * `tabGroups.all` rende les MEMES instances d'un releve a l'autre, et notre adaptateur
 * reconstruit de toute facon ses enveloppes a chaque appel. Une comparaison d'identite
 * declarerait alors « nouveau » un onglet present depuis le debut.
 *
 * PAR MULTI-ENSEMBLE, ET NON PAR SIMPLE COMPTAGE : une fenetre peut rouvrir automatiquement
 * un panneau Claude a son lancement (`docs/compatibilite.md`), et rien ne dit que le premier
 * onglet trouve est celui qu'on vient d'attacher. Le decompte par cle designe le panneau
 * NEUF meme au milieu d'autres, et resiste au cas ou l'un se ferme pendant qu'un autre
 * s'ouvre — que le comptage seul manquerait.
 */
export function selectNewPanel<T extends PanelTabLike>(
  before: readonly PanelTabLike[],
  after: readonly T[]
): T | undefined {
  const seen = new Map<string, number>();
  for (const tab of before) {
    if (!isClaudePanel(tab)) continue;
    const key = tabKey(tab);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  for (const tab of after) {
    if (!isClaudePanel(tab)) continue;
    const key = tabKey(tab);
    const remaining = seen.get(key) ?? 0;
    // Deja compte avant : cet onglet-la n'est pas neuf, mais un homonyme peut l'etre.
    if (remaining > 0) {
      seen.set(key, remaining - 1);
      continue;
    }
    return tab;
  }
  return undefined;
}
