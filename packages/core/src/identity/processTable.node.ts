import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ClaudeManagerError, ERROR_CODES, systemErrorCode } from '../errors.js';
import {
  parsePosixProcessTable,
  parseWindowsProcessTable,
  type ProcessSnapshot,
  type ProcessTable,
} from './processTable.js';

/**
 * Execution d'une commande systeme rendant sa sortie standard.
 *
 * C'est la **couture de test** du module : elle permet de rejouer une capture reelle sans
 * relancer la commande, et d'eprouver la branche de l'autre plateforme. Ce n'est pas un
 * point d'extension public — ce qu'on lui fait rendre reste une sortie reellement capturee.
 *
 * ASYNCHRONE, et ce n'est pas cosmetique : l'appelant de production est l'extension host de
 * VSCode, dont la boucle d'evenements est MONO-THREAD et sert toutes les extensions de la
 * fenetre. Un `execFileSync` la bloquait de 700 ms a 1,3 s — et differer l'appel d'un tick
 * n'y changeait rien, la tache repartant sur la meme boucle. Seule une commande reellement
 * asynchrone rend le temps a l'editeur.
 */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<string>;

export interface ReadProcessTableOptions {
  readonly platform?: NodeJS.Platform;
  readonly run?: CommandRunner;
}

/** La table complete d'un poste depasse largement le defaut de 1 Mo d'`execFile`. */
const MAX_BUFFER = 32 * 1024 * 1024;

const WINDOWS_COMMAND = 'powershell.exe';
const WINDOWS_ARGS: readonly string[] = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }',
];

const POSIX_COMMAND = 'ps';
const POSIX_ARGS: readonly string[] = ['-Ao', 'pid=,ppid='];

const execFileAsync = promisify(execFile);

/** `windowsHide` interdit l'apparition d'une console : rien ne doit voler le focus. */
const runWithChildProcess: CommandRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, [...args], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
};

/**
 * Lit la table des processus du systeme, et la DATE.
 *
 * @throws {ClaudeManagerError} `PROCESS_TABLE_UNAVAILABLE` si la commande echoue, ou si la
 * table obtenue est vide : un processus se lit toujours au moins lui-meme, une table vide
 * n'est donc pas un resultat mais une anomalie. On echoue explicitement plutot que de
 * rendre une identite vide, qui ferait silencieusement echouer toute resolution en aval.
 */
export async function readProcessTable(
  options: ReadProcessTableOptions = {}
): Promise<ProcessSnapshot> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runWithChildProcess;

  // Releve AVANT la commande : voir `ProcessSnapshot.capturedAt`.
  const capturedAt = Date.now();

  let table: ProcessTable;
  try {
    table =
      platform === 'win32'
        ? parseWindowsProcessTable(await run(WINDOWS_COMMAND, WINDOWS_ARGS))
        : parsePosixProcessTable(await run(POSIX_COMMAND, POSIX_ARGS));
  } catch (cause) {
    throw new ClaudeManagerError(
      ERROR_CODES.PROCESS_TABLE_UNAVAILABLE,
      `Failed to run the process inventory command on ${platform}`,
      // Le CODE, jamais le message : celui d'un `execFile` en echec recopie le stderr du
      // processus, qui n'est contraint par rien et part vers un agent et vers un journal.
      { platform, cause: systemErrorCode(cause) }
    );
  }

  if (table.size === 0) {
    throw new ClaudeManagerError(
      ERROR_CODES.PROCESS_TABLE_UNAVAILABLE,
      `The process inventory command returned no usable entry on ${platform}`,
      { platform }
    );
  }

  return { table, capturedAt };
}
