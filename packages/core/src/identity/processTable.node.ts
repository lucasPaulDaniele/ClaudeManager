import { execFileSync } from 'node:child_process';
import { ClaudeManagerError, ERROR_CODES } from '../errors.js';
import { parsePosixProcessTable, parseWindowsProcessTable, type ProcessTable } from './processTable.js';

/**
 * Execution d'une commande systeme rendant sa sortie standard.
 *
 * C'est la **couture de test** du module : elle permet de rejouer une capture reelle sans
 * relancer la commande, et d'eprouver la branche de l'autre plateforme. Ce n'est pas un
 * point d'extension public — ce qu'on lui fait rendre reste une sortie reellement capturee.
 */
export type CommandRunner = (command: string, args: readonly string[]) => string;

export interface ReadProcessTableOptions {
  readonly platform?: NodeJS.Platform;
  readonly run?: CommandRunner;
}

/** La table complete d'un poste depasse largement le defaut de 1 Mo d'`execFileSync`. */
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

/** `windowsHide` interdit l'apparition d'une console : rien ne doit voler le focus. */
const runWithChildProcess: CommandRunner = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });

/**
 * Lit la table des processus du systeme.
 *
 * @throws {ClaudeManagerError} `PROCESS_TABLE_UNAVAILABLE` si la commande echoue, ou si la
 * table obtenue est vide : un processus se lit toujours au moins lui-meme, une table vide
 * n'est donc pas un resultat mais une anomalie. On echoue explicitement plutot que de
 * rendre une identite vide, qui ferait silencieusement echouer toute resolution en aval.
 */
export function readProcessTable(options: ReadProcessTableOptions = {}): ProcessTable {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runWithChildProcess;

  let table: ProcessTable;
  try {
    table =
      platform === 'win32'
        ? parseWindowsProcessTable(run(WINDOWS_COMMAND, WINDOWS_ARGS))
        : parsePosixProcessTable(run(POSIX_COMMAND, POSIX_ARGS));
  } catch (cause) {
    throw new ClaudeManagerError(
      ERROR_CODES.PROCESS_TABLE_UNAVAILABLE,
      `Failed to run the process inventory command on ${platform}`,
      { platform, cause: cause instanceof Error ? cause.message : String(cause) }
    );
  }

  if (table.size === 0) {
    throw new ClaudeManagerError(
      ERROR_CODES.PROCESS_TABLE_UNAVAILABLE,
      `The process inventory command returned no usable entry on ${platform}`,
      { platform }
    );
  }

  return table;
}
