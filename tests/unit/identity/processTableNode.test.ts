import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  ClaudeManagerError,
  ERROR_CODES,
  isClaudeManagerError,
  readProcessTable,
  type CommandRunner,
} from '../../../packages/core/src/index.js';
import { POSIX_CAPTURE, POSIX_ROLES, WINDOWS_CAPTURE, WINDOWS_ROLES } from './fixtures.js';

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Rejoue une capture reelle a la place de l'appel systeme, en enregistrant la commande
 * effectivement demandee. Ce n'est pas un faux systeme : la sortie rendue a ete produite
 * par la vraie commande sur une vraie machine (voir tests/fixtures/identity/README.md).
 */
function replay(capture: string, calls: Call[]): CommandRunner {
  return (command, args) => {
    calls.push({ command, args });
    return capture;
  };
}

function catchFailure(operation: () => unknown): ClaudeManagerError {
  try {
    operation();
  } catch (error) {
    return error as ClaudeManagerError;
  }
  throw new Error("l'operation devait lever une ClaudeManagerError");
}

describe('readProcessTable — branche win32', () => {
  it('emet EXACTEMENT la commande avec laquelle la capture a ete prise', () => {
    // Ce test ferme la boucle : si la commande de production derive de celle documentee
    // dans la provenance de la fixture, la fixture cesse de prouver quoi que ce soit.
    const calls: Call[] = [];
    readProcessTable({ platform: 'win32', run: replay(WINDOWS_CAPTURE, calls) });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('powershell.exe');
    expect(calls[0]?.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_ROLES.provenance.command,
    ]);
  });

  it('rend une table coherente avec les roles releves', () => {
    const table = readProcessTable({ platform: 'win32', run: replay(WINDOWS_CAPTURE, []) });

    expect(table.size).toBeGreaterThan(0);
    expect(table.get(WINDOWS_ROLES.owningExtHostPid)).toBe(WINDOWS_ROLES.mainCodePid);
  });
});

describe('readProcessTable — branche POSIX', () => {
  it('emet EXACTEMENT la commande avec laquelle la capture a ete prise', () => {
    const calls: Call[] = [];
    readProcessTable({ platform: 'linux', run: replay(POSIX_CAPTURE, calls) });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(POSIX_ROLES.provenance.command);
    expect(calls[0]?.args).toEqual(POSIX_ROLES.provenance.args);
  });

  it('rend la table exploitable relevee a la capture', () => {
    const table = readProcessTable({ platform: 'linux', run: replay(POSIX_CAPTURE, []) });

    expect(table.size).toBe(POSIX_ROLES.usableEntryCount);
  });
});

describe('readProcessTable — defaillances', () => {
  it('nomme l echec quand la commande d inventaire ne peut pas s executer', () => {
    // Echec systeme reel et identique sur toutes les plateformes : le binaire n'existe pas.
    const failure = catchFailure(() =>
      readProcessTable({
        platform: 'linux',
        run: (_command, _args) =>
          execFileSync('claudemanager-no-such-inventory-binary', [], { encoding: 'utf8' }),
      })
    );

    expect(isClaudeManagerError(failure)).toBe(true);
    expect(failure.code).toBe(ERROR_CODES.PROCESS_TABLE_UNAVAILABLE);
    expect(failure.remediation.length).toBeGreaterThan(0);
    expect(failure.details?.['platform']).toBe('linux');
    expect(String(failure.details?.['cause']).length).toBeGreaterThan(0);
  });

  it('rend la cause meme quand ce qui est leve n est pas une Error', () => {
    const failure = catchFailure(() =>
      readProcessTable({
        platform: 'win32',
        run: () => {
          throw 'acces refuse';
        },
      })
    );

    expect(failure.details?.['cause']).toBe('acces refuse');
  });

  it('refuse une table vide : un processus se lit toujours au moins lui-meme', () => {
    const failure = catchFailure(() =>
      readProcessTable({ platform: 'linux', run: () => 'PID PPID\n' })
    );

    expect(failure.code).toBe(ERROR_CODES.PROCESS_TABLE_UNAVAILABLE);
    expect(failure.message).toMatch(/no usable entry/);
  });
});

describe('readProcessTable — systeme reel, sans aucune injection', () => {
  // Seule verification qui garantit que les analyseurs collent encore a la realite de
  // chaque plateforme. Elle tourne sur Windows en local ET sur Linux en CI, jamais ignoree.
  it('inventorie le processus courant et son parent', () => {
    const table = readProcessTable();

    expect(table.size).toBeGreaterThan(1);
    expect(table.has(process.pid)).toBe(true);
    expect(table.get(process.pid)).toBe(process.ppid);
  }, 30_000);
});
