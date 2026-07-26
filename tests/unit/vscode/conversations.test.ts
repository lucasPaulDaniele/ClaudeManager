import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  isClaudeManagerError,
  type ProcessSnapshot,
} from '../../../packages/core/src/index.js';
import {
  openConversation,
  serializeOpenings,
  type ClaudeExtensionHandle,
  type EditorPort,
  type HiddenTerminal,
  type HiddenTerminalSpec,
  type OpenConversationResult,
} from '../../../packages/vscode/src/conversations.js';
import { CLAUDE_OPEN_COMMAND, CLAUDE_PANEL_VIEW_TYPE, type PanelTabLike } from '../../../packages/vscode/src/seed.js';

/**
 * LE MECANISME V1, EPROUVE SUR SON ORDRE.
 *
 * Ce que ces tests etablissent est la SEQUENCE et les REFUS — « le repli ne part jamais une
 * fois le terminal cree », « l'erreur nommee precede le repli », « le terminal est supprime
 * sur tous les chemins ». Aucune de ces proprietes ne s'observe dans une vraie fenetre sans
 * provoquer des pannes qu'on ne sait pas provoquer.
 *
 * CE QU'ILS N'ETABLISSENT PAS, et c'est dit : que `editor.open` attache reellement une
 * session, que `hideFromUser` cache reellement le terminal, que `dispose` laisse reellement
 * survivre le panneau. Cela n'est prouve QUE par `npm run test:integration`, dans une vraie
 * fenetre avec la vraie extension Claude (principe fondateur n.5).
 *
 * Le systeme de fichiers, lui, est REEL : le fichier de prompt est vraiment ecrit dans un
 * vrai repertoire temporaire, et vraiment efface.
 */

const PANEL_VIEW_TYPE = `mainThreadWebview-${CLAUDE_PANEL_VIEW_TYPE}`;
const temporaries: string[] = [];

/** Pid du shell du terminal masque, et pid du `claude` qu'il engendre. */
const SHELL_PID = 4242;
const SEED_PID = 4343;

/** L'identifiant que la preuve IMPOSE : c'est lui qui nomme le fichier de transcript. */
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/**
 * Le repertoire de projet du CLI, tel qu'il le nomme — un slug de `cwd`.
 *
 * IL EST ARBITRAIRE ICI, ET C'EST TOUT LE POINT : le mecanisme ne le CALCULE jamais, il balaie
 * les sous-repertoires et reconnait le fichier par son NOM. Un slug fantaisiste doit donc etre
 * trouve tout aussi bien qu'un vrai — si un test venait a echouer parce que ce nom change, c'est
 * que quelqu'un a reintroduit la derivation de slug que D7 ne garantit pas.
 */
const PROJECT_SLUG = 'un-slug-que-personne-ne-calcule';

/** Ce que le fichier de transcript pese a son apparition, puis ce que la sortie du tour ajoute. */
const TRANSCRIPT_AT_APPEARANCE = 'x'.repeat(64);
const TURN_OUTPUT = 'y'.repeat(32);

/** Table des processus ou le shell a bien engendre le tour 1 — le cas nominal. */
function tableWithSeed(): ProcessSnapshot {
  return {
    table: new Map([
      [SHELL_PID, { ppid: 1, createdAt: undefined }],
      [SEED_PID, { ppid: SHELL_PID, createdAt: undefined }],
    ]),
    capturedAt: 0,
  };
}

/** Table ou RIEN n'est ne du shell : une porte du CLI attend, ou le binaire a refuse. */
function tableWithoutSeed(): ProcessSnapshot {
  return { table: new Map([[SHELL_PID, { ppid: 1, createdAt: undefined }]]), capturedAt: 0 };
}

/** Journal ORDONNE de tout ce que le mecanisme a demande a l'editeur. */
interface Trace {
  readonly calls: string[];
  readonly lines: string[];
  readonly terminals: RecordedTerminal[];
  readonly sent: string[];
  /**
   * CE QUE LE TRANSCRIPT ETAIT A L'INSTANT EXACT DU `dispose()` — le garde-fou de ce correctif.
   *
   * Releve DANS le `dispose` du terminal, et pas apres coup : `dispose()` TUE le `claude` du
   * tour 1, donc la seule question qui vaille est « le tour avait-il eu lieu quand on l'a tue ? ».
   * Un ordre de traces ne repond pas a cette question — un fichier constate, oui.
   */
  transcriptAtDispose?: { readonly found: boolean; readonly bytes: number };
}

interface RecordedTerminal {
  readonly spec: HiddenTerminalSpec;
  disposed: boolean;
}

interface HarnessOptions {
  readonly extension?: 'missing' | 'inactive' | 'activate-throws' | 'active';
  readonly commands?: readonly string[];
  /** Onglets rendus a chaque releve — le dernier element est repete quand la liste s epuise. */
  readonly tabs?: readonly (readonly PanelTabLike[])[];
  readonly isTrusted?: boolean;
  readonly workspaceFolders?: readonly string[];
  readonly executeCommand?: (command: string, args: readonly unknown[]) => Promise<unknown> | undefined;
  /** N'ecrit AUCUN executable dans le PATH simule. */
  readonly withoutClaude?: boolean;
  readonly withoutShell?: boolean;
  /** Le pty est deja mort : `processId` ne se resout JAMAIS (ecueil ADR-002 n.5). */
  readonly deadPty?: boolean;
  /** Tables rendues successivement ; la derniere est repetee quand la liste s epuise. */
  readonly processTables?: readonly ProcessSnapshot[];
  /**
   * A QUELLE ATTENTE LE TRANSCRIPT APPARAIT, et a laquelle il GROSSIT.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * LE FICHIER EST VRAIMENT ECRIT, DANS UN VRAI REPERTOIRE, et son apparition est branchee sur
   * l'attente INJECTEE du mecanisme. C'est ce qui rend la preuve possible sans horloge : le
   * fichier n'apparait QUE PARCE QUE le mecanisme a REELLEMENT patiente. Un code qui ne
   * patienterait pas — celui d'avant ce correctif — ne le verrait jamais.
   *
   * Le compte est GLOBAL : `awaitSeedProcess` et l'attachement consomment aussi des attentes.
   * Au cas nominal ils n'en consomment aucune (le processus est trouve a la premiere lecture,
   * l'onglet au premier sondage), d'ou les valeurs par defaut ; les tests qui font patienter
   * ces etapes passent leurs propres chiffres.
   * ─────────────────────────────────────────────────────────────────────────────────────────
   */
  readonly transcriptAppearsAfterWaits?: number;
  readonly transcriptGrowsAfterWaits?: number;
  /** Le transcript n'apparait JAMAIS : le tour n'a pas eu lieu. */
  readonly withoutTranscript?: boolean;
  /** Le fichier est deja la AVANT l'envoi — pour les tests qui n'injectent aucune attente. */
  readonly transcriptAlreadyThere?: boolean;
}

