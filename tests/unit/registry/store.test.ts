import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeManagerError,
  ERROR_CODES,
  isClaudeManagerError,
  purgeStaleEntries,
  readRegistry,
  resolveRegistryDir,
  writeWindowEntry,
  type ProcessTable,
  type SkipReason,
  type WindowEntry,
} from '../../../packages/core/src/index.js';
import { WINDOWS_ROLES } from '../identity/fixtures.js';
import {
  currentSchemaEntry,
  makeRegistryDir,
  REAL_TABLE,
  snapshotOf,
  tableWithoutExtensionHosts,
} from './fixtures.js';

function catchFailure(operation: () => unknown): ClaudeManagerError {
  try {
    operation();
  } catch (error) {
    return error as ClaudeManagerError;
  }
  throw new Error("l'operation devait lever une ClaudeManagerError");
}

const HOST = WINDOWS_ROLES.owningExtHostPid;
const SIBLING = WINDOWS_ROLES.otherExtHostPids[0] as number;

/** Ecrit une valeur brute la ou l extension compagnon ecrirait, sans passer par le module. */
function writeRaw(dir: string, file: string, content: string): void {
  writeFileSync(path.join(dir, file), content, 'utf8');
}

function reasonFor(dir: string, table: ProcessTable, file: string): SkipReason | undefined {
  return readRegistry({ snapshot: snapshotOf(table), dir }).skipped.find((entry) => entry.file === file)?.reason;
}

let dir: string;

beforeEach(() => {
  dir = makeRegistryDir();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveRegistryDir', () => {
  it('retombe sur le repertoire personnel, sans separateur code en dur', () => {
    expect(resolveRegistryDir()).toBe(path.join(os.homedir(), '.claudemanager', 'windows'));
  });

  it('honore le repertoire fourni — la couture qui rend les tests possibles', () => {
    expect(resolveRegistryDir(dir)).toBe(dir);
  });
});

describe('readRegistry — repertoire', () => {
  it('rend un resultat vide quand le repertoire n existe pas : c est l etat nominal', () => {
    // Un poste ou aucune fenetre ne s est encore enregistree n est pas en anomalie.
    const absent = path.join(dir, 'jamais-cree');

    expect(readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir: absent })).toEqual({ windows: [], skipped: [] });
  });

  it('nomme l echec quand le repertoire existe mais ne peut pas etre liste', () => {
    // Anomalie systeme REELLE : le chemin du registre designe un fichier, pas un repertoire.
    const asFile = path.join(dir, 'registre-qui-est-un-fichier');
    writeFileSync(asFile, 'pas un repertoire', 'utf8');

    const failure = catchFailure(() => readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir: asFile }));

    expect(isClaudeManagerError(failure)).toBe(true);
    expect(failure.code).toBe(ERROR_CODES.REGISTRY_UNREADABLE);
    expect(failure.remediation.length).toBeGreaterThan(0);
  });

  it('ne fait fuiter aucun chemin dans son erreur', () => {
    // Le message systeme porterait le chemin absolu du registre, donc le nom de
    // l utilisateur — et cette erreur part vers un agent et vers des journaux.
    const asFile = path.join(dir, 'registre-qui-est-un-fichier');
    writeFileSync(asFile, 'pas un repertoire', 'utf8');

    const failure = catchFailure(() => readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir: asFile }));

    expect(failure.message).not.toContain(dir);
    expect(JSON.stringify(failure.toJSON())).not.toContain(os.homedir());
    expect(failure.details).toBeUndefined();
  });

  it('ignore SANS les rapporter les fichiers qui ne pretendent pas etre des entrees', () => {
    writeRaw(dir, 'notes.txt', 'rien a voir');
    writeRaw(dir, '11172.json.tmp', '{');
    writeWindowEntry(currentSchemaEntry(HOST), { dir });

    const result = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect(result.windows).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });
});

