/**
 * Point d'acces UNIQUE de l'extension au coeur.
 *
 * Rien n'est reimplemente ici : ce module ne fait que reexporter les vraies sources de
 * `@claudemanager/core`, qui sont compilees avec l'extension (voir `tsconfig.build.json`).
 * L'erreur a ne pas repeter est celle de la version 0.1.0, qui avait recopie la logique de
 * registre et publiait un format que la version courante doit aujourd'hui traiter comme
 * etranger.
 *
 * POURQUOI UN CHEMIN RELATIF plutot que le specificateur `@claudemanager/core` : `tsc`
 * n'emet pas les correspondances de chemins, il recopie le specificateur tel quel. Un
 * `require('@claudemanager/core')` emis remonterait a `packages/core/package.json`, dont
 * le champ `main` designe un fichier `.ts` — que Node ne sait pas charger. Le chemin
 * relatif, lui, pointe apres emission sur le coeur compile a cote (`dist/core/src`).
 * Ce detour disparaitra au lot E, quand le packaging sera outille.
 *
 * UNE SEULE LIGNE, et c'est desormais vrai sans exception. `systemErrorCode` en faisait une :
 * absent de l'index du coeur, il etait importe ici depuis son module (`core/src/errors.js`),
 * avec le defaut signale en commentaire. Le coeur l'exporte depuis le gate du lot B — plus
 * rien dans ce fichier ne vise un module interne, la porte publique suffit.
 *
 * Le reste de l'extension importe donc `./core.js`, et jamais le coeur directement : la
 * dependance reste declaree en un seul endroit.
 */
export * from '../../core/src/index.js';
