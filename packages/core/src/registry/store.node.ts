/**
 * Registre des fenetres pilotables, sur le systeme de fichiers.
 *
 * UN FICHIER PAR FENETRE, et non un registre unique : c'est une decision. Plusieurs
 * extension hosts ecrivent simultanement, sans aucun moyen de se coordonner entre eux. Un
 * fichier partage exigerait un verrou — donc un etat a reparer quand un processus meurt en
 * le tenant. Un fichier nomme par le pid rend le conflit structurellement impossible, et
 * fait de la purge une simple suppression.
 *
 * Ce module ne fait AUCUN reseau et ne parle a personne : il lit et ecrit des fichiers. Le
 * serveur local vit dans l'extension compagnon, le client HTTP dans `core/client`.
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeManagerError, ERROR_CODES } from '../errors.js';
import type { ProcessTable } from '../identity/processTable.js';
import { parseWindowEntry, type EntryIdentity, type WindowEntry } from './entry.js';

/** Motif pour lequel un fichier du registre n'a pas donne de fenetre pilotable. */
export type SkipReason = 'unreadable' | 'unparsable' | 'invalid' | 'foreign-schema' | 'dead' | 'pid-reused';

export interface SkippedEntry {
  /**
   * Nom de fichier seul, JAMAIS un chemin absolu : ce champ part vers un agent et vers des
   * journaux, et le chemin du registre porte le nom de l'utilisateur.
   */
  readonly file: string;
  readonly reason: SkipReason;
}

export interface RegistryReadResult {
  readonly windows: readonly WindowEntry[];
  /**
   * Tout ce qui a ete ecarte, et pourquoi. Ce n'est pas decoratif : c'est l'application du
   * principe fondateur n.3 — l'appelant apprend TOUJOURS qu'on a laisse quelque chose de
   * cote. `cmgr windows` et `cmgr doctor` s'en servent.
   */
  readonly skipped: readonly SkippedEntry[];
}

export interface ReadRegistryOptions {
  /**
   * Fournie par l'appelant, jamais relue ici : `readProcessTable()` coute de 700 ms a
   * 1,25 s sur un poste reel. Le coeur ne garde volontairement aucun etat — la mise en
   * cache appartient a l'appelant, qui sait seul quand son instantane a vieilli.
   */
  readonly table: ProcessTable;
  readonly dir?: string;
}

export interface PurgeStaleEntriesOptions {
  readonly table: ProcessTable;
  readonly dir?: string;
}

export interface WriteWindowEntryOptions {
  readonly dir?: string;
}

const ENTRY_EXTENSION = '.json';

/** Racine par defaut, sous le repertoire personnel : jamais de separateur code en dur. */
export function resolveRegistryDir(dir?: string): string {
  return dir ?? path.join(os.homedir(), '.claudemanager', 'windows');
}

/**
 * Liste les fichiers candidats du registre.
 *
 * Un repertoire absent est l'etat NOMINAL d'un poste ou aucune fenetre ne s'est encore
 * enregistree : resultat vide, aucune erreur. Un repertoire present mais illisible est en
 * revanche une anomalie, et elle est nommee.
 *
 * L'existence est sondee avant la lecture plutot que deduite du code d'erreur systeme :
 * cela evite d'interpreter une valeur non contractuelle, et surtout de faire remonter un
 * message systeme — qui porte le chemin absolu du registre, donc le nom de l'utilisateur.
 * Prix assume : un repertoire supprime entre le sondage et la lecture sera signale comme
 * illisible plutot que comme absent. C'est une anomalie de concurrence, la nommer est juste.
 */
function listEntryFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];

  try {
    return readdirSync(dir).filter((name) => name.endsWith(ENTRY_EXTENSION));
  } catch {
    // Sans detail : le message systeme porterait le chemin du registre dans les journaux.
    throw new ClaudeManagerError(
      ERROR_CODES.REGISTRY_UNREADABLE,
      'The window registry directory exists but cannot be listed'
    );
  }
}

type Liveness = 'alive' | 'dead' | 'pid-reused' | 'unknown';

/**
 * Juge si la fenetre decrite par une entree existe encore.
 *
 * GARDE ANTI-REEMPLOI DE PID : un pid vivant ne prouve pas que la fenetre l'est. Un pid
 * libere puis reattribue par le systeme designerait un processus quelconque — et le
 * registre pretendrait piloter une fenetre qui n'en est pas une, ce qui viole directement
 * l'invariant d'isolation. Le `ppid` releve a l'enregistrement le detecte : un processus
 * reattribue n'a quasiment jamais le meme parent que l'extension host qu'il remplace.
 *
 * Sans `extHostPid` lisible, on ne CONCLUT pas : on ne sait pas si l'entree est morte, et
 * la purge devra s'en abstenir.
 */
function judgeLiveness(identity: EntryIdentity, table: ProcessTable): Liveness {
  const { extHostPid, mainPid } = identity;
  if (extHostPid === undefined) return 'unknown';

  const parentPid = table.get(extHostPid);
  if (parentPid === undefined) return 'dead';
  // `mainPid` manque aux entrees anterieures au schema 1 : leur vivacite se juge alors sur
  // la seule presence du pid, faute de mieux. Elles ne sont de toute facon jamais pilotees.
  if (mainPid !== undefined && parentPid !== mainPid) return 'pid-reused';

  return 'alive';
}

type Classification =
  | { readonly kind: 'window'; readonly entry: WindowEntry }
  | { readonly kind: 'skip'; readonly reason: SkipReason };

