/**
 * Hygiene du lanceur d'integration : ce qu'il efface apres lui, et comment il echoue.
 *
 * DEUX REGLES, ET ELLES VIENNENT D'UN DEFAUT MESURE (finding B1 du gate). La suite passait
 * INTEGRALEMENT, le rapport etait complet, le point 8 verifie — puis `fs.rmSync` sur le
 * `--user-data-dir` levait `EPERM`, VSCode conservant des poignees dessus juste apres sa
 * sortie, et la commande sortait en code 1. Or `npm run test:integration` est un critere de
 * merge : une commande qui echoue alors que tout est vert finit par etre contournee, ce qui
 * est le pire des etats.
 *
 *   1. Le code de sortie reflete LES ASSERTIONS, jamais l'hygiene. Un nettoyage qui echoue
 *      n'echoue pas la commande.
 *   2. Mais il n'echoue jamais EN SILENCE : l'echec est rapporte, avec son code systeme
 *      (principe fondateur n.3).
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Ce que le harnais depose sous le repertoire temporaire — et LUI SEUL.
 *
 * Les motifs sont ancres des deux cotes : un fichier qui ne les respecte pas exactement n'a
 * pas ete ecrit par nous et n'est jamais touche. `mkdtemp` ajoute six caracteres aleatoires,
 * d'ou la longueur imposee sur les deux repertoires.
 */
const HARNESS_LEFTOVERS: readonly RegExp[] = [
  /^cmgr-b3-ws-[A-Za-z0-9]{6}$/,
  /^cmgr-b3-uds-[A-Za-z0-9]{6}$/,
  /^cmgr-b3-report-\d+\.json$/,
  // Un rapport PAR SCENARIO depuis B5 : `cmgr-b3-report-<pid>-<scenario>.json`. La forme
  // sans scenario est conservee — le repertoire temporaire du poste en porte encore, laisses
  // par les executions anterieures, et ne plus les reconnaitre les rendrait immortels.
  /^cmgr-b3-report-\d+-[a-z][a-z0-9-]*\.json$/,
  /^cmgr-b3-current\.json$/,
];

/**
 * Le verrou N'EST PAS un residu balayable, et il n'a rien a faire dans la liste ci-dessus : un
 * run concurrent le detient legitimement, et l'effacer reviendrait a supprimer l'exclusion
 * mutuelle qu'on vient de poser. Il est retire par son detenteur, ou repris quand le pid qu'il
 * porte est mort.
 */
export const HARNESS_LOCK_FILE = 'cmgr-b3-harness.lock';

export interface RemovalOutcome {
  readonly target: string;
  readonly removed: boolean;
  /** `OK`, ou le code systeme du dernier echec. Jamais le message, qui porte le chemin. */
  readonly code: string;
  readonly attempts: number;
}

export interface RemoveOptions {
  /** Bornes du reessai. Volontairement petites : on temporise, on ne s'acharne pas. */
  readonly attempts?: number;
  readonly delayMs?: number;
  /**
   * SEUL POINT D'INJECTION du module, et il est la pour une raison precise : une
   * suppression qui echoue ne se provoque pas a volonte sur un vrai systeme de fichiers —
   * l'`EPERM` de VSCode depend d'un minutage —, alors que la BORNE du reessai est justement
   * ce qu'il faut prouver. Le defaut rend le vrai `rmSync`, et c'est lui que le harnais
   * emploie.
   */
  readonly remove?: (target: string) => void;
}

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 200;

function systemCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code } = error as { readonly code?: unknown };
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'UNKNOWN';
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Supprime, avec reessai borne et temporisation — et NE LEVE JAMAIS.
 *
 * La temporisation croit avec le rang de la tentative : les poignees que VSCode garde sur
 * son `--user-data-dir` se relachent en quelques centaines de millisecondes, et attendre un
 * peu plus a chaque fois vaut mieux que marteler.
 */
