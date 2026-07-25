import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readRegistry,
  requireOwningWindow,
  resolveOwningWindow,
  writeWindowEntry,
  type WindowEntry,
} from '../../../packages/core/src/index.js';
import { WINDOWS_ROLES } from '../identity/fixtures.js';
import { currentSchemaEntry, makeRegistryDir, REAL_TABLE } from './fixtures.js';

/**
 * L'invariant du produit, verifie de bout en bout DANS LE COEUR : du registre sur disque
 * jusqu'a la resolution de la fenetre hote, sur des pid mesures et dans la configuration la
 * plus adverse — deux fenetres ouvrant le MEME dossier.
 */

const CALLER = WINDOWS_ROLES.callerClaudePid;
const HOST = WINDOWS_ROLES.owningExtHostPid;
const SIBLING = WINDOWS_ROLES.otherExtHostPids[0] as number;

/** Le meme dossier de travail pour les deux fenetres : le cas de reference du produit. */
const SHARED_FOLDERS = currentSchemaEntry(HOST).workspaceFolders;

function entryOn(extHostPid: number): WindowEntry {
  return { ...currentSchemaEntry(extHostPid), workspaceFolders: SHARED_FOLDERS };
}

let dir: string;

beforeEach(() => {
  dir = makeRegistryDir();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('registre + identite — deux fenetres sur le meme dossier', () => {
  it('retient la fenetre hote et JAMAIS sa voisine', () => {
    writeWindowEntry(entryOn(HOST), { dir });
    writeWindowEntry(entryOn(SIBLING), { dir });

    const { windows } = readRegistry({ table: REAL_TABLE, dir });

    expect(windows).toHaveLength(2);
    expect(windows.map((window) => window.workspaceFolders)).toEqual([
      SHARED_FOLDERS,
      SHARED_FOLDERS,
    ]);
    expect(resolveOwningWindow(CALLER, REAL_TABLE, windows)?.extHostPid).toBe(HOST);
    expect(requireOwningWindow(CALLER, REAL_TABLE, windows).extHostPid).toBe(HOST);
  });

  it('rend le meme verdict quel que soit l ordre des ecritures', () => {
    // L ordre de lecture du systeme de fichiers ne doit tenir lieu d aucun arbitrage.
    writeWindowEntry(entryOn(SIBLING), { dir });
    writeWindowEntry(entryOn(HOST), { dir });

    const { windows } = readRegistry({ table: REAL_TABLE, dir });

    expect(resolveOwningWindow(CALLER, REAL_TABLE, windows)?.extHostPid).toBe(HOST);
  });

  it('ne revendique rien quand seule la voisine est enregistree', () => {
    writeWindowEntry(entryOn(SIBLING), { dir });

    const { windows } = readRegistry({ table: REAL_TABLE, dir });

    expect(windows).toHaveLength(1);
    expect(resolveOwningWindow(CALLER, REAL_TABLE, windows)).toBeUndefined();
  });

  it('ne se laisse pas duper par le port ni par le jeton de la voisine', () => {
    // Aucun critere autre que l extHostPid ne doit entrer dans la resolution : ici les deux
    // entrees ne different plus QUE par lui.
    const host = entryOn(HOST);
    const sibling: WindowEntry = { ...host, extHostPid: SIBLING, mainPid: host.mainPid };
    writeWindowEntry(host, { dir });
    writeWindowEntry(sibling, { dir });

    const { windows } = readRegistry({ table: REAL_TABLE, dir });

    expect(windows).toHaveLength(2);
    expect(resolveOwningWindow(CALLER, REAL_TABLE, windows)?.extHostPid).toBe(HOST);
  });
});
