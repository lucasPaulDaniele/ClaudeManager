import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  promptStdinFrom,
  runProcess,
  type CliHost,
  type StdinLike,
} from '../../../packages/cli/src/run.js';

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

/**
 * Un VRAI flux lisible, jamais un faux emetteur d'evenements.
 *
 * `Readable.from` produit exactement ce que Node pose sur le descripteur 0 pour un tube :
 * un `Readable` qui rend des `Buffer` en plusieurs morceaux. C'est ce qui rend la propriete
 * « on concatene avant de decoder » observable, plutot que declaree.
 */
function stdinFrom(chunks: readonly Uint8Array[], isTTY = false): StdinLike {
  return Object.assign(Readable.from(chunks), { isTTY });
}

function hostWith(argv: readonly string[], pid: number, stdin?: StdinLike): Recorder {
  const out: string[] = [];
  const err: string[] = [];

  return {
    // `argv` REEL de Node : interpreteur, script, puis l'invocation.
    argv: ['C:\\Program Files\\nodejs\\node.exe', 'cmgr', ...argv],
    pid,
    // Par defaut, un terminal : aucune commande de ce fichier ne lit stdin, et un flux qui
    // pendrait ferait pendre le test plutot que d'echouer.
    stdin: stdin ?? stdinFrom([], true),
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

/**
 * LA LECTURE DE STDIN, sur un VRAI flux.
 *
 * `open` n'est pas invoquee ici — `runProcess` cable le contexte de PRODUCTION, registre reel du
 * poste compris, ce qu'aucun test unitaire de ce depot ne touche. Ce qui est eprouve est la
 * PLOMBERIE : ce que `run.ts` fait des octets qu'il recoit, et comment il juge le terminal.
 * L'usage qu'`open` en fait est eprouve dans `open.test.ts`.
 */
describe('lecture de stdin', () => {
  it('un caractere multi-octets coupe entre deux morceaux reste intact', async () => {
    // Un prompt accentue de 20 Ko arrive necessairement en plusieurs morceaux, et la coupure
    // peut tomber AU MILIEU d'un caractere. Decoder morceau par morceau le remplacerait par
    // deux caracteres de remplacement — silencieusement, dans le prompt d'une vraie conversation.
    const bytes = Buffer.from('Reponds : eleve, ete, ou — et voila.', 'utf8');
    const dash = bytes.indexOf(Buffer.from('—', 'utf8'));
    expect(dash).toBeGreaterThan(0);

    const stdin = promptStdinFrom(
      stdinFrom([bytes.subarray(0, dash + 1), bytes.subarray(dash + 1)])
    );

    expect(await stdin.read()).toBe('Reponds : eleve, ete, ou — et voila.');
    expect(await promptStdinFrom(stdinFrom([bytes])).read()).not.toContain('�');
  });

  it('accepte aussi bien des Buffer que des chaines', async () => {
    // Un `Readable` rend des `Buffer` par defaut, et des chaines des qu'un encodage lui a ete
    // pose. `process.stdin` peut etre dans l'un ou l'autre etat selon ce qui l'a touche.
    const stdin = promptStdinFrom(Readable.from(['une chaine, ', Buffer.from('puis des octets')]));

    expect(await stdin.read()).toBe('une chaine, puis des octets');
  });

  it('un terminal est reconnu par `isTTY === true`, jamais par son absence', async () => {
    // MESURE DU 2026-07-26 : dans le harnais qui execute les outils d'un agent, `isTTY` vaut
    // `undefined` alors que rien n'attend sur stdin. Traiter l'absence comme « pas un terminal »
    // est donc juste ; la traiter comme « un terminal » ferait echouer l'invocation nominale.
    expect(promptStdinFrom(stdinFrom([], true)).isTerminal).toBe(true);
    expect(promptStdinFrom(stdinFrom([])).isTerminal).toBe(false);

    const withoutIsTTY: StdinLike = Readable.from([]);
    expect(withoutIsTTY.isTTY).toBeUndefined();
    expect(promptStdinFrom(withoutIsTTY).isTerminal).toBe(false);
  });
});
