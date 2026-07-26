/**
 * GARDE DE PLAFOND DE LIGNE DE COMMANDE — elle decide AVANT toute tentative.
 *
 * Le mecanisme retenu (ADR-002, voie V1) soumet le tour 1 par un prompt POSITIONNEL :
 * `claude --session-id <uuid> "<prompt>"`. Cette forme a un plafond, il est bas au regard des
 * prompts d'orchestration visés (15 a 25 Ko), et — c'est le point — **son depassement est
 * SILENCIEUX** : aucune sortie, aucune erreur, aucun processus. Un mecanisme qui se contente
 * de tenter degraderait donc en silence, ce que le principe fondateur n.3 interdit.
 *
 * D'ou cette garde : elle vit dans le COEUR parce qu'elle est une decision pure — pas une
 * E/S, pas une API d'editeur, pas un appel systeme. Elle se verifie en Node, contre des
 * chaines, des deux cotes de la limite.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * OU EST LE PLAFOND, ET OU IL N'EST PAS — mesure du 2026-07-26 (ADR-004) :
 *
 *   L1, prompt ecrit dans la ligne envoyee au pty  → OK a 32 000, ECHEC a 32 600
 *   L2, prompt lu depuis un fichier par le shell   → OK a 32 000, ECHEC a 32 600
 *
 * Les deux echouent aux MEMES tailles avec des lignes de pty de 32 744 et 236 caracteres.
 * Le plafond n'est donc PAS la ligne envoyee au terminal — raccourcir celle-ci ne releve
 * rien — mais `CreateProcess`, dont `lpCommandLine` est borne a ~32 767 caracteres.
 *
 * UNITES UTF-16, ET C'EST A DIRE EXPLICITEMENT : le lecteur pressé lira « octets ». Le
 * plafond Windows porte sur des `WCHAR`, c'est-a-dire exactement ce que compte
 * `String.prototype.length` en JavaScript. Un prompt de 20 000 caracteres non-ASCII pese
 * 20 000 unites ici et bien davantage en octets UTF-8 : compter des octets refuserait a tort.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import { ClaudeManagerError, ERROR_CODES } from './errors.js';

/**
 * Plafond de `lpCommandLine` sous Windows, en unites UTF-16.
 *
 * Valeur documentee par Microsoft (32 767, terminateur compris) et COHERENTE avec la mesure :
 * la ligne de 32 144 caracteres passe, celle de 32 744 echoue. La mesure ne donne pas la
 * frontiere exacte — elle donne un encadrement, et cette constante est la valeur documentee
 * qui tombe dedans. C'est un encadrement qu'on assume, pas une frontiere qu'on invente.
 */
export const WINDOWS_COMMAND_LINE_LIMIT = 32_767;

/**
 * Marge de securite, en unites UTF-16 — EXPLICITE, jamais devinee.
 *
 * Elle couvre ce que nous ne controlons pas : le terminateur NUL que Windows compte, la
 * facon exacte dont `pwsh` recite un argument natif avant de le passer a `CreateProcess`
 * (regle non contractuelle, et non mesuree caractere par caractere), et l'ecart entre la
 * borne SUPERIEURE calculee par `quotedArgumentCost` et le cout reel.
 *
 * 256 plutot que 4 096 : une marge large refuserait des prompts qui passent, et la mesure
 * montre qu'a 600 caracteres pres du plafond le comportement bascule deja. Une marge trop
 * genereuse serait une garde qui ment dans l'autre sens.
 */
export const COMMAND_LINE_SAFETY_MARGIN = 256;

/**
 * Cout d'un argument UNE FOIS CITE — borne SUPERIEURE, jamais une estimation.
 *
 * Windows reconstruit `argv` par `CommandLineToArgvW` : un argument cite est encadre de
 * guillemets, chaque `"` interne est protege par une contre-oblique, et les contre-obliques
 * qui precedent un guillemet sont doublees. Majorer par « une unite de plus par `"` ET par
 * `\` » couvre le pire cas sans avoir a rejouer l'algorithme exact — lequel n'est pas
 * contractuel cote `pwsh`.
 *
 * MAJORER EST LE SENS SUR : une borne trop haute refuse un prompt qui serait passe et le DIT ;
 * une borne trop basse laisse tenter un envoi qui echouera SANS BRUIT. Les deux erreurs ne
 * coutent pas la meme chose.
 */