interface Harness {
  readonly trace: Trace;
  readonly editor: EditorPort;
  readonly promptDirectory: string;
  readonly binDirectory: string;
  /** La racine de projets balayee par le mecanisme — un vrai repertoire temporaire. */
  readonly transcriptRoot: string;
  /** Le fichier que le CLI ecrirait : `<racine>/<slug>/<sessionId>.jsonl`. */
  readonly transcriptFile: string;
  open(prompt: string): Promise<OpenConversationResult>;
}

/** Ce que le harnais voit du transcript a un instant donne — jamais son contenu. */
function lookAtTranscript(file: string): { readonly found: boolean; readonly bytes: number } {
  try {
    return { found: true, bytes: fs.statSync(file).size };
  } catch {
    return { found: false, bytes: 0 };
  }
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmgr-open-'));
  temporaries.push(root);
  const binDirectory = path.join(root, 'bin');
  const promptDirectory = path.join(root, 'prompts');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  // De VRAIS fichiers : la resolution sonde le systeme de fichiers, elle n'est pas simulee.
  if (options.withoutClaude !== true) fs.writeFileSync(path.join(binDirectory, 'claude.exe'), '');
  if (options.withoutShell !== true) fs.writeFileSync(path.join(binDirectory, 'pwsh.exe'), '');

  // La racine de projets, et le repertoire de slug SOUS lequel le fichier vivra : le
  // repertoire existe, le fichier n'existe pas encore — l'etat exact d'avant l'envoi.
  const transcriptRoot = path.join(root, 'projects');
  const transcriptFile = path.join(transcriptRoot, PROJECT_SLUG, `${SESSION_ID}.jsonl`);
  fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
  if (options.transcriptAlreadyThere === true) {
    fs.writeFileSync(transcriptFile, TRANSCRIPT_AT_APPEARANCE, 'utf8');
  }

  const trace: Trace = { calls: [], lines: [], terminals: [], sent: [] };
  const tabs = options.tabs ?? [[], [{ viewType: PANEL_VIEW_TYPE, label: 'ouverte' }]];
  let releve = 0;
  let tableReads = 0;
  let waits = 0;

  /** L'attente INJECTEE : elle ne patiente pas, elle fait avancer le monde exterieur. */
  const wait = (): Promise<void> => {
    waits += 1;
    if (options.withoutTranscript !== true) {
      if (waits === (options.transcriptAppearsAfterWaits ?? 1)) {
        fs.writeFileSync(transcriptFile, TRANSCRIPT_AT_APPEARANCE, 'utf8');
      }
      if (waits === (options.transcriptGrowsAfterWaits ?? 2)) {
        fs.appendFileSync(transcriptFile, TURN_OUTPUT, 'utf8');
      }
    }
    return Promise.resolve();
  };

  const extensionState = options.extension ?? 'active';
  const handle: ClaudeExtensionHandle = {
    isActive: extensionState === 'active',
    extensionPath: path.join(root, 'claude-extension'),
    activate: async (): Promise<void> => {
      trace.calls.push('activate');
      if (extensionState === 'activate-throws') throw Object.assign(new Error('boom'), { code: 'EBOOM' });
      // `inactive` : `activate()` rend la main SANS activer — le cas qu'on doit constater.
    },
  };

  const editor: EditorPort = {
    readWorkspace: () => ({
      workspaceFolders: options.workspaceFolders ?? [workspace],
      isTrusted: options.isTrusted ?? true,
    }),
    getClaudeExtension: () => (extensionState === 'missing' ? undefined : handle),
    listCommands: () => {
      trace.calls.push('listCommands');
      return Promise.resolve(options.commands ?? [CLAUDE_OPEN_COMMAND, 'claude-vscode.autre']);
    },
    executeCommand: (command, ...args) => {
      trace.calls.push(`executeCommand(${command}, ${args[0] === null ? 'null' : 'sessionId'})`);
      return options.executeCommand?.(command, args) ?? Promise.resolve(undefined);
    },
    createHiddenTerminal: (spec): HiddenTerminal => {
      trace.calls.push('createHiddenTerminal');
      const recorded: RecordedTerminal = { spec, disposed: false };
      trace.terminals.push(recorded);
      return {
        sendText: (line) => {
          trace.calls.push('sendText');
          trace.sent.push(line);
        },
        dispose: () => {
          trace.calls.push('dispose');
          // RELEVE ICI, ET NULLE PART AILLEURS : c'est cet instant qui tue le tour 1.
          trace.transcriptAtDispose = lookAtTranscript(transcriptFile);
          recorded.disposed = true;
        },
        processId: () => Promise.resolve(options.deadPty === true ? undefined : SHELL_PID),
      };
    },
    listPanelTabs: () => {
      const snapshot = tabs[Math.min(releve, tabs.length - 1)] ?? [];
      releve += 1;
      return snapshot;
    },
  };

  return {
    trace,
    editor,
    promptDirectory,
    binDirectory,
    transcriptRoot,
    transcriptFile,
    open: (prompt) =>
      openConversation(
        { prompt },
        {
          editor,
          extHostPid: 11172,
          promptDirectory,
          log: (message) => trace.lines.push(message),
          platform: 'win32',
          environment: { PATH: binDirectory, CLAUDECODE: '1', CLAUDE_PID: '42', HOME: 'c:\\users\\x' },
          // On n'attend pas reellement : ce qu'il faut prouver est que les echelles sont
          // BORNEES, que la commande est re-emise et que le transcript est ATTENDU — pas la
          // patience du minuteur.
          wait,
          transcriptProjectRoots: [transcriptRoot],
          newSessionId: () => SESSION_ID,
          readProcessTable: () => {
            const tables = options.processTables ?? [tableWithSeed()];
            const snapshot = tables[Math.min(tableReads, tables.length - 1)] ?? tableWithSeed();
            tableReads += 1;
            trace.calls.push('readProcessTable');
            return Promise.resolve(snapshot);
          },
        }
      ),
  };
}

