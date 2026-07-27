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
export const CLI_VERSION = '0.5.0';

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
  synopsis: 'cmgr <windows|whoami|conversations|open|close> [--prompt-file <chemin>] [<id>]',
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
    {
      name: 'conversations',
      summary:
        "Enumere les onglets de conversation Claude de la fenetre hote du processus appelant, et d aucune autre. LECTURE, aucun effet de bord — mais du reseau, contrairement a windows et whoami : les onglets d une fenetre ne se lisent que DANS cette fenetre. Le canal est CONFIRME par GET /health avant la demande. Chaque conversation porte un id — une POIGNEE OPAQUE emise par la fenetre —, son libelle, son viewType releve tel quel, sa position (viewColumn, indexInGroup) et isActive. UNE LISTE VIDE N EST PAS UNE ERREUR : le code de sortie reste 0. LES POIGNEES PERIMENT, et c est le fond du contrat : elles ne survivent ni au deplacement de l onglet, ni au changement de son libelle, ni au redemarrage de l extension host de la fenetre. cmgr close EXIGE une poignee fraiche — lister, puis fermer, dans cet ordre.",
    },
    {
      name: 'open',
      /**
       * IL A MENTI SUR UN FAIT OPERATOIRE, ET C'ETAIT LE PIRE ENDROIT POUR LE FAIRE.
       *
       * Ce resume annoncait « firstTurnVerified, TOUJOURS false ». C'etait vrai en C2 ; le
       * correctif du 2026-07-26 a rendu ce champ `true` sur toute la voie amorcee, et le resume
       * n'a pas suivi. Ce n'est pas de la prose : ce module pose qu'un agent doit pouvoir faire
       * `JSON.parse(stdout)` SANS CONDITION, y compris sur l'aide. Un agent qui lisait ce
       * contrat concluait que le champ ne porte AUCUNE information — l'inverse exact de ce que
       * le correctif a construit, et le champ sur lequel il decide.
       *
       * Les TROIS etats reellement produits sont donc enonces ici, et un test interdit desormais
       * qu'une valeur y soit redonnee pour constante.
       */
      summary:
        "Ouvre une conversation Claude dans la fenetre hote du processus appelant, avec un prompt d amorcage lu par --prompt-file ou sur stdin. Le canal est CONFIRME par GET /health avant toute demande — identite discordante, aucune ouverture. La sortie porte firstTurnVerified, qui a TROIS etats. (1) true, avec mode seeded : la fenetre a CONSTATE le transcript de la session, le tour 1 a eu lieu — son CONTENU n est pas lu pour autant, la REPONSE ne sera restituee que par cmgr open --wait (lot D). Seul cas qui sorte en code 0. (2) false, avec mode fallback : le repli V5 a joue, aucune session n est amorcee et le prompt est seulement PRE-REMPLI dans le champ de saisie. (3) false, avec mode seeded : la fenetre porte une version anterieure de l extension compagnon, qui n observait que le demarrage d un processus — c est la combinaison mesuree comme pouvant rendre un panneau VIDE. Les cas (2) et (3) sortent en code 4, jamais en 0, et aucun des deux ne se retente a l aveugle.",
    },
    {
      name: 'close <id>',
      summary:
        "Ferme UNE conversation de la fenetre hote — celle que <id> designe, et aucune autre. L identifiant est la poignee rendue par cmgr conversations, en argument positionnel : un uuid ne court aucun risque d echappement en shell, contrairement a un prompt, et il ne decrit aucune fenetre. UN CONTRAT EN DEUX TEMPS : la fenetre re-enumere ses onglets et EXIGE que celui qui est designe corresponde encore a ce qu elle avait liste — meme libelle, meme colonne, meme rang. Sinon elle REFUSE sans rien fermer (CONVERSATION_HANDLE_STALE : relister, puis retenter). Un onglet deja parti sort en CONVERSATION_ALREADY_CLOSED : il n y a rien a fermer, ne pas retenter. Le succes n est rendu qu apres avoir CONSTATE la disparition de l onglet par re-enumeration — le booleen de l editeur est releve dans editorReportedClosed, il ne fait pas preuve. Le focus n est JAMAIS emprunte.",
    },
  ],
  options: [
    {
      name: '--prompt-file <chemin>',
      summary:
        "Fichier UTF-8 portant le prompt d amorcage de `open` ; un BOM eventuel est retire. En son absence, le prompt est lu sur stdin, sauf si stdin est un terminal — auquel cas c est une erreur d usage. Quand --prompt-file est donne, stdin n est NI lu NI inspecte : le fichier prime, et le champ prompt.source de la sortie dit toujours d ou le prompt est venu.",
    },
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
    [String(EXIT_CODES.DEGRADED_SUCCESS)]:
      "succes DEGRADE — une conversation EXISTE, mais le tour 1 n est pas acquis. DEUX cas le portent : le repli V5 (mode fallback — le prompt est seulement PRE-REMPLI dans le champ de saisie et attend une validation humaine) et un tour NON VERIFIE sur la voie amorcee (mode seeded avec firstTurnVerified false — la combinaison mesuree comme pouvant rendre un panneau VIDE). Dans les deux cas : ne pas retenter a l aveugle, une relance ouvrirait une seconde conversation. Ni 0 (le tour ne tourne pas) ni 1 (l operation a bien eu lieu)",
  },
  notes: [
    "stdout ne porte QU'UNE SEULE valeur JSON, en succes comme en echec. Les diagnostics lisibles par un humain vont sur stderr.",
    "Aucune commande ne permet de decrire une fenetre a la main : les fenetres proviennent exclusivement du registre, ou leur identite est verifiee. Une fenetre decrite en ligne de commande contournerait cette verification. Il n existe pas davantage d option pour designer un hote ou un port — cmgr ne parle qu a la boucle locale.",
    "LE PROMPT NE PASSE JAMAIS PAR UN ARGUMENT : `cmgr open \"mon prompt\"` est une erreur d usage. L echappement des prompts longs en shell est une source de bugs inepuisable, et un prompt tronque partirait sans que rien ne le signale. `close`, lui, prend bien un argument positionnel : un uuid de longueur fixe, sans espace ni guillemet, qu aucun shell ne peut tronquer ni reinterpreter — la regle vise l echappement, pas la position.",
    "windows et whoami ne font AUCUN reseau. conversations en fait, sans aucun effet de bord. open et close AGISSENT : ils demandent a la fenetre hote, sur 127.0.0.1, d ouvrir ou de fermer une conversation. Aucune commande n ecrit dans le registre ni ne le purge.",
  ],
};