describe('readRegistry — classement des entrees', () => {
  it('retient une entree valide dont la fenetre est vivante', () => {
    writeWindowEntry(currentSchemaEntry(HOST), { dir });

    const result = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect(result.windows).toEqual([currentSchemaEntry(HOST)]);
    expect(result.skipped).toEqual([]);
  });

  it('rapporte un fichier illisible sans jamais le taire', () => {
    // Illisibilite REELLE : un repertoire porte le nom d une entree.
    mkdirSync(path.join(dir, 'illisible.json'));

    expect(reasonFor(dir, REAL_TABLE, 'illisible.json')).toBe('unreadable');
  });

  it('rapporte un fichier qui n est pas du JSON', () => {
    writeRaw(dir, 'tronque.json', '{"schemaVersion": 1, "extHostPid":');

    expect(reasonFor(dir, REAL_TABLE, 'tronque.json')).toBe('unparsable');
  });

  it('rapporte une entree invalide dont on ne peut meme pas lire le pid', () => {
    writeRaw(dir, 'sans-pid.json', JSON.stringify({ schemaVersion: 1 }));

    expect(reasonFor(dir, REAL_TABLE, 'sans-pid.json')).toBe('invalid');
  });

  it('rapporte une entree dont la fenetre a disparu', () => {
    writeWindowEntry(currentSchemaEntry(HOST), { dir });

    expect(reasonFor(dir, tableWithoutExtensionHosts(), `${HOST}.json`)).toBe('dead');
  });

  it('rapporte un pid reattribue, meme vivant — garde anti-reemploi', () => {
    // L entree a ete publiee alors que l extension host avait un autre parent. Le pid est
    // vivant dans la table, mais il ne designe plus la meme fenetre : le piloter reviendrait
    // a s adresser a un processus quelconque.
    const reused: WindowEntry = { ...currentSchemaEntry(HOST), mainPid: WINDOWS_ROLES.callerClaudePid };
    writeWindowEntry(reused, { dir });

    expect(REAL_TABLE.has(HOST)).toBe(true);
    expect(reasonFor(dir, REAL_TABLE, `${HOST}.json`)).toBe('pid-reused');
  });

  it('classe chaque fichier une fois et une seule', () => {
    writeWindowEntry(currentSchemaEntry(HOST), { dir });
    writeRaw(dir, 'tronque.json', 'pas du json');
    mkdirSync(path.join(dir, 'illisible.json'));

    const result = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect(result.windows.map((entry) => entry.extHostPid)).toEqual([HOST]);
    expect([...result.skipped].map((entry) => entry.file).sort()).toEqual([
      'illisible.json',
      'tronque.json',
    ]);
  });

  it('ne rapporte QUE des noms de fichiers, jamais des chemins absolus', () => {
    writeRaw(dir, 'tronque.json', 'pas du json');

    for (const skipped of readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir }).skipped) {
      expect(path.isAbsolute(skipped.file)).toBe(false);
      expect(skipped.file).not.toContain(path.sep);
    }
  });

  it('ne supprime rien : la lecture est sans effet de bord', () => {
    writeRaw(dir, 'tronque.json', 'pas du json');
    writeWindowEntry(currentSchemaEntry(HOST), { dir });
    const before = readdirSync(dir).sort();

    readRegistry({ snapshot: snapshotOf(tableWithoutExtensionHosts()), dir });

    expect(readdirSync(dir).sort()).toEqual(before);
  });
});

