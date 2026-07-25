import { ClaudeManagerError, ERROR_CODES } from '../errors.js';
import { ancestorsOf } from './ancestry.js';
import type { ProcessTable } from './processTable.js';

/** Vue minimale d'une fenetre, suffisante pour la resolution d'identite. */
export interface WindowLike {
  readonly extHostPid: number;
}

/**
 * Chaine de rattachement d'un processus, du plus proche au plus lointain.
 *
 * Le processus appelant **en fait partie** : l'extension compagnon *est* l'extension host
 * de sa fenetre, elle doit donc se resoudre elle-meme.
 */
function ownershipChain(callerPid: number, table: ProcessTable): readonly number[] {
  // `ancestorsOf` garantit des pid uniques et distincts de `callerPid` : la chaine ne
  // porte aucun doublon, l'indexation par profondeur ci-dessous est donc sans ambiguite.
  return [callerPid, ...ancestorsOf(callerPid, table)];
}

/**
 * Determine dans QUELLE fenetre s'execute le processus appelant.
 *
 * C'est l'invariant du produit : une commande emise depuis une fenetre ne doit jamais agir
 * sur une autre, y compris quand les deux ouvrent le meme dossier. On ne se fie donc ni au
 * titre, ni au chemin du workspace, ni a `VSCODE_PID` — partage par toutes les fenetres
 * d'un meme processus principal. Seul l'`extHostPid`, retrouve dans la chaine d'ancetres,
 * fait foi.
 *
 * C'est une **requete** : elle rend `undefined` quand aucune fenetre ne revendique le
 * processus. Pour l'operation qui exige une reponse, voir `requireOwningWindow`.
 */
export function resolveOwningWindow<T extends WindowLike>(
  callerPid: number,
  table: ProcessTable,
  windows: readonly T[]
): T | undefined {
  const depthByPid = new Map<number, number>();
  ownershipChain(callerPid, table).forEach((pid, depth) => depthByPid.set(pid, depth));

  let owner: T | undefined;
  let ownerDepth = Number.POSITIVE_INFINITY;
  for (const window of windows) {
    const depth = depthByPid.get(window.extHostPid);
    // Decision de conception : quand PLUSIEURS fenetres enregistrees figurent dans la
    // chaine — cas anormal mais possible, une fenetre VSCode ouverte depuis le terminal
    // integre d'une autre —, on retient la PLUS PROCHE du processus appelant. C'est
    // necessairement la fenetre hote reelle : les autres ne sont que ses aieules, et agir
    // sur elles violerait l'isolation. A profondeur egale, la premiere enregistree gagne :
    // aucun autre critere — surtout pas le chemin du workspace — ne doit les departager.
    if (depth !== undefined && depth < ownerDepth) {
      owner = window;
      ownerDepth = depth;
    }
  }

  return owner;
}

/**
 * Meme resolution, mais en **operation** : l'absence de fenetre hote est une defaillance
 * nommee, jamais un blanc silencieux (principe fondateur n.3).
 *
 * Les `details` sont exclusivement numeriques : ils partent vers un agent et vers des
 * journaux, ils ne doivent porter ni chemin ni titre de fenetre.
 *
 * @throws {ClaudeManagerError} `OWNING_WINDOW_NOT_FOUND`
 */
export function requireOwningWindow<T extends WindowLike>(
  callerPid: number,
  table: ProcessTable,
  windows: readonly T[]
): T {
  const owner = resolveOwningWindow(callerPid, table, windows);
  if (owner !== undefined) return owner;

  throw new ClaudeManagerError(
    ERROR_CODES.OWNING_WINDOW_NOT_FOUND,
    `No registered window owns process ${callerPid}`,
    {
      callerPid,
      chainLength: ownershipChain(callerPid, table).length,
      registeredExtHostPids: windows.map((window) => window.extHostPid),
    }
  );
}
