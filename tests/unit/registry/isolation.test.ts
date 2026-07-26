import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeManagerError,
  ERROR_CODES,
  isClaudeManagerError,
  purgeStaleEntries,
  readRegistry,
  requireOwningWindow,
  resolveOwningWindow,
  writeWindowEntry,
  type WindowEntry,
} from '../../../packages/core/src/index.js';
import { WINDOWS_ROLES } from '../identity/fixtures.js';
import { currentSchemaEntry, makeRegistryDir, REAL_TABLE, snapshotOf } from './fixtures.js';

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

function catchFailure(operation: () => unknown): ClaudeManagerError {
  try {
    operation();
  } catch (error) {
    return error as ClaudeManagerError;
  }
  throw new Error("l'operation devait lever une ClaudeManagerError");
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

    const { windows } = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir });

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

    const { windows } = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect(resolveOwningWindow(CALLER, REAL_TABLE, windows)?.extHostPid).toBe(HOST);
  });

  it('ne revendique rien quand seule la voisine est enregistree', () => {
    writeWindowEntry(entryOn(SIBLING), { dir });

    const { windows } = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir });

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

    const { windows } = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect(windows).toHaveLength(2);
    expect(resolveOwningWindow(CALLER, REAL_TABLE, windows)?.extHostPid).toBe(HOST);
  });
});

/**
 * L'invariant eprouve sur des entrees MALVEILLANTES, et plus seulement honnetes.
 *
 * Le registre est l'ancre de confiance du produit : il vit dans un repertoire ou tout
 * processus du compte utilisateur peut ecrire — une autre extension VSCode, un
 * `postinstall` npm. Une entree forgee n'a pas besoin de casser la validation : il lui
 * suffit d'etre plus credible que la vraie.
 *
 * CE QUI EST EPROUVE ICI EST UNE MOITIE, ET IL FAUT LE DIRE : la forge qui S'AJOUTE au
 * registre sous un nom choisi. Celle qui SE SUBSTITUE — l'intrus ecrase le fichier qui porte
 * deja le bon nom — ne laisse aucune anomalie derriere elle, donc rien a assertir dans ce
 * fichier : elle est mesuree en `tests/unit/vscode/publication.test.ts` (defaut S2), du seul
 * point ou elle se voit, celui de la fenetre qui a ecrit l'entree.
 */
describe('registre + identite — entrees forgees', () => {
  /** Nom de fichier qui precede toute entree honnete dans l ordre alphabetique. */
  const FORGED_FILE = '0000.json';

  it('refuse une entree dont le nom de fichier ne vaut pas l identite revendiquee', () => {
    // La forge exacte : les pid REELS de la fenetre hote, un port et un jeton a
    // l attaquant, et un nom de fichier choisi pour passer en tete de `readdir`.
    const forged: WindowEntry = { ...entryOn(HOST), port: 65_000, token: 'jeton-de-l-attaquant' };
    writeFileSync(path.join(dir, FORGED_FILE), JSON.stringify(forged, null, 2), 'utf8');
    writeWindowEntry(entryOn(HOST), { dir });

    const { windows, skipped } = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect(skipped).toEqual([{ file: FORGED_FILE, reason: 'identity-mismatch' }]);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.token).toBe(entryOn(HOST).token);
    expect(resolveOwningWindow(CALLER, REAL_TABLE, windows)?.token).toBe(entryOn(HOST).token);
  });

  it('ne la supprime pas pour autant : la purge reste conservatrice, mais elle la nomme', () => {
    const forged: WindowEntry = { ...entryOn(HOST), port: 65_000, token: 'jeton-de-l-attaquant' };
    writeFileSync(path.join(dir, FORGED_FILE), JSON.stringify(forged, null, 2), 'utf8');

    const result = purgeStaleEntries({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([{ file: FORGED_FILE, reason: 'identity-mismatch' }]);
  });

  it('traite deux fenetres de MEME extHostPid comme une anomalie nommee, jamais un arbitrage', () => {
    // Apres la garde du nom de fichier, ce cas ne peut plus venir que d une duplication ou
    // d une forge : departager reviendrait a laisser gagner l une des deux en silence.
    const first = entryOn(HOST);
    const second: WindowEntry = { ...first, port: 65_000, token: 'jeton-de-l-attaquant' };

    for (const order of [[first, second], [second, first]]) {
      const failure = catchFailure(() => resolveOwningWindow(CALLER, REAL_TABLE, order));

      expect(isClaudeManagerError(failure)).toBe(true);
      expect(failure.code).toBe(ERROR_CODES.DUPLICATE_WINDOW_IDENTITY);
      expect(failure.remediation.length).toBeGreaterThan(0);
    }
  });

  it('ne fait fuiter que des nombres quand elle nomme cette anomalie', () => {
    const first = entryOn(HOST);
    const failure = catchFailure(() => resolveOwningWindow(CALLER, REAL_TABLE, [first, first]));

    expect(Object.values(failure.details ?? {}).every((value) => typeof value === 'number')).toBe(true);
    expect(JSON.stringify(failure.toJSON())).not.toContain(first.token);
  });
});
