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
 * serveur local vit dans l'extension compagnon, le client HTTP vivra dans `core/client`.
 */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeManagerError, ERROR_CODES, systemErrorCode } from '../errors.js';
import type { ProcessSnapshot } from '../identity/processTable.js';
import { parseWindowEntry, type EntryIdentity, type WindowEntry } from './entry.js';

/** Motif pour lequel un fichier du registre n'a pas donne de fenetre pilotable. */
export type SkipReason =
  | 'unreadable'
  | 'unparsable'
  | 'invalid'
  | 'foreign-schema'
  | 'identity-mismatch'
  | 'dead'
  | 'pid-reused';

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

/**
 * Motif pour lequel la purge a LAISSE un fichier qu'elle avait condamne.
 *
 * Deux motifs n'existent QU'ICI, parce qu'ils n'ont de sens que pour la purge :
 *   - `younger-than-snapshot` — ce fichier a-t-il pu naitre APRES l'instantane qui le
 *     condamne ? La lecture, elle, classe sur la seule table ;
 *   - `removal-failed` — le systeme de fichiers a refuse la suppression. La lecture ne
 *     supprime rien, elle ne peut donc pas rencontrer ce cas.
 */
export type KeptReason = SkipReason | 'younger-than-snapshot' | 'removal-failed';

export interface KeptEntry {
  readonly file: string;
  readonly reason: KeptReason;
  /**
   * CODE systeme de la defaillance, et rien d'autre — present pour le seul motif
   * `removal-failed`.
   *
   * Ni le message ni le chemin : une erreur `fs` de Node embarque systematiquement le
   * chemin absolu, donc le nom du compte, et ce champ part vers un agent et vers des
   * journaux joints en preuve a des PR d'un depot public (voir `systemErrorCode`).
   */
  readonly cause?: string;
}

export interface PurgeResult {
  /** Entrees effectivement supprimees. */
  readonly removed: readonly string[];
  /** Temporaires d'ecriture abandonnes, effaces : ils portaient un jeton en clair. */
  readonly removedTemporaries: readonly string[];
  /**
   * Tout ce que la purge a LAISSE, avec le motif exact — entrees comme temporaires.
   *
   * C'est ce qui empeche la purge conservatrice d'etre une disparition silencieuse : une
   * entree heritee dont le pid est recycle n'est ni pilotable ni purgeable — elle est donc
   * immortelle, et `cmgr doctor` doit pouvoir la montrer a l'utilisateur plutot que de la
   * taire. Un fichier que le systeme a refuse d'effacer y figure au meme titre : sans lui,
   * la seule trace de l'incident serait la purge avortee elle-meme.
   */
  readonly kept: readonly KeptEntry[];
}

export interface ReadRegistryOptions {
  /**
   * Fourni par l'appelant, jamais releve ici : `readProcessTable()` coute de 700 ms a
   * 1,3 s sur un poste reel. Le coeur ne garde volontairement aucun etat — la mise en
   * cache appartient a l'appelant, qui sait seul quand son instantane a vieilli. C'est
   * precisement pourquoi l'instantane porte sa date : lire sur une table perimee est
   * reparable, mais la purge, elle, ne peut pas se le permettre.
   */
  readonly snapshot: ProcessSnapshot;
  readonly dir?: string;
}

export interface PurgeStaleEntriesOptions {
  readonly snapshot: ProcessSnapshot;
  readonly dir?: string;
}

export interface WriteWindowEntryOptions {
  readonly dir?: string;
}

const ENTRY_EXTENSION = '.json';
const TEMPORARY_EXTENSION = '.tmp';

/**
 * Temporaire d'ecriture atomique : `<pid>.<uuid>.tmp`.
 *
 * Le pid en prefixe n'est pas decoratif — c'est ce qui rend un temporaire ORPHELIN
 * identifiable, donc effacable. Le motif est strict : un fichier qui ne le respecte pas
 * n'a pas ete ecrit par nous et n'est jamais touche.
 */
