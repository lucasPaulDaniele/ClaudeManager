/**
 * LE MECANISME V1 — ouvrir une conversation Claude interactive dans CETTE fenetre.
 *
 * Arbitre a l'ADR-002 le 2026-07-25, complete par l'ADR-004 pour le transport du prompt.
 * Dans l'ordre, et L'ORDRE FAIT PARTIE DU MECANISME :
 *
 *   1. refus precoce — fenetre non approuvee, ou sans dossier de travail ;
 *   2. disponibilite de la commande d'attachement — c'est ICI, et nulle part ailleurs, que
 *      le repli V5 se decide ;
 *   3. `uuid` ;
 *   4. terminal MASQUE (`hideFromUser: true`, `show()` JAMAIS appele), `cwd` = un dossier de
 *      travail de CETTE fenetre, environnement herite NEUTRALISE ;
 *   5. une seule ligne, envoyee par `sendText` — forme L2 (ADR-004) ;
 *   6. attachement par `claude-vscode.editor.open(<uuid>)`, prouve par DIFF DES ONGLETS ;
 *   7. `terminal.dispose()` — le `claude` du panneau survit, l'onglet reste intact ;
 *   8. repli V5, uniquement depuis les etapes qui precedent la creation du terminal.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * AUCUN IMPORT DE `vscode`, et c'est ce qui rend l'ORDRE ci-dessus verifiable sans editeur.
 * L'editeur est atteint par un PORT (`EditorPort`) que `extension.ts` — seul point de contact
 * du paquet avec l'API — implemente en quelques lignes sans decision.
 *
 * CE QUE CE PORT EST, ET CE QU'IL N'EST PAS (principe fondateur n.5, « pas de mocks du
 * systeme reel »). Il est une couture d'ORDRE : ce que les tests unitaires eprouvent a
 * travers lui, c'est la SEQUENCE et les REFUS — « le repli ne part jamais une fois le terminal
 * cree », « l'erreur nommee precede le repli », « le terminal est supprime sur tous les
 * chemins ». Aucune de ces proprietes ne s'observe dans une fenetre reelle sans provoquer des
 * pannes qu'on ne sait pas provoquer. Il n'est PAS une simulation du comportement de VSCode :
 * que `editor.open` attache reellement une session, que `hideFromUser` cache reellement le
 * terminal, que `dispose` laisse reellement survivre le panneau — cela n'est prouve QUE par
 * `npm run test:integration`, dans une vraie fenetre, avec la vraie extension Claude.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertCommandLineFits,
  ClaudeManagerError,
  ERROR_CODES,
  isClaudeManagerError,
  readProcessTable,
  systemErrorCode,
  type ProcessSnapshot,
  type SerializedError,
} from './core.js';
import { describe } from './diagnostics.js';
import type { WorkspaceState } from './publication.js';
import {
  bundledClaudeCandidates,
  buildSeedCommandLine,
  claudeBinaryNames,
  CLAUDE_EXTENSION_ID,
  CLAUDE_OPEN_COMMAND,
  neutralizedTerminalEnvironment,
  resolveExecutable,
  seedLeadingArguments,
  selectNewPanel,
  shellNames,
  splitPathVariable,
  type PanelTabLike,
} from './seed.js';

/** L'extension Claude Code, vue par le mecanisme. */
export interface ClaudeExtensionHandle {
  readonly isActive: boolean;
  /** Repertoire d'installation — il porte la VERSION, il n'est jamais reconstruit (D16). */
  readonly extensionPath: string;
  activate(): Promise<void>;
}

/** Ce qu'on demande a l'editeur pour creer le terminal transitoire. */
export interface HiddenTerminalSpec {
  readonly name: string;
  readonly cwd: string;
  readonly shellPath: string;
  readonly shellArgs: readonly string[];
  /**
   * Noms herites, chacun mappe a `null` — JAMAIS `undefined`, JAMAIS `''`, JAMAIS
   * `strictEnv`. Le type dit `null` et rien d'autre : c'est la garde de typage du piege
   * mesure a l'ADR-004.
   */
  readonly env: Readonly<Record<string, null>>;
}

export interface HiddenTerminal {
  sendText(line: string): void;
  dispose(): void;
  /**
   * Pid du SHELL du terminal, quand l'editeur l'a resolu.
   *
   * C'est l'ancre de l'observation du tour 1 : le `claude` amorce est un ENFANT de ce shell.
   * Ecueil connu (ADR-002) : il ne se resout JAMAIS pour un pty deja mort — l'attendre sans
   * borne bloquerait indefiniment.
   */
  processId(): Promise<number | undefined>;
}