function classifyFile(file: string, table: ProcessTable): Classification {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return { kind: 'skip', reason: 'unreadable' };
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { kind: 'skip', reason: 'unparsable' };
  }

  const parsed = parseWindowEntry(value);
  // La vivacite se juge AVANT le schema : la version d'une fenetre morte n'a plus d'objet,
  // et c'est ce qui rend une entree etrangere perimee purgeable un jour.
  const liveness = judgeLiveness(parsed.identity, table);
  if (liveness === 'dead' || liveness === 'pid-reused') return { kind: 'skip', reason: liveness };

  if (!parsed.ok) return { kind: 'skip', reason: parsed.reason };
  return { kind: 'window', entry: parsed.entry };
}

/**
 * Lit le registre et classe chacune de ses entrees.
 *
 * LA LECTURE NE SUPPRIME RIEN : elle est sans effet de bord, ce qui la rend sure a appeler
 * depuis n'importe quel processus, y compris plusieurs a la fois. La purge est une
 * operation distincte et explicite.
 *
 * Aucun tri n'est applique : departager ou ordonner des fenetres supposerait un critere, et
 * le seul disponible ici serait le chemin du workspace — precisement ce que l'invariant
 * d'isolation interdit d'utiliser.
 *
 * @throws {ClaudeManagerError} `REGISTRY_UNREADABLE`
 */
export function readRegistry(options: ReadRegistryOptions): RegistryReadResult {
  const dir = resolveRegistryDir(options.dir);
  const windows: WindowEntry[] = [];
  const skipped: SkippedEntry[] = [];

  for (const file of listEntryFiles(dir)) {
    const classification = classifyFile(path.join(dir, file), options.table);
    if (classification.kind === 'window') windows.push(classification.entry);
    else skipped.push({ file, reason: classification.reason });
  }

  return { windows, skipped };
}

/**
 * Supprime les entrees dont la fenetre n'existe plus, et RIEN d'autre.
 *
 * PURGE CONSERVATRICE — c'est une decision, pas un detail d'implementation. Ne sont
 * supprimees que les entrees jugees `dead` ou `pid-reused`, quel que soit leur schema : un
 * processus mort ne revient pas, sa version importe peu. Une entree etrangere dont le pid
 * est VIVANT n'est jamais touchee : elle appartient probablement a une version ulterieure
 * de ClaudeManager, et il est hors de question que la version 1 detruise ses entrees.
 *
 * Contre-intuitif mais volontaire : une entree illisible ou corrompue dont on n'a pas pu
 * lire le pid n'est PAS supprimable non plus — on ignore si sa fenetre est morte, et
 * supprimer par defaut reviendrait a nettoyer a l'aveugle le registre d'autrui.
 *
 * Operation explicite, appelee a l'activation de l'extension compagnon. JAMAIS depuis
 * `readRegistry`.
 */
export function purgeStaleEntries(options: PurgeStaleEntriesOptions): readonly string[] {
  const dir = resolveRegistryDir(options.dir);
  // La purge rejoue exactement la classification de la lecture : les deux ne peuvent pas
  // diverger, donc la purge ne peut pas supprimer ce que la lecture aurait retenu.
  const { skipped } = readRegistry({ table: options.table, dir });

  const removed: string[] = [];
  for (const entry of skipped) {
    if (entry.reason !== 'dead' && entry.reason !== 'pid-reused') continue;
    // `force` : deux fenetres peuvent purger en meme temps. Un fichier deja disparu n'est
    // pas une defaillance, c'est le resultat recherche. Les autres erreurs, elles, remontent.
    rmSync(path.join(dir, entry.file), { force: true });
    removed.push(entry.file);
  }

  return removed;
}

/**
 * Publie l'entree d'une fenetre.
 *
 * Ecriture ATOMIQUE : fichier temporaire du MEME repertoire puis `rename`, jamais
 * d'ecriture en place. Un lecteur concurrent — il y en a, par construction — ne doit
 * jamais tomber sur un JSON tronque. Le temporaire ne porte pas l'extension des entrees :
 * il ne serait pas lu meme s'il etait apercu.
 *
 * IDEMPOTENTE : reecrire la meme entree remplace le fichier, sans doublon ni erreur.
 *
 * @throws {ClaudeManagerError} `REGISTRY_ENTRY_INVALID` — ecrire une entree qu'on
 * refuserait de relire n'aurait aucun sens.
 */
export function writeWindowEntry(entry: WindowEntry, options: WriteWindowEntryOptions = {}): string {
  const parsed = parseWindowEntry(entry);
  if (!parsed.ok) {
    throw new ClaudeManagerError(
      ERROR_CODES.REGISTRY_ENTRY_INVALID,
      `Refusing to publish a window entry rejected as ${parsed.reason}`,
      { reason: parsed.reason, extHostPid: parsed.identity.extHostPid }
    );
  }

  const dir = resolveRegistryDir(options.dir);
  mkdirSync(dir, { recursive: true });

  const file = path.join(dir, `${parsed.entry.extHostPid}${ENTRY_EXTENSION}`);
  const temporary = path.join(dir, `${parsed.entry.extHostPid}.${randomUUID()}.tmp`);
  // On ecrit l'entree RECONSTRUITE : un champ inconnu tolere a la lecture n'est jamais
  // reecrit, sans quoi le registre accumulerait des champs que plus personne ne comprend.
  writeFileSync(temporary, `${JSON.stringify(parsed.entry, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);

  return file;
}