const TEMPORARY_FILE = /^(\d+)\.[0-9a-f-]+\.tmp$/;

/**
 * Droits du repertoire du registre et de ses entrees.
 *
 * Une entree porte le JETON PORTEUR de sa fenetre en clair. Sans `mode`, Node applique
 * `0o777 & ~umask` au repertoire et `0o666 & ~umask` au fichier — soit 0755 et 0644 sous
 * l'umask par defaut : sur un poste POSIX multi-utilisateurs, n'importe quel autre compte
 * lit le jeton et le port de chaque fenetre. Les deux modes sont necessaires, le
 * temporaire portant exactement le meme secret que l'entree definitive.
 *
 * Sous Windows ces bits n'ont pas de sens — `chmod` n'y pilote que l'attribut « lecture
 * seule » — et c'est l'ACL heritee de `C:\\Users\\<compte>` qui protege deja. Les poser
 * n'y coute rien et n'y echoue pas.
 */
const REGISTRY_DIR_MODE = 0o700;
const ENTRY_FILE_MODE = 0o600;

/** Racine par defaut, sous le repertoire personnel : jamais de separateur code en dur. */
export function resolveRegistryDir(dir?: string): string {
  return dir ?? path.join(os.homedir(), '.claudemanager', 'windows');
}

/**
 * LA CONVENTION DE NOMMAGE DU REGISTRE — `<extHostPid>.json`, et elle vit ICI.
 *
 * Elle etait REECRITE a la main partout ou l'on voulait localiser une entree : dans le coeur
 * (ecriture, confrontation du nom au contenu), dans l'extension, et — sans aucune garde — dans
 * le harnais d'integration, qui reencodait a la fois le repertoire et le nom (alerte n.33).
 * Le coeur, lui, est garde de toutes parts : changer la convention y fait tomber des tests. Le
 * harnais ne faisait qu'un `existsSync` sur un chemin qui n'aurait alors jamais rien porte, et
 * aurait imprime « l entree a DISPARU : deactivate a bien retire cette fenetre » — une preuve
 * FAUSSE dans un journal joint a une PR, donc dans un critere de merge.
 *
 * Exporter la convention rend cette classe de defaut impossible : le jour ou elle change, elle
 * change en un seul endroit, et tous ses consommateurs suivent sans le savoir.
 *
 * ELLE N'EST PAS DANS LE CONTRAT INTER-VERSIONS pour autant — celui-ci ne gele que
 * `schemaVersion` et `extHostPid` (voir `judgeForeignLiveness`). Une version 2 a le droit de
 * nommer ses fichiers autrement ; c'est precisement pourquoi la version 1 ne conclut jamais
 * « ce pid est mort » sur la foi d'un nom de fichier.
 */
export function windowEntryFileName(extHostPid: number): string {
  return `${extHostPid}${ENTRY_EXTENSION}`;
}

/** Chemin complet de l'entree d'UNE fenetre, registre par defaut sauf mention contraire. */
export function windowEntryPath(extHostPid: number, dir?: string): string {
  return path.join(resolveRegistryDir(dir), windowEntryFileName(extHostPid));
}