/**
 * LE SEUL CONTACT AVEC L'EDITEUR, et il est declare ici plutot qu'importe.
 *
 * `show()` n'y figure pas, et c'est deliberе : le mecanisme ne doit pas POUVOIR reveler un
 * terminal. Un principe qu'aucun type ne porte est un principe qu'on finit par enfreindre.
 */
export interface EditorPort {
  readWorkspace(): WorkspaceState;
  getClaudeExtension(): ClaudeExtensionHandle | undefined;
  listCommands(): Promise<readonly string[]>;
  executeCommand(command: string, ...args: readonly unknown[]): Promise<unknown>;
  createHiddenTerminal(spec: HiddenTerminalSpec): HiddenTerminal;
  listPanelTabs(): readonly PanelTabLike[];
}

/**
 * ECHELLE D'ATTENTE DE L'ATTACHEMENT — bornee, croissante, en millisecondes.
 *
 * L'attachement N'EST PAS INSTANTANE : la session doit d'abord exister cote CLI, ce qui
 * suppose le demarrage d'un processus Node complet. `editor.open` est donc RE-EMISE a chaque
 * echelon, et les onglets sont sondes pendant tout l'echelon.
 *
 * Total : 62 s. Borne, et c'est le point — les DEUX PORTES du CLI (onboarding, « Quick safety
 * check » du dossier) bloquent INDEFINIMENT quand elles se presentent. Sans borne, la route
 * pendrait pour toujours ; avec elle, l'appelant recoit une erreur nommee. Le mecanisme ne
 * tente JAMAIS de franchir ces portes : leur libelle n'est pas contractuel, et c'est
 * `cmgr doctor` (lot D) qui doit les verifier et les nommer.
 */
const ATTACH_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 32_000];

/** Granularite du sondage des onglets pendant un echelon. */
const TAB_POLL_INTERVAL_MS = 250;

/**
 * ATTENTE DU PROCESSUS AMORCE — combien de fois on interroge la table des processus.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * POURQUOI CETTE ETAPE EXISTE, ET ELLE N'EST PAS UNE PRECAUTION : elle corrige un defaut
 * MESURE le 2026-07-26, dans une vraie fenetre.
 *
 * L'attachement ne peut PAS servir d'horloge. Falsification jouee : `editor.open` appelee
 * avec un identifiant de session JAMAIS AMORCE ouvre un panneau tout de meme
 * (`ghostSessionOpensAPanel: true`). Le diff d'onglets aboutissait donc en moins de 200 ms —
 * avant meme que `claude` n'ait fini de demarrer —, et `terminal.dispose()` suivait aussitot.
 * Or la suppression du terminal TUE le `claude` du tour 1 (ADR-002) : le tour etait interrompu
 * a la naissance, et la route rendait un succes. Une degradation silencieuse, exactement ce
 * que le principe fondateur n.3 interdit.
 *
 * L'attente porte donc sur un FAIT OBSERVE — le shell a engendre un processus — et non sur
 * une duree devinee. C'est aussi ce qui donne enfin un signal aux DEUX PORTES du CLI :
 * quand l'une d'elles attend, aucun processus n'est engendre, et l'appelant recoit
 * `SEED_PROCESS_NOT_STARTED` plutot qu'un faux succes.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Chaque interrogation coute de 700 ms a 1,3 s (`Get-CimInstance`) : huit tentatives bornent
 * l'attente autour d'une dizaine de secondes, sans qu'aucun nombre ne soit invente.
 */
const SEED_PROCESS_ATTEMPTS = 8;

/**
 * Age au-dela duquel un fichier de prompt abandonne est efface au passage.
 *
 * RATTRAPAGE DE L'EXISTANT (principe fondateur n.7) : la ligne envoyee au shell efface le
 * fichier elle-meme, et l'extension a un filet en `finally`. Reste le cas ou l'extension host
 * MEURT entre l'ecriture et l'envoi — aucun des deux ne joue alors, et un prompt reste sur
 * le disque indefiniment. Une heure : bien au-dela des 62 s d'un cycle d'ouverture, donc
 * jamais le fichier d'une ouverture en cours, y compris celle d'une autre fenetre.
 */
const ABANDONED_PROMPT_MAX_AGE_MS = 3_600_000;

/** Droits du repertoire de transit et du fichier de prompt — meme discipline que le registre. */
const PROMPT_DIR_MODE = 0o700;
const PROMPT_FILE_MODE = 0o600;

export interface OpenConversationRequest {
  readonly prompt: string;
}

