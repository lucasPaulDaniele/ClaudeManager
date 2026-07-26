/**
 * D'OU VIENT LE PROMPT — et, tout autant, d'ou il ne vient JAMAIS.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LE PROMPT NE PASSE JAMAIS PAR UN ARGUMENT DE LIGNE DE COMMANDE. C'est une regle du produit,
 * pas une preference : l'echappement des prompts longs en shell — a fortiori PowerShell — est
 * une source de bugs inepuisable, et un prompt d'orchestration pese couramment 15 a 25 Ko.
 * `cmgr open` n'accepte donc AUCUN argument positionnel : `cmgr open "mon prompt"` est une
 * erreur d'usage, et le message le dit.
 *
 * NE PAS CONFONDRE AVEC LE TRANSPORT INTERNE vers le pty, qui est l'affaire de l'ADR-004 et de
 * l'extension : la ce sont un fichier transitoire et un argument positionnel. Deux couches,
 * deux regles, et elles ne se contredisent pas.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync } from 'node:fs';
import { ClaudeManagerError, ERROR_CODES, systemErrorCode } from './core.js';

export type PromptSource = 'file' | 'stdin';

export interface PromptInput {
  readonly source: PromptSource;
  readonly text: string;
  /** Taille du prompt retenu, en octets UTF-8, BOM exclu. */
  readonly bytes: number;
}

/**
 * L'entree standard, telle que la CLI a besoin de la voir.
 *
 * `isTerminal` n'est PAS une commodite : sans lui, `cmgr open` sans `--prompt-file` lance
 * depuis un terminal interactif attendrait qu'un humain tape un prompt puis ferme le flux —
 * c'est-a-dire pendrait, pour un outil dont le consommateur est un agent.
 */
export interface PromptStdin {
  readonly isTerminal: boolean;
  /** Lit jusqu'a EOF. N'est appele QUE lorsque `--prompt-file` est absent. */
  read(): Promise<string>;
}

/**
 * La marque d'ordre des octets, que Node ne retire PAS d'un `readFileSync(…, 'utf8')`.
 *
 * Un editeur Windows en depose une sans le dire. Sans ce retrait, elle partirait en tete du
 * prompt jusque dans la conversation : invisible a la relecture, et bien reelle pour le modele.
 *
 * ECRITE EN ECHAPPEMENT, jamais en litteral : un caractere invisible dans une source est
 * exactement ce que le piege n.7 du chantier recense — on ne le voit pas, donc on ne le relit
 * pas, donc on le perd au premier outil qui normalise le fichier.
 */
const BYTE_ORDER_MARK = '\uFEFF';

function withoutByteOrderMark(text: string): string {
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
}

function inputFrom(source: PromptSource, raw: string): PromptInput {
  const text = withoutByteOrderMark(raw);
  return { source, text, bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * Lit le prompt dans le fichier que l'appelant a nomme.
 *
 * UTF-8 EXPLICITE, jamais l'encodage par defaut de la plateforme : un prompt est du texte, et
 * la page de code d'un poste Windows n'est le contrat de personne.
 *
 * @throws {ClaudeManagerError} `PROMPT_FILE_UNREADABLE`
 */
export function readPromptFile(file: string): PromptInput {
  try {
    return inputFrom('file', readFileSync(file, 'utf8'));
  } catch (cause) {
    // Sans le chemin : une erreur `fs` de Node l'embarque systematiquement, donc le nom du
    // compte, et ce champ part vers un agent comme vers une PR d'un depot PUBLIC.
    throw new ClaudeManagerError(
      ERROR_CODES.PROMPT_FILE_UNREADABLE,
      'The prompt file could not be read',
      { cause: systemErrorCode(cause) }
    );
  }
}

/**
 * Lit le prompt sur l'entree standard — le defaut, quand aucun fichier n'est nomme.
 *
 * Rend `undefined` quand stdin est un TERMINAL : il n'y a alors rien a lire, et attendre
 * reviendrait a pendre. L'appelant en fait une erreur d'usage, la seule reponse juste — c'est
 * un appel a corriger, pas un presuppose du systeme qui serait tombe.
 */
export async function readPromptStdin(stdin: PromptStdin): Promise<PromptInput | undefined> {
  if (stdin.isTerminal) return undefined;
  return inputFrom('stdin', await stdin.read());
}
