/**
 * Analyse des tables de processus du systeme.
 *
 * Ces fonctions sont pures : aucune entree/sortie, aucune dependance a la plateforme.
 * L'appel systeme qui produit leur entree vit dans `processTable.node.ts`.
 */

/** Ce que la table retient d'un processus. */
export interface ProcessRecord {
  /** Pid du parent, tel que le systeme le declare a la capture. */
  readonly ppid: number;
  /**
   * Date de creation du processus, en millisecondes depuis l'epoque.
   *
   * C'est la SECONDE garde anti-reemploi de pid, et elle rattrape ce que la premiere ne
   * peut pas voir : comparer le seul `ppid` suppose « un pid reattribue n'a quasiment
   * jamais le meme parent », ce qui est faux ici. Sous Windows le parent enregistre est le
   * `Code.exe` principal, qui engendre des enfants en permanence — ptyHost, shared
   * process, file watchers, installateurs, autres extension hosts. Un pid recycle par
   * n'importe lequel d'entre eux satisfait la garde. La date de creation, elle, ne se
   * recycle pas.
   *
   * `undefined` quand la plateforme ne la rend pas : la garde ne s'applique alors pas, et
   * rien d'autre ne change. Voir `parsePosixProcessTable`.
   */
  readonly createdAt: number | undefined;
}

/** Table des processus du systeme : pid -> ce qu'on sait de lui. */
export type ProcessTable = ReadonlyMap<number, ProcessRecord>;

/**
 * Table des processus AVEC la date de sa capture.
 *
 * Une table nue ne dit pas de QUAND elle date, et c'est precisement ce qui manquait : le
 * coeur ne garde aucun etat, l'appelant est donc invite a mettre son inventaire en cache —
 * usage nominal, pas un abus. Une purge qui detruit sur la foi d'une table sans age
 * supprime alors les entrees publiees APRES sa capture, c'est-a-dire des fenetres bien
 * vivantes. L'horodatage rend cette borne opposable : voir `purgeStaleEntries`.
 */
export interface ProcessSnapshot {
  readonly table: ProcessTable;
  /**
   * Millisecondes depuis l'epoque, relevees AVANT le lancement de la commande
   * d'inventaire — jamais apres. C'est une borne INFERIEURE de l'age de l'instantane :
   * l'enumeration dure de 700 ms a 1,3 s, et un processus ne pendant ce laps peut lui
   * avoir echappe. Dater l'instantane de sa fin le declarerait plus frais qu'il ne l'est,
   * et rendrait supprimable exactement ce qu'il a manque.
   */
  readonly capturedAt: number;
}

/**
 * Sortie de `Get-CimInstance Win32_Process`, guillemets et espaces toleres.
 *
 * TROIS colonnes : `pid,ppid,creation`. La troisieme peut etre vide — la commande produit
 * une date vide plutot qu'une erreur quand `CreationDate` manque —, et une date qu'on n'a
 * pas est simplement une garde qui ne s'applique pas.
 */
const WINDOWS_ENTRY = /^\s*"?(\d+)"?\s*,\s*"?(\d+)"?\s*,\s*"?(\d*)"?\s*$/;

/** Sortie de `ps -Ao pid=,ppid=` : deux entiers separes par des espaces. */
const POSIX_ENTRY = /^\s*(\d+)\s+(\d+)\s*$/;

/** Les deux plateformes produisent l'une des deux terminaisons de ligne. */
const LINE_BREAK = /\r?\n/;

/**
 * `exec` sur un motif rend `null`, ou un tableau dont les captures sont necessairement
 * presentes. TypeScript ne sait pas exprimer cette garantie du motif : l'assertion porte
 * sur elle, pas sur une supposition d'execution.
 */
type PosixMatch = readonly [line: string, pid: string, ppid: string];
type WindowsMatch = readonly [line: string, pid: string, ppid: string, createdAt: string];

/**
 * Retient un processus, ou l'ecarte.
 *
 * Un pid ou un ppid non strictement positif ne designe aucun processus reel : sous
 * Windows, `0,0` est le processus Idle et `ppid = 0` marque la racine.
 */
function retain(
  table: Map<number, ProcessRecord>,
  pidText: string,
  ppidText: string,
  createdAt: number | undefined
): void {
  const pid = Number.parseInt(pidText, 10);
  const ppid = Number.parseInt(ppidText, 10);
  if (pid > 0 && ppid > 0) table.set(pid, { ppid, createdAt });
}

/**
 * Analyse la sortie de `Get-CimInstance Win32_Process | ForEach-Object { ... }` — voir
 * `processTable.node.ts` pour la commande exacte, et `tests/fixtures/identity/README.md`
 * pour la capture qui en atteste.
 */
export function parseWindowsProcessTable(raw: string): ProcessTable {
  const table = new Map<number, ProcessRecord>();

  for (const line of raw.split(LINE_BREAK)) {
    const match = WINDOWS_ENTRY.exec(line) as WindowsMatch | null;
    // Une table des processus est un instantane mouvant : en-tete, ligne vide, bruit ou
    // processus disparu en cours de lecture sont ignores. Une ligne illisible ne doit
    // jamais faire echouer tout l'inventaire.
    if (match === null) continue;

    const [, pid, ppid, createdAt] = match;
    retain(table, pid, ppid, createdAt === '' ? undefined : Number.parseInt(createdAt, 10));
  }

  return table;
}

/**
 * Analyse la sortie de `ps -Ao pid=,ppid=` (Linux et macOS).
 *
 * SANS DATE DE CREATION, et c'est declare plutot que subi : `ps` l'expose bien
 * (`-o lstart=`, `-o etimes=`), mais l'ajouter suppose de RECAPTURER la fixture POSIX sur
 * une vraie machine — le depot n'accepte pas de fixture fabriquee (principe fondateur
 * n.5), et l'environnement de capture documente n'etait pas disponible. La garde de date
 * ne s'applique donc pas hors Windows ; celle du `ppid`, elle, s'applique partout.
 */
export function parsePosixProcessTable(raw: string): ProcessTable {
  const table = new Map<number, ProcessRecord>();

  for (const line of raw.split(LINE_BREAK)) {
    const match = POSIX_ENTRY.exec(line) as PosixMatch | null;
    if (match === null) continue;

    const [, pid, ppid] = match;
    retain(table, pid, ppid, undefined);
  }

  return table;
}
