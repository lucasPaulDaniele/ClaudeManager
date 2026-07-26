/**
 * Branchement de la CLI sur un processus.
 *
 * Tout ce qui touche a `process` est ici, derriere une interface : le binaire (`cmgr.ts`) se
 * reduit alors a passer le vrai `process`, et cette plomberie-la — decoupage d'`argv`, choix
 * du flux, code de sortie — reste eprouvable sans lancer de processus.
 */

import { runCli } from './cli.js';
import { createLoopbackTransport, readProcessTable } from './core.js';
import type { PromptStdin } from './prompt.js';

export interface WritableLike {
  write(chunk: string): unknown;
}

/**
 * L'entree standard, telle que Node la presente.
 *
 * ASYNC-ITERABLE plutot qu'un jeu d'evenements : c'est ce que `Readable` expose, et cela permet
 * de brancher ici un VRAI flux — `Readable.from([...])` dans les tests, `process.stdin` en
 * production — sans jamais fabriquer un faux emetteur d'evenements.
 *
 * `isTTY` n'est pas declare par tous les flux que Node peut poser sur le descripteur 0 : il est
 * donc optionnel, et c'est `=== true` qui decide, jamais l'absence.
 */
export interface StdinLike extends AsyncIterable<string | Uint8Array> {
  readonly isTTY?: boolean | undefined;
}

/**
 * Le sous-ensemble de `process` dont la CLI a besoin.
 *
 * `exitCode` admet `string` et `null` parce que Node les declare ainsi : c'est a l'interface
 * d'accepter le vrai `process`, pas au binaire de le contorsionner pour entrer ici.
 */
export interface CliHost {
  readonly argv: readonly string[];
  readonly pid: number;
  readonly stdin: StdinLike;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  exitCode?: number | string | null | undefined;
}

/**
 * Lit l'entree standard jusqu'a EOF, en UTF-8.
 *
 * LES OCTETS SONT CONCATENES AVANT D'ETRE DECODES, et ce n'est pas un detail de style : un
 * caractere multi-octets peut etre coupe en deux par une frontiere de paquet, et decoder
 * morceau par morceau le remplacerait par deux caracteres de remplacement. Un prompt accentue
 * de 20 Ko arrive necessairement en plusieurs morceaux.
 */
async function readAll(stdin: StdinLike): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stdin) {
    // Un `Readable` rend des `Buffer` par defaut, mais rend des chaines des qu'un encodage lui
    // a ete pose : les deux formes sont ramenees a des octets avant d'etre concatenees.
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reduit un flux d'entree a ce que la CLI en attend.
 *
 * EXPORTEE POUR ETRE EPROUVEE, et c'est la seule raison : un test qui reecrirait ce calcul de
 * son cote ne verifierait que sa propre copie. C'est la fonction que `runProcess` emploie.
 */
export function promptStdinFrom(stdin: StdinLike): PromptStdin {
  return {
    // `=== true`, jamais la seule absence : `isTTY` vaut `undefined` sur un tube COMME sur
    // `NUL` — mesure du 2026-07-26 —, et seule la valeur `true` affirme un terminal.
    isTerminal: stdin.isTTY === true,
    read: () => readAll(stdin),
  };
}

/**
 * Joue une invocation de bout en bout.
 *
 * `argv.slice(2)` retire l'interpreteur et le script : ce qui suit est l'invocation telle
 * que l'utilisateur l'a ecrite.
 *
 * `process.exitCode` plutot que `process.exit()` : le second coupe les flux en cours
 * d'ecriture, et `stdout` peut etre un tube — c'est meme le cas nominal quand un agent
 * appelle `cmgr`. Un JSON tronque par une sortie brutale trahirait le contrat au moment
 * precis ou il compte.
 */
export async function runProcess(host: CliHost): Promise<void> {
  const result = await runCli(host.argv.slice(2), {
    pid: host.pid,
    // Registre par defaut : `~/.claudemanager/windows`. Il n'existe AUCUN moyen d'en
    // changer depuis la ligne de commande — le registre est le seul endroit ou l'identite
    // d'une fenetre est verifiee.
    registryDir: undefined,
    // La fonction du coeur, passee telle quelle : un enrobage `() => readProcessTable()`
    // n'ajouterait rien qu'une ligne que rien n'eprouve.
    readSnapshot: readProcessTable,
    stdin: promptStdinFrom(host.stdin),
    // Le transport du COEUR, cable ici et nulle part ailleurs : aucune source de la CLI
    // n'importe `node:http`, et il n'existe aucune option pour designer un hote — une entree
    // de registre ne decrit jamais qu'une fenetre de CE poste.
    transport: createLoopbackTransport(),
  });

  host.stdout.write(result.stdout);
  if (result.stderr.length > 0) host.stderr.write(result.stderr);
  host.exitCode = result.exitCode;
}
