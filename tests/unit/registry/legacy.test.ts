import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

/**
 * Rattrapage de l'AVENIR — le pendant du precedent, et le seul jamais eprouve jusqu'ici.
 *
 * Les entrees 0.1.0 n'ont pas de `mainPid` : elles sont structurellement exemptes de la
 * garde anti-reemploi, donc elles ne prouvaient rien de la compatibilite ascendante. Une
 * version 2 qui GARDE le nom `mainPid` en changeant ce qu'il designe est le cas qui compte.
 */
describe('purgeStaleEntries face a une version ULTERIEURE', () => {
  /** Entree de schema 2 : pid bien vivant, `mainPid` porteur d'un autre sens que le notre. */
  function writeSchema2Entry(extHostPid: number): void {
    const entry = {
      ...currentSchemaEntry(extHostPid),
      schemaVersion: 2,
      // Une v2 pourrait y mettre un identifiant de fenetre, un parent releve a distance,
      // ou le parent releve a un autre instant. La version 1 n'en sait rien — c'est le
      // sujet. Ici : un pid reel de la capture, qui n'est pas le parent de `extHostPid`.
      mainPid: WINDOWS_ROLES.callerClaudePid,
    };
    writeFileSync(path.join(dir, `${extHostPid}.json`), JSON.stringify(entry, null, 2), 'utf8');
  }

  it('ne detruit JAMAIS son entree vivante, meme si `mainPid` a change de sens', () => {
    writeSchema2Entry(HOST);

    const result = purgeStaleEntries({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect(REAL_TABLE.has(HOST)).toBe(true);
    expect(result.removed).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([...LEGACY_FILES].sort());
    expect(result.kept).toContainEqual({ file: `${HOST}.json`, reason: 'foreign-schema' });
  });

  it('ne la pilote pas davantage : un schema inconnu ne se pilote pas', () => {
    writeSchema2Entry(HOST);

    const result = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir });

    expect(result.windows).toEqual([]);
    expect(result.skipped).toContainEqual({ file: `${HOST}.json`, reason: 'foreign-schema' });
  });

  it('la supprime en revanche des que son pid a disparu, quelle que soit sa version', () => {
    // Contre-epreuve : le conservatisme n'est pas de l'immobilisme. La seule question que
    // la version 1 s autorise sur un schema etranger — ce pid existe-t-il ? — reste posee.
    writeSchema2Entry(HOST);
    const table = new Map(REAL_TABLE);
    table.delete(HOST);

    expect(purgeStaleEntries({ snapshot: snapshotOf(table), dir }).removed).toEqual([
      `${HOST}.json`,
    ]);
  });
});
