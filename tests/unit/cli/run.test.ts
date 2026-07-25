import { describe, expect, it } from 'vitest';
import { runProcess, type CliHost } from '../../../packages/cli/src/run.js';

/**
 * Branchement sur le processus.
 *
 * Ce que ces tests eprouvent n'est PAS la resolution d'identite — elle l'est ailleurs, sur
 * des captures reelles — mais la plomberie qui l'entoure : quel flux recoit quoi, quel code
 * de sortie est pose, et ou commence l'invocation dans `argv`. C'est exactement la couche
 * qu'un test de bout en bout ne distingue pas quand il echoue.
 *
 * AUCUNE INVOCATION DE `windows` NI DE `whoami` ICI, et c'est delibere : `runProcess` cable
 * le contexte de PRODUCTION — registre par defaut, inventaire reel du poste —, sans option
 * ni variable d'environnement pour en changer. L'y appeler ferait lire par un test unitaire
 * le vrai `~/.claudemanager/windows`, ce qu'aucun test de ce depot ne fait. Les scenarios
 * qui ont besoin d'un registre passent par `runCli`, avec leur propre repertoire temporaire.
 */

interface Recorder extends CliHost {
  readonly out: string[];
  readonly err: string[];
}

function hostWith(argv: readonly string[], pid: number): Recorder {
  const out: string[] = [];
  const err: string[] = [];

  return {
    // `argv` REEL de Node : interpreteur, script, puis l'invocation.
    argv: ['C:\\Program Files\\nodejs\\node.exe', 'cmgr', ...argv],
    pid,
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    out,
    err,
  };
}

describe('runProcess', () => {
  it('ecrit une seule valeur JSON sur stdout et pose le code de sortie', async () => {
    const host = hostWith(['--version'], 4242);

    await runProcess(host);

    expect(host.out).toHaveLength(1);
    expect(JSON.parse(host.out.join(''))).toMatchObject({ command: 'version', ok: true });
    expect(host.exitCode).toBe(0);
  });

  it('n ecrit RIEN sur stderr quand il n y a rien a dire', async () => {
    const host = hostWith(['--help'], 4242);

    await runProcess(host);

    expect(host.err).toEqual([]);
  });

  it('retire l interpreteur et le script avant d analyser l invocation', async () => {
    // Sans le decoupage, la premiere « commande » serait le chemin de l'interpreteur.
    const host = hostWith(['nope'], 4242);

    await expect(runProcess(host)).resolves.toBeUndefined();

    const payload = JSON.parse(host.out.join('')) as Record<string, unknown>;
    expect((payload['error'] as Record<string, unknown>)['details']).toEqual({ argumentIndex: 1 });
    expect(host.exitCode).toBe(2);
  });

  it('ecrit le diagnostic humain sur stderr, et le JSON reste seul sur stdout', async () => {
    const host = hostWith(['nope'], 4242);

    await runProcess(host);

    expect(host.err.join('')).toContain('cmgr: CLI_USAGE');
    expect(host.out.join('')).not.toContain('cmgr:');
  });
});