async function refusal(harness: Harness, prompt = 'Reponds exactement OK'): Promise<unknown> {
  try {
    await harness.open(prompt);
  } catch (error) {
    return error;
  }
  return undefined;
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('etape 1 — refus precoce, et SANS repli', () => {
  it('refuse une fenetre en Restricted Mode', async () => {
    const harness = makeHarness({ isTrusted: false });

    const error = await refusal(harness);

    expect(isClaudeManagerError(error) && error.code).toBe(ERROR_CODES.WORKSPACE_NOT_TRUSTED);
    // AUCUNE commande n'a ete emise : ni le repli, ni meme l'inventaire.
    expect(harness.trace.calls).toEqual([]);
  });

  it('refuse une fenetre sans dossier de travail', async () => {
    const harness = makeHarness({ workspaceFolders: [] });

    const error = await refusal(harness);

    expect(isClaudeManagerError(error) && error.code).toBe(ERROR_CODES.WORKSPACE_FOLDER_MISSING);
    expect(harness.trace.calls).toEqual([]);
  });
});

describe('etape 2 — les TROIS causes, et pourquoi AUCUNE ne peut basculer en V5', () => {
  it('extension ABSENTE — erreur nommee, aucun repli', async () => {
    const harness = makeHarness({ extension: 'missing' });

    const error = await refusal(harness);

    expect(isClaudeManagerError(error) && error.code).toBe(ERROR_CODES.CLAUDE_EXTENSION_MISSING);
    expect(harness.trace.calls).toEqual([]);
  });

  it('extension NON ACTIVABLE — activation tentee, constatee, erreur DISTINCTE', async () => {
    const harness = makeHarness({ extension: 'activate-throws' });

    const error = await refusal(harness);

    expect(isClaudeManagerError(error) && error.code).toBe(ERROR_CODES.CLAUDE_EXTENSION_INACTIVE);
    expect(harness.trace.calls).toEqual(['activate']);
  });

  it('extension qui rend la main SANS s activer — constate, jamais suppose', async () => {
    const harness = makeHarness({ extension: 'inactive' });

    const error = await refusal(harness);

    expect(isClaudeManagerError(error) && error.code).toBe(ERROR_CODES.CLAUDE_EXTENSION_INACTIVE);
    // `activate()` a bien ete appelee : c'est le constat d'`isActive` ensuite qui tranche.
    expect(harness.trace.calls).toEqual(['activate']);
  });

  it('commande DISPARUE — erreur nommee, et AUCUN repli : le repli EST cette commande', async () => {
    // ALERTE MESUREE : `getCommands(true)` rend ZERO commande `claude-vscode.*` avant
    // activation, dix-huit apres. On active donc explicitement AVANT d'interroger — sans
    // quoi « extension pas encore activee » et « commande disparue » seraient indiscernables.
    const harness = makeHarness({ extension: 'active', commands: ['claude-vscode.autre'] });

    const error = await refusal(harness);

    expect(isClaudeManagerError(error) && error.code).toBe(ERROR_CODES.CLAUDE_COMMAND_MISSING);
    // AUCUN `executeCommand` : `claude-vscode.editor.open` est le repli lui-meme.
    expect(harness.trace.calls).toEqual(['listCommands']);
  });

  it('active l extension AVANT d interroger l inventaire — l ordre est le fond du correctif', async () => {
    const harness = makeHarness({ extension: 'inactive', commands: [CLAUDE_OPEN_COMMAND] });
    await refusal(harness);

    const harnessActive = makeHarness({ extension: 'active' });
    await harnessActive.open('x');

    // Sur une extension deja active, on n'appelle pas `activate` : l'inventaire suffit.
    expect(harnessActive.trace.calls[0]).toBe('listCommands');
  });
});

describe('etapes 3 a 6 — la voie nominale', () => {
  it('cree un terminal MASQUE, sur pwsh, dans un dossier de travail de CETTE fenetre', async () => {
    const harness = makeHarness();

    const result = await harness.open('Reponds exactement OK');

    expect(result).toMatchObject({ ok: true, mode: 'seeded', extHostPid: 11172, humanActionRequired: false });
    const spec = harness.trace.terminals[0]?.spec;
    expect(spec?.shellPath).toBe(path.join(harness.binDirectory, 'pwsh.exe'));
    expect(spec?.shellArgs).toEqual(['-NoLogo']);
    // LE `cwd` EST LE WORKSPACE : c'est ce qui rend le piege n.3 impossible par construction.
    expect(spec?.cwd).toBe(harness.editor.readWorkspace().workspaceFolders[0]);
  });

  it('neutralise l environnement herite — `null`, jamais autre chose', async () => {
    const harness = makeHarness();

    await harness.open('x');

    const env = harness.trace.terminals[0]?.spec.env ?? {};
    expect(Object.keys(env).sort()).toEqual(['CLAUDECODE', 'CLAUDE_PID']);
    expect(Object.values(env).every((value) => value === null)).toBe(true);
    // `HOME` et `PATH` passent intacts : on n'assainit pas le terminal, on le desintoxique.
    expect(Object.keys(env)).not.toContain('PATH');
  });

  it('ecrit le prompt dans un fichier, l envoie par la ligne L2, et EFFACE le fichier', async () => {
    const harness = makeHarness();

    await harness.open('un prompt avec "guillemets" et $(Get-Date)');

    const line = harness.trace.sent[0] ?? '';
    // Le prompt n'apparait NULLE PART dans la ligne : il est lu en donnee.
    expect(line).not.toContain('Get-Date');
    expect(line).toContain('[IO.File]::ReadAllText');
    // Filet cote extension : le fichier n'existe plus, la ligne du shell n'ayant jamais tourne.
    expect(fs.readdirSync(harness.promptDirectory)).toEqual([]);
  });

  // Sous Windows ces bits n'ont pas de sens : `chmod` n'y pilote que l'attribut « lecture
  // seule », et c'est l'ACL heritee de C:\\Users\\<compte> qui protege. La verification a donc
  // lieu la ou elle veut dire quelque chose — et elle tourne en CI, sous Linux.
  const posixOnly = process.platform === 'win32' ? it.skip : it;

  posixOnly('ecrit le prompt a DROITS RESTREINTS — il porte tout le contexte d un lot', async () => {
    const harness = makeHarness();
    await harness.open('x');

    // Le fichier lui-meme est efface a la fin du cycle ; le repertoire, lui, survit et porte
    // la meme discipline que celui du registre.
    expect(fs.statSync(harness.promptDirectory).mode & 0o777).toBe(0o700);
  });

  posixOnly('resserre un repertoire de transit laisse ouvert par une version anterieure', async () => {
    // Rattrapage de l'existant : le `mode` de `mkdirSync` ne s'applique qu'a la CREATION.
    const harness = makeHarness();
    fs.mkdirSync(harness.promptDirectory, { recursive: true, mode: 0o755 });
    fs.chmodSync(harness.promptDirectory, 0o755);

    await harness.open('x');

    expect(fs.statSync(harness.promptDirectory).mode & 0o777).toBe(0o700);
  });

  it('ecrit puis efface le prompt, quelle que soit la plateforme', async () => {
    const harness = makeHarness();

    await harness.open('x');

    expect(fs.existsSync(harness.promptDirectory)).toBe(true);
    expect(fs.readdirSync(harness.promptDirectory)).toEqual([]);
  });

  it('PROUVE l attachement par diff des onglets, jamais par l absence d erreur', async () => {
    const harness = makeHarness();

    await harness.open('x');

    expect(harness.trace.calls).toContain(`executeCommand(${CLAUDE_OPEN_COMMAND}, sessionId)`);
  });

  it('supprime le terminal APRES l attachement — le panneau, lui, survit', async () => {
    const harness = makeHarness();

    await harness.open('x');

    const order = harness.trace.calls;
    expect(order.indexOf('dispose')).toBeGreaterThan(order.indexOf('sendText'));
    expect(harness.trace.terminals[0]?.disposed).toBe(true);
  });

  it('RE-EMET la commande d attachement a chaque echelon, et BORNE l attente', async () => {
    // Les deux portes du CLI bloquent INDEFINIMENT quand elles se presentent : sans borne, la
    // route pendrait pour toujours.
    const harness = makeHarness({ tabs: [[]] });

    const error = await refusal(harness);

    expect(isClaudeManagerError(error) && error.code).toBe(ERROR_CODES.CLAUDE_PANEL_VIEWTYPE_UNKNOWN);
    const attempts = harness.trace.calls.filter((call) => call.includes('sessionId')).length;
    expect(attempts).toBe(5);
    expect(isClaudeManagerError(error) && error.details).toMatchObject({ attempts: 5, waitedMs: 62_000 });
  });

  it('ne confond pas un panneau DEJA la avec celui qu on vient d ouvrir', async () => {
    const restaure: PanelTabLike = { viewType: PANEL_VIEW_TYPE, label: 'conversation restauree' };
    const harness = makeHarness({ tabs: [[restaure]] });

    const error = await refusal(harness);

    // Un panneau Claude etait la du debut a la fin : rien n'est APPARU, donc rien n'est prouve.
    expect(isClaudeManagerError(error) && error.code).toBe(ERROR_CODES.CLAUDE_PANEL_VIEWTYPE_UNKNOWN);
  });
});

describe('etape 5 bis — le tour 1 a REELLEMENT demarre (defaut mesure le 2026-07-26)', () => {
  /**
   * CETTE ETAPE NE PORTE PLUS LA PREUVE DU TOUR — c'est l'etape 6 qui la porte — et elle est
   * CONSERVEE pour ce qu'elle discrimine, elle seule : « rien n'a demarre du tout » se distingue
   * de « demarre, mais aucun tour ». Deux causes, deux remediations, deux erreurs nommees.
   */
  it('ATTEND le processus amorce AVANT d attacher', async () => {
    const harness = makeHarness();

    const result = await harness.open('x');

    const order = harness.trace.calls;
    expect(order.indexOf('readProcessTable')).toBeGreaterThan(order.indexOf('sendText'));
    expect(order.indexOf('readProcessTable')).toBeLessThan(
      order.indexOf(`executeCommand(${CLAUDE_OPEN_COMMAND}, sessionId)`)
    );
    expect(result.firstTurn).toBe('transcript-observed');
  });

  it('patiente tant que le shell n a rien engendre, puis repart des qu il l a fait', async () => {
    const harness = makeHarness({
      processTables: [tableWithoutSeed(), tableWithoutSeed(), tableWithSeed()],
      // DEUX ATTENTES SONT CONSOMMEES ICI, avant meme que le transcript ne soit attendu : le
      // compte des attentes est global, et le decaler est plus honnete que de le cacher.
      transcriptAppearsAfterWaits: 3,
      transcriptGrowsAfterWaits: 4,
    });

    const result = await harness.open('x');

    expect(result.mode).toBe('seeded');
    expect(harness.trace.calls.filter((call) => call === 'readProcessTable')).toHaveLength(3);
    expect(harness.trace.transcriptAtDispose?.found).toBe(true);
  });

  it('NOMME l echec quand rien ne demarre — c est le signal des DEUX PORTES du CLI', async () => {
    // Quand l'onboarding ou le « Quick safety check » attend une reponse, aucun processus
    // n'est engendre. Sans cette etape, l'appelant recevait un SUCCES.
    const harness = makeHarness({ processTables: [tableWithoutSeed()] });

    const error = await refusal(harness);

    expect(isClaudeManagerError(error) && error.code).toBe(ERROR_CODES.SEED_PROCESS_NOT_STARTED);
    expect(isClaudeManagerError(error) && error.details).toMatchObject({ attempts: 8 });
    // Jamais de repli : un `claude` tourne peut-etre deja.
    expect(harness.trace.calls).not.toContain(`executeCommand(${CLAUDE_OPEN_COMMAND}, null)`);
    // Et le terminal est supprime, comme sur tous les autres chemins.
    expect(harness.trace.terminals[0]?.disposed).toBe(true);
  });

  it('NOMME l echec quand le pty est deja mort — `processId` ne se resout jamais', async () => {
    // Ecueil ADR-002 n.5 : l'attendre sans borne bloquerait indefiniment.
    const harness = makeHarness({ deadPty: true });

    const error = await refusal(harness);

    expect(isClaudeManagerError(error) && error.code).toBe(ERROR_CODES.SEED_PROCESS_NOT_STARTED);
    expect(harness.trace.calls).not.toContain('readProcessTable');
  });

  it('n attache RIEN quand le tour n a pas demarre', async () => {
    const harness = makeHarness({ processTables: [tableWithoutSeed()] });

    await refusal(harness);

    expect(harness.trace.calls.some((call) => call.includes('sessionId'))).toBe(false);
  });
});

describe('etape 6 — LE TOUR 1 A EU LIEU (defaut de recette du 2026-07-26)', () => {
  /**
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * LE GARDE-FOU DU DEFAUT, ET IL PORTE SUR UN ORDONNANCEMENT.
   *
   * CE QUI ETAIT CASSE : `dispose()` tombait 2,1 s apres l'envoi de la ligne — mesure en
   * recette, journal de l'extension a l'appui — alors que le `claude` du tour 1 en etait encore
   * a son demarrage. Or `dispose()` TUE ce processus (ADR-002). Le panneau s'attachait sur une
   * session VIDE, aucun transcript n'etait ecrit, et la route rendait `HTTP 200` en 2 s.
   *
   * CE QUE CE TEST OBSERVE, ET POURQUOI CETTE FORME : il ne compare pas des positions dans un
   * journal de traces — il releve, A L'INSTANT MEME DU `dispose()`, si le transcript de la
   * session existait. C'est la seule question qui decide du sort du tour. Le fichier, lui,
   * n'apparait que parce que le mecanisme a REELLEMENT patiente : il est ecrit depuis l'attente
   * injectee. Un mecanisme qui n'attend pas ne peut donc pas le voir.
   *
   * PREUVE DU FAILS-BEFORE : joue contre le `conversations.ts` d'avant le correctif, ce test
   * echoue sur `transcriptAtDispose.found` — `false`, aucun fichier n'existait quand le terminal
   * a ete supprime.
   * ─────────────────────────────────────────────────────────────────────────────────────────
   */
  it('ne supprime JAMAIS le terminal avant que le transcript de la session n existe', async () => {
    const harness = makeHarness();

    const result = await harness.open('x');

    expect(harness.trace.transcriptAtDispose?.found).toBe(true);
    expect(result.firstTurn).toBe('transcript-observed');
    expect(result.firstTurnVerified).toBe(true);
  });

  it('ne supprime pas le terminal avant que la SORTIE du tour n ait ete ecrite', async () => {
    // MESURE DU 2026-07-26 : le transcript apparait a +2 533 ms avec le prompt et SANS la
    // reponse, qui n'arrive qu'a +6 417 ms. Supprimer a l'apparition tuerait la reponse en vol —
    // le defaut d'origine, reproduit un etage plus haut.
    const harness = makeHarness();

    await harness.open('x');

    expect(harness.trace.transcriptAtDispose?.bytes).toBe(
      TRANSCRIPT_AT_APPEARANCE.length + TURN_OUTPUT.length
    );
  });

  it('ATTEND le transcript avant d attacher — et l attente est branchee sur l attente injectee', async () => {
    const harness = makeHarness();

    await harness.open('x');

    const order = harness.trace.calls;
    // Le journal dit l'ordre ; le releve ci-dessus dit le FAIT. Les deux, pas l'un ou l'autre.
    const observed = harness.trace.lines.findIndex((line) => line.includes('transcript appeared'));
    expect(observed).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('sendText')).toBeLessThan(order.indexOf('dispose'));
    expect(order.indexOf(`executeCommand(${CLAUDE_OPEN_COMMAND}, sessionId)`)).toBeGreaterThan(
      order.indexOf('readProcessTable')
    );
  });

  it('trouve le fichier PAR SON NOM, sous un slug que personne ne calcule', async () => {
    // D7 — la derivation du slug depuis le `cwd` n'est pas contractuelle, et D17 laisse la
    // racine en `— non verifie`. Le NOM du fichier, lui, est l'identifiant que NOUS imposons.
    const harness = makeHarness();

    const result = await harness.open('x');

    expect(result.firstTurnVerified).toBe(true);
    expect(harness.transcriptFile).toContain(PROJECT_SLUG);
    expect(fs.existsSync(harness.transcriptFile)).toBe(true);
  });

  it('NOMME l echec quand aucun transcript n apparait — et supprime le terminal quand meme', async () => {
    const harness = makeHarness({ withoutTranscript: true });

    const error = await refusal(harness);

    expect(isClaudeManagerError(error) && error.code).toBe(ERROR_CODES.SEED_TRANSCRIPT_NOT_FOUND);
    // 45 s d'echelle a 500 ms de sondage : l'attente est BORNEE, et le detail le dit.
    expect(isClaudeManagerError(error) && error.details).toMatchObject({
      waitedMs: 45_000,
      rootsScanned: 1,
    });
    expect(harness.trace.terminals[0]?.disposed).toBe(true);
    // AUCUN panneau n'est attache sur une session sans tour : ce serait le panneau vide de la
    // recette, avec une erreur en plus.
    expect(harness.trace.calls.some((call) => call.includes('sessionId'))).toBe(false);
  });

  it('ne rend AUCUN chemin dans l erreur — le depot est public, ces racines portent le compte', async () => {
    const harness = makeHarness({ withoutTranscript: true });

    const error = await refusal(harness);

    // CONSTATE D'ABORD QU'IL Y A UNE ERREUR : sans cette ligne, le test passerait tout aussi
    // bien sur un mecanisme qui n'echoue pas du tout — c'est-a-dire sans rien eprouver.
    expect(isClaudeManagerError(error)).toBe(true);
    const serialized = JSON.stringify(isClaudeManagerError(error) ? error.toJSON() : {});
    expect(serialized).not.toContain('cmgr-open-');
    expect(serialized).not.toContain(PROJECT_SLUG);
    expect(serialized).not.toContain(SESSION_ID);
  });

  it('ne bascule JAMAIS en repli V5 quand le tour n a pas eu lieu — une session tourne peut-etre', async () => {
    const harness = makeHarness({ withoutTranscript: true });

    await refusal(harness);

    expect(harness.trace.calls).not.toContain(`executeCommand(${CLAUDE_OPEN_COMMAND}, null)`);
    expect(
      harness.trace.lines.some((line) => line.includes('a claude session may already be running'))
    ).toBe(true);
  });

  it('DIT que la sortie du tour n a pas fini de s ecrire, et ouvre quand meme', async () => {
    // NI ERREUR NI SILENCE : le tour est ENREGISTRE, seule sa sortie n'est pas retombee dans le
    // temps accorde. Refuser ici reviendrait a rejeter une conversation ouverte parce que le
    // service a ete lent.
    const harness = makeHarness({ transcriptAppearsAfterWaits: 1, transcriptGrowsAfterWaits: 0 });

    const result = await harness.open('x');

    expect(result.firstTurnVerified).toBe(true);
    expect(harness.trace.lines.some((line) => line.includes('had not settled'))).toBe(true);
    expect(harness.trace.transcriptAtDispose?.bytes).toBe(TRANSCRIPT_AT_APPEARANCE.length);
  });

  it('n interprete rien du fichier : un transcript VIDE compte comme un tour enregistre', async () => {
    // Lire le contenu est la frontiere du lot D. Ce que le mecanisme affirme est l'EXISTENCE.
    const harness = makeHarness({ withoutTranscript: true });
    fs.writeFileSync(harness.transcriptFile, '', 'utf8');

    const result = await harness.open('x');

    expect(result.firstTurnVerified).toBe(true);
  });
});

