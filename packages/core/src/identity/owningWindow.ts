import { ClaudeManagerError, ERROR_CODES } from '../errors.js';
import { ancestorsOf } from './ancestry.js';
import type { ProcessTable } from './processTable.js';

/** Vue minimale d'une fenetre, suffisante pour la resolution d'identite. */
export interface WindowLike {
  readonly extHostPid: number;
}

/**
 * Un pid REEL : entier strictement positif.
 *
 * La defense est LOCALE, et sa redondance avec la validation du registre est assumee.
 * `Map#get` emploie SameValueZero : `NaN` correspond a `NaN`, `0` a `0`. Un pid absurde
 * face a une fenetre au pid tout aussi absurde produisait donc une correspondance — c'est
 * a dire le pilotage d'une fenetre qui n'est pas la sienne, la violation meme de
 * l'invariant du produit. Le registre en etait le seul garant, par un commentaire situe
 * dans un AUTRE module : ce module est exporte publiquement sur un `WindowLike` qui
 * n'exige qu'un `extHostPid: number`, et rien ne dit d'ou il vient. Deux lignes ici
 * valent mieux qu'une precondition que personne ne lit.
 */
function isRealPid(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Chaine de rattachement d'un processus, du plus proche au plus lointain.
 *
 * Le processus appelant **en fait partie** : l'extension compagnon *est* l'extension host
 * de sa fenetre, elle doit donc se resoudre elle-meme.
 */
function ownershipChain(callerPid: number, table: ProcessTable): readonly number[] {
  // `ancestorsOf` valide bien son argument, mais son resultat etait concatene APRES un
  // `callerPid` brut : la garde doit donc etre posee ici, en amont de la concatenation.
  if (!isRealPid(callerPid)) return [];
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
 *
 * @throws {ClaudeManagerError} `DUPLICATE_WINDOW_IDENTITY` — jamais pour une absence,
 * uniquement pour une AMBIGUITE : deux fenetres revendiquant le meme extension host.
 */
export function resolveOwningWindow<T extends WindowLike>(
  callerPid: number,
  table: ProcessTable,
  windows: readonly T[]
): T | undefined {
  const depthByPid = new Map<number, number>();
  ownershipChain(callerPid, table).forEach((pid, depth) => depthByPid.set(pid, depth));

  /**
   * Les extension hosts DEJA revendiques, et c'est l'index qui detecte l'ambiguite.
   *
   * INDEXER PAR PID, JAMAIS PAR PROFONDEUR. L'egalite de profondeur ne se lisait que face
   * a la fenetre RETENUE, laquelle n'est mise a jour que par la branche « plus proche » :
   * deux fenetres de meme `extHostPid` situees plus loin qu'une fenetre deja retenue
   * n'etaient donc jamais comparees entre elles. Meme ensemble, trois ordres, deux
   * verdicts — precisement ce que la decision 5 d'ADR-003 interdit.
   */
  const claimed = new Set<number>();

  let owner: T | undefined;
  let ownerDepth = Number.POSITIVE_INFINITY;
  for (const window of windows) {
    // Une table corrompue peut porter un ppid non entier — le filtre des analyseurs
    // n'ecarte que le non-positif —, et il se retrouverait alors dans la chaine. Une
    // fenetre au pid absurde y correspondrait. Elle n'en est pas une : on l'ignore.
    if (!isRealPid(window.extHostPid)) continue;

    const depth = depthByPid.get(window.extHostPid);
    if (depth === undefined) continue;

    // UN PID REVENDIQUE DEUX FOIS EST UNE AMBIGUITE, quelle que soit sa place dans la
    // chaine. Le registre nomme ses fichiers d'apres le pid et la lecture le verifie : ce
    // cas ne peut plus provenir que d'une duplication ou d'une forge. On ne departage donc
    // PAS — surtout pas par l'ordre d'enumeration, qui donnerait la victoire au premier nom
    // de fichier venu. L'ambiguite est nommee, l'appelant tranche.
    //
    // PORTEE, ET ELLE EST HONNETE : ce chemin n'est PAS atteignable depuis `readRegistry`
    // aujourd'hui — `claimsItsOwnName` impose `<extHostPid>.json`, et deux fichiers d'un
    // meme repertoire ne peuvent pas porter le meme nom. C'est de la defense en profondeur.
    // Mais cette fonction est exportee publiquement sur un `WindowLike` qui n'exige qu'un
    // `extHostPid`, et le lot C sera le premier appelant a ne pas venir de `readRegistry`.
    if (claimed.has(window.extHostPid)) {
      throw new ClaudeManagerError(
        ERROR_CODES.DUPLICATE_WINDOW_IDENTITY,
        `Two registered windows claim extension host ${window.extHostPid}`,
        { extHostPid: window.extHostPid, chainDepth: depth }
      );
    }
    claimed.add(window.extHostPid);

    // Quand PLUSIEURS fenetres enregistrees figurent dans la chaine — cas anormal mais
    // possible, une fenetre VSCode ouverte depuis le terminal integre d'une autre —, on
    // retient la PLUS PROCHE du processus appelant. C'est necessairement la fenetre hote
    // reelle : les autres ne sont que ses aieules, et agir sur elles violerait l'isolation.
    // L'arbitrage n'a lieu qu'APRES la garde ci-dessus : on ne departage jamais une
    // ambiguite, on la nomme.
    if (depth < ownerDepth) {
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
