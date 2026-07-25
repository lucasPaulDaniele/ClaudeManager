import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ClaudeManagerError,
  ERROR_CODES,
  isClaudeManagerError,
  readProcessTable,
  type CommandRunner,
} from '../../../packages/core/src/index.js';
import { POSIX_CAPTURE, POSIX_ROLES, WINDOWS_CAPTURE, WINDOWS_ROLES } from './fixtures.js';

const execFileAsync = promisify(execFile);

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Rejoue une capture reelle a la place de l'appel systeme, en enregistrant la commande
 * effectivement demandee. Ce n'est pas un faux systeme : la sortie rendue a ete produite
 * par la vraie commande sur une vraie machine (voir tests/fixtures/identity/README.md).
 *
 * ASYNCHRONE comme l'est la vraie : un inventaire qui bloque la boucle d'evenements bloque
 * avec elle toutes les extensions de la fenetre.
 */
function replay(capture: string, calls: Call[]): CommandRunner {
  return async (command, args) => {
    calls.push({ command, args });
    return capture;
  };
}

async function catchFailure(operation: () => Promise<unknown>): Promise<ClaudeManagerError> {
  try {
    await operation();
  } catch (error) {
    return error as ClaudeManagerError;
  }
  throw new Error("l'operation devait lever une ClaudeManagerError");
}

describe('readProcessTable — branche win32', () => {
  it('emet EXACTEMENT la commande avec laquelle la capture a ete prise', async () => {
    // Ce test ferme la boucle : si la commande de production derive de celle documentee
    // dans la provenance de la fixture, la fixture cesse de prouver quoi que ce soit.
    const calls: Call[] = [];
    await readProcessTable({ platform: 'win32', run: replay(WINDOWS_CAPTURE, calls) });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('powershell.exe');
    expect(calls[0]?.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_ROLES.provenance.command,
    ]);
  });

  it('rend une table coherente avec les roles releves', async () => {
    const { table } = await readProcessTable({
      platform: 'win32',
      run: replay(WINDOWS_CAPTURE, []),
    });

    expect(table.size).toBeGreaterThan(0);
    expect(table.get(WINDOWS_ROLES.owningExtHostPid)).toBe(WINDOWS_ROLES.mainCodePid);
  });
});

describe('readProcessTable — branche POSIX', () => {
  it('emet EXACTEMENT la commande avec laquelle la capture a ete prise', async () => {
    const calls: Call[] = [];
    await readProcessTable({ platform: 'linux', run: replay(POSIX_CAPTURE, calls) });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(POSIX_ROLES.provenance.command);
    expect(calls[0]?.args).toEqual(POSIX_ROLES.provenance.args);
  });

  it('rend la table exploitable relevee a la capture', async () => {
    const { table } = await readProcessTable({ platform: 'linux', run: replay(POSIX_CAPTURE, []) });

    expect(table.size).toBe(POSIX_ROLES.usableEntryCount);
  });
});

describe('readProcessTable — instantane date', () => {
  it("n'analyse la sortie qu'une fois la commande REELLEMENT terminee", async () => {
    // Bascule asynchrone : tant que la lecture etait synchrone, un runner asynchrone lui
    // livrait une promesse a analyser, jamais une sortie.
    let finished = false;
    const deferred: CommandRunner = async () => {
      await new Promise((done) => setTimeout(done, 20));
      finished = true;
      return WINDOWS_CAPTURE;
    };

    const { table } = await readProcessTable({ platform: 'win32', run: deferred });

    expect(finished).toBe(true);
    expect(table.get(WINDOWS_ROLES.owningExtHostPid)).toBe(WINDOWS_ROLES.mainCodePid);
  });

  it("date l'instantane AVANT de lancer la commande, jamais apres", async () => {
    // La date est une borne INFERIEURE de l'age de l'instantane : c'est ce qui autorise la
    // purge a epargner tout fichier plus recent qu'elle. La dater de la FIN de l'enumeration
    // declarerait frais un instantane qui a deja manque les processus nes entre-temps.
    const before = Date.now();
    const slow: CommandRunner = async () => {
      await new Promise((done) => setTimeout(done, 50));
      return WINDOWS_CAPTURE;
    };

    const snapshot = await readProcessTable({ platform: 'win32', run: slow });

    expect(snapshot.capturedAt).toBeGreaterThanOrEqual(before);
    expect(snapshot.capturedAt).toBeLessThanOrEqual(Date.now() - 50);
  });
});

