/**
 * Entree du registre des fenetres pilotables.
 *
 * Ce module est pur : aucune entree/sortie, aucune dependance a la plateforme. Les acces au
 * systeme de fichiers vivent dans `store.node.ts`.
 */

/**
 * Version du schema d'une entree.
 *
 * C'est le garde-fou du rattrapage de l'existant (principe fondateur n.7) : le repertoire du
 * registre peut contenir des entrees ecrites par une version ANTERIEURE de ClaudeManager —
 * il en existe sur le poste de developpement — comme par une version ULTERIEURE. Une entree
 * dont le schema n'est pas exactement celui-ci n'est jamais pilotee, et n'est jamais
 * confondue avec une entree corrompue : les deux cas n'appellent pas le meme traitement.
 */
export const WINDOW_ENTRY_SCHEMA_VERSION = 1;

/** Ce qu'une fenetre VSCode publie d'elle-meme pour se rendre joignable. */
export interface WindowEntry {
  readonly schemaVersion: number;
  /**
   * IDENTITE de la fenetre, et rien d'autre ne l'est.
   *
   * Jamais `VSCODE_PID` — un processus principal heberge plusieurs fenetres et le partage
   * entre toutes (piege n.4) —, jamais le titre, jamais le chemin du workspace : deux
   * fenetres sur le meme dossier physique sont le cas de reference du produit.
   */
  readonly extHostPid: number;
  /** `ppid` de l'extension host a l'enregistrement : garde anti-reemploi de PID. */
  readonly mainPid: number;
  readonly port: number;
  readonly token: string;
  readonly workspaceFolders: readonly string[];
  readonly isTrusted: boolean;
  readonly extensionVersion: string;
  readonly startedAt: string;
}

/**
 * Motif de rejet d'une valeur brute.
 *
 * `foreign-schema` n'est PAS une variante de `invalid` : une entree etrangere est
 * probablement bien formee pour la version qui l'a ecrite. La distinction commande la
 * purge — on ne detruit pas les entrees d'une autre version (voir `store.node.ts`).
 */
export type EntryRejectionReason = 'invalid' | 'foreign-schema';

/**
 * Les seuls pid lisibles d'une valeur brute, valides ou non par ailleurs.
 *
 * Ils servent EXCLUSIVEMENT a juger la vivacite d'une entree qu'on n'a pas retenue : sans
 * eux, une entree etrangere ou corrompue serait indestructible, meme apres la mort de sa
 * fenetre. Ils n'entrent jamais dans la liste des fenetres pilotables.
 */
export interface EntryIdentity {
  readonly extHostPid: number | undefined;
  readonly mainPid: number | undefined;
}

export interface WindowEntryAccepted {
  readonly ok: true;
  readonly identity: EntryIdentity;
  readonly entry: WindowEntry;
}

export interface WindowEntryRejected {
  readonly ok: false;
  readonly identity: EntryIdentity;
  readonly reason: EntryRejectionReason;
}

export type ParseResult = WindowEntryAccepted | WindowEntryRejected;

/** Le plus grand numero de port TCP. */
const MAX_PORT = 65_535;

function asInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/**
 * Alerte n.14 : l'entier strictement positif est la defense du registre contre une fausse
 * correspondance d'identite. `resolveOwningWindow` construit sa chaine a partir du pid
 * appelant sans le valider ; une entree portant un `extHostPid` absurde (`0`, `NaN`, non
 * entier) face au meme pid appelant absurde produirait une correspondance — donc une
 * violation de l'isolation. Il a ete decide que le registre en est le garant.
 */