/**
 * Liste les fichiers du registre.
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
function listFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];

  try {
    return readdirSync(dir);
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
 * Juge si la fenetre decrite par une entree DU SCHEMA COURANT existe encore.
 *
 * GARDE ANTI-REEMPLOI DE PID : un pid vivant ne prouve pas que la fenetre l'est. Un pid
 * libere puis reattribue par le systeme designerait un processus quelconque — et le
 * registre pretendrait piloter une fenetre qui n'en est pas une, ce qui viole directement
 * l'invariant d'isolation. Le `ppid` releve a l'enregistrement le detecte : un processus
 * reattribue n'a quasiment jamais le meme parent que l'extension host qu'il remplace.
 *
 * SECONDE GARDE, PAR LA DATE DE CREATION : la premiere se franchit. Sous Windows le
 * parent enregistre est le `Code.exe` principal, qui engendre des enfants en permanence —
 * ptyHost, shared process, file watchers, installateurs, autres extension hosts. Un pid
 * recycle par n'importe lequel d'entre eux a EXACTEMENT le meme parent, et passe. Un
 * processus ne APRES l'ecriture de l'entree, en revanche, n'a jamais pu etre la fenetre
 * qui l'a ecrite : la comparaison est sans appel.
 *
 * Elle est stricte, sans marge, et c'est deliberе : la marge est structurelle. Un
 * extension host est cree bien avant que l'extension qui publie son entree ne s'active —
 * l'activation se compte en centaines de millisecondes, la ou les deux horloges du systeme
 * ne divergent que de quelques unites. Y ajouter une tolerance serait une intuition non
 * mesuree, ce que ce projet s'interdit.
 *
 * `mainPid` n'a ce sens QUE dans le schema courant, d'ou cette fonction distincte : voir
 * `judgeForeignLiveness` pour ce qu'on s'autorise face a une entree qu'on ne comprend pas.
 */
function judgeCurrentSchemaLiveness(entry: WindowEntry, snapshot: ProcessSnapshot): Liveness {
  const host = snapshot.table.get(entry.extHostPid);
  if (host === undefined) return 'dead';
  if (host.ppid !== entry.mainPid) return 'pid-reused';
  // Date inconnue : la garde ne s'applique pas, elle ne se devine pas non plus.
  if (host.createdAt !== undefined && host.createdAt > Date.parse(entry.startedAt)) {
    return 'pid-reused';
  }

  return 'alive';
}

/**
 * CONTRAT INTER-VERSIONS — ce que la version 1 a le droit de supposer d'une entree qu'elle
 * n'a pas ecrite, et rien de plus :
 *
 *   - `schemaVersion` designe la version du schema de l'entree ;
 *   - `extHostPid` designe le pid de l'extension host de la fenetre.
 *
 * Ces DEUX champs seulement, une version ulterieure s'engage a ne pas les deplacer. Tous
 * les autres — `mainPid` au premier chef — peuvent changer de sens sans preavis : une
 * version 2 pourrait y mettre un identifiant de fenetre, un `ppid` releve a distance, ou
 * le parent releve a un autre instant.
 *
 * La consequence est stricte : la seule question qu'on s'autorise ici est « ce pid
 * existe-t-il encore ? ». Un pid absent ⇒ `dead`, et un processus mort ne revient pas,
 * quelle que soit la version qui l'a inscrit. Tout le reste ⇒ INTOUCHABLE. Appliquer la
 * semantique v1 de `mainPid` a un schema qu'on ne possede pas reviendrait a supprimer
 * l'entree VIVANTE d'une version ulterieure — exactement ce que `schemaVersion` existe
 * pour empecher.
 *
 * Sans `extHostPid` lisible, on ne CONCLUT pas : on ignore si l'entree est morte, et la
 * purge devra s'en abstenir.
 */
function judgeForeignLiveness(identity: EntryIdentity, snapshot: ProcessSnapshot): Liveness {
  if (identity.extHostPid === undefined) return 'unknown';
  return snapshot.table.has(identity.extHostPid) ? 'unknown' : 'dead';
}

type Classification =
  | { readonly kind: 'window'; readonly entry: WindowEntry }
  | { readonly kind: 'skip'; readonly reason: SkipReason };

/**
 * Fichier du registre, classe et DATE.
 *
 * `modifiedAt` est releve dans le MEME `try` que la lecture : un `stat` separe ajouterait
 * un chemin d'echec propre, la ou un fichier qu'on ne sait pas dater est deja un fichier
 * qu'on ne sait pas lire.
 */
interface ScannedFile {
  readonly file: string;
  readonly classification: Classification;
  readonly modifiedAt: number;
}

