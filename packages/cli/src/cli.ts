/**
 * Analyse des arguments, aiguillage, et fabrication de la sortie.
 *
 * TOUTE la CLI est ici, a l'exception du branchement sur `process` (`run.ts`) et du binaire
 * lui-meme (`cmgr.ts`). Elle est TOTALE : `runCli` ne leve jamais. Une commande `cmgr` qui
 * mourrait sur une exception ecrirait une trace de pile sur `stderr` et rien sur `stdout` —
 * l'agent appelant recevrait alors un flux vide la ou le contrat lui promet du JSON.
 *
 * ANALYSE ECRITE A LA MAIN, sans bibliotheque : deux commandes et deux drapeaux ne
 * justifient pas une dependance, et une dependance d'analyse d'arguments accepterait par
 * defaut des formes qu'on ne veut pas (abreviations, options inconnues tolerees).
 */

import {
  openCommand,
  whoamiCommand,
  windowsCommand,
  type CliContext,
  type CommandBody,
  type Diagnostics,
} from './commands.js';
import type { SkippedEntry } from './core.js';
import { EXIT_CODES, renderFailure, usageFailure, type ExitCode, type Failure } from './exit.js';
import { CLI_NAME, CLI_VERSION, USAGE } from './usage.js';

/**
 * Les commandes de LECTURE reconnues.
 *
 * Elles n'acceptent AUCUNE option, et c'est ce qui garantit qu'on ne peut pas decrire une
 * fenetre depuis la ligne de commande. `open` en accepte UNE — `--prompt-file` —, qui designe
 * un fichier de prompt et rien d'autre : elle ne dit rien d'une fenetre, ni d'un hote, ni d'un
 * port. La surface reste la garantie (alerte n.19).
 */
const READ_COMMANDS = {
  windows: windowsCommand,
  whoami: whoamiCommand,
} as const;

type ReadCommandName = keyof typeof READ_COMMANDS;

function isReadCommandName(value: string): value is ReadCommandName {
  return Object.prototype.hasOwnProperty.call(READ_COMMANDS, value);
}

const OPEN_COMMAND = 'open';
const PROMPT_FILE_OPTION = '--prompt-file';

export interface CliResult {
  /**
   * UNE SEULE valeur JSON, terminee par un saut de ligne. Rien d'autre n'y va : ni
   * banniere, ni avertissement, ni ligne de progression. Un agent doit pouvoir faire
   * `JSON.parse` sans condition, en succes comme en echec.
   */
  readonly stdout: string;
  /** Diagnostics lisibles par un humain. Vide quand il n'y a rien a dire. */
  readonly stderr: string;
  readonly exitCode: ExitCode;
}

type ParsedInvocation =
  | { readonly kind: 'read'; readonly name: ReadCommandName }
  | { readonly kind: 'open'; readonly promptFile: string | undefined }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'usage-error'; readonly failure: Failure };

/**
 * Analyse ce qui suit `open`, et refuse tout le reste.
 *
 * UN ARGUMENT POSITIONNEL EST UNE ERREUR, ET C'EST LE POINT : `cmgr open "mon prompt"` est
 * precisement la forme que le produit s'interdit. La refuser ici est ce qui rend la regle
 * OPERANTE plutot que declarative — l'echappement d'un prompt de 20 Ko en shell est une source
 * de bugs inepuisable, et un prompt tronque par le shell partirait sans que rien ne le signale.
 *
 * La valeur fautive n'est jamais recopiee : seule sa POSITION est rendue (voir `usageFailure`).
 */
function parseOpenArguments(argv: readonly string[]): ParsedInvocation {
  let promptFile: string | undefined;

  for (let index = 1; index < argv.length; ) {
    if (argv[index] !== PROMPT_FILE_OPTION) {
      return {
        kind: 'usage-error',
        failure: usageFailure('Unknown option, or a prompt passed as an argument', {
          argumentIndex: index + 1,
        }),
      };
    }
    if (promptFile !== undefined) {
      return {
        kind: 'usage-error',
        failure: usageFailure('--prompt-file was given more than once', {
          argumentIndex: index + 1,
        }),
      };
    }
    const value = argv[index + 1];
    if (value === undefined) {
      return {
        kind: 'usage-error',
        failure: usageFailure('--prompt-file expects a path', { argumentIndex: index + 1 }),
      };
    }
    promptFile = value;
    index += 2;
  }

  return { kind: 'open', promptFile };
}

/**
 * Reconnait l'invocation, ou la refuse.
 *
 * Aucune tolerance : un argument surnumeraire est une erreur, pas un silence. Accepter en
 * l'ignorant ferait croire a l'appelant que son option a ete prise en compte — c'est
 * exactement la degradation silencieuse que le principe fondateur n.3 interdit.
 *
 * Les positions sont comptees a partir de 1 et EXCLUENT le binaire : `argv` est deja
 * debarrasse de l'interpreteur et du script par `run.ts`.
 */