export function quotedArgumentCost(value: string): number {
  let escapes = 0;
  for (const character of value) {
    if (character === '"' || character === '\\') escapes += 1;
  }
  // 2 : les guillemets encadrants.
  return 2 + value.length + escapes;
}

/** La ligne telle qu'elle sera REELLEMENT construite — pas le seul prompt. */
export interface CommandLineDraft {
  /** Chemin de l'executable, cite comme un argument : il peut porter des espaces. */
  readonly executable: string;
  /** Tout ce qui precede le prompt : `--session-id`, l'uuid, et rien d'autre a ce jour. */
  readonly leadingArguments: readonly string[];
  readonly prompt: string;
}

export interface CommandLineBudget {
  readonly limit: number;
  readonly safetyMargin: number;
  /** Cout de l'executable, des drapeaux et des separateurs — tout sauf le prompt. */
  readonly fixedCost: number;
  /** Cout du prompt une fois cite, borne superieure. */
  readonly promptCost: number;
  /** Longueur du prompt en unites UTF-16, telle que l'appelant la compte. */
  readonly promptLength: number;
  readonly total: number;
  /** Ce qu'un prompt pourrait encore couter — negatif quand la ligne deborde. */
  readonly available: number;
  readonly fits: boolean;
}

/**
 * Mesure la ligne complete, sans rien tenter.
 *
 * PORTEE DE PLATEFORME — un blanc DIT plutot qu'un chiffre invente. Le plafond retenu est
 * celui de Windows, la seule plateforme mesuree. Il est applique PARTOUT, y compris sous
 * POSIX, ou la limite reelle est differente (`MAX_ARG_STRLEN`, `ARG_MAX`) et n'a **pas ete
 * mesuree ici**. Consequence assumee : sous POSIX, un prompt qui serait peut-etre passe est
 * refuse — avec un code stable et les deux nombres en `details`, donc de facon diagnosticable.
 * L'inverse — laisser tenter sous une limite inconnue — reproduirait exactement l'echec
 * silencieux que cette garde existe pour supprimer.
 */
export function measureCommandLineBudget(draft: CommandLineDraft): CommandLineBudget {
  // Chaque argument est precede d'UNE espace de separation, y compris le prompt.
  const fixedCost =
    quotedArgumentCost(draft.executable) +
    draft.leadingArguments.reduce((total, argument) => total + 1 + quotedArgumentCost(argument), 0) +
    1;
  const promptCost = quotedArgumentCost(draft.prompt);
  const total = fixedCost + promptCost + COMMAND_LINE_SAFETY_MARGIN;

  return {
    limit: WINDOWS_COMMAND_LINE_LIMIT,
    safetyMargin: COMMAND_LINE_SAFETY_MARGIN,
    fixedCost,
    promptCost,
    promptLength: draft.prompt.length,
    total,
    available: WINDOWS_COMMAND_LINE_LIMIT - COMMAND_LINE_SAFETY_MARGIN - fixedCost - promptCost,
    fits: total <= WINDOWS_COMMAND_LINE_LIMIT,
  };
}

/**
 * Refuse une ligne qui deborderait, par une erreur NOMMEE — jamais un tronquage.
 *
 * Tronquer un prompt d'orchestration produirait une conversation qui a l'air normale et qui
 * demande autre chose que ce qu'on lui a demande : la pire des defaillances, parce qu'elle
 * ne se voit pas. Les `details` portent la mesure ET le plafond, pour que l'appelant sache
 * de combien il depasse plutot que d'avoir a le deviner.
 *
 * @throws {ClaudeManagerError} `PROMPT_TOO_LARGE`
 */
export function assertCommandLineFits(draft: CommandLineDraft): CommandLineBudget {
  const budget = measureCommandLineBudget(draft);
  if (budget.fits) return budget;

  throw new ClaudeManagerError(
    ERROR_CODES.PROMPT_TOO_LARGE,
    'The command line carrying this prompt would exceed the operating system limit',
    {
      // Aucun chemin ici : `fixedCost` est un NOMBRE derive de l'executable, pas son chemin.
      promptLength: budget.promptLength,
      promptCost: budget.promptCost,
      fixedCost: budget.fixedCost,
      safetyMargin: budget.safetyMargin,
      limit: budget.limit,
      total: budget.total,
      overflowBy: budget.total - budget.limit,
    }
  );
}