describe('readProcessTable — defaillances', () => {
  /** Rejoue un echec systeme REEL et rend la cause telle que l'erreur nommee la porte. */
  async function causeOf(run: CommandRunner): Promise<unknown> {
    const failure = await catchFailure(() => readProcessTable({ platform: 'linux', run }));

    expect(failure.code).toBe(ERROR_CODES.PROCESS_TABLE_UNAVAILABLE);
    return failure.details?.['cause'];
  }

  it('nomme l echec quand la commande d inventaire ne peut pas s executer', async () => {
    // Echec systeme reel et identique sur toutes les plateformes : le binaire n'existe pas.
    const failure = await catchFailure(() =>
      readProcessTable({
        platform: 'linux',
        run: async (_command, _args) => {
          const { stdout } = await execFileAsync('claudemanager-no-such-inventory-binary', [], {
            encoding: 'utf8',
          });
          return stdout;
        },
      })
    );

    expect(isClaudeManagerError(failure)).toBe(true);
    expect(failure.code).toBe(ERROR_CODES.PROCESS_TABLE_UNAVAILABLE);
    expect(failure.remediation.length).toBeGreaterThan(0);
    expect(failure.details?.['platform']).toBe('linux');
    expect(failure.details?.['cause']).toBe('ENOENT');
  });

  it('ne laisse passer que le CODE de la defaillance, jamais le message systeme', async () => {
    // Le message d'un `execFile` en echec recopie le stderr du processus — que rien ne
    // contraint — et les erreurs `fs` y ajoutent le chemin absolu, donc le nom de compte.
    // Ces details partent vers un agent et vers un journal joint a une PR publique.
    const noisy = await causeOf(async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['-e', 'process.stderr.write(process.env.HOME ?? process.env.USERPROFILE ?? "?"); process.exit(3)'],
        { encoding: 'utf8' }
      );
      return stdout;
    });

    expect(noisy).toBe('EXIT_3');
  });

  it('rend le signal quand le processus a ete tue plutot que sorti', async () => {
    const killed = await causeOf(async () => {
      const { stdout } = await execFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
        encoding: 'utf8',
        timeout: 200,
      });
      return stdout;
    });

    expect(killed).toBe('SIGTERM');
  });

  it('ne dit rien quand il n y a pas de code a dire', async () => {
    // Une defaillance sans code : on prefere ne rien affirmer plutot que recopier un texte
    // dont on ne sait pas ce qu'il contient.
    expect(
      await causeOf(() => {
        throw new Error('un message dont on ignore la provenance');
      })
    ).toBe('UNKNOWN');

    // Et ce qui est leve n'est meme pas toujours une Error.
    expect(
      await causeOf(() => {
        throw 'acces refuse';
      })
    ).toBe('UNKNOWN');
  });

  it('refuse une table vide : un processus se lit toujours au moins lui-meme', async () => {
    const failure = await catchFailure(() =>
      readProcessTable({ platform: 'linux', run: async () => 'PID PPID\n' })
    );

    expect(failure.code).toBe(ERROR_CODES.PROCESS_TABLE_UNAVAILABLE);
    expect(failure.message).toMatch(/no usable entry/);
  });
});

describe('readProcessTable — systeme reel, sans aucune injection', () => {
  // Seule verification qui garantit que les analyseurs collent encore a la realite de
  // chaque plateforme. Elle tourne sur Windows en local ET sur Linux en CI, jamais ignoree.
  it('inventorie le processus courant et son parent', async () => {
    const { table, capturedAt } = await readProcessTable();

    expect(table.size).toBeGreaterThan(1);
    expect(table.has(process.pid)).toBe(true);
    expect(table.get(process.pid)).toBe(process.ppid);
    expect(capturedAt).toBeLessThanOrEqual(Date.now());
  }, 30_000);
});
