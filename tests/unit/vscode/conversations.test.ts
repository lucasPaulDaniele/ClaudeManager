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
}

interface Harness {
  readonly trace: Trace;
  readonly editor: EditorPort;
  readonly promptDirectory: string;
  readonly binDirectory: string;
  open(prompt: string): Promise<OpenConversationResult>;
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

  const trace: Trace = { calls: [], lines: [], terminals: [], sent: [] };
  const tabs = options.tabs ?? [[], [{ viewType: PANEL_VIEW_TYPE, label: 'ouverte' }]];
  let releve = 0;
  let tableReads = 0;

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
          // On n'attend pas reellement : ce qu'il faut prouver est que l'echelle est BORNEE
          // et que la commande est re-emise, pas la patience du minuteur.
          wait: () => Promise.resolve(),
          newSessionId: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
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

    expect(result).toMatchObject({ ok: true, mode: 'nominal', extHostPid: 11172, humanActionRequired: false });
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
  it('ATTEND le processus amorce AVANT d attacher — sinon on tue le tour a sa naissance', async () => {
    // LE GARDE-FOU DE NON-REGRESSION. Falsification jouee en vraie fenetre : `editor.open`
    // ouvre un panneau MEME pour une session jamais amorcee. Le diff d'onglets aboutissait
    // donc en moins de 200 ms, `dispose()` suivait, et la suppression du terminal TUE le
    // `claude` du tour 1 : le tour etait interrompu et la route rendait un succes.
    const harness = makeHarness();

    const result = await harness.open('x');

    const order = harness.trace.calls;
    expect(order.indexOf('readProcessTable')).toBeGreaterThan(order.indexOf('sendText'));
    expect(order.indexOf('readProcessTable')).toBeLessThan(
      order.indexOf(`executeCommand(${CLAUDE_OPEN_COMMAND}, sessionId)`)
    );
    expect(result.seedProcessObserved).toBe(true);
  });

  it('patiente tant que le shell n a rien engendre, puis repart des qu il l a fait', async () => {
    const harness = makeHarness({
      processTables: [tableWithoutSeed(), tableWithoutSeed(), tableWithSeed()],
    });

    const result = await harness.open('x');

    expect(result.mode).toBe('nominal');
    expect(harness.trace.calls.filter((call) => call === 'readProcessTable')).toHaveLength(3);
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

  it('attend REELLEMENT entre deux sondages quand aucune attente n est injectee', async () => {
    // Un releve vide de plus qu'au cas nominal : le premier sondage manque le panneau, et
    // c'est le minuteur reel qui porte l'echelon suivant.
    const harness = makeHarness({
      tabs: [[], [], [{ viewType: PANEL_VIEW_TYPE, label: 'ouverte' }]],
    });
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
        // L'inventaire des processus est injecte — sinon ce test lancerait huit
        // `Get-CimInstance` reels. C'est l'ATTENTE qu'il eprouve, pas l'inventaire.
        readProcessTable: () => Promise.resolve(tableWithSeed()),
      }
    );

    expect(result.mode).toBe('nominal');
    // La granularite du sondage est de 250 ms : au moins une attente a eu lieu.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  it('lit `Path` quand Windows ne rend pas `PATH` — la casse n est pas garantie', async () => {
    const harness = makeHarness();

    const result = await openConversation(
      { prompt: 'x' },
      {
        editor: harness.editor,
        extHostPid: 11172,
        promptDirectory: harness.promptDirectory,
        log: () => undefined,
        platform: 'win32',
        environment: { Path: harness.binDirectory },
        wait: () => Promise.resolve(),
        readProcessTable: () => Promise.resolve(tableWithSeed()),
      }
    );

    expect(result.mode).toBe('nominal');
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
    expect(result.mode).toBe('nominal');
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
      return { ok: true, mode: 'nominal', sessionId: label, extHostPid: 1, humanActionRequired: false };
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
        : Promise.resolve({ ok: true, mode: 'nominal', sessionId: label, extHostPid: 1, humanActionRequired: false } as OpenConversationResult);
    });

    await expect(serialized('ko')).rejects.toThrow('ko');
    await expect(serialized('ok')).resolves.toMatchObject({ sessionId: 'ok' });
    expect(calls).toBe(2);
  });
});
