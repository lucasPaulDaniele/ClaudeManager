import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  it('rapporte un pid reattribue SOUS LE MEME PARENT — la garde que le ppid ne voit pas', () => {
    // Le trou exact de la garde par le seul `ppid` : sous Windows le parent enregistre est
    // le `Code.exe` principal, qui engendre des enfants en permanence. `16872` est l un
    // d eux, releve dans la capture reelle — meme parent que l extension host, et pourtant
    // il n a jamais ete cette fenetre : il est ne bien apres l ecriture de l entree.
    const recycled = WINDOWS_ROLES.pidRecycledUnderTheSameParent;
    const entry: WindowEntry = {
      ...currentSchemaEntry(HOST),
      extHostPid: recycled.pid,
      mainPid: recycled.ppid,
    };
    writeWindowEntry(entry, { dir });

    // La premiere garde est bel et bien satisfaite : c est ce qui rend le cas dangereux.
    expect(REAL_TABLE.get(recycled.pid)?.ppid).toBe(entry.mainPid);
    // Et la seconde ne l est pas : le processus est ne apres l entree qui le revendique.
    expect(recycled.createdAt).toBeGreaterThan(Date.parse(entry.startedAt));

    expect(reasonFor(dir, REAL_TABLE, `${recycled.pid}.json`)).toBe('pid-reused');
    expect(purgeStaleEntries({ snapshot: snapshotOf(REAL_TABLE), dir }).removed).toEqual([
      `${recycled.pid}.json`,
    ]);
  });

  it('retient l extension host dont la creation PRECEDE son entree', () => {
    // Contre-epreuve, sur les memes donnees mesurees : c est bien la date qui departage,
    // pas un effet de bord du pid choisi.
    const host = currentSchemaEntry(HOST);

    expect(REAL_TABLE.get(HOST)?.createdAt).toBeLessThan(Date.parse(host.startedAt));

    writeWindowEntry(host, { dir });

    expect(readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir }).windows).toEqual([host]);
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

describe('writeWindowEntry — defaillance du systeme de fichiers', () => {
  /** Anomalie systeme REELLE, la meme qu en lecture : le registre existe, en FICHIER. */
  function registryPathHeldByAFile(): string {
    const asFile = path.join(dir, 'registre-qui-est-un-fichier');
    writeFileSync(asFile, 'pas un repertoire', 'utf8');
    return asFile;
  }

  it('nomme l echec, comme le fait deja la lecture', () => {
    // La lecture nomme cet etat depuis B2 (`REGISTRY_UNREADABLE`) et lui offre une
    // remediation. L ecriture, elle, laissait remonter l erreur systeme nue — la
    // convention du projet n etait donc tenue que d un cote.
    const failure = catchFailure(() => writeWindowEntry(currentSchemaEntry(HOST), { dir: registryPathHeldByAFile() }));

    expect(isClaudeManagerError(failure)).toBe(true);
    expect(failure.code).toBe(ERROR_CODES.REGISTRY_UNWRITABLE);
    expect(failure.remediation.length).toBeGreaterThan(0);
  });

  it('ne fait fuiter ni chemin ni message systeme dans son erreur', () => {
    const asFile = registryPathHeldByAFile();

    const failure = catchFailure(() => writeWindowEntry(currentSchemaEntry(HOST), { dir: asFile }));

    expect(failure.message).not.toContain(asFile);
    expect(JSON.stringify(failure.toJSON())).not.toContain(os.homedir());
    // Le code systeme, lui, reste : il diagnostique sans rien reveler du poste.
    expect(failure.details).toEqual({ cause: 'EEXIST' });
  });

  it('ne laisse derriere elle aucun temporaire porteur du jeton', () => {
    // Le temporaire porte le jeton COMPLET et n a pas l extension des entrees : il
    // echappe a la lecture, donc a l inventaire, donc a l utilisateur.
    const readOnlyEntry = path.join(dir, `${HOST}${'.json'}`);
    mkdirSync(readOnlyEntry);

    catchFailure(() => writeWindowEntry(currentSchemaEntry(HOST), { dir }));

    expect(readdirSync(dir)).toEqual([`${HOST}.json`]);
  });
});

describe('registre sur disque — droits', () => {
  // Sous Windows ces bits n ont pas de sens : `chmod` n y pilote que l attribut « lecture
  // seule », et c est l ACL heritee de C:\\Users\\<compte> qui protege. La verification a
  // donc lieu la ou elle veut dire quelque chose — et elle tourne en CI, sous Linux.
  const posixOnly = process.platform === 'win32' ? it.skip : it;

  posixOnly('n expose le jeton a aucun autre compte de la machine', () => {
    const file = writeWindowEntry(currentSchemaEntry(HOST), { dir });

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  posixOnly('resserre un repertoire laisse ouvert par une version anterieure', () => {
    // Rattrapage de l existant : le `mode` de `mkdirSync` ne s applique qu a la creation.
    chmodSync(dir, 0o755);

    writeWindowEntry(currentSchemaEntry(HOST), { dir });

    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('publie sans defaillir, quelle que soit la plateforme', () => {
    // Le pendant du precedent : poser ces modes ne doit jamais empecher de publier.
    const file = writeWindowEntry(currentSchemaEntry(HOST), { dir });

    expect(readdirSync(dir)).toEqual([`${HOST}.json`]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(currentSchemaEntry(HOST));
  });
});

describe('purgeStaleEntries — temporaires orphelins', () => {
  /** Temporaire tel que l ecriture atomique le nomme : `<pid>.<uuid>.tmp`. */
  function writeOrphanTemporary(extHostPid: number): string {
    const file = `${extHostPid}.3f2b1c8a-0000-4000-8000-000000000000.tmp`;
    writeRaw(dir, file, JSON.stringify(currentSchemaEntry(HOST)));
    return file;
  }

  it('efface le temporaire abandonne par un processus mort', () => {
    // Il porte le jeton complet, il n a pas l extension des entrees : rien ne le lit, donc
    // rien ne le comptait ni ne l effacait. Il survivait a toutes les purges.
    const orphan = writeOrphanTemporary(HOST);

    const result = purgeStaleEntries({ snapshot: snapshotOf(tableWithoutExtensionHosts()), dir });

    expect(result.removedTemporaries).toEqual([orphan]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('ne touche PAS a celui d un processus vivant : son ecriture est peut-etre en cours', () => {
    const inFlight = writeOrphanTemporary(HOST);

    const result = purgeStaleEntries({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect(result.removedTemporaries).toEqual([]);
    expect(readdirSync(dir)).toEqual([inFlight]);
  });

  it('ne touche a aucun fichier qu elle n a pas ecrit elle-meme', () => {
    // Le motif est strict : sans pid en prefixe et sans uuid, ce n est pas notre temporaire.
    writeRaw(dir, 'notes.txt', 'rien a voir');
    writeRaw(dir, `${HOST}.json.tmp`, '{');
    writeRaw(dir, 'sauvegarde.tmp', 'pas la notre');

    const result = purgeStaleEntries({ snapshot: snapshotOf(tableWithoutExtensionHosts()), dir });

    expect(result.removedTemporaries).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([`${HOST}.json.tmp`, 'notes.txt', 'sauvegarde.tmp']);
  });
});
