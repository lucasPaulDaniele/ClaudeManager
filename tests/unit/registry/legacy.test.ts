import { readdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  purgeStaleEntries,
  readRegistry,
  writeWindowEntry,
} from '../../../packages/core/src/index.js';
import { WINDOWS_ROLES } from '../identity/fixtures.js';
import {
  copyLegacyEntriesInto,
  currentSchemaEntry,
  LEGACY_FILES,
  makeRegistryDir,
  readLegacyEntry,
  REAL_TABLE,
  snapshotOf,
  tableWithoutExtensionHosts,
} from './fixtures.js';

/**
 * Rattrapage de l'existant (principe fondateur n.7), sur la capture reelle des entrees
 * ecrites par l'extension fantome 0.1.0 — installee ET active sur le poste de
 * developpement. Voir `tests/fixtures/registry/README.md`.
 */

const HOST = WINDOWS_ROLES.owningExtHostPid;
const SIBLING = WINDOWS_ROLES.otherExtHostPids[0] as number;

let dir: string;

beforeEach(() => {
  dir = makeRegistryDir();
  copyLegacyEntriesInto(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('entrees heritees 0.1.0 — pourquoi elles sont dangereuses', () => {
  it('sont bien formees et leurs pid sont REELLEMENT vivants', () => {
    // Le piege exact : une lecture naive y verrait deux fenetres pilotables, et s adresserait
    // au serveur d une version fantome. Rien dans ces entrees ne trahit le probleme, sinon
    // l absence de schemaVersion.
    for (const extHostPid of [HOST, SIBLING]) {
      const legacy = readLegacyEntry(extHostPid);

      expect(legacy.extHostPid).toBe(extHostPid);
      expect(legacy.port).toBeGreaterThan(0);
      expect(legacy.token.length).toBeGreaterThan(0);
      expect(legacy.workspaceFolders.length).toBeGreaterThan(0);
      expect(legacy.extensionVersion).toBe('0.1.0');
      expect(REAL_TABLE.get(extHostPid)).toBe(WINDOWS_ROLES.mainCodePid);
    }
  });

  it("n ont ni schemaVersion ni mainPid — c est la forme reelle du schema 0.1.0", () => {
    const legacy: Record<string, unknown> = readLegacyEntry(HOST) as unknown as Record<string, unknown>;

    expect(Object.keys(legacy)).not.toContain('schemaVersion');
    expect(Object.keys(legacy)).not.toContain('mainPid');
  });
});

describe('readRegistry face aux entrees heritees', () => {
  it("ne les pilote JAMAIS, alors meme que leurs pid sont vivants", () => {
    const result = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect(result.windows).toEqual([]);
  });

  it('les rapporte comme foreign-schema, jamais escamotees', () => {
    const result = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect([...result.skipped].sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: '11172.json', reason: 'foreign-schema' },
      { file: '17544.json', reason: 'foreign-schema' },
    ]);
  });

  it('cohabite avec le schema courant : la republication remplace l heritee', () => {
    // Le chemin de migration reel : la version courante s active dans la fenetre 11172 et
    // republie son entree, par-dessus celle de la 0.1.0. L autre fenetre, elle, tourne
    // toujours sous la version fantome et reste hors de portee.
    const mine = currentSchemaEntry(HOST);
    writeWindowEntry(mine, { dir });

    const result = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect(result.windows).toEqual([mine]);
    expect(result.skipped).toEqual([{ file: `${SIBLING}.json`, reason: 'foreign-schema' }]);
  });
});

describe('purgeStaleEntries face aux entrees heritees — purge conservatrice', () => {
  it('ne les supprime PAS tant que leurs pid sont vivants', () => {
    // Une version ULTERIEURE de ClaudeManager ecrira un schemaVersion 2 : il est hors de
    // question que la version 1 detruise ses entrees.
    const result = purgeStaleEntries({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect(result.removed).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([...LEGACY_FILES].sort());
    // Immortelles tant que leur pid vit : c est le prix assume de la purge conservatrice,
    // et il doit etre RAPPORTE, pas subi en silence.
    expect([...result.kept].sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: '11172.json', reason: 'foreign-schema' },
      { file: '17544.json', reason: 'foreign-schema' },
    ]);
  });

  it('les supprime des que leurs pid ont disparu', () => {
    // Un processus mort ne revient pas : sa version importe peu.
    const { removed } = purgeStaleEntries({ snapshot: snapshotOf(tableWithoutExtensionHosts()), dir });

    expect([...removed].sort()).toEqual([...LEGACY_FILES].sort());
    expect(readdirSync(dir)).toEqual([]);
  });

  it('ne supprime que celle dont la fenetre est morte, jamais sa voisine', () => {
    const table = new Map(REAL_TABLE);
    table.delete(HOST);

    expect(purgeStaleEntries({ snapshot: snapshotOf(table), dir }).removed).toEqual([`${HOST}.json`]);
    expect(readdirSync(dir)).toEqual([`${SIBLING}.json`]);
  });
});