describe("ce que la reponse PROMET — trois etats mesures, et pas un de plus", () => {
  /**
   * L'HISTOIRE DE CE CHAMP, PARCE QU'ELLE EXPLIQUE SA FORME.
   *
   * La route rendait d'abord `mode: 'nominal'`, `humanActionRequired: false`, sans autre
   * qualificatif — c'est-a-dire, a la lecture, « la conversation est ouverte et le tour 1 est
   * joue ». C'etait FAUX : un `claude` lance avec la ligne EXACTE attendue peut rester bloque a
   * une porte du CLI sans ecrire une ligne de transcript (mesure, `showSetupScreens`). La reponse
   * s'est donc mise a porter `firstTurnVerified: false` — un aveu, faute de pouvoir verifier.
   *
   * ELLE LE VERIFIE DESORMAIS, et c'est le correctif du 2026-07-26 : le mecanisme constate
   * l'existence du transcript avant de rendre la main. `false` en voie amorcee n'est plus un etat
   * atteignable — il ne subsiste qu'en repli, et cote CLIENT pour lire une fenetre plus ancienne.
   */
  it('AFFIRME le tour 1 quand elle l a constate, et jamais autrement', async () => {
    const harness = makeHarness();

    const result = await harness.open('x');

    // `'nominal'` se lisait « tout va bien ». `'seeded'` dit la VOIE ; le tour, lui, est dit par
    // les deux champs suivants — jamais deduit du mode.
    expect(result.mode).toBe('seeded');
    expect(result.firstTurn).toBe('transcript-observed');
    expect(result.firstTurnVerified).toBe(true);
  });

  it('ne qualifie AUCUN tour en repli : il n y a pas de session amorcee', async () => {
    const harness = makeHarness();

    const result = await harness.open('A'.repeat(40_000));

    expect(result.mode).toBe('fallback');
    expect(result.firstTurn).toBe('not-attempted');
    expect(result.firstTurnVerified).toBe(false);
  });

  it('reserve `humanActionRequired` a ce qu il enonce vraiment — le champ pre-rempli', async () => {
    // Il ne dit RIEN de l'etat du tour 1 : c'est `firstTurnVerified` qui le porte. Les
    // confondre reintroduirait exactement l'ambiguite qu'on vient de retirer.
    expect((await makeHarness().open('x')).humanActionRequired).toBe(false);
    expect((await makeHarness().open('A'.repeat(40_000))).humanActionRequired).toBe(true);
  });
});

