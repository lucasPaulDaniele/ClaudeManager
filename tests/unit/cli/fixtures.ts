/**
 * Montage des tests de la CLI.
 *
 * AUCUN DOUBLE DU COEUR, et c'est la contrainte structurante (principe fondateur n.5) : la
 * CLI eprouvee ici consomme le VRAI `readRegistry`, la VRAIE resolution d'identite et un
 * VRAI repertoire temporaire sur disque. Ce qui est fourni de l'exterieur — l'instantane des
 * processus — est une capture REELLE versionnee (`tests/fixtures/identity/`), pas une table
 * inventee pour l'occasion.
 *
 * Le registre reel du poste (`~/.claudemanager/windows`) n'est ni lu ni ecrit : chaque
 * scenario travaille dans son propre repertoire, cree par `mkdtempSync`.
 */

import { expect } from 'vitest';
import type { CliResult } from '../../../packages/cli/src/cli.js';
import type { CliContext } from '../../../packages/cli/src/commands.js';
import type { ProcessTable } from '../../../packages/core/src/index.js';
import { REAL_TABLE, snapshotOf } from '../registry/fixtures.js';

export { WINDOWS_ROLES } from '../identity/fixtures.js';
export {
  copyLegacyEntriesInto,
  currentSchemaEntry,
  LEGACY_FILES,
  makeRegistryDir,
  REAL_TABLE,
} from '../registry/fixtures.js';

/**
 * Contexte d'invocation, avec un COMPTEUR d'instantanes.
 *
 * Le compteur n'est pas decoratif : `readProcessTable()` coute de 700 ms a 1,3 s sur un
 * poste reel, et lire deux fois dans une meme commande ne ferait pas que la ralentir — elle
 * jugerait le registre et la chaine d'ancetres sur deux etats differents du systeme.
 */
export interface TestContext extends CliContext {
  readonly snapshotReads: () => number;
}

export function contextFor(
  registryDir: string | undefined,
  pid: number,
  table: ProcessTable = REAL_TABLE
): TestContext {
  const snapshot = snapshotOf(table);
  let reads = 0;

  return {
    pid,
    registryDir,
    readSnapshot: () => {
      reads += 1;
      return Promise.resolve(snapshot);
    },
    snapshotReads: () => reads,
  };
}

/**
 * LE contrat de sortie, verifie sur la chaine reellement produite.
 *
 * `JSON.parse` rejette deux valeurs concatenees : l'appeler suffit donc a prouver qu'il n'y
 * a qu'UNE valeur sur `stdout`, et qu'aucune banniere ni ligne de progression ne s'y est
 * glissee. Cette fonction est appelee dans TOUS les scenarios, succes comme echec — c'est
 * ce qui fait du contrat une propriete verifiee partout plutot qu'un cas de test isole.
 */
export function expectSoleJsonValue(result: CliResult): Record<string, unknown> {
  expect(result.stdout.endsWith('\n'), 'stdout se termine par un saut de ligne').toBe(true);

  const payload: unknown = JSON.parse(result.stdout);
  expect(typeof payload).toBe('object');
  expect(payload).not.toBeNull();
  expect(Array.isArray(payload)).toBe(false);

  const record = payload as Record<string, unknown>;
  expect(record).toHaveProperty('command');
  expect(record).toHaveProperty('ok');
  return record;
}

/** L'enveloppe d'echec, telle qu'un agent la lit. */
export function expectFailure(result: CliResult, exitCode: number): Record<string, unknown> {
  const payload = expectSoleJsonValue(result);
  expect(payload['ok']).toBe(false);
  expect(result.exitCode).toBe(exitCode);
  return payload['error'] as Record<string, unknown>;
}

export function expectSuccess(result: CliResult): Record<string, unknown> {
  const payload = expectSoleJsonValue(result);
  expect(payload['ok']).toBe(true);
  expect(result.exitCode).toBe(0);
  return payload;
}