describe('purgeStaleEntries', () => {
  it('supprime les entrees dont la fenetre est morte', () => {
    writeWindowEntry(currentSchemaEntry(HOST), { dir });
    writeWindowEntry(currentSchemaEntry(SIBLING), { dir });

    const { removed } = purgeStaleEntries({ snapshot: snapshotOf(tableWithoutExtensionHosts()), dir });

    expect([...removed].sort()).toEqual([`${HOST}.json`, `${SIBLING}.json`]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('supprime une entree dont le pid a ete reattribue', () => {
    const reused: WindowEntry = { ...currentSchemaEntry(HOST), mainPid: WINDOWS_ROLES.callerClaudePid };
    writeWindowEntry(reused, { dir });

    expect(purgeStaleEntries({ snapshot: snapshotOf(REAL_TABLE), dir }).removed).toEqual([
      `${HOST}.json`,
    ]);
  });

  it('ne touche JAMAIS a une entree vivante', () => {
    writeWindowEntry(currentSchemaEntry(HOST), { dir });

    expect(purgeStaleEntries({ snapshot: snapshotOf(REAL_TABLE), dir }).removed).toEqual([]);
    expect(readdirSync(dir)).toEqual([`${HOST}.json`]);
  });

  it('ne supprime pas ce dont elle ne sait pas si c est mort', () => {
    // Contre-intuitif et volontaire : sans pid lisible, on ignore si la fenetre existe
    // encore. Supprimer par defaut reviendrait a nettoyer a l aveugle le registre d autrui.
    writeRaw(dir, 'tronque.json', 'pas du json');
    writeRaw(dir, 'sans-pid.json', JSON.stringify({ schemaVersion: 1 }));
    mkdirSync(path.join(dir, 'illisible.json'));

    const result = purgeStaleEntries({ snapshot: snapshotOf(tableWithoutExtensionHosts()), dir });

    expect(result.removed).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['illisible.json', 'sans-pid.json', 'tronque.json']);
  });

  it('RAPPORTE tout ce qu elle a laisse, avec son motif exact', () => {
    // Principe fondateur n.3 : la purge conservatrice ne doit pas etre une disparition
    // silencieuse. Ce que la version 1 s interdit de detruire, elle le nomme — sans quoi
    // `cmgr doctor` n aurait aucun moyen de montrer a l utilisateur ce qui s accumule.
    writeRaw(dir, 'tronque.json', 'pas du json');
    mkdirSync(path.join(dir, 'illisible.json'));

    const { kept } = purgeStaleEntries({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect([...kept].sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: 'illisible.json', reason: 'unreadable' },
      { file: 'tronque.json', reason: 'unparsable' },
    ]);
  });

  it('supprime une entree corrompue dont le pid, lui, est bien mort', () => {
    writeRaw(dir, `${HOST}.json`, JSON.stringify({ schemaVersion: 1, extHostPid: HOST }));

    expect(purgeStaleEntries({ snapshot: snapshotOf(tableWithoutExtensionHosts()), dir }).removed).toEqual([
      `${HOST}.json`,
    ]);
  });

  it('reste sans effet sur un registre inexistant', () => {
    const absent = path.join(dir, 'absent');

    expect(purgeStaleEntries({ snapshot: snapshotOf(REAL_TABLE), dir: absent })).toEqual({
      removed: [],
      removedTemporaries: [],
      kept: [],
    });
  });
});

describe('purgeStaleEntries — fraicheur de l instantane', () => {
  it('ne supprime JAMAIS une entree publiee APRES la capture de l instantane', () => {
    // Le cas de production : deux fenetres demarrent a quelques centaines de ms d ecart.
    // A inventorie les processus, B nait et publie, PUIS A lit le registre. `dead` ne veut
    // dire ici que « absent de CET instantane » — pas « morte ».
    const capturedAt = Date.now();
    writeWindowEntry(currentSchemaEntry(HOST), { dir });
    // L instantane precede l ecriture d une seconde pleine : la comparaison ne depend
    // d aucune granularite d horodatage du systeme de fichiers.
    const stale = { table: tableWithoutExtensionHosts(), capturedAt: capturedAt - 1_000 };

    const result = purgeStaleEntries({ snapshot: stale, dir });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([{ file: `${HOST}.json`, reason: 'younger-than-snapshot' }]);
    expect(readdirSync(dir)).toEqual([`${HOST}.json`]);
  });

  it('supprime la meme entree des que l instantane est plus recent qu elle', () => {
    // Contre-epreuve : c est bien la fraicheur qui a retenu la purge, et rien d autre.
    writeWindowEntry(currentSchemaEntry(HOST), { dir });
    const fresh = { table: tableWithoutExtensionHosts(), capturedAt: Date.now() + 1_000 };

    expect(purgeStaleEntries({ snapshot: fresh, dir }).removed).toEqual([`${HOST}.json`]);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('writeWindowEntry', () => {
  it('publie l entree la ou la lecture la retrouvera', () => {
    const entry = currentSchemaEntry(HOST);

    const file = writeWindowEntry(entry, { dir });

    expect(file).toBe(path.join(dir, `${HOST}.json`));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(entry);
    expect(readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir }).windows).toEqual([entry]);
  });

  it('cree l arborescence du registre si elle manque', () => {
    const nested = path.join(dir, 'jamais', 'cree');

    writeWindowEntry(currentSchemaEntry(HOST), { dir: nested });

    expect(readdirSync(nested)).toEqual([`${HOST}.json`]);
  });

  it('est idempotente : ni doublon, ni erreur, ni octet de difference', () => {
    const entry = currentSchemaEntry(HOST);

    const first = writeWindowEntry(entry, { dir });
    const content = readFileSync(first, 'utf8');
    const second = writeWindowEntry(entry, { dir });

    expect(second).toBe(first);
    expect(readFileSync(second, 'utf8')).toBe(content);
    expect(readdirSync(dir)).toEqual([`${HOST}.json`]);
  });

  it('ne laisse aucun fichier temporaire derriere elle', () => {
    writeWindowEntry(currentSchemaEntry(HOST), { dir });
    writeWindowEntry(currentSchemaEntry(SIBLING), { dir });

    expect(readdirSync(dir).sort()).toEqual([`${HOST}.json`, `${SIBLING}.json`]);
  });

  it('n ecrit jamais les champs qu elle ne comprend pas', () => {
    const entry = currentSchemaEntry(HOST);

    const file = writeWindowEntry({ ...entry, mouchard: 'reste dehors' } as WindowEntry, { dir });

    expect(readFileSync(file, 'utf8')).not.toContain('mouchard');
  });

  it('refuse de publier une entree qu elle refuserait de relire', () => {
    const invalid = { ...currentSchemaEntry(HOST), extHostPid: 0 } as WindowEntry;

    const failure = catchFailure(() => writeWindowEntry(invalid, { dir }));

    expect(failure.code).toBe(ERROR_CODES.REGISTRY_ENTRY_INVALID);
    expect(failure.details).toEqual({ reason: 'invalid', extHostPid: undefined });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuse aussi de publier une entree d un autre schema', () => {
    const foreign = { ...currentSchemaEntry(HOST), schemaVersion: 2 } as WindowEntry;

    const failure = catchFailure(() => writeWindowEntry(foreign, { dir }));

    expect(failure.code).toBe(ERROR_CODES.REGISTRY_ENTRY_INVALID);
    expect(failure.details).toEqual({ reason: 'foreign-schema', extHostPid: HOST });
  });
});
