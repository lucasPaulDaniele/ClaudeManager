/**
 * Ce que l'extension DIT d'elle-meme — et rien de ce qu'elle fait.
 *
 * AUCUN IMPORT DE `vscode` ICI, et c'est la raison d'etre du module : la mise en forme d'une
 * defaillance et la lecture d'un manifeste sont des decisions pures, qui n'exigent pas
 * l'editeur. Les laisser dans `extension.ts` les rendait inverifiables autrement qu'en
 * lancant un VSCode complet — ce qui, mesure a l'appui, ne s'est jamais fait (finding C7 du
 * gate : 497 lignes d'extension sans un seul test unitaire).
 */

import { isClaudeManagerError, systemErrorCode } from './core.js';

/** Version de repli si le manifeste devenait illisible : jamais vide, l'entree serait refusee. */
export const UNKNOWN_VERSION = '0.0.0-unknown';

/**
 * Rend une defaillance lisible SANS rien laisser passer du message systeme.
 *
 * Une erreur nommee est rendue avec son code stable et sa remediation, toutes deux ecrites
 * par le coeur et donc maitrisees. TOUT LE RESTE est reduit a son seul CODE — `EPERM`,
 * `ENOENT`, un statut de sortie, un signal.
 *
 * POURQUOI PAS `error.message` : les erreurs `fs` de Node embarquent systematiquement le
 * chemin, donc le nom de compte et l'arborescence personnelle
 * (`EPERM: operation not permitted, rename 'C:\\Users\\<compte>\\.claudemanager\\...'`), et
 * ce texte partait dans un canal de JOURNAL persiste sur disque, que `cmgr doctor` (lot D)
 * doit lire et qu'une PR d'un depot PUBLIC porte en preuve. Le repli n'etait pas theorique :
 * `removeWindowEntry` (`rmSync`) et la purge du coeur levent des erreurs `fs` nues.
 *
 * C'est la meme discipline que `systemErrorCode` applique deja aux `details` d'une erreur
 * nommee : le code suffit au diagnostic et ne porte rien de personnel.
 */
export function describe(error: unknown): string {
  if (isClaudeManagerError(error)) {
    return `${error.code}: ${error.message} — ${error.remediation}`;
  }
  // Le NOM de la classe est conserve : il distingue une `TypeError` d'une erreur systeme
  // sans rien reveler du poste. Le message, lui, est jete.
  const name = error instanceof Error ? error.name : 'Unknown';
  return `${name}(${systemErrorCode(error)})`;
}

/**
 * Lit la version du manifeste de l'extension.
 *
 * `packageJSON` est type `any` par l'API VSCode : on ne s'y fie qu'apres controle. Le
 * parametre est volontairement `unknown` plutot qu'un `ExtensionContext` — c'est ce qui
 * garde ce module hors de `vscode`, et la valeur testable telle quelle.
 */
export function readExtensionVersion(packageJSON: unknown): string {
  if (typeof packageJSON !== 'object' || packageJSON === null) return UNKNOWN_VERSION;
  const version = (packageJSON as Record<string, unknown>)['version'];
  return typeof version === 'string' && version.length > 0 ? version : UNKNOWN_VERSION;
}
