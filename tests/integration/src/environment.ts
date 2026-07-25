/**
 * L'environnement contre lequel le harnais d'integration eprouve l'extension.
 *
 * Module a part, et pas une constante de `runTests.ts` : ce dernier lance un VSCode des son
 * chargement, ce qui interdit a quiconque de lui demander une valeur. Cette version est
 * pourtant l'un des trois nombres que le manifeste, les types et la preuve doivent garder en
 * accord (finding R6) — elle doit donc etre lisible sans effet de bord.
 */

/**
 * VERSION EPINGLEE, jamais `stable` : une preuve doit etre rejouable a l'identique. C'est
 * la version du poste de reference (`docs/compatibilite.md`). La relever est une decision,
 * pas un effet de bord d'une publication amont.
 */
export const VSCODE_VERSION = '1.122.1';