describe('etape 7 — le terminal disparait SUR TOUS LES CHEMINS', () => {
  it('sur l echec d attachement', async () => {
    const harness = makeHarness({ tabs: [[]] });

    await refusal(harness);

    expect(harness.trace.terminals[0]?.disposed).toBe(true);
    expect(fs.existsSync(harness.promptDirectory) ? fs.readdirSync(harness.promptDirectory) : []).toEqual([]);
  });

  it('sur une defaillance INATTENDUE de la commande d attachement', async () => {
    const harness = makeHarness({
      executeCommand: () => Promise.reject(new TypeError('interne')),
    });

    await expect(harness.open('x')).rejects.toBeInstanceOf(TypeError);

    // Une erreur qui n'est pas nommee remonte telle quelle — mais le terminal est supprime.
    expect(harness.trace.terminals[0]?.disposed).toBe(true);
  });
});

describe('etape 8 — le repli V5 s AJOUTE a l erreur nommee, il ne la remplace jamais', () => {
  it('bascule sur un prompt TROP GRAND, et rend LES DEUX', async () => {
    const harness = makeHarness();

    const result = await harness.open('A'.repeat(40_000));

    expect(result.mode).toBe('fallback');
    // Aucune session amorcee : l'humain valide un champ pre-rempli.
    expect(result.sessionId).toBeNull();
    expect(result.humanActionRequired).toBe(true);
    // L'ERREUR QUI L'A CAUSE, dans la meme reponse : sans elle, l'appelant croirait le
    // mecanisme nominal intact (dette D18).
    expect(result.degradedFrom?.code).toBe(ERROR_CODES.PROMPT_TOO_LARGE);
    expect(result.degradedFrom?.remediation).toBeTruthy();
  });

  it('emet l erreur nommee AVANT d executer le repli — l ordre n est pas negociable', async () => {
    const harness = makeHarness();

    await harness.open('A'.repeat(40_000));

    const failure = harness.trace.lines.findIndex((line) => line.includes('the nominal V1 path failed'));
    const fallback = harness.trace.calls.indexOf(`executeCommand(${CLAUDE_OPEN_COMMAND}, null)`);
    expect(failure).toBeGreaterThanOrEqual(0);
    expect(fallback).toBeGreaterThanOrEqual(0);
    // Le journal porte l'erreur, et le repli n'est parti qu'ensuite.
    expect(harness.trace.lines[failure]).toContain(ERROR_CODES.PROMPT_TOO_LARGE);
    expect(harness.trace.lines.some((line) => line.includes('PRE-FILLED, NOT submitted'))).toBe(true);
  });

  it('bascule aussi quand le binaire claude est introuvable', async () => {
    const harness = makeHarness({ withoutClaude: true });

    const result = await harness.open('x');

    expect(result.mode).toBe('fallback');
    expect(result.degradedFrom?.code).toBe(ERROR_CODES.CLAUDE_BINARY_NOT_FOUND);
    // Le NOMBRE d'emplacements sondes, jamais leur chemin : le depot est public.
    expect(JSON.stringify(result.degradedFrom?.details)).not.toContain('cmgr-open-');
  });

  it('bascule aussi quand pwsh est introuvable — jamais un autre shell en silence', async () => {
    const harness = makeHarness({ withoutShell: true });

    const result = await harness.open('x');

    expect(result.mode).toBe('fallback');
    expect(result.degradedFrom?.code).toBe(ERROR_CODES.SEED_SHELL_NOT_FOUND);
  });

  it('NE BASCULE JAMAIS une fois le terminal cree — un second panneau serait pire', async () => {
    // LE CRITERE, ET IL EST LA : une vraie session `claude` tourne peut-etre. Le repli repare
    // une INDISPONIBILITE, jamais une latence.
    const harness = makeHarness({ tabs: [[]] });

    const error = await refusal(harness);

    expect(isClaudeManagerError(error)).toBe(true);
    expect(harness.trace.calls).not.toContain(`executeCommand(${CLAUDE_OPEN_COMMAND}, null)`);
    expect(harness.trace.lines.some((line) => line.includes('a claude session may already be running'))).toBe(true);
  });

  it('rend l erreur NOMINALE quand le repli echoue a son tour', async () => {
    const harness = makeHarness({
      withoutClaude: true,
      executeCommand: () => Promise.reject(new Error('la commande a disparu entre-temps')),
    });

    const error = await refusal(harness, 'x');

    // C'est la cause NOMINALE que l'appelant doit diagnostiquer, pas la consequence.
    expect(isClaudeManagerError(error) && error.code).toBe(ERROR_CODES.CLAUDE_BINARY_NOT_FOUND);
    expect(harness.trace.lines.some((line) => line.includes('the V5 fallback failed too'))).toBe(true);
  });
});

