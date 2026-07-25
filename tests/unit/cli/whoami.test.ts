import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../../packages/cli/src/cli.js';
import { writeWindowEntry } from '../../../packages/core/src/index.js';
import {
  contextFor,
  copyLegacyEntriesInto,
  currentSchemaEntry,
  expectFailure,
  expectSoleJsonValue,
  expectSuccess,
  LEGACY_FILES,
  makeRegistryDir,
  WINDOWS_ROLES,
} from './fixtures.js';

/**
 * `cmgr whoami` — « dans quelle fenetre s'execute le processus qui m'appelle ? »
 *
 * Les pid ne sont pas choisis : ils viennent de la capture reelle
 * (`tests/fixtures/identity/windows-process-table.roles.json`). Le `claude.exe` appelant
 * `18408` descend de l'extension host `11172` par deux sauts intermediaires, et `17544` est
 * un SECOND extension host reel, hors de cette chaine, sous le meme processus principal.
 */
describe('cmgr whoami', () => {
  it('resout la fenetre hote et rend la chaine reellement parcourue', async () => {
    const dir = makeRegistryDir();
    const entry = currentSchemaEntry(WINDOWS_ROLES.owningExtHostPid);
    writeWindowEntry(entry, { dir });

    const context = contextFor(dir, WINDOWS_ROLES.callerClaudePid);
    const payload = expectSuccess(await runCli(['whoami'], context));

    const window = payload['window'] as Record<string, unknown>;
    expect(window['extHostPid']).toBe(WINDOWS_ROLES.owningExtHostPid);

    const ancestry = payload['ancestry'] as Record<string, unknown>;
    expect(ancestry['callerPid']).toBe(WINDOWS_ROLES.callerClaudePid);
    // La chaine EXACTE de la capture : appelant inclus, puis ses ancetres jusqu'a l'orphelin.
    expect(ancestry['chain']).toEqual([
      WINDOWS_ROLES.callerClaudePid,
      ...WINDOWS_ROLES.expectedAncestry,
    ]);
    expect(ancestry['ownerDepth']).toBe(3);
  });

  it('masque le jeton : il n apparait dans AUCUN octet de stdout', async () => {
    const dir = makeRegistryDir();
    const entry = currentSchemaEntry(WINDOWS_ROLES.owningExtHostPid);
    writeWindowEntry(entry, { dir });

    // L'assertion serait vide si le jeton n'etait pas reellement sur disque : on le verifie.
    const onDisk = readFileSync(path.join(dir, `${entry.extHostPid}.json`), 'utf8');
    expect(onDisk).toContain(entry.token);

    const result = await runCli(['whoami'], contextFor(dir, WINDOWS_ROLES.callerClaudePid));
    const payload = expectSuccess(result);

    expect(result.stdout).not.toContain(entry.token);
    expect(result.stderr).not.toContain(entry.token);
    expect((payload['window'] as Record<string, unknown>)['token']).toBe('***');
  });

  it('ne revendique pas une fenetre hors de sa chaine — l isolation, sur des pid mesures', async () => {
    const dir = makeRegistryDir();
    // `17544` est un extension host REEL et VIVANT, mais il n'est pas dans la chaine de
    // `18408`. Une resolution indexee sur le workspace, le titre ou le processus principal
    // — que les deux fenetres partagent — le retiendrait ; l'extHostPid, non.
    const other = WINDOWS_ROLES.otherExtHostPids[0] as number;
    writeWindowEntry(currentSchemaEntry(other), { dir });

    const result = await runCli(['whoami'], contextFor(dir, WINDOWS_ROLES.callerClaudePid));
    const error = expectFailure(result, 1);

    expect(error['code']).toBe('OWNING_WINDOW_NOT_FOUND');
    // La fenetre existe bel et bien — elle n'est simplement pas la sienne.
    expect((error['details'] as Record<string, unknown>)['registeredExtHostPids']).toEqual([other]);
  });

  it('OWNING_WINDOW_NOT_FOUND est une erreur nommee, rendue telle quelle, code de sortie non nul', async () => {
    const dir = makeRegistryDir();
    copyLegacyEntriesInto(dir);

    const result = await runCli(['whoami'], contextFor(dir, WINDOWS_ROLES.callerClaudePid));
    const error = expectFailure(result, 1);

    expect(error['code']).toBe('OWNING_WINDOW_NOT_FOUND');
    // Message et remediation viennent du coeur, mot pour mot : la CLI ne reformule pas.
    expect(error['message']).toBe(`No registered window owns process ${WINDOWS_ROLES.callerClaudePid}`);
    expect(error['remediation']).toContain('extension compagnon ClaudeManager');
  });

  it('restitue `skipped` DANS l enveloppe d echec — c est la que le motif compte', async () => {
    const dir = makeRegistryDir();
    copyLegacyEntriesInto(dir);

    const result = await runCli(['whoami'], contextFor(dir, WINDOWS_ROLES.callerClaudePid));
    const payload = expectSoleJsonValue(result);
    expect(payload['ok']).toBe(false);
    expect(result.exitCode).toBe(1);

    // Sans cela, l'utilisateur lirait « aucune fenetre ne te revendique » sans apprendre
    // que deux entrees existaient et pourquoi elles ont ete ecartees.
    expect(payload['skipped']).toEqual(
      LEGACY_FILES.map((file) => ({ file, reason: 'foreign-schema' }))
    );
    expect(result.stderr).toContain('2 entree(s) du registre ecartee(s)');
  });

  it('ne lit l inventaire des processus QU UNE FOIS (alerte n.15 : 700 ms a 1,3 s)', async () => {
    const dir = makeRegistryDir();
    writeWindowEntry(currentSchemaEntry(WINDOWS_ROLES.owningExtHostPid), { dir });

    const context = contextFor(dir, WINDOWS_ROLES.callerClaudePid);
    await runCli(['whoami'], context);

    expect(context.snapshotReads()).toBe(1);
  });
});
