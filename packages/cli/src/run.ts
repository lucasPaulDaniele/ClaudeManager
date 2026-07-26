/**
 * Branchement de la CLI sur un processus.
 *
 * Tout ce qui touche a `process` est ici, derriere une interface : le binaire (`cmgr.ts`) se
 * reduit alors a passer le vrai `process`, et cette plomberie-la — decoupage d'`argv`, choix
 * du flux, code de sortie — reste eprouvable sans lancer de processus.
 */

import { runCli } from './cli.js';
import { readProcessTable } from './core.js';

export interface WritableLike {
  write(chunk: string): unknown;
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
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  exitCode?: number | string | null | undefined;
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
  });

  host.stdout.write(result.stdout);
  if (result.stderr.length > 0) host.stderr.write(result.stderr);
  host.exitCode = result.exitCode;
}