describe('ce que le mecanisme prend du PROCESSUS quand on ne lui dit rien', () => {
  it('retombe sur la plateforme, l environnement et l uuid du processus', async () => {
    // Les quatre valeurs par defaut sont relevees a l'entree, AVANT le moindre refus : un
    // refus precoce suffit donc a les eprouver sans lancer quoi que ce soit.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmgr-open-'));
    temporaries.push(root);
    const editor = makeHarness({ isTrusted: false }).editor;

    await expect(
      openConversation(
        { prompt: 'x' },
        { editor, extHostPid: 1, promptDirectory: path.join(root, 'p'), log: () => undefined }
      )
    ).rejects.toMatchObject({ code: ERROR_CODES.WORKSPACE_NOT_TRUSTED });
  });

  it(
    'attend REELLEMENT entre deux sondages quand aucune attente n est injectee',
    async () => {
      // Un releve vide de plus qu'au cas nominal : le premier sondage manque le panneau, et
      // c'est le minuteur reel qui porte l'echelon suivant. Le transcript, lui, est deja la et
      // GROSSIT pour de vrai a 300 ms — l'attente de la sortie du tour est donc portee par le
      // minuteur reel elle aussi, ce qui explique les ~3,5 s de ce test (3 s de silence exige).
      const harness = makeHarness({
        tabs: [[], [], [{ viewType: PANEL_VIEW_TYPE, label: 'ouverte' }]],
        transcriptAlreadyThere: true,
      });
      const grow = setTimeout(() => fs.appendFileSync(harness.transcriptFile, TURN_OUTPUT), 300);
      const started = Date.now();

      const result = await openConversation(
        { prompt: 'x' },
        {
          editor: harness.editor,
          extHostPid: 11172,
          promptDirectory: harness.promptDirectory,
          log: (message) => harness.trace.lines.push(message),
          platform: 'win32',
          environment: { PATH: harness.binDirectory },
          transcriptProjectRoots: [harness.transcriptRoot],
          // LE MEME identifiant que celui du fichier prepare : c'est son NOM que le mecanisme
          // cherche. Sans lui, `randomUUID` designerait un transcript que personne n'a ecrit.
          newSessionId: () => SESSION_ID,
          // L'inventaire des processus est injecte — sinon ce test lancerait huit
          // `Get-CimInstance` reels. C'est l'ATTENTE qu'il eprouve, pas l'inventaire.
          readProcessTable: () => Promise.resolve(tableWithSeed()),
        }
      );
      clearTimeout(grow);

      expect(result.mode).toBe('seeded');
      // Le silence exige de la sortie du tour est de 3 s : le minuteur REEL les a portees.
      expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
      expect(harness.trace.lines.some((line) => line.includes('turn output settled'))).toBe(true);
    },
    // L'echelle reelle de ce test se compte en secondes, par construction : c'est le minuteur
    // du systeme qu'il eprouve. Le delai par defaut de vitest (5 s) ne suffirait pas.
    20_000
  );

  it('lit `Path` quand Windows ne rend pas `PATH` — la casse n est pas garantie', async () => {
    const harness = makeHarness({ transcriptAlreadyThere: true });

    const result = await openConversation(
      { prompt: 'x' },
      {
        editor: harness.editor,
        extHostPid: 11172,
        promptDirectory: harness.promptDirectory,
        log: () => undefined,
        platform: 'win32',
        environment: { Path: harness.binDirectory },
        transcriptProjectRoots: [harness.transcriptRoot],
        newSessionId: () => SESSION_ID,
        wait: () => Promise.resolve(),
        readProcessTable: () => Promise.resolve(tableWithSeed()),
      }
    );

    expect(result.mode).toBe('seeded');
  });

  it('cherche sous les racines de projets du CLI quand personne ne les lui donne', async () => {
    // Le defaut est `<HOME>/.claude/projects`, plus la racine de `CLAUDE_CONFIG_DIR` si elle est
    // posee (D17). AUCUN transcript n'y sera jamais ecrit pour cette session inventee : ce que ce
    // test etablit est que l'absence de racine injectee ne fait pas planter le mecanisme, et
    // qu'elle aboutit a l'erreur NOMMEE — pas a un succes.
    const harness = makeHarness();

    await expect(
      openConversation(
        { prompt: 'x' },
        {
          editor: harness.editor,
          extHostPid: 11172,
          promptDirectory: harness.promptDirectory,
          log: () => undefined,
          platform: 'win32',
          environment: { PATH: harness.binDirectory },
          wait: () => Promise.resolve(),
          newSessionId: () => 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          readProcessTable: () => Promise.resolve(tableWithSeed()),
        }
      )
    ).rejects.toMatchObject({ code: ERROR_CODES.SEED_TRANSCRIPT_NOT_FOUND });
  });
});

