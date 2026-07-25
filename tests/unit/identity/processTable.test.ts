import { describe, expect, it } from 'vitest';
import {
  parsePosixProcessTable,
  parseWindowsProcessTable,
} from '../../../packages/core/src/index.js';
import { POSIX_CAPTURE, POSIX_ROLES, WINDOWS_CAPTURE, WINDOWS_ROLES } from './fixtures.js';

describe('parseWindowsProcessTable — sur la capture reelle', () => {
  const table = parseWindowsProcessTable(WINDOWS_CAPTURE);

  it('rend une table non vide', () => {
    expect(table.size).toBeGreaterThan(0);
  });

  it('retrouve les liens de parente releves a la capture', () => {
    // Ces couples sont ceux documentes dans windows-process-table.roles.json.
    expect(table.get(WINDOWS_ROLES.callerClaudePid)).toBe(WINDOWS_ROLES.expectedAncestry[0]);
    expect(table.get(WINDOWS_ROLES.owningExtHostPid)).toBe(WINDOWS_ROLES.mainCodePid);
    for (const host of WINDOWS_ROLES.extensionHosts) {
      expect(table.get(host.pid), `extension host ${host.pid}`).toBe(host.ppid);
    }
  });

  it('rejette les entrees non strictement positives que la capture contient reellement', () => {
    // La capture porte `0,0` (processus Idle) et `4,0` (System) : ni l'un ni l'autre ne
    // designe un processus dont on puisse remonter la parente.
    expect(WINDOWS_CAPTURE).toMatch(/^0,0\r?$/m);
    expect(WINDOWS_CAPTURE).toMatch(/^4,0\r?$/m);
    expect(table.has(0)).toBe(false);
    expect(table.has(4)).toBe(false);
  });

  it('ignore moins d une entree sur dix — la capture est presque integralement lisible', () => {
    const lines = WINDOWS_CAPTURE.split(/\r?\n/).filter((line) => line.length > 0);
    expect(table.size).toBeGreaterThan(lines.length * 0.9);
  });
});

describe('parseWindowsProcessTable — tolerances', () => {
  it('accepte guillemets, espaces et les deux fins de ligne', () => {
    const table = parseWindowsProcessTable('"100","10"\r\n 200 , 20 \n"300",30');

    expect([...table.entries()]).toEqual([
      [100, 10],
      [200, 20],
      [300, 30],
    ]);
  });

  it('ignore lignes vides, en-tete et bruit sans faire echouer l inventaire', () => {
    const table = parseWindowsProcessTable(
      ['ProcessId,ParentProcessId', '', '100,10', '   ', 'Get-CimInstance : acces refuse', '200,20'].join('\n')
    );

    expect([...table.keys()]).toEqual([100, 200]);
  });

  it('rejette une entree dont le pid ou le ppid n est pas un entier positif', () => {
    const table = parseWindowsProcessTable(['0,0', '4,0', '-5,10', '1.5,10', 'abc,10', '100,10'].join('\n'));

    expect([...table.entries()]).toEqual([[100, 10]]);
  });

  it('rend une table vide sur une entree vide', () => {
    expect(parseWindowsProcessTable('').size).toBe(0);
  });
});

describe('parsePosixProcessTable — sur la capture reelle', () => {
  const table = parsePosixProcessTable(POSIX_CAPTURE);

  it('rend exactement les entrees exploitables relevees a la capture', () => {
    expect(table.size).toBe(POSIX_ROLES.usableEntryCount);
  });

  it('rejette la racine, dont le ppid vaut 0', () => {
    expect(POSIX_CAPTURE).toMatch(/^\s+1\s+0$/m);
    expect(table.has(POSIX_ROLES.rootPid)).toBe(false);
  });

  it('retrouve la plus longue chaine relevee dans la capture', () => {
    const { from, ancestors } = POSIX_ROLES.longestChain;
    expect(table.get(from)).toBe(ancestors[0]);
  });
});

describe('parsePosixProcessTable — tolerances', () => {
  it('accepte les espaces de cadrage et les deux fins de ligne', () => {
    const table = parsePosixProcessTable('    100     10\r\n 200 20 \n300 30');

    expect([...table.entries()]).toEqual([
      [100, 10],
      [200, 20],
      [300, 30],
    ]);
  });

  it('ignore une ligne portant plus de deux colonnes plutot que de la deviner', () => {
    const table = parsePosixProcessTable(['  PID  PPID', '100 10 node', '200 20'].join('\n'));

    expect([...table.keys()]).toEqual([200]);
  });
});