export async function removeQuietly(
  target: string,
  options: RemoveOptions = {}
): Promise<RemovalOutcome> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const remove = options.remove ?? ((item: string) => fs.rmSync(item, { recursive: true, force: true }));

  let lastCode = 'UNKNOWN';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      remove(target);
      return { target, removed: true, code: 'OK', attempts: attempt };
    } catch (error) {
      lastCode = systemCodeOf(error);
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }

  return { target, removed: false, code: lastCode, attempts };
}

/**
 * Enumere ce que des executions PRECEDENTES du harnais ont laisse derriere elles.
 *
 * Le lanceur n'effacait que le workspace et le `user-data-dir` de son propre run : les
 * rapports et le fichier de position s'accumulaient a chaque execution — six retires a la
 * main sur le poste de reference —, et un run interrompu par l'`EPERM` ci-dessus laissait en
 * plus son `user-data-dir` entier.
 *
 * Rend des chemins absolus, tries, et RIEN qui ne corresponde exactement a un motif du
 * harnais : ce repertoire est partage avec tout le systeme.
 */
/**
 * Verrou d'execution du harnais — un VRAI, parce que l'ancienne justification etait FAUSSE.
 *
 * Le balayage des residus supprime des `--user-data-dir` que le harnais a laisses derriere
 * lui. Il etait justifie ainsi : « deux executions simultanees sont deja impossibles par
 * construction, `cmgr-b3-current.json` etant ecrit a un chemin fixe que la seconde
 * ecraserait ». UN CHEMIN FIXE ECRASE N'EST PAS UNE EXCLUSION MUTUELLE : il ne bloque rien, il
 * perd une information. Deux `npm run test:integration` lances en parallele demarrent tous les
 * deux, et le balayage du premier supprime le `--user-data-dir` d'un VSCode EN COURS
 * D'EXECUTION (finding S7).
 *
 * `wx` est l'exclusion mutuelle elle-meme : la creation echoue si le fichier existe, et
 * l'operation est atomique cote systeme de fichiers. Le pid du detenteur y est ecrit — non
 * pour departager, mais pour que le second run puisse DIRE qui le tient.
 */
export interface HarnessLock {
  readonly acquired: boolean;
  /** Pid du run qui le detient deja, quand `acquired` est faux et qu'il a pu etre lu. */
  readonly holder?: number;
}

/**
 * Prend le verrou, ou dit qui le tient.
 *
 * RESIDU D'UN RUN MORT : un harnais tue en cours de route laisse son verrou. On ne l'ecrase
 * jamais a l'aveugle — on demande au systeme si le pid inscrit vit encore, et on ne le reprend
 * que s'il est mort. `process.kill(pid, 0)` n'envoie AUCUN signal : c'est un test d'existence,
 * jamais une terminaison. Un `EPERM` signifie « il existe mais il n'est pas a nous » — donc
 * vivant, donc on ne prend pas.
 */
export function acquireHarnessLock(file: string): HarnessLock {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { encoding: 'utf8', flag: 'wx' });
      return { acquired: true };
    } catch (error) {
      if (systemCodeOf(error) !== 'EEXIST') return { acquired: false };
    }

    const holder = readLockHolder(file);
    if (holder === undefined || isAlive(holder)) {
      return holder === undefined ? { acquired: false } : { acquired: false, holder };
    }
    // Le detenteur est mort : son verrou n'est plus qu'un residu, et on le retire une fois.
    try {
      fs.rmSync(file, { force: true });
    } catch {
      return { acquired: false, holder };
    }
  }

  return { acquired: false };
}

/** Rend le verrou. Ne leve jamais : l'hygiene ne fait pas echouer un run (regle n.1). */
export function releaseHarnessLock(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Rien a dire de plus : le prochain run le reprendra en constatant que ce pid est mort.
  }
}

function readLockHolder(file: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 : aucun signal n'est envoye, seule l'existence est testee.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // `EPERM` : le processus existe, il ne nous appartient pas. Vivant, donc.
    return systemCodeOf(error) === 'EPERM';
  }
}

export function findHarnessLeftovers(dir: string): readonly string[] {
  let entries: readonly string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  return entries
    .filter((name) => HARNESS_LEFTOVERS.some((pattern) => pattern.test(name)))
    .sort()
    .map((name) => path.join(dir, name));
}