describe('hygiene et concurrence', () => {
  it('refuse par une erreur NOMMEE quand le prompt ne peut pas etre ecrit', async () => {
    const harness = makeHarness();
    // Le repertoire de transit est occupe par un FICHIER : `mkdirSync` echoue.
    fs.mkdirSync(path.dirname(harness.promptDirectory), { recursive: true });
    fs.writeFileSync(harness.promptDirectory, 'pas un repertoire', 'utf8');

    const result = await harness.open('x');

    // Defaillance ANTERIEURE au terminal : le repli est donc encore disponible.
    expect(result.mode).toBe('fallback');
    expect(result.degradedFrom?.code).toBe(ERROR_CODES.PROMPT_FILE_UNWRITABLE);
    // Le code systeme seul, jamais le chemin : le depot est public.
    expect(JSON.stringify(result.degradedFrom?.details)).not.toContain('cmgr-open-');
  });

  it('DIT ce qu elle n a pas pu balayer, et ouvre quand meme', async () => {
    const harness = makeHarness();
    fs.mkdirSync(harness.promptDirectory, { recursive: true });
    // Un REPERTOIRE portant le nom d'un prompt : le prix d'un `mkdir` pour n'importe quel
    // processus du compte. `rmSync` sans `recursive` le refuse.
    const trap = path.join(harness.promptDirectory, 'piege.prompt.txt');
    fs.mkdirSync(trap);
    const ancient = Date.now() - 7_200_000;
    fs.utimesSync(trap, ancient / 1000, ancient / 1000);

    const result = await harness.open('x');

    // L'hygiene ne fait PAS echouer une ouverture — mais elle ne se tait pas non plus.
    expect(result.mode).toBe('seeded');
    expect(harness.trace.lines.some((line) => line.includes('could not sweep'))).toBe(true);
    expect(fs.existsSync(trap)).toBe(true);
  });


  it('efface un prompt ABANDONNE par un cycle mort, jamais celui d un cycle en cours', async () => {
    const harness = makeHarness();
    fs.mkdirSync(harness.promptDirectory, { recursive: true });
    const old = path.join(harness.promptDirectory, 'ancienne-session.prompt.txt');
    const recent = path.join(harness.promptDirectory, 'recente-session.prompt.txt');
    const keptFile = path.join(harness.promptDirectory, 'autre-chose.txt');
    for (const file of [old, recent, keptFile]) fs.writeFileSync(file, 'prompt', 'utf8');
    // Deux heures : bien au-dela des 62 s d'un cycle d'ouverture.
    const ancient = Date.now() - 7_200_000;
    fs.utimesSync(old, ancient / 1000, ancient / 1000);

    await harness.open('x');

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    // Un fichier hors convention n'a pas ete ecrit par nous : on n'y touche pas.
    expect(fs.existsSync(keptFile)).toBe(true);
  });

  it('serialise les ouvertures : deux diffs d onglets concurrents se voleraient leur panneau', async () => {
    const order: string[] = [];
    const serialized = serializeOpenings(async (label: string) => {
      order.push(`debut ${label}`);
      await new Promise((done) => setTimeout(done, 5));
      order.push(`fin ${label}`);
      return { ok: true, mode: 'seeded', sessionId: label, extHostPid: 1, humanActionRequired: false,
        firstTurn: 'transcript-observed', firstTurnVerified: true };
    });

    await Promise.all([serialized('a'), serialized('b')]);

    expect(order).toEqual(['debut a', 'fin a', 'debut b', 'fin b']);
  });

  it('une ouverture qui echoue ne bloque pas les suivantes', async () => {
    let calls = 0;
    const serialized = serializeOpenings((label: string) => {
      calls += 1;
      return label === 'ko'
        ? Promise.reject(new Error('ko'))
        : Promise.resolve({ ok: true, mode: 'seeded', sessionId: label, extHostPid: 1, humanActionRequired: false,
        firstTurn: 'transcript-observed', firstTurnVerified: true } as OpenConversationResult);
    });

    await expect(serialized('ko')).rejects.toThrow('ko');
    await expect(serialized('ok')).resolves.toMatchObject({ sessionId: 'ok' });
    expect(calls).toBe(2);
  });
});
