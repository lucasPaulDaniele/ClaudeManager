import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseWindowsProcessTable,
  WINDOW_ENTRY_SCHEMA_VERSION,
  type ProcessSnapshot,
  type ProcessTable,
  type WindowEntry,
} from '../../../packages/core/src/index.js';
import { WINDOWS_CAPTURE, WINDOWS_ROLES } from '../identity/fixtures.js';

/** Entrees 0.1.0 reellement capturees. Voir `tests/fixtures/registry/README.md`. */
const LEGACY_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'registry',
  'legacy-0.1.0'
);

/** Les deux fenetres presentes dans la capture du registre. */
export const LEGACY_FILES: readonly string[] = ['11172.json', '17544.json'];

/**
 * Table des processus REELLE capturee en B1 (`tests/fixtures/identity/`).
 *
 * `11172` et `17544` y sont vivants, tous deux de `ppid 16196` : les deux extension hosts
 * des entrees heritees existaient bel et bien au moment de la capture.
 */
export const REAL_TABLE: ProcessTable = parseWindowsProcessTable(WINDOWS_CAPTURE);

/**
 * La MEME capture, moins les deux extension hosts : ce meme poste une fois les deux
 * fenetres fermees. Rien n'est ajoute — deux lignes reelles sont retirees, c'est tout.
 */
export function tableWithoutExtensionHosts(): ProcessTable {
  const table = new Map(REAL_TABLE);
  table.delete(WINDOWS_ROLES.owningExtHostPid);
  for (const pid of WINDOWS_ROLES.otherExtHostPids) table.delete(pid);
  return table;
}

/**
 * Marge separant les ecritures d'un test de la date de son instantane.
 *
 * L'horodatage d'un fichier et `Date.now()` ne viennent PAS de la meme horloge : mesure
 * sur ce poste, `mtimeMs` NTFS precede `Date.now()` de jusqu'a 5 ms. Un test qui ecrit
 * puis capture dans la milliseconde suivante est donc ambigu par construction, et la purge
 * — conservatrice — epargnerait au hasard ce qu'elle devait supprimer.
 */
const WRITES_SETTLED_MS = 1_000;

/**
 * Instantane date, tel que `readProcessTable()` le rend.
 *
 * `capturedAt` est releve A L'APPEL puis decale de la marge ci-dessus : c'est le cas
 * NOMINAL, celui ou le registre a ete ecrit bien avant l'inventaire. Le cas inverse —
 * entree publiee APRES la capture — est construit explicitement la ou il est eprouve,
 * jamais subi au hasard de l'horloge.
 */
export function snapshotOf(table: ProcessTable): ProcessSnapshot {
  return { table, capturedAt: Date.now() + WRITES_SETTLED_MS };
}

/** Repertoire de registre neuf, sur un VRAI systeme de fichiers temporaire. */
export function makeRegistryDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'cmgr-registry-'));
}

/** Recopie les entrees heritees dans un repertoire de travail — jamais l'inverse. */
export function copyLegacyEntriesInto(dir: string): void {
  for (const file of LEGACY_FILES) {
    copyFileSync(path.join(LEGACY_DIR, file), path.join(dir, file));
  }
}

/** Forme du schema 0.1.0 : ni `schemaVersion`, ni `mainPid`. */
interface LegacyEntry {
  readonly extHostPid: number;
  readonly port: number;
  readonly token: string;
  readonly workspaceFolders: readonly string[];
  readonly isTrusted: boolean;
  readonly extensionVersion: string;
  readonly startedAt: string;
}

export function readLegacyEntry(extHostPid: number): LegacyEntry {
  return JSON.parse(
    readFileSync(path.join(LEGACY_DIR, `${extHostPid}.json`), 'utf8')
  ) as LegacyEntry;
}

/**
 * Entree du schema courant, DERIVEE de la capture reelle.
 *
 * Aucune version 1 n'a encore tourne : il n'existait rien de tel a capturer. Plutot que de
 * fabriquer une entree de toutes pieces, on reprend l'entree 0.1.0 reelle mot pour mot et
 * on lui ajoute les deux seuls champs que le schema 1 introduit :
 *   - `schemaVersion` ;
 *   - `mainPid`, qui est le `ppid` REEL de cet extension host dans la table capturee.
 */
export function currentSchemaEntry(extHostPid: number): WindowEntry {
  const legacy = readLegacyEntry(extHostPid);
  const host = REAL_TABLE.get(extHostPid);
  if (host === undefined) throw new Error(`${extHostPid} absent de la table capturee`);

  return {
    schemaVersion: WINDOW_ENTRY_SCHEMA_VERSION,
    extHostPid: legacy.extHostPid,
    mainPid: host.ppid,
    port: legacy.port,
    token: legacy.token,
    workspaceFolders: legacy.workspaceFolders,
    isTrusted: legacy.isTrusted,
    extensionVersion: legacy.extensionVersion,
    startedAt: legacy.startedAt,
  };
}
