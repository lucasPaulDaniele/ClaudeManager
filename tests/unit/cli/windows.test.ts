import { describe, expect, it } from 'vitest';
import { runCli } from '../../../packages/cli/src/cli.js';
import { writeWindowEntry } from '../../../packages/core/src/index.js';
import {
  contextFor,
  copyLegacyEntriesInto,
  currentSchemaEntry,
  expectSuccess,
  LEGACY_FILES,
  makeRegistryDir,
  WINDOWS_ROLES,
} from './fixtures.js';

/** `cmgr windows` — « quelles fenetres sont pilotables ? » */
describe('cmgr windows', () => {
  it('enumere les fenetres pilotables, jeton masque, et designe la fenetre hote', async () => {
    const dir = makeRegistryDir();
    const other = WINDOWS_ROLES.otherExtHostPids[0] as number;
    const owning = currentSchemaEntry(WINDOWS_ROLES.owningExtHostPid);
    writeWindowEntry(owning, { dir });
    writeWindowEntry(currentSchemaEntry(other), { dir });

    const result = await runCli(['windows'], contextFor(dir, WINDOWS_ROLES.callerClaudePid));
    const payload = expectSuccess(result);

    const windows = payload['windows'] as readonly Record<string, unknown>[];
    // Aucun tri n'est applique par le coeur : on compare des ensembles, pas un ordre.
    expect(windows.map((window) => window['extHostPid']).sort()).toEqual(
      [WINDOWS_ROLES.owningExtHostPid, other].sort()
    );
    for (const window of windows) expect(window['token']).toBe('***');
    expect(result.stdout).not.toContain(owning.token);

    // Les deux fenetres partagent le meme processus principal et le meme repertoire de
    // registre : seule la chaine d'ancetres les departage.
    expect(payload['owner']).toEqual({ extHostPid: WINDOWS_ROLES.owningExtHostPid });
  });

  it('une liste VIDE assortie de `skipped` non vide est un renseignement, pas un echec', async () => {
    const dir = makeRegistryDir();
    copyLegacyEntriesInto(dir);

    const result = await runCli(['windows'], contextFor(dir, WINDOWS_ROLES.callerClaudePid));
    const payload = expectSuccess(result);

    // Les deux entrees 0.1.0 ont des pid VIVANTS dans la capture reelle : une lecture naive
    // les declarerait pilotables, et `cmgr` s'adresserait au serveur d'une version fantome.
    expect(payload['windows']).toEqual([]);
    expect(payload['skipped']).toEqual(
      LEGACY_FILES.map((file) => ({ file, reason: 'foreign-schema' }))
    );
    expect(result.stderr).toContain('11172.json (foreign-schema)');
  });

  it('une entree de schema etranger n entre JAMAIS dans les fenetres pilotables', async () => {
    const dir = makeRegistryDir();
    copyLegacyEntriesInto(dir);
    writeWindowEntry(currentSchemaEntry(WINDOWS_ROLES.owningExtHostPid), { dir });

    const result = await runCli(['windows'], contextFor(dir, WINDOWS_ROLES.callerClaudePid));
    const payload = expectSuccess(result);

    // `11172.json` est REECRIT au schema courant par l'ecriture ci-dessus : seule `17544`
    // reste etrangere. La distinction se joue sur le contenu, jamais sur le nom.
    expect(payload['windows']).toHaveLength(1);
    expect((payload['windows'] as readonly Record<string, unknown>[])[0]?.['extHostPid']).toBe(
      WINDOWS_ROLES.owningExtHostPid
    );
    expect(payload['skipped']).toEqual([{ file: '17544.json', reason: 'foreign-schema' }]);
  });

  it('n avoir aucune fenetre hote n est pas une erreur : lister n est pas se situer', async () => {
    const dir = makeRegistryDir();
    const other = WINDOWS_ROLES.otherExtHostPids[0] as number;
    writeWindowEntry(currentSchemaEntry(other), { dir });

    // Le meme montage fait echouer `whoami` — et c'est voulu : les deux commandes ne
    // repondent pas a la meme question.
    const payload = expectSuccess(
      await runCli(['windows'], contextFor(dir, WINDOWS_ROLES.callerClaudePid))
    );

    expect(payload['windows']).toHaveLength(1);
    expect(payload['owner']).toBeNull();
  });

  it('un registre absent rend une liste vide, sans erreur', async () => {
    const dir = makeRegistryDir();

    const payload = expectSuccess(
      await runCli(['windows'], contextFor(dir, WINDOWS_ROLES.callerClaudePid))
    );

    expect(payload).toEqual({ command: 'windows', ok: true, windows: [], owner: null, skipped: [] });
  });

  it('ne lit l inventaire des processus QU UNE FOIS', async () => {
    const dir = makeRegistryDir();
    copyLegacyEntriesInto(dir);

    const context = contextFor(dir, WINDOWS_ROLES.callerClaudePid);
    await runCli(['windows'], context);

    expect(context.snapshotReads()).toBe(1);
  });
});