function asPositiveInteger(value: unknown): number | undefined {
  const integer = asInteger(value);
  return integer !== undefined && integer > 0 ? integer : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asPort(value: unknown): number | undefined {
  const port = asPositiveInteger(value);
  return port !== undefined && port <= MAX_PORT ? port : undefined;
}

/**
 * Refuser une fenetre sans dossier de travail est une REGLE DE VALIDATION, pas un controle
 * tardif : une session Claude ne se charge dans un panneau que si son `cwd` correspond au
 * workspace de la fenetre (`docs/compatibilite.md`, D10). Sans workspace,
 * `claude-vscode.editor.open` REUSSIT en ouvrant un panneau vide, sans lever la moindre
 * erreur. On refuse donc en amont, plutot que d'echouer en silence bien plus tard.
 */
function asWorkspaceFolders(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const folders: string[] = [];
  for (const candidate of value as readonly unknown[]) {
    const folder = asNonEmptyString(candidate);
    if (folder === undefined) return undefined;
    folders.push(folder);
  }
  return folders;
}

/** Une date qu'on ne sait pas relire ne date rien : elle est refusee comme tout le reste. */
function asTimestamp(value: unknown): string | undefined {
  const text = asNonEmptyString(value);
  if (text === undefined) return undefined;
  return Number.isFinite(Date.parse(text)) ? text : undefined;
}

function readIdentity(raw: Readonly<Record<string, unknown>>): EntryIdentity {
  return {
    extHostPid: asPositiveInteger(raw['extHostPid']),
    mainPid: asPositiveInteger(raw['mainPid']),
  };
}

function reject(
  reason: EntryRejectionReason,
  raw: Readonly<Record<string, unknown>>
): WindowEntryRejected {
  return { ok: false, identity: readIdentity(raw), reason };
}

const NO_IDENTITY: EntryIdentity = { extHostPid: undefined, mainPid: undefined };

/**
 * Valide une valeur brute lue sur disque.
 *
 * Le registre est un contrat entre plusieurs versions potentiellement differentes de
 * l'extension et de la CLI, ecrivant toutes dans le meme repertoire. Une entree n'est
 * jamais devinee : elle est retenue telle qu'elle est comprise, ou rejetee avec son motif.
 * Rien ne disparait en silence (principe fondateur n.3).
 */
export function parseWindowEntry(value: unknown): ParseResult {
  // Un tableau est bien un objet : c'est un fichier corrompu, pas un schema etranger.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, identity: NO_IDENTITY, reason: 'invalid' };
  }
  const raw = value as Readonly<Record<string, unknown>>;

  // Le schema d'abord : une entree d'une AUTRE version se reconnait a cela seul, et ses
  // autres champs n'ont pas a etre juges par les regles de la version courante.
  const rawSchemaVersion = raw['schemaVersion'];
  // Champ absent : c'est la forme exacte des entrees 0.1.0 heritees. Elles sont etrangeres,
  // pas corrompues — la nuance decide si la purge a le droit d'y toucher.
  if (rawSchemaVersion === undefined) return reject('foreign-schema', raw);
  const schemaVersion = asInteger(rawSchemaVersion);
  // Present mais pas un entier : aucune version n'a jamais ecrit cela, le fichier est
  // corrompu. Un entier different, lui, denote bel et bien une autre version.
  if (schemaVersion === undefined) return reject('invalid', raw);
  if (schemaVersion !== WINDOW_ENTRY_SCHEMA_VERSION) return reject('foreign-schema', raw);

  const extHostPid = asPositiveInteger(raw['extHostPid']);
  if (extHostPid === undefined) return reject('invalid', raw);

  const mainPid = asPositiveInteger(raw['mainPid']);
  if (mainPid === undefined) return reject('invalid', raw);

  const port = asPort(raw['port']);
  if (port === undefined) return reject('invalid', raw);

  const token = asNonEmptyString(raw['token']);
  if (token === undefined) return reject('invalid', raw);

  const workspaceFolders = asWorkspaceFolders(raw['workspaceFolders']);
  if (workspaceFolders === undefined) return reject('invalid', raw);

  const isTrusted = raw['isTrusted'];
  if (typeof isTrusted !== 'boolean') return reject('invalid', raw);

  const extensionVersion = asNonEmptyString(raw['extensionVersion']);
  if (extensionVersion === undefined) return reject('invalid', raw);

  const startedAt = asTimestamp(raw['startedAt']);
  if (startedAt === undefined) return reject('invalid', raw);

  return {
    ok: true,
    identity: { extHostPid, mainPid },
    // Reconstruction champ a champ : un champ inconnu ne rend pas l'entree invalide
    // (compatibilite ascendante) mais n'est jamais propage — encore moins reecrit.
    entry: {
      schemaVersion,
      extHostPid,
      mainPid,
      port,
      token,
      workspaceFolders,
      isTrusted,
      extensionVersion,
      startedAt,
    },
  };
}
