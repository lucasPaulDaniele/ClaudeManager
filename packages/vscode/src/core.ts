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
 * Le reste de l'extension importe donc `./core.js`, et jamais le coeur directement : la
 * dependance reste declaree en un seul endroit.
 */
export * from '../../core/src/index.js';

/**
 * DEFAUT DU COEUR SIGNALE, NON CORRIGE ICI : `systemErrorCode` n'est pas reexporte par
 * `packages/core/src/index.ts`, alors que c'est la fonction meme qui reduit une defaillance
 * systeme a son code — et donc ce qui empeche un chemin personnel d'atteindre un journal
 * public. Le coeur s'en sert (`store.node.ts`), l'extension en a le meme besoin, mais la
 * porte publique ne la laisse pas passer.
 *
 * Elle est donc importee ici depuis son module, faute de mieux. La correction appartient au
 * coeur — ajouter la ligne a son index —, hors du perimetre de cet increment.
 */
export { systemErrorCode } from '../../core/src/errors.js';
