/**
 * CONTRAT DE SORTIE de `cmgr` : codes de sortie, et mise en forme des defaillances.
 *
 * Le consommateur principal est un AGENT, pas un humain (principe fondateur n.6). Deux
 * consequences gouvernent tout ce module :
 *
 *   - le code de sortie dit ce qui s'est passe SANS qu'il faille lire la sortie ;
 *   - une erreur nommee du coeur est rendue TELLE QUELLE — son code, son message, sa
 *     remediation, ses details —, jamais traduite ni enrichie. La CLI n'a rien a ajouter a
 *     ce que le coeur a deja formule, et le prefixe `CLI_` distingue sans ambiguite les
 *     rares defaillances qui lui sont propres.
 */

import { isClaudeManagerError, systemErrorCode } from './core.js';

/**
 * Les quatre codes de sortie, et rien d'autre.
 *
 * Ils sont DISJOINTS parce qu'un agent doit pouvoir decider sans analyser la sortie : `2`
 * signifie « corrige ton appel », `1` « ton appel etait bon, le presuppose est tombe »,
 * `3` « ClaudeManager a un defaut ». Les confondre reviendrait a faire retenter a l'infini
 * une commande qui n'existe pas.
 */
export const EXIT_CODES = {
  /** La commande a rendu ce qu'on lui demandait. */
  SUCCESS: 0,
  /** Erreur NOMMEE du domaine : `OWNING_WINDOW_NOT_FOUND`, `REGISTRY_UNREADABLE`, ... */
  DOMAIN_ERROR: 1,
  /** Erreur d'usage : commande inconnue, option inconnue, argument surnumeraire. */
  USAGE_ERROR: 2,
  /**
   * Defaillance IMPREVUE — donc un defaut de ClaudeManager, pas de l'appelant.
   *
   * Son code distinct est ce qui empeche de la confondre avec une erreur nommee : la
   * premiere se traite (la remediation le dit), la seconde se signale.
   */
  UNEXPECTED_ERROR: 3,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Codes propres a la CLI, volontairement DISJOINTS de ceux du coeur (`ERROR_CODES`).
 *
 * Le prefixe n'est pas decoratif : il dit a l'appelant que cette defaillance n'a jamais
 * atteint le coeur, donc qu'elle n'apprend rien sur l'etat de l'ecosysteme Claude.
 */
export const CLI_ERROR_CODES = {
  USAGE: 'CLI_USAGE',
  UNEXPECTED: 'CLI_UNEXPECTED',
} as const;

/**
 * Forme rendue d'une defaillance, quelle qu'en soit l'origine.
 *
 * Elle epouse exactement `SerializedError` du coeur : une erreur nommee y entre sans
 * transformation, ce qui rend structurellement impossible de la reformuler en chemin.
 */
export interface RenderedError {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface Failure {
  readonly error: RenderedError;
  readonly exitCode: ExitCode;
}

const UNEXPECTED_REMEDIATION =
  "Defaillance imprevue de ClaudeManager : ce n'est pas une erreur d'appel. Le message a ete reduit a son type et a son code systeme, deliberement — un message brut porterait un chemin, donc le nom du compte. Relancer la commande, puis signaler le code si elle echoue encore.";

const USAGE_REMEDIATION =
  "Appel invalide. `cmgr --help` enumere les commandes reconnues et leurs codes de sortie. Aucune commande n'accepte d'option, et il n'existe aucun moyen de decrire une fenetre a la main : les fenetres viennent du registre, jamais de la ligne de commande.";

/**
 * Erreur d'usage.
 *
 * LE JETON FAUTIF N'EST JAMAIS RECOPIE, et c'est une decision : les arguments viennent de
 * l'appelant, rien ne dit ce qu'ils contiennent, et `cmgr --token=<secret>` ferait
 * imprimer ce secret sur `stdout` par la seule vertu d'un message d'erreur serviable.
 * Seule la POSITION est rendue — l'appelant sait ce qu'il a ecrit a cette place, et la
 * liste de ce qui est accepte figure dans `--help`.
 */
export function usageFailure(message: string, details?: Readonly<Record<string, unknown>>): Failure {
  return {
    error:
      details === undefined
        ? { code: CLI_ERROR_CODES.USAGE, message, remediation: USAGE_REMEDIATION }
        : { code: CLI_ERROR_CODES.USAGE, message, remediation: USAGE_REMEDIATION, details },
    exitCode: EXIT_CODES.USAGE_ERROR,
  };
}

/**
 * Met en forme une defaillance SANS jamais laisser fuiter de trace de pile ni de message
 * systeme.
 *
 * Une erreur nommee passe telle quelle : son message et sa remediation sont ecrits par le
 * coeur, donc maitrises, et ses `details` sont deja tenus a l'ecart de tout chemin. TOUT LE
 * RESTE est reduit a son type et a son CODE — `EPERM`, `ENOENT`, un statut de sortie, un
 * signal —, jamais a `error.message` : les erreurs `fs` de Node y embarquent le chemin,
 * donc le nom du compte et l'arborescence personnelle, et cette sortie part vers un agent
 * comme vers un journal joint en preuve a une PR d'un depot PUBLIC.
 *
 * DUPLICATION ASSUMEE ET SIGNALEE : `packages/vscode/src/diagnostics.ts` applique exactement
 * la meme reduction, sous le nom `describe`. Elle merite de remonter dans le coeur, aux
 * cotes de `systemErrorCode` qu'elle prolonge — hors du perimetre de cet increment, qui ne
 * touche pas au coeur.
 */
export function renderFailure(cause: unknown): Failure {
  if (isClaudeManagerError(cause)) {
    return { error: cause.toJSON(), exitCode: EXIT_CODES.DOMAIN_ERROR };
  }

  // Le NOM de la classe est conserve : il distingue une `TypeError` d'une erreur systeme
  // sans rien reveler du poste. Le message, lui, est jete.
  const name = cause instanceof Error ? cause.name : 'Unknown';
  return {
    error: {
      code: CLI_ERROR_CODES.UNEXPECTED,
      message: `${name}(${systemErrorCode(cause)})`,
      remediation: UNEXPECTED_REMEDIATION,
    },
    exitCode: EXIT_CODES.UNEXPECTED_ERROR,
  };
}
