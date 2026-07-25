/**
 * Point d'acces UNIQUE de la CLI au coeur.
 *
 * Rien n'est reimplemente ici : ce module ne fait que reexporter les vraies sources de
 * `@claudemanager/core`, qui sont compilees avec la CLI (voir `tsconfig.build.json`). Toute
 * la garantie d'identite — validation d'entree, confrontation au nom de fichier, vivacite,
 * masquage du jeton — vit la-bas et n'est jamais redite ici.
 *
 * POURQUOI UN CHEMIN RELATIF plutot que le specificateur `@claudemanager/core` : `tsc`
 * n'emet pas les correspondances de chemins, il recopie le specificateur tel quel. Un
 * `import '@claudemanager/core'` emis remonterait a `packages/core/package.json`, dont le
 * champ `main` designe un fichier `.ts` — que Node ne sait pas charger. Le chemin relatif,
 * lui, pointe apres emission sur le coeur compile a cote (`dist/core/src`). Meme detour que
 * `packages/vscode/src/core.ts`, meme echeance : le lot E, quand le packaging sera outille.
 */
export * from '../../core/src/index.js';