function parseArguments(argv: readonly string[]): ParsedInvocation {
  const first = argv[0];
  if (first === undefined) {
    return { kind: 'usage-error', failure: usageFailure('No command given') };
  }

  // `open` est la SEULE commande qui prenne des arguments : elle analyse la suite elle-meme,
  // les autres n'en tolerent aucun.
  if (first === OPEN_COMMAND) return parseOpenArguments(argv);

  const recognized: ParsedInvocation | undefined =
    first === '--help' || first === '-h'
      ? { kind: 'help' }
      : first === '--version' || first === '-v'
        ? { kind: 'version' }
        : isReadCommandName(first)
          ? { kind: 'read', name: first }
          : undefined;

  if (recognized === undefined) {
    // La valeur fautive n'est PAS recopiee — voir `usageFailure`.
    return {
      kind: 'usage-error',
      failure: usageFailure('Unknown command or option', { argumentIndex: 1 }),
    };
  }

  if (argv.length > 1) {
    return {
      kind: 'usage-error',
      failure: usageFailure('Unexpected extra argument', { argumentIndex: 2 }),
    };
  }

  return recognized;
}

function envelope(
  command: string | null,
  ok: boolean,
  body: CommandBody,
  diagnostics: Diagnostics
): Record<string, unknown> {
  const payload: Record<string, unknown> = { command, ok, ...body };
  // `skipped` est rendu des qu'il est connu, en succes comme en echec.
  if (diagnostics.skipped !== undefined) payload['skipped'] = diagnostics.skipped;
  return payload;
}

/** Une ligne de `stderr`, toujours prefixee : les flux se melangent dans un terminal. */
function say(lines: readonly string[]): string {
  return lines.map((line) => `${CLI_NAME}: ${line}\n`).join('');
}

/**
 * Ce qui a ete ecarte est DIT a l'humain, pas seulement rendu a la machine.
 *
 * Les entrees ecartees ne portent que le nom du fichier — un pid — et un motif : rien de
 * personnel, aucun jeton.
 */
function skippedLines(skipped: readonly SkippedEntry[] | undefined): readonly string[] {
  if (skipped === undefined || skipped.length === 0) return [];
  const detail = skipped.map((entry) => `${entry.file} (${entry.reason})`).join(', ');
  return [`${skipped.length} entree(s) du registre ecartee(s) : ${detail}`];
}

function succeeded(command: string, body: CommandBody, diagnostics: Diagnostics): CliResult {
  return {
    stdout: `${JSON.stringify(envelope(command, true, body, diagnostics), null, 2)}\n`,
    stderr: say([...(diagnostics.notes ?? []), ...skippedLines(diagnostics.skipped)]),
    /**
     * UN SUCCES DEGRADE N'EST PAS UN SUCCES NOMINAL, et le code de sortie le dit sans qu'il
     * faille analyser la sortie : la conversation est ouverte, mais le prompt n'y est que
     * PRE-REMPLI et attend un geste humain. Voir `EXIT_CODES.DEGRADED_SUCCESS`.
     */
    exitCode: diagnostics.degraded === true ? EXIT_CODES.DEGRADED_SUCCESS : EXIT_CODES.SUCCESS,
  };
}

function failed(command: string | null, failure: Failure, diagnostics: Diagnostics): CliResult {
  const { error } = failure;
  return {
    stdout: `${JSON.stringify(envelope(command, false, { error }, diagnostics), null, 2)}\n`,
    stderr: say([
      `${error.code}: ${error.message}`,
      error.remediation,
      ...skippedLines(diagnostics.skipped),
    ]),
    exitCode: failure.exitCode,
  };
}

/**
 * Execute une invocation et rend ce qu'il faut ecrire, sans rien ecrire soi-meme.
 *
 * Separer la decision de l'ecriture n'est pas une coquetterie : c'est ce qui permet
 * d'eprouver le contrat de sortie — « une seule valeur JSON sur `stdout`, en toutes
 * circonstances » — sur la chaine de caracteres reellement produite, plutot que sur un objet
 * dont on supposerait qu'il sera bien serialise.
 *
 * Ne leve jamais. La serialisation elle-meme est dans le `try` : seules des valeurs
 * numeriques et textuelles la traversent, mais une enveloppe qu'on ne saurait pas serialiser
 * doit ressortir en erreur nommee, pas en exception nue.
 */
export async function runCli(argv: readonly string[], context: CliContext): Promise<CliResult> {
  const diagnostics: Diagnostics = {};
  let command: string | null = null;

  try {
    const parsed = parseArguments(argv);

    if (parsed.kind === 'usage-error') return failed(null, parsed.failure, diagnostics);
    if (parsed.kind === 'help') return succeeded('help', { usage: USAGE }, diagnostics);
    if (parsed.kind === 'version') {
      return succeeded('version', { name: CLI_NAME, version: CLI_VERSION }, diagnostics);
    }

    if (parsed.kind === 'open') {
      command = OPEN_COMMAND;
      // `open` peut encore refuser sur l'USAGE apres l'analyse d'arguments — « aucun prompt,
      // et stdin est un terminal » ne se voit pas dans `argv`. La commande NOMME alors la
      // commande fautive, la ou une erreur d'analyse ne le peut pas.
      const outcome = await openCommand(context, diagnostics, { promptFile: parsed.promptFile });
      return outcome.kind === 'usage'
        ? failed(OPEN_COMMAND, outcome.failure, diagnostics)
        : succeeded(OPEN_COMMAND, outcome.body, diagnostics);
    }

    command = parsed.name;
    return succeeded(
      parsed.name,
      await READ_COMMANDS[parsed.name](context, diagnostics),
      diagnostics
    );
  } catch (cause) {
    return failed(command, renderFailure(cause), diagnostics);
  }
}
