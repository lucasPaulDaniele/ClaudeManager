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
    expect(table.get(WINDOWS_ROLES.callerClaudePid)?.ppid).toBe(WINDOWS_ROLES.expectedAncestry[0]);
    expect(table.get(WINDOWS_ROLES.owningExtHostPid)?.ppid).toBe(WINDOWS_ROLES.mainCodePid);
    for (const host of WINDOWS_ROLES.extensionHosts) {
      expect(table.get(host.pid)?.ppid, `extension host ${host.pid}`).toBe(host.ppid);
    }
  });

  it('retrouve les dates de creation relevees a la capture', () => {
    // La seconde garde anti-reemploi de pid n a de valeur que si cette colonne est lue.
    for (const host of WINDOWS_ROLES.extensionHosts) {
      expect(table.get(host.pid)?.createdAt, `extension host ${host.pid}`).toBe(host.createdAt);
    }

    const recycled = WINDOWS_ROLES.pidRecycledUnderTheSameParent;
    expect(table.get(recycled.pid)).toEqual({ ppid: recycled.ppid, createdAt: recycled.createdAt });
  });

  it('porte un temoin REEL de ce que la garde par le seul ppid ne voit pas', () => {
    // Meme parent que l extension host, et pourtant ce n est pas lui : ne bien plus tard.
    const recycled = WINDOWS_ROLES.pidRecycledUnderTheSameParent;
    const host = table.get(WINDOWS_ROLES.owningExtHostPid);

    expect(recycled.ppid).toBe(WINDOWS_ROLES.mainCodePid);
    expect(host?.ppid).toBe(WINDOWS_ROLES.mainCodePid);
    expect(recycled.createdAt).toBeGreaterThan(host?.createdAt as number);
  });

  it('rejette les entrees non strictement positives que la capture contient reellement', () => {
    // La capture porte `0,0,...` (processus Idle) et `4,0,...` (System) : ni l'un ni
    // l'autre ne designe un processus dont on puisse remonter la parente.
    expect(WINDOWS_CAPTURE).toMatch(/^0,0,\d+\r?$/m);
    expect(WINDOWS_CAPTURE).toMatch(/^4,0,\d+\r?$/m);
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
    const table = parseWindowsProcessTable('"100","10","1000"\r\n 200 , 20 , 2000 \n"300",30,3000');

    expect([...table.entries()]).toEqual([
      [100, { ppid: 10, createdAt: 1000 }],
      [200, { ppid: 20, createdAt: 2000 }],
      [300, { ppid: 30, createdAt: 3000 }],
    ]);
  });

  it('ignore lignes vides, en-tete et bruit sans faire echouer l inventaire', () => {
    const table = parseWindowsProcessTable(
      [
        'ProcessId,ParentProcessId,CreationDate',
        '',
        '100,10,1000',
        '   ',
        'Get-CimInstance : acces refuse',
        '200,20,2000',
      ].join('\n')
    );

    expect([...table.keys()]).toEqual([100, 200]);
  });

  it('tolere une date de creation absente sans perdre le processus', () => {
    // La commande rend une colonne vide plutot qu une erreur quand `CreationDate` manque :
    // une date qu on n a pas est une garde qui ne s applique pas, pas une entree perdue.
    const table = parseWindowsProcessTable('100,10,\n200,20,2000');

    expect(table.get(100)).toEqual({ ppid: 10, createdAt: undefined });
    expect(table.get(200)?.createdAt).toBe(2000);
  });

  it('rejette une entree dont le pid ou le ppid n est pas un entier positif', () => {
    const table = parseWindowsProcessTable(
      ['0,0,1000', '4,0,1000', '-5,10,1000', '1.5,10,1000', 'abc,10,1000', '100,10,1000'].join('\n')
    );

    expect([...table.entries()]).toEqual([[100, { ppid: 10, createdAt: 1000 }]]);
  });

  it('ignore une ligne a deux colonnes plutot que de deviner sa date', () => {
    // C est la forme de la capture d AVANT la recapture : elle n est plus celle que la
    // commande de production emet, on refuse de l interpreter.
    expect(parseWindowsProcessTable('100,10').size).toBe(0);
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
    expect(table.get(from)?.ppid).toBe(ancestors[0]);
  });

  it('ne porte AUCUNE date de creation : `ps -Ao pid=,ppid=` n en rend pas', () => {
    // Declare, pas oublie : voir tests/fixtures/identity/README.md. La garde par la date
    // ne s applique donc pas hors Windows ; celle du `ppid` s applique partout.
    for (const record of table.values()) expect(record.createdAt).toBeUndefined();
  });
});

describe('parsePosixProcessTable — tolerances', () => {
  it('accepte les espaces de cadrage et les deux fins de ligne', () => {
    const table = parsePosixProcessTable('    100     10\r\n 200 20 \n300 30');

    expect([...table.entries()]).toEqual([
      [100, { ppid: 10, createdAt: undefined }],
      [200, { ppid: 20, createdAt: undefined }],
      [300, { ppid: 30, createdAt: undefined }],
    ]);
  });

  it('ignore une ligne portant plus de deux colonnes plutot que de la deviner', () => {
    const table = parsePosixProcessTable(['  PID  PPID', '100 10 node', '200 20'].join('\n'));

    expect([...table.keys()]).toEqual([200]);
  });
});