/**
 * QUEL CHEMIN A ETE PRIS — et rien de plus.
 *
 * `'seeded'` A REMPLACE `'nominal'`, ET CE N'EST PAS COSMETIQUE. « Nominal » se lit
 * naturellement « tout s'est bien passe », c'est-a-dire « la conversation est ouverte et le
 * tour 1 est joue ». Or c'est FAUX : ce que ce mode etablit est qu'une session a ete AMORCEE
 * et qu'un panneau s'est attache — jamais que le tour ait ete joue (voir `firstTurnVerified`).
 * Un nom qui laisse croire davantage que ce qui est mesure est une degradation silencieuse a
 * lui tout seul.
 */
export type OpenMode = 'seeded' | 'fallback';

/**
 * CE QUE L'OUVERTURE A REELLEMENT ETABLI DU TOUR 1.
 *
 * `'process-started'` — un vrai processus a ete engendre par le shell d'amorcage, constate
 * dans la table des processus. **Cela ne dit RIEN de ce qu'il fait**, et ce n'est pas une
 * precaution de style : MESURE le 2026-07-26, un `claude` lance avec la ligne EXACTE attendue
 * — binaire du bundle, `--session-id`, prompt intact — reste bloque 87 secondes dans
 * `showSetupScreens()`, l'ecran d'accueil du CLI, sans jamais ecrire une ligne de transcript.
 * L'identite du processus ne discrimine donc PAS un CLI qui joue le tour d'un CLI arrete a
 * une porte : les deux sont `claude.exe`, avec la meme ligne de commande.
 *
 * `'not-attempted'` — repli V5 : aucune session n'a ete amorcee, il n'y a pas de tour.
 */
export type FirstTurnOutcome = 'process-started' | 'not-attempted';

export interface OpenConversationResult {
  readonly ok: true;
  readonly mode: OpenMode;
  /** `null` en repli : aucune session n'a ete amorcee, l'humain valide un champ pre-rempli. */
  readonly sessionId: string | null;
  readonly extHostPid: number;
  /**
   * Vrai en repli SEULEMENT, et l'enonce est etroit a dessein : le prompt est pre-rempli dans
   * le champ de saisie et attend une validation humaine. Ce champ ne dit RIEN de l'etat du
   * tour 1 dans la voie amorcee — c'est `firstTurnVerified` qui le porte.
   */
  readonly humanActionRequired: boolean;
  /** Ce que l'ouverture a etabli du tour 1 — jamais plus que ce qui a ete observe. */
  readonly firstTurn: FirstTurnOutcome;
  /**
   * LE TOUR 1 A-T-IL ETE JOUE ? **TOUJOURS `false`, ET C'EST STRUCTUREL.**
   *
   * Le savoir suppose de lire le transcript (`<CONFIG>/projects/**`) ou le hook `Stop`, dont
   * `packages/**` n'a pas le droit de dependre : c'est la frontiere du lot D, et elle ne
   * bouge pas. Le champ existe pour que l'appelant n'ait pas a DEDUIRE cette limite d'une
   * absence — un agent qui lit `ok: true` sans ce champ conclurait, a tort, que le tour a eu
   * lieu.
   *
   * Le type est litteral : une version ulterieure qui saurait le verifier devra elargir ce
   * type, donc rompre la compilation de ses consommateurs. C'est voulu — la promesse change.
   */
  readonly firstTurnVerified: false;
  /**
   * Le `viewType` de l'onglet apparu, RELEVE TEL QUEL — il est prefixe par VSCode.
   *
   * Rendu a l'appelant plutot que garde : c'est la seule trace, cote client, de ce sur quoi
   * la preuve d'attachement a porte. Absent en repli, ou aucun diff n'est fait.
   */
  readonly panelViewType?: string | undefined;
  /**
   * L'ERREUR QUI A CAUSE LE REPLI — le repli s'AJOUTE a elle, il ne la remplace jamais
   * (dette D18). Sans ce champ, l'appelant croirait le mecanisme nominal intact.
   */
  readonly degradedFrom?: SerializedError;
}