/**
 * L'ecriture NOMME le fichier d'apres le pid — la lecture doit donc le VERIFIER.
 *
 * Sans ce controle, rien ne rattache un fichier a l'identite qu'il revendique : n'importe
 * quel processus tournant sous le compte de l'utilisateur peut deposer un `0000.json`
 * declarant l'`extHostPid` et le `mainPid` REELS d'une fenetre. L'entree passe alors toute
 * la validation, est jugee vivante, et gagne l'arbitrage a egalite de profondeur par le
 * seul ordre alphabetique de `readdir` — le client s'adresse au serveur de l'attaquant en
 * croyant parler a sa propre fenetre.
 *
 * Le nom du fichier est la seule chose qu'un intrus ne controle pas librement : deux
 * fichiers ne peuvent pas porter le meme nom, donc un pid ne peut etre revendique qu'une
 * fois. Exiger l'egalite fait de cette contrainte du systeme de fichiers une contrainte
 * d'identite.
 */
function claimsItsOwnName(file: string, identity: EntryIdentity): boolean {
  // Pid illisible : l'entree sera de toute facon rejetee, et jamais purgee faute de savoir
  // si sa fenetre vit. Rien a confronter ici.
  if (identity.extHostPid === undefined) return true;
  return file === windowEntryFileName(identity.extHostPid);
}

function classifyContent(file: string, content: string, snapshot: ProcessSnapshot): Classification {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { kind: 'skip', reason: 'unparsable' };
  }

  const parsed = parseWindowEntry(value);
  if (!claimsItsOwnName(file, parsed.identity)) return { kind: 'skip', reason: 'identity-mismatch' };
  // Le SCHEMA d'abord, la vivacite ensuite — et jamais l'inverse : juger la vivacite d'une
  // entree avant de savoir de quelle version elle est, c'est lui appliquer une semantique
  // qu'on ne lui connait pas. Une entree morte reste purgeable dans les deux cas, mais par
  // la seule question qui vaut pour toutes les versions : son pid existe-t-il encore ?
  const liveness = parsed.ok
    ? judgeCurrentSchemaLiveness(parsed.entry, snapshot)
    : judgeForeignLiveness(parsed.identity, snapshot);
  if (liveness === 'dead' || liveness === 'pid-reused') return { kind: 'skip', reason: liveness };

  if (!parsed.ok) return { kind: 'skip', reason: parsed.reason };
  return { kind: 'window', entry: parsed.entry };
}

