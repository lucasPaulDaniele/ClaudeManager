/**
 * Analyse des tables de processus du systeme.
 *
 * Ces fonctions sont pures : aucune entree/sortie, aucune dependance a la plateforme.
 * L'appel systeme qui produit leur entree vit dans `processTable.node.ts`.
 */

/** Table des processus du systeme : pid -> pid du parent. */
export type ProcessTable = ReadonlyMap<number, number>;

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

/** Sortie de `Get-CimInstance Win32_Process`, guillemets et espaces toleres. */
const WINDOWS_ENTRY = /^\s*"?(\d+)"?\s*,\s*"?(\d+)"?\s*$/;

/** Sortie de `ps -Ao pid=,ppid=` : deux entiers separes par des espaces. */
const POSIX_ENTRY = /^\s*(\d+)\s+(\d+)\s*$/;

/** Les deux plateformes produisent l'une des deux terminaisons de ligne. */
const LINE_BREAK = /\r?\n/;

/**
 * `exec` sur un motif a deux groupes rend `null`, ou un tableau dont les deux captures
 * sont necessairement presentes. TypeScript ne sait pas exprimer cette garantie du motif :
 * l'assertion porte sur elle, pas sur une supposition d'execution.
 */
type EntryMatch = readonly [line: string, pid: string, ppid: string];

function parseEntries(raw: string, entry: RegExp): ProcessTable {
  const table = new Map<number, number>();

  for (const line of raw.split(LINE_BREAK)) {
    const match = entry.exec(line) as EntryMatch | null;
    // Une table des processus est un instantane mouvant : en-tete, ligne vide, bruit ou
    // processus disparu en cours de lecture sont ignores. Une ligne illisible ne doit
    // jamais faire echouer tout l'inventaire.
    if (match === null) continue;

    const [, pidText, ppidText] = match;
    const pid = Number.parseInt(pidText, 10);
    const ppid = Number.parseInt(ppidText, 10);
    // Un pid ou un ppid non strictement positif ne designe aucun processus reel :
    // sous Windows, `0,0` est le processus Idle et `ppid = 0` marque la racine.
    if (pid > 0 && ppid > 0) table.set(pid, ppid);
  }

  return table;
}

/**
 * Analyse la sortie de
 * `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }`.
 */
export function parseWindowsProcessTable(raw: string): ProcessTable {
  return parseEntries(raw, WINDOWS_ENTRY);
}

/** Analyse la sortie de `ps -Ao pid=,ppid=` (Linux et macOS). */
export function parsePosixProcessTable(raw: string): ProcessTable {
  return parseEntries(raw, POSIX_ENTRY);
}