export interface OpenConversationDependencies {
  readonly editor: EditorPort;
  readonly extHostPid: number;
  /** Repertoire de transit du prompt — le stockage propre a l'extension, hors du workspace. */
  readonly promptDirectory: string;
  readonly log: (message: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Attente differee — SEUL POINT D'INJECTION avec le port, et pour la meme raison que
   * `schedule` dans `publication.ts` : ce qu'il faut prouver est que l'echelle est BORNEE et
   * que `editor.open` est re-emise, pas qu'on patiente 62 secondes.
   */
  readonly wait?: (ms: number) => Promise<void>;
  /** Identifiant de session — injectable pour que la preuve puisse l'imposer. */
  readonly newSessionId?: () => string;
  /**
   * Inventaire des processus du systeme. Defaut : celui du coeur.
   *
   * Injectable pour la meme raison que `wait` : ce qu'il faut prouver est que l'attente porte
   * sur un FAIT OBSERVE et qu'elle est bornee, pas que `Get-CimInstance` reponde en 1,1 s.
   */
  readonly readProcessTable?: () => Promise<ProcessSnapshot>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Ecrit le prompt dans un fichier transitoire, a droits restreints.
 *
 * MEME DISCIPLINE QUE L'ENTREE DE REGISTRE, et pour un motif voisin : ce fichier porte le
 * prompt en clair — c'est-a-dire, en production, tout le contexte d'un lot d'orchestration.
 * Sans `mode`, Node applique `0o666 & ~umask` : sur un poste POSIX multi-utilisateurs,
 * n'importe quel autre compte le lirait. Sous Windows ces bits ne pilotent que l'attribut
 * « lecture seule » et c'est l'ACL heritee qui protege — les poser n'y coute rien.
 *
 * @throws {ClaudeManagerError} `PROMPT_FILE_UNWRITABLE`
 */
function writePromptFile(directory: string, sessionId: string, prompt: string): string {
  const file = path.join(directory, `${sessionId}.prompt.txt`);
  try {
    mkdirSync(directory, { recursive: true, mode: PROMPT_DIR_MODE });
    // Le `mode` de `mkdirSync` ne s'applique qu'a la CREATION : un repertoire deja la —
    // celui d'une version anterieure — resterait ouvert. Ce `chmod` est idempotent.
    chmodSync(directory, PROMPT_DIR_MODE);
    writeFileSync(file, prompt, { encoding: 'utf8', mode: PROMPT_FILE_MODE });
  } catch (cause) {
    // Sans detail hors du code systeme : le message porterait le chemin, donc le compte.
    throw new ClaudeManagerError(
      ERROR_CODES.PROMPT_FILE_UNWRITABLE,
      'The transient prompt file could not be written',
      { cause: systemErrorCode(cause) }
    );
  }
  return file;
}

/**
 * Efface les prompts qu'aucun cycle n'a pu effacer — jamais ceux d'un cycle en cours.
 *
 * Ne leve JAMAIS : c'est de l'hygiene, et une hygiene qui ferait echouer une ouverture serait
 * pire que le residu qu'elle vise. Ce qu'elle n'a pas pu faire est journalise.
 */
function sweepAbandonedPrompts(directory: string, now: number, log: (message: string) => void): void {
  let files: readonly string[];
  try {
    files = readdirSync(directory);
  } catch {
    // Repertoire absent : c'est l'etat nominal d'une fenetre qui n'a encore rien ouvert.
    return;
  }

  let removed = 0;
  for (const file of files) {
    if (!file.endsWith('.prompt.txt')) continue;
    const absolute = path.join(directory, file);
    try {
      if (now - statSync(absolute).mtimeMs < ABANDONED_PROMPT_MAX_AGE_MS) continue;
      rmSync(absolute, { force: true });
      removed += 1;
    } catch (error) {
      log(`could not sweep an abandoned prompt file — ${describe(error)}`);
    }
  }
  if (removed > 0) log(`swept ${removed} abandoned prompt file(s)`);
}

/**
 * Verifie que la commande d'attachement EXISTE — et distingue trois causes, pas une.
 *
 * ALERTE MESUREE : les commandes `claude-vscode.*` sont enregistrees A L'ACTIVATION, elles ne
 * sont pas contribuees par le manifeste. Avant activation, `getCommands(true)` en rend ZERO ;
 * apres, il en rend dix-huit. Un `executeCommand` sur une extension non encore activee echoue
 * donc en *command not found* — EXACTEMENT le symptome qui, seul, ferait conclure a la
 * disparition de la commande. Les deux causes sont indiscernables au point d'appel : on
 * active DONC explicitement, on constate `isActive`, et alors seulement on interroge
 * l'inventaire.
 *
 * @throws {ClaudeManagerError} `CLAUDE_EXTENSION_MISSING`, `CLAUDE_EXTENSION_INACTIVE`,
 * `CLAUDE_COMMAND_MISSING`
 */
async function requireAttachCommand(
  editor: EditorPort,
  log: (message: string) => void
): Promise<ClaudeExtensionHandle> {
  const extension = editor.getClaudeExtension();
  if (extension === undefined) {
    throw new ClaudeManagerError(
      ERROR_CODES.CLAUDE_EXTENSION_MISSING,
      `The ${CLAUDE_EXTENSION_ID} extension is not installed in this window`,
      { extensionId: CLAUDE_EXTENSION_ID }
    );
  }

  if (!extension.isActive) {
    try {
      await extension.activate();
    } catch (cause) {
      throw new ClaudeManagerError(
        ERROR_CODES.CLAUDE_EXTENSION_INACTIVE,
        `The ${CLAUDE_EXTENSION_ID} extension failed to activate in this window`,
        { extensionId: CLAUDE_EXTENSION_ID, cause: systemErrorCode(cause) }
      );
    }
  }
  // CONSTATE, jamais suppose : `activate()` peut rendre la main sans que l'extension soit
  // active — un `activate` qui rejette silencieusement, une desactivation concurrente.
  if (!extension.isActive) {
    throw new ClaudeManagerError(
      ERROR_CODES.CLAUDE_EXTENSION_INACTIVE,
      `The ${CLAUDE_EXTENSION_ID} extension reports itself inactive after activation`,
      { extensionId: CLAUDE_EXTENSION_ID }
    );
  }

  const commands = await editor.listCommands();
  if (!commands.includes(CLAUDE_OPEN_COMMAND)) {
    throw new ClaudeManagerError(
      ERROR_CODES.CLAUDE_COMMAND_MISSING,
      `The ${CLAUDE_OPEN_COMMAND} command is not registered although the extension is active`,
      { command: CLAUDE_OPEN_COMMAND }
    );
  }
  log(`attach command available: ${CLAUDE_OPEN_COMMAND}`);
  // RENDUE plutot que relue plus loin : une seconde interrogation ouvrirait un cas
  // « l'extension a disparu entre-temps » qu'aucun test ne peut atteindre, et qu'il faudrait
  // pourtant ecrire. La poignee qu'on a validee est celle dont on se sert.
  return extension;
}

/**
 * Attend que le shell du terminal ait REELLEMENT engendre le processus du tour 1.
 *
 * L'observation est faite sur la TABLE DES PROCESSUS du systeme — la meme que celle qui
 * resout « ma fenetre » —, jamais sur un fichier d'etat du CLI : `<CONFIG>/sessions/<pid>.json`
 * porte un `— non verifie` assume dans `docs/compatibilite.md` (D17), et faire dependre le
 * mecanisme de la plus grosse inconnue du lot suivant serait le mettre a sa merci.
 *
 * CE QU'ELLE ETABLIT : un processus est ne du shell, donc la ligne s'est executee, donc le
 * binaire a demarre et aucune porte n'attend.
 * CE QU'ELLE N'ETABLIT PAS, et c'est dit : que le TOUR soit termine. Le savoir suppose de
 * lire le transcript — lot D.
 *
 * @throws {ClaudeManagerError} `SEED_PROCESS_NOT_STARTED`
 */
async function awaitSeedProcess(
  terminal: HiddenTerminal,
  readTable: () => Promise<ProcessSnapshot>,
  wait: (ms: number) => Promise<void>,
  log: (message: string) => void
): Promise<{ readonly shellPid: number | undefined; readonly seedPid: number | undefined }> {
  // Ecueil ADR-002 n.5 : `processId` ne se resout JAMAIS pour un pty deja mort. La course
  // contre l'echelle ci-dessous le borne — on ne l'attend pas seul.
  const shellPid = await terminal.processId();
  if (shellPid === undefined) {
    throw new ClaudeManagerError(
      ERROR_CODES.SEED_PROCESS_NOT_STARTED,
      'The hidden terminal never resolved a shell process id'
    );
  }

  for (let attempt = 1; attempt <= SEED_PROCESS_ATTEMPTS; attempt += 1) {
    const snapshot = await readTable();
    for (const [pid, record] of snapshot.table) {
      if (record.ppid !== shellPid) continue;
      log(`the seed process started after ${attempt} process table read(s)`);
      return { shellPid, seedPid: pid };
    }
    // La table coute deja de 700 ms a 1,3 s : on n'y ajoute qu'une respiration courte.
    await wait(TAB_POLL_INTERVAL_MS);
  }

  throw new ClaudeManagerError(
    ERROR_CODES.SEED_PROCESS_NOT_STARTED,
    'The hidden terminal shell never spawned the first-turn process',
    { attempts: SEED_PROCESS_ATTEMPTS }
  );
}

/**
 * Attache le panneau, et PROUVE l'attachement par diff des onglets.
 *
 * L'ABSENCE D'ERREUR NE PROUVE RIEN : `editor.open` REUSSIT en ouvrant un panneau VIDE quand
 * le `cwd` de la session ne correspond pas au workspace de la fenetre (D10). Ce mecanisme
 * rend ce cas impossible par construction — le `cwd` du terminal EST un dossier de travail de
 * cette fenetre — mais on ne s'en remet pas a cette construction : on constate l'onglet.
 *
 * @throws {ClaudeManagerError} `CLAUDE_PANEL_VIEWTYPE_UNKNOWN`
 */
async function attachPanel(
  editor: EditorPort,
  sessionId: string,
  before: readonly PanelTabLike[],
  wait: (ms: number) => Promise<void>,
  log: (message: string) => void
): Promise<PanelTabLike> {
  let attempts = 0;
  for (const budgetMs of ATTACH_RETRY_DELAYS_MS) {
    attempts += 1;
    await editor.executeCommand(CLAUDE_OPEN_COMMAND, sessionId);

    for (let waited = 0; waited < budgetMs; waited += TAB_POLL_INTERVAL_MS) {
      const panel = selectNewPanel(before, editor.listPanelTabs());
      if (panel !== undefined) {
        // `viewType` est defini par construction — `selectNewPanel` ne rend qu'un onglet
        // deja reconnu Claude. Aucun repli n'est ecrit pour un cas qui ne se produit pas.
        log(`panel attached after ${attempts} attempt(s), viewType=${panel.viewType}`);
        return panel;
      }
      await wait(TAB_POLL_INTERVAL_MS);
    }
  }

  const totalMs = ATTACH_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
  throw new ClaudeManagerError(
    ERROR_CODES.CLAUDE_PANEL_VIEWTYPE_UNKNOWN,
    'No Claude conversation tab appeared after the attach command was issued',
    { attempts, waitedMs: totalMs }
  );
}

/**
 * LE REPLI V5 — il s'AJOUTE a l'erreur nommee, il ne la remplace JAMAIS.
 *
 * `editor.open(null, <prompt>)` PRE-REMPLIT le champ de saisie sans jamais soumettre : prouve
 * deux fois (au source — il appelle `setInputText`, rien d'autre — et par mesure). La
 * conversation est ouverte, le prompt est la, l'humain valide. Perte d'autonomie ASSUMEE :
 * mieux vaut un geste humain qu'une conversation non ouverte.
 *
 * Si le repli echoue a son tour, c'est l'erreur NOMINALE qui remonte : c'est elle que
 * l'appelant doit diagnostiquer, l'echec du repli n'en est qu'une consequence.
 */
async function runFallback(
  editor: EditorPort,
  prompt: string,
  cause: ClaudeManagerError,
  extHostPid: number,
  log: (message: string) => void
): Promise<OpenConversationResult> {
  try {
    await editor.executeCommand(CLAUDE_OPEN_COMMAND, null, prompt);
  } catch (error) {
    log(`the V5 fallback failed too, the named failure above stands — ${describe(error)}`);
    throw cause;
  }

  log('V5 fallback ran: the conversation is open with the prompt PRE-FILLED, NOT submitted');
  return {
    ok: true,
    mode: 'fallback',
    sessionId: null,
    extHostPid,
    humanActionRequired: true,
    // Aucune session n'a ete amorcee : il n'y a pas de tour 1 a qualifier.
    firstTurn: 'not-attempted',
    firstTurnVerified: false,
    degradedFrom: cause.toJSON(),
  };
}

/**
 * Ouvre une conversation Claude interactive dans CETTE fenetre.
 *
 * @throws {ClaudeManagerError} toute defaillance prevue du mecanisme, avec son code stable.
 */
export async function openConversation(
  request: OpenConversationRequest,
  dependencies: OpenConversationDependencies
): Promise<OpenConversationResult> {
  const { editor, extHostPid, promptDirectory, log } = dependencies;
  const platform = dependencies.platform ?? process.platform;
  const environment = dependencies.environment ?? process.env;
  const wait = dependencies.wait ?? sleep;
  const readTable = dependencies.readProcessTable ?? readProcessTable;
  const sessionId = (dependencies.newSessionId ?? randomUUID)();

  // ---- Etape 1 : refus precoce ----------------------------------------------------------
  // AVANT TOUT LE RESTE, et sans repli : ce sont des etats de la FENETRE, pas des defaillances
  // de l'ecosysteme Claude. En Restricted Mode les commandes de l'extension Claude n'existent
  // meme pas — l'echec serait incomprehensible s'il se presentait plus loin (piege n.1).
  const workspace = editor.readWorkspace();
  if (!workspace.isTrusted) {
    throw new ClaudeManagerError(
      ERROR_CODES.WORKSPACE_NOT_TRUSTED,
      'This window is in Restricted Mode, no conversation can be opened here'
    );
  }
  const cwd = workspace.workspaceFolders[0];
  if (cwd === undefined) {
    throw new ClaudeManagerError(
      ERROR_CODES.WORKSPACE_FOLDER_MISSING,
      'This window has no workspace folder to run the first turn in'
    );
  }

  // ---- Etape 2 : disponibilite de la commande — LE POINT DE DECISION DU REPLI ------------
  //
  // Les trois defaillances ci-dessous SORTENT SANS REPLI, et ce n'est pas un oubli : le repli
  // V5 est `claude-vscode.editor.open` elle-meme. Extension absente, extension non activable,
  // commande disparue — dans les trois cas, il n'y a plus rien a appeler. C'est ce que dit la
  // derniere phrase de la decision : « Si `editor.open` est elle-meme absente, il n'y a plus
  // de repli : erreur nommee, et c'est tout. »
  //
  // Une fois cette etape franchie, le repli est DISPONIBLE — et il le restera jusqu'a la
  // creation du terminal, pas au-dela (voir `seeded` ci-dessous).
  const claudeExtension = await requireAttachCommand(editor, log);

  let seeded = false;
  let terminal: HiddenTerminal | undefined;
  let promptFile: string | undefined;

  try {
    // ---- Etapes 3 a 5 : la ligne, et tout ce qu'il faut pour la construire ---------------
    //
    // `PATH` ou `Path` : Windows ne garantit pas la casse de ses variables d'environnement,
    // et `process.env` de Node la restitue telle que le processus l'a recue.
    const pathEntries = splitPathVariable(environment['PATH'] ?? environment['Path']);

    const claudeBinary = resolveExecutable({
      // Le bundle de l'extension D'ABORD : `claude` n'est pas sur le `PATH` de tous les
      // shells du poste de reference (constate), et le chemin du bundle porte la version —
      // il est derive de ce que l'editeur rend, jamais code en dur (D16).
      preferred: bundledClaudeCandidates(claudeExtension.extensionPath, platform),
      names: claudeBinaryNames(platform),
      pathEntries,
      exists: existsAsFile,
    });
    if (claudeBinary === undefined) {
      throw new ClaudeManagerError(
        ERROR_CODES.CLAUDE_BINARY_NOT_FOUND,
        'The claude binary was found neither in the extension bundle nor on PATH',
        // Le NOMBRE d'emplacements sondes, jamais leur chemin : ils portent le compte.
        { searchedPathEntries: pathEntries.length }
      );
    }

    // `pwsh`, et JAMAIS `shellPath` pointant directement sur `claude.exe` : c'est le shell qui
    // garde un canal ouvert vers le processus, donc qui rend franchissables les deux portes du
    // CLI. Aucun repli silencieux sur un autre shell : leurs regles de citation different, et
    // la forme L2 n'a ete mesuree que sous PowerShell.
    const shell = resolveExecutable({
      preferred: [],
      names: shellNames(platform),
      pathEntries,
      exists: existsAsFile,
    });
    if (shell === undefined) {
      throw new ClaudeManagerError(
        ERROR_CODES.SEED_SHELL_NOT_FOUND,
        'PowerShell 7 (pwsh) was not found on this window PATH',
        { searchedPathEntries: pathEntries.length }
      );
    }

    // GARDE DE PLAFOND — AVANT toute tentative, parce que le depassement est SILENCIEUX.
    // Elle pese la ligne du PROCESSUS FILS, pas celle envoyee au pty : c'est `CreateProcess`
    // qui plafonne (ADR-004).
    const budget = assertCommandLineFits({
      executable: claudeBinary,
      leadingArguments: seedLeadingArguments(sessionId),
      prompt: request.prompt,
    });
    log(
      `command line budget: prompt=${budget.promptLength} cost=${budget.promptCost} ` +
        `fixed=${budget.fixedCost} available=${budget.available} limit=${budget.limit}`
    );

    sweepAbandonedPrompts(promptDirectory, Date.now(), log);
    promptFile = writePromptFile(promptDirectory, sessionId, request.prompt);

    // ---- Etape 4 : le terminal masque ---------------------------------------------------
    // A PARTIR D'ICI, PLUS AUCUN REPLI. Un `claude` va exister : basculer en V5 ouvrirait une
    // SECONDE conversation pendant qu'une vraie session tourne. Le repli repare une
    // INDISPONIBILITE, jamais une latence.
    seeded = true;
    terminal = editor.createHiddenTerminal({
      name: `ClaudeManager seed ${sessionId}`,
      // LE `cwd` EST UN DOSSIER DE TRAVAIL DE CETTE FENETRE, et c'est ce qui rend le piege
      // n.3 impossible PAR CONSTRUCTION : `editor.open` n'attache la session que si son `cwd`
      // correspond au workspace de la fenetre — sinon il reussit en ouvrant un panneau VIDE.
      cwd,
      shellPath: shell,
      shellArgs: ['-NoLogo'],
      env: neutralizedTerminalEnvironment(environment),
    });

    const before = editor.listPanelTabs();
    terminal.sendText(buildSeedCommandLine({ claudeBinary, sessionId, promptFile }));
    log(`seed line sent to a hidden terminal (session ${sessionId})`);

    // ---- Etape 5 bis : un processus a REELLEMENT ete engendre ----------------------------
    // Correction d'un defaut mesure : sans elle, l'attachement aboutissait avant que `claude`
    // n'existe, et la suppression du terminal tuait le tour a sa naissance.
    //
    // CE QU'ELLE ETABLIT S'ARRETE LA, ET LE RESULTAT LE DIT : le processus existe. Qu'il joue
    // le tour ou qu'il attende derriere l'ecran d'accueil du CLI ne se distingue pas d'ici —
    // mesure du 2026-07-26, les deux sont `claude.exe` avec la meme ligne de commande.
    await awaitSeedProcess(terminal, readTable, wait, log);

    // ---- Etape 6 : attachement, prouve par diff des onglets ------------------------------
    const panel = await attachPanel(editor, sessionId, before, wait, log);

    return {
      ok: true,
      mode: 'seeded',
      sessionId,
      extHostPid,
      humanActionRequired: false,
      firstTurn: 'process-started',
      firstTurnVerified: false,
      panelViewType: panel.viewType,
    };
  } catch (error) {
    if (!isClaudeManagerError(error)) throw error;

    // L'ERREUR NOMMEE EST EMISE D'ABORD, LE REPLI ENSUITE — l'ordre n'est pas negociable
    // (dette D18). Sans quoi l'appelant croirait le mecanisme nominal intact.
    log(`the nominal V1 path failed — ${describe(error)}`);

    // LE SEUL CRITERE DU REPLI, ET IL EST ICI : aucun `claude` n'a encore pu naitre. Une fois
    // le terminal cree, une vraie session tourne peut-etre — ouvrir un second panneau
    // pre-rempli serait pire que l'echec qu'on repare.
    if (seeded) {
      log('no V5 fallback: a claude session may already be running, a second panel would be worse');
      throw error;
    }
    return await runFallback(editor, request.prompt, error, extHostPid, log);
  } finally {
    // ---- Etape 7 : le terminal disparait SUR TOUS LES CHEMINS, succes comme echec --------
    // Le `claude` du panneau survit, l'onglet reste intact (mesure, ADR-002).
    terminal?.dispose();
    // FILET : la ligne efface le fichier elle-meme, avant meme que `claude` ne demarre. Ce
    // filet couvre le cas ou elle n'a jamais pu s'executer.
    if (promptFile !== undefined) rmSync(promptFile, { force: true });
  }
}

/**
 * SERIALISE LES OUVERTURES DE CETTE FENETRE — une a la fois, jamais deux de front.
 *
 * La preuve d'attachement est un DIFF D'ONGLETS. Deux ouvertures concurrentes releveraient
 * leur etat « avant » a des instants entrelaces : la seconde verrait apparaitre le panneau de
 * la premiere et le revendiquerait. Les deux routes rendraient un succes, l'une des deux avec
 * le panneau de l'autre — et l'appelant recevrait un `sessionId` qui ne designe pas ce qui
 * s'est ouvert.
 *
 * File d'un seul rang, exactement comme celle des transitions de publication. Une ouverture
 * qui echoue ne bloque pas les suivantes : le `catch` porte sur la CHAINE, pas sur la tache.
 */
export function serializeOpenings<T>(
  open: (request: T) => Promise<OpenConversationResult>
): (request: T) => Promise<OpenConversationResult> {
  let queue: Promise<unknown> = Promise.resolve();
  return (request: T): Promise<OpenConversationResult> => {
    const settled = queue.then(
      () => open(request),
      () => open(request)
    );
    queue = settled.catch(() => undefined);
    return settled;
  };
}

/**
 * Un candidat existe-t-il, ET est-ce un fichier ?
 *
 * `statSync` plutot qu'`existsSync` : un REPERTOIRE nomme `claude.exe` sur le `PATH` ferait
 * conclure a tort a la presence du binaire, et l'echec suivant n'aurait plus de nom.
 */
function existsAsFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