/** Parcours unique du registre : la lecture et la purge en derivent toutes deux. */
function scanRegistry(dir: string, snapshot: ProcessSnapshot): readonly ScannedFile[] {
  const scanned: ScannedFile[] = [];

  for (const file of listFiles(dir)) {
    // Un fichier hors convention n'est pas rapporte : il ne pretend pas etre une entree.
    if (!file.endsWith(ENTRY_EXTENSION)) continue;

    const absolute = path.join(dir, file);
    let modifiedAt: number;
    let content: string;
    try {
      // Tronque a la MILLISECONDE : `mtimeMs` porte des fractions de milliseconde sur NTFS
      // quand `Date.now()` n'en a jamais. Sans cette troncature, un fichier ecrit dans la
      // milliseconde de la capture s'en trouverait « plus recent » — et une entree morte
      // deviendrait indestructible une fois sur deux, au hasard de l'horloge.
      modifiedAt = Math.floor(statSync(absolute).mtimeMs);
      content = readFileSync(absolute, 'utf8');
    } catch {
      // Un fichier qu'on ne sait ni dater ni lire ne sera de toute facon jamais supprime.
      scanned.push({ file, classification: { kind: 'skip', reason: 'unreadable' }, modifiedAt: 0 });
      continue;
    }

    scanned.push({ file, classification: classifyContent(file, content, snapshot), modifiedAt });
  }

  return scanned;
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

  for (const scanned of scanRegistry(dir, options.snapshot)) {
    if (scanned.classification.kind === 'window') windows.push(scanned.classification.entry);
    else skipped.push({ file: scanned.file, reason: scanned.classification.reason });
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
 * de ClaudeManager, et il est hors de question que la version 1 detruise ses entrees. Ce
 * que « vivant » veut dire pour une entree qu'on ne comprend pas est fixe par le contrat
 * inter-versions — voir `judgeForeignLiveness`.
 *
 * Contre-intuitif mais volontaire : ni un fichier corrompu, ni une entree dont le nom dement
 * le contenu (`identity-mismatch`) ne sont supprimables — MEME quand un pid mort y est
 * parfaitement lisible.
 *
 * LE MOTIF N'EST PAS « on ignore si sa fenetre est morte », et le dire serait faux : un
 * fichier nomme `<pid>.json` porte un pid lisible dans son NOM, et une entree
 * `identity-mismatch` porte le sien dans son CONTENU. Le motif est que LA CONVENTION DE
 * NOMMAGE N'EST PAS DANS LE CONTRAT INTER-VERSIONS : celui-ci ne gele que `schemaVersion` et
 * `extHostPid` (voir `judgeForeignLiveness`), jamais la facon dont les fichiers sont nommes.
 * Une version 2 a le droit de nommer les siens autrement — et la version 1 lirait alors un
 * `identity-mismatch`, ou un fichier corrompu, sur une entree parfaitement VIVANTE.
 * Conclure « le pid 12345 est mort » sur la foi d'un nom de fichier reviendrait a detruire
 * l'entree d'une version ulterieure : exactement ce que `schemaVersion` existe pour empecher.
 *
 * Seul le CONTENU autorise a conclure, et seulement quand le fichier revendique son propre
 * nom. Ce qui n'est pas supprime est RAPPORTE dans `kept`, jamais escamote.
 *
 * FRAICHEUR DE L'INSTANTANE — contrainte propre a la purge, que la lecture n'a pas :
 * `dead` ne veut dire que « absent de CET instantane ». Une entree publiee apres sa capture
 * en est absente par construction, sans etre morte pour autant — et c'est le cas nominal au
 * demarrage de deux fenetres a quelques centaines de ms d'ecart. Un fichier plus recent que
 * `capturedAt` n'est donc jamais supprime : il est rapporte, jamais escamote. Lire a tort
 * est reparable, supprimer a tort ne l'est pas. Elle vaut pour les entrees COMME pour les
 * temporaires : le processus qui ecrit le sien est exactement celui qu'elle protege.
 *
 * Operation explicite, appelee a l'activation de l'extension compagnon. JAMAIS depuis
 * `readRegistry`.
 *
 * @throws {ClaudeManagerError} `REGISTRY_UNREADABLE` — le repertoire du registre existe mais
 * ne peut pas etre liste. C'est la SEULE defaillance qui interrompt la purge : celles des
 * suppressions, elles, sont rapportees dans `kept` sans jamais l'avorter.
 */
export function purgeStaleEntries(options: PurgeStaleEntriesOptions): PurgeResult {
  const dir = resolveRegistryDir(options.dir);
  // La purge rejoue exactement la classification de la lecture : les deux ne peuvent pas
  // diverger, donc la purge ne peut pas supprimer ce que la lecture aurait retenu.
  const scanned = scanRegistry(dir, options.snapshot);

  const removed: string[] = [];
  const kept: KeptEntry[] = [];
  for (const { file, classification, modifiedAt } of scanned) {
    if (classification.kind === 'window') continue;
    const reason = classification.reason;

    if (reason !== 'dead' && reason !== 'pid-reused') {
      kept.push({ file, reason });
      continue;
    }
    // La datation est DEJA connue : la lecture l'a relevee dans le meme `try` que le
    // contenu. Seuls les temporaires, que rien ne lit, la font relever a la suppression.
    removeIfSettled(
      { dir, file, capturedAt: options.snapshot.capturedAt, modifiedAt },
      removed,
      kept
    );
  }

  const temporaries = purgeOrphanTemporaries(dir, options.snapshot);

  return {
    removed,
    removedTemporaries: temporaries.removed,
    kept: [...kept, ...temporaries.kept],
  };
}

/** Fichier que le classement condamne, et ce que la purge sait deja de sa date. */
interface Condemned {
  readonly dir: string;
  readonly file: string;
  /** Date de l'instantane qui le condamne. */
  readonly capturedAt: number;
  /**
   * Datation DEJA relevee, ou `undefined` s'il revient a la suppression de la relever.
   *
   * Une entree la tient de sa lecture — meme `try`, meme instant. Un temporaire, lui, n'est
   * jamais lu : rien ne l'a datee avant ce point.
   */
  readonly modifiedAt: number | undefined;
}

/**
 * Supprime un fichier condamne — ou DIT pourquoi il ne l'a pas ete.
 *
 * UN SEUL point de suppression pour les entrees ET les temporaires, et c'est ce qui rend la
 * purge TOTALE. Sans ce `try`, une seule defaillance avortait tout le balayage : un
 * repertoire depose au motif d'un temporaire — le prix d'un `mkdir` pour n'importe quel
 * processus du compte — cassait DEFINITIVEMENT le nettoyage du registre de toutes les
 * fenetres du poste, en faisant remonter une erreur `fs` nue portant le chemin absolu.
 *
 * C'est aussi le seul endroit ou la GARDE DE FRAICHEUR s'ecrit, pour que les entrees et les
 * temporaires ne puissent pas en avoir deux versions divergentes. La troncature a la
 * MILLISECONDE est la meme qu'a la lecture : `mtimeMs` porte des fractions de milliseconde
 * sur NTFS quand `capturedAt` n'en a jamais, et sans elle un fichier ecrit dans la
 * milliseconde de la capture s'en trouverait « plus recent » une fois sur deux.
 *
 * `force` : deux fenetres peuvent purger en meme temps. Un fichier deja disparu n'est pas
 * une defaillance mais le RESULTAT RECHERCHE — `force` absorbe `ENOENT`, et rien d'autre.
 * Toute autre defaillance devient une entree `kept`, motif `removal-failed`, portant le seul
 * code systeme : le message porterait le chemin du registre, donc le nom de l'utilisateur.
 *
 * Rapporter plutot que lever preserve les DEUX proprietes a la fois : rien ne disparait en
 * silence (principe fondateur n.3), et le balayage va jusqu'au bout.
 */
function removeIfSettled(condemned: Condemned, removed: string[], kept: KeptEntry[]): void {
  const { file } = condemned;
  const absolute = path.join(condemned.dir, file);

  try {
    const modifiedAt = condemned.modifiedAt ?? Math.floor(statSync(absolute).mtimeMs);
    if (modifiedAt > condemned.capturedAt) {
      kept.push({ file, reason: 'younger-than-snapshot' });
      return;
    }

    rmSync(absolute, { force: true });
    removed.push(file);
  } catch (cause) {
    kept.push({ file, reason: 'removal-failed', cause: systemErrorCode(cause) });
  }
}

/**
 * Efface les temporaires d'ecriture abandonnes.
 *
 * Ils portent le JETON COMPLET et n'ont pas l'extension des entrees : ni la lecture, ni la
 * purge des entrees, ni `cmgr doctor` ne les voient. Un `renameSync` interrompu par une
 * mort brutale du processus en laisse un derriere lui — indefiniment, et avec un secret
 * dedans. `writeWindowEntry` efface les siens ; celui-ci ramasse ceux que personne n'a pu
 * effacer.
 *
 * DEUX gardes decident, exactement les memes que pour les entrees :
 *
 *   - LE PID EN PREFIXE — un temporaire dont le processus VIT peut etre une ecriture en
 *     cours, on n'y touche pas ;
 *   - LA FRAICHEUR DE L'INSTANTANE — et elle manquait ici, alors que le raisonnement qui l'a
 *     imposee aux entrees s'applique mot pour mot a celui qui ecrit son temporaire. Une
 *     fenetre nee APRES la capture est absente de la table par construction : son temporaire
 *     passe pour orphelin quand il est en cours d'ecriture. L'effacer entre son `write` et
 *     son `rename` fait lever `REGISTRY_UNWRITABLE` a une fenetre parfaitement vivante — et
 *     c'est le cas NOMINAL de deux fenetres qui demarrent a quelques centaines de
 *     millisecondes d'ecart, pas un accident de laboratoire.
 */
function purgeOrphanTemporaries(
  dir: string,
  snapshot: ProcessSnapshot
): { readonly removed: readonly string[]; readonly kept: readonly KeptEntry[] } {
  const removed: string[] = [];
  const kept: KeptEntry[] = [];

  for (const file of listFiles(dir)) {
    const match = TEMPORARY_FILE.exec(file);
    if (match === null) continue;
    if (snapshot.table.has(Number.parseInt(match[1] as string, 10))) continue;

    // `modifiedAt: undefined` : personne n'a lu ce fichier, donc personne ne l'a date.
    removeIfSettled(
      { dir, file, capturedAt: snapshot.capturedAt, modifiedAt: undefined },
      removed,
      kept
    );
  }

  return { removed, kept };
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
  // MEME convention que la lecture et que tous les consommateurs, parce que c'est la MEME
  // fonction : l'ecriture nomme, la lecture confronte, et rien ne peut plus les desaccorder.
  const file = windowEntryPath(parsed.entry.extHostPid, dir);
  const temporary = path.join(
    dir,
    `${parsed.entry.extHostPid}.${randomUUID()}${TEMPORARY_EXTENSION}`
  );

  // Le nettoyage du temporaire ne doit JAMAIS masquer la defaillance qu'il accompagne : on
  // ne tente de l'effacer que s'il a reellement ete cree. Sinon `rmSync` sonde un chemin
  // situe SOUS un repertoire qui n'en est pas un — `ENOTDIR`, que `force` ne rattrape pas,
  // contrairement a `ENOENT` — et c'est cette erreur nue qui remonterait a la place.
  let temporaryExists = false;
  try {
    mkdirSync(dir, { recursive: true, mode: REGISTRY_DIR_MODE });
    // RATTRAPAGE DE L'EXISTANT (principe fondateur n.7) : le `mode` de `mkdirSync` ne
    // s'applique qu'a la CREATION, et l'umask le rogne. Un repertoire cree par une version
    // anterieure — il en existe sur des postes en service — resterait donc en 0755. Ce
    // `chmod` est idempotent : il resserre a chaque publication, sans rien exiger de plus.
    chmodSync(dir, REGISTRY_DIR_MODE);
    // On ecrit l'entree RECONSTRUITE : un champ inconnu tolere a la lecture n'est jamais
    // reecrit, sans quoi le registre accumulerait des champs que plus personne ne comprend.
    writeFileSync(temporary, `${JSON.stringify(parsed.entry, null, 2)}\n`, {
      encoding: 'utf8',
      mode: ENTRY_FILE_MODE,
    });
    temporaryExists = true;
    renameSync(temporary, file);
  } catch (cause) {
    // Un temporaire abandonne porte le JETON COMPLET, et son nom ne se termine pas par
    // `.json` : il echappe a la lecture, donc a l'inventaire, donc a l'utilisateur. Chaque
    // echec ulterieur en ajouterait un. On l'efface ici, ou la purge le ramassera.
    if (temporaryExists) rmSync(temporary, { force: true });
    // Erreur NOMMEE, symetrique de `REGISTRY_UNREADABLE` cote lecture : un `mkdirSync` sur
    // un chemin qui existe deja en fichier, un `renameSync` bloque par un antivirus ou un
    // indexeur sont des defaillances previsibles. Sans detail hors du code systeme : le
    // message porterait le chemin du registre, donc le nom de l'utilisateur.
    throw new ClaudeManagerError(
      ERROR_CODES.REGISTRY_UNWRITABLE,
      'The window registry entry could not be written',
      { cause: systemErrorCode(cause) }
    );
  }

  return file;
}
