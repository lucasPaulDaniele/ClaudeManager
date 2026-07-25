/**
 * Ce que `cmgr` dit de lui-meme.
 *
 * `--help` et `--version` rendent du JSON sur `stdout` comme tout le reste : un agent doit
 * pouvoir faire `JSON.parse(stdout)` SANS CONDITION, y compris sur l'aide. Une page d'aide
 * en texte libre casserait le contrat pour le seul confort d'un lecteur humain qui, lui,
 * lit tres bien du JSON indente.
 */

import { EXIT_CODES } from './exit.js';

export const CLI_NAME = 'cmgr';

/**
 * Version du binaire.
 *
 * Constante plutot que lecture du manifeste a l'execution : le chemin du `package.json`
 * depuis le code EMIS depend de la profondeur d'emission, qui est un detail de la
 * configuration de compilation — s'y fier ferait dependre `--version` d'un `rootDir`. Un
 * test unitaire la confronte au manifeste, sur le modele de `tests/unit/vscode/manifest.test.ts` :
 * les deux ne peuvent pas se desolidariser en silence.
 */
export const CLI_VERSION = '0.1.0';

export interface UsageEntry {
  readonly name: string;
  readonly summary: string;
}

export interface Usage {
  readonly name: string;
  readonly version: string;
  readonly synopsis: string;
  readonly commands: readonly UsageEntry[];
  readonly options: readonly UsageEntry[];
  readonly exitCodes: Readonly<Record<string, string>>;
  readonly notes: readonly string[];
}

export const USAGE: Usage = {
  name: CLI_NAME,
  version: CLI_VERSION,
  synopsis: 'cmgr <windows|whoami>',
  commands: [
    {
      name: 'windows',
      summary:
        "Enumere les fenetres VSCode pilotables, jeton masque, et restitue tout ce qui a ete ecarte du registre avec son motif. Indique laquelle est la fenetre hote du processus appelant, le cas echeant — n'en avoir aucune n'est pas une erreur.",
    },
    {
      name: 'whoami',
      summary:
        "Resout la fenetre VSCode dans laquelle s'execute le processus appelant, en remontant sa chaine d'ancetres jusqu'a un extension host enregistre. N'avoir aucune fenetre hote est une erreur nommee (OWNING_WINDOW_NOT_FOUND).",
    },
  ],
  options: [
    { name: '--help, -h', summary: 'Rend cette description, en JSON.' },
    { name: '--version, -v', summary: 'Rend le nom et la version du binaire, en JSON.' },
  ],
  exitCodes: {
    [String(EXIT_CODES.SUCCESS)]: 'succes',
    [String(EXIT_CODES.DOMAIN_ERROR)]:
      "erreur nommee du domaine — le champ `error` porte son code stable, son message et sa remediation, tels que le coeur les a formules",
    [String(EXIT_CODES.USAGE_ERROR)]: 'erreur d usage : commande inconnue, option inconnue, argument surnumeraire',
    [String(EXIT_CODES.UNEXPECTED_ERROR)]:
      'defaillance imprevue de ClaudeManager — reduite a son type et a son code systeme, jamais une trace de pile',
  },
  notes: [
    "stdout ne porte QU'UNE SEULE valeur JSON, en succes comme en echec. Les diagnostics lisibles par un humain vont sur stderr.",
    "Aucune commande n'accepte d'option, et aucune ne permet de decrire une fenetre a la main : les fenetres proviennent exclusivement du registre, ou leur identite est verifiee. Une fenetre decrite en ligne de commande contournerait cette verification.",
    'cmgr est en lecture seule : il ne purge pas, n ecrit pas, n ouvre ni ne ferme aucune conversation, et ne fait AUCUN reseau.',
  ],
};
