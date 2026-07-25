/**
 * L'environnement contre lequel le harnais d'integration eprouve l'extension.
 *
 * Module a part, et pas des constantes de `runTests.ts` : ce dernier lance un VSCode des son
 * chargement, ce qui interdit a quiconque de lui demander quoi que ce soit. Or ce qui vit ici
 * doit etre lisible SANS EFFET DE BORD — la version epinglee parce qu'elle est l'un des trois
 * nombres que le manifeste, les types et la preuve doivent garder en accord (finding R6),
 * l'assainissement parce que c'est une garde, et qu'une garde non gardee finit par tomber.
 */

/**
 * VERSION EPINGLEE, jamais `stable` : une preuve doit etre rejouable a l'identique. C'est
 * la version du poste de reference (`docs/compatibilite.md`). La relever est une decision,
 * pas un effet de bord d'une publication amont.
 */
export const VSCODE_VERSION = '1.122.1';

/**
 * Familles de variables qu'une session Claude propage a tout ce qu'elle lance.
 *
 * PAR FAMILLE DE PREFIXES, JAMAIS PAR LISTE NOMMEE, et c'est mesure : le poste de reference
 * en portait 19 le 2026-07-25 et 21 le 2026-07-26
 * (`tests/fixtures/environment/claude-session-env-names.json`). Une liste nommee aurait
 * laisse passer les deux nouvelles sans que rien ne le signale — or il suffit d'UNE variable
 * oubliee pour que le lancement echoue sans diagnostic.
 *
 * Les huit `CLAUDE*` sont celles de l'alerte n.6 ; s'y ajoutent les `VSCODE_*`, `ELECTRON_*`
 * et `CHROME_*` de l'extension host hote.
 */
export const INHERITED_ENVIRONMENT = /^(CLAUDECODE|CLAUDE_|VSCODE_|ELECTRON_|CHROME_)/;

/**
 * Assainit un environnement AVANT de demarrer le VSCode de test.
 *
 * SANS CELA, LE HARNAIS NE FONCTIONNE PAS LA OU IL COMPTE. Lance depuis une session Claude
 * — la configuration de PRODUCTION de ClaudeManager, pas un cas limite —, il herite
 * d'`ELECTRON_RUN_AS_NODE=1` : le binaire VSCode demarre alors en Node et traite le premier
 * argument de lancement comme un script, d'ou un `Cannot find module <dossier de travail>`
 * dont rien n'indique la cause. Mesure a l'appui : identique, l'appel passe depuis un shell
 * propre et echoue depuis un shell contamine.
 *
 * ON SUPPRIME LES VARIABLES, ON NE LES VIDE PAS. Electron teste leur PRESENCE : une chaine
 * vide reste « definie », et l'assainissement serait alors sans effet tout en ayant l'air
 * d'avoir eu lieu. C'est la meme regle qui vaudra pour le terminal masque du lot C.
 *
 * On DIT ce qu'on a retire, plutot que d'assainir en silence : l'environnement d'execution
 * fait partie de ce qu'une preuve doit exposer (principe fondateur n.3).
 *
 * @param env L'environnement a assainir, MUTE SUR PLACE. Defaut : celui du processus — c'est
 * la seule forme qu'emploie le lanceur, le parametre n'existant que pour rendre la garde
 * eprouvable sans contaminer le processus de test.
 * @returns Les noms retires, tries.
 */
export function neutralizeInheritedEnvironment(
  env: NodeJS.ProcessEnv = process.env
): readonly string[] {
  // Les cles sont relevees AVANT toute suppression : muter un objet pendant qu'on l'enumere
  // est le genre de detail qui ne se voit qu'une fois sur trois.
  const inherited = Object.keys(env).filter((name) => INHERITED_ENVIRONMENT.test(name));
  // `delete`, jamais `env[name] = ''` : voir ci-dessus, c'est tout l'objet de la garde.
  for (const name of inherited) delete env[name];
  return inherited.sort();
}
