/**
 * Les trois commandes de `cmgr` : deux lectures, et une ouverture.
 *
 * PERIMETRE, ET C'EST UNE DECISION : ce module lit le registre et la table des processus, et
 * demande a SA fenetre — jamais a une autre — d'ouvrir une conversation. Il n'ecrit rien dans
 * le registre, ne purge rien — la purge appartient a l'extension compagnon, qui seule sait
 * quand sa fenetre s'active —, et ne ferme aucune conversation (increment C4).
 *
 * LE RESEAU EST ENTRE DANS `cmgr` A L'INCREMENT C2, ET SEULEMENT PAR `open`. Les deux
 * commandes de lecture n'interrogent toujours aucun serveur, et ce n'est pas un residu du lot
 * B : faire dependre l'inventaire des fenetres de leur joignabilite melangerait deux questions
 * distinctes — « quelles fenetres existent ? » et « laquelle repond ? ». La seconde appartient
 * a `cmgr doctor` (lot D). Quand `open` fait du reseau, il le fait par le CLIENT DU COEUR
 * (`core/client`) : aucune source de la CLI n'importe `node:http`, et un test d'architecture
 * le verifie.
 *
 * AUCUNE FENETRE N'EST FABRIQUEE ICI. Toute la garantie d'identite vit dans
 * `parseWindowEntry` : validation de schema, confrontation du contenu au NOM du fichier,
 * garde anti-reemploi de pid. Une fenetre decrite depuis un argument de ligne de commande
 * n'aurait traverse aucun de ces controles, et `resolveOwningWindow` la retiendrait aussi
 * volontiers qu'une vraie. C'est pourquoi la liste passee au coeur provient TOUJOURS de
 * `readRegistry`, et pourquoi aucune option n'existe pour la completer — pas davantage sur
 * `open`, qui agit pourtant, et pour qui l'enjeu est donc entier.
 */

import {
  ancestorsOf,
  assertSubmittablePrompt,
  openConversationInWindow,
  readRegistry,
  redactWindowEntry,
  requireOwningWindow,
  resolveOwningWindow,
  resolveRegistryDir,
  type ProcessSnapshot,
  type RegistryReadResult,
  type SkippedEntry,
  type WindowTransport,
} from './core.js';
import { readPromptFile, readPromptStdin, type PromptInput, type PromptStdin } from './prompt.js';
import { usageFailure, type Failure } from './exit.js';

/**
 * Tout ce dont une commande a besoin du monde exterieur.
 *
 * `readSnapshot` est fourni plutot qu'appele : c'est la couture qui permet aux tests
 * unitaires de rejouer une capture reelle sans relancer l'inventaire du poste. Ce n'est PAS
 * un point d'extension public — la CLI reelle y branche `readProcessTable`, et rien d'autre
 * n'est offert a l'utilisateur pour en changer.
 *
 * `registryDir` est explicitement `string | undefined` et non optionnel : un appelant doit
 * DIRE qu'il vise le registre par defaut, plutot que de l'obtenir par omission.
 */
export interface CliContext {
  /** Le processus dont on cherche la fenetre : `process.pid` en production. */
  readonly pid: number;
  readonly registryDir: string | undefined;
  readonly readSnapshot: () => Promise<ProcessSnapshot>;
  /** D'ou `open` lit son prompt quand aucun fichier n'est nomme. */
  readonly stdin: PromptStdin;
  /**
   * Le transport HTTP, fourni plutot qu'appele — meme couture que `readSnapshot`, et pour la
   * meme raison : elle permet d'eprouver `open` contre une VRAIE socket servant de VRAIES
   * reponses capturees, sans jamais fabriquer un faux `http` (principe fondateur n.5).
   *
   * La CLI reelle y branche `createLoopbackTransport()`, et rien d'autre n'est offert a
   * l'utilisateur pour en changer : il n'existe aucune option pour designer un hote.
   */
  readonly transport: WindowTransport;
}

/**
 * Contexte d'enveloppe, rendu en succes COMME en echec.
 *
 * Il est MUTABLE et rempli au plus tot, deliberement : `skipped` est connu des la lecture du
 * registre, mais `whoami` peut echouer juste apres. Or c'est precisement dans ce cas que
 * l'utilisateur en a le plus besoin — « aucune fenetre ne te revendique, et voici les deux
 * entrees qu'on a ecartees, avec leur motif » repond a la question, la ou l'erreur seule la
 * laisse entiere (principe fondateur n.3 : ce qui a ete ecarte doit APPARAITRE).
 *
 * Il n'entre jamais dans l'erreur elle-meme, qui est rendue telle que le coeur l'a formulee.
 */
export interface Diagnostics {
  skipped?: readonly SkippedEntry[];
  /**
   * La commande a produit un resultat, mais PAS LE NOMINAL — et il y a DEUX facons.
   *
   * Le repli V5 en est une : la conversation est ouverte, le prompt seulement pre-rempli.
   * L'autre est un tour 1 NON VERIFIE sur une voie amorcee — ce qu'une fenetre portant une
   * version anterieure de l'extension rend —, c'est-a-dire exactement la combinaison mesuree
   * comme produisant un panneau VIDE. Les deux disent la meme chose a l'appelant : la
   * conversation existe, ce n'est pas ce qu'il a demande, et retenter en ouvrirait une seconde.
   *
   * C'est le CODE DE SORTIE qui en depend (`DEGRADED_SUCCESS`), et c'est pourquoi il passe par
   * ici plutot que d'etre relu dans le corps de la reponse : lire un champ du JSON pour
   * decider du code de sortie ferait dependre l'enveloppe de son contenu.
   */
  degraded?: boolean;
  /**
   * Ce qu'un HUMAIN doit lire, et qu'un champ JSON seul laisserait passer.
   *
   * `firstTurnVerified` est le cas d'espece : un agent qui lit `ok: true` sans le voir
   * conclurait que le tour 1 a eu lieu — a tort quand le champ vaut `false`. Le champ est dans
   * la sortie machine ; la phrase, elle, va sur `stderr`, ou un humain la lit sans avoir a
   * interroger le JSON, et elle dit lequel des trois cas on a sous les yeux (`openingNote`).
   */
  notes?: readonly string[];
}

export type CommandBody = Readonly<Record<string, unknown>>;

/**
 * Le repertoire est resolu UNE fois, par le resolveur du coeur, et jamais par une branche.
 *
 * `readRegistry({ snapshot })` et `readRegistry({ snapshot, dir })` aboutissent au meme
 * `resolveRegistryDir` : choisir entre les deux selon que `registryDir` est defini n'aurait
 * fait qu'ajouter un chemin dont l'un des deux cotes n'est jamais emprunte par les tests —
 * le defaut visant, lui, le registre REEL du poste, qu'aucun test unitaire ne doit toucher.
 */
function readWindowRegistry(context: CliContext, snapshot: ProcessSnapshot): RegistryReadResult {
  return readRegistry({ snapshot, dir: resolveRegistryDir(context.registryDir) });
}

/**
 * UN SEUL instantane par commande.
 *
 * `readProcessTable()` coute de 700 ms a 1,3 s sur un poste reel : le relire une seconde
 * fois doublerait la duree de la commande pour rien, et — plus grave — ferait juger le
 * registre et la chaine d'ancetres sur deux etats du systeme differents.
 */
async function inventory(
  context: CliContext
): Promise<{ readonly snapshot: ProcessSnapshot; readonly registry: RegistryReadResult }> {
  const snapshot = await context.readSnapshot();
  return { snapshot, registry: readWindowRegistry(context, snapshot) };
}

/**
 * « Quelles fenetres sont pilotables ? »
 *
 * Une liste VIDE assortie de `skipped` NON VIDE n'est pas un echec : c'est le renseignement
 * capital que des fenetres existent, qu'aucune n'est pilotable, et pourquoi. C'est
 * exactement l'etat d'un poste ou seule une version anterieure de l'extension a tourne.
 *
 * L'absence de fenetre hote n'est PAS une erreur ici : lister n'est pas se situer.
 * L'AMBIGUITE, elle, en est une — `resolveOwningWindow` leve `DUPLICATE_WINDOW_IDENTITY`
 * quand deux entrees revendiquent le meme extension host, et on la laisse remonter plutot
 * que de rendre `owner: null`. Un `null` dirait « aucune fenetre ne te revendique » la ou la
 * verite est « deux te revendiquent » : ce serait la degradation silencieuse que le principe
 * fondateur n.3 interdit.
 */
export async function windowsCommand(
  context: CliContext,
  diagnostics: Diagnostics
): Promise<CommandBody> {
  const { snapshot, registry } = await inventory(context);
  diagnostics.skipped = registry.skipped;

  const owner = resolveOwningWindow(context.pid, snapshot.table, registry.windows);

  return {
    // `redactWindowEntry` vit dans le coeur pour que la CLI ne puisse pas l'oublier : c'est
    // le seul chemin par lequel une entree devient affichable.
    windows: registry.windows.map(redactWindowEntry),
    owner: owner === undefined ? null : { extHostPid: owner.extHostPid },
  };
}

/**
 * « Dans quelle fenetre s'execute le processus qui m'appelle ? »
 *
 * La chaine remonte naturellement du binaire au shell, du shell au `claude.exe`, puis a
 * l'extension host : c'est le seul rattachement qui fasse identite. Ni `VSCODE_PID` — un
 * processus principal heberge plusieurs fenetres et le partage entre toutes —, ni le titre,
 * ni le chemin du workspace n'y entrent : deux fenetres sur le meme dossier physique sont le
 * cas de reference du produit.
 *
 * N'avoir AUCUNE fenetre hote n'est pas un succes a champ vide : c'est
 * `OWNING_WINDOW_NOT_FOUND`, rendue telle quelle avec un code de sortie non nul. D'ou
 * `requireOwningWindow` plutot que `resolveOwningWindow`.
 */
export async function whoamiCommand(
  context: CliContext,
  diagnostics: Diagnostics
): Promise<CommandBody> {
  const { snapshot, registry } = await inventory(context);
  // Rempli AVANT la resolution : c'est en cas d'echec qu'il vaut le plus.
  diagnostics.skipped = registry.skipped;

  // La MEME chaine que celle sur laquelle le coeur decide — processus appelant inclus, car
  // l'extension compagnon est l'extension host de sa fenetre et doit se resoudre elle-meme.
  // Elle est rendue pour que l'utilisateur puisse VOIR le rattachement, jamais pour le
  // decider : la decision reste entierement celle de `requireOwningWindow`.
  const chain = [context.pid, ...ancestorsOf(context.pid, snapshot.table)];

  const owner = requireOwningWindow(context.pid, snapshot.table, registry.windows);

  return {
    window: redactWindowEntry(owner),
    ancestry: {
      callerPid: context.pid,
      chain,
      /** Profondeur a laquelle la fenetre hote a ete trouvee — 0 signifie « c'est moi ». */
      ownerDepth: chain.indexOf(owner.extHostPid),
    },
  };
}

/** Ce que l'analyse d'arguments a retenu pour `open`, et rien de plus. */
export interface OpenOptions {
  readonly promptFile: string | undefined;
}

/**
 * D'OU VIENT LE PROMPT — et pourquoi `--prompt-file` PRIME sans jamais entrer en conflit.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * ECART ASSUME AU CAHIER DES CHARGES DE C2, ET IL EST MESURE. Il etait demande que « les deux
 * fournis » soit une erreur d'usage. Ce cas N'EST PAS DECIDABLE sans se tromper, et se tromper
 * ici couterait plus cher que le cas qu'on renonce a detecter.
 *
 * MESURE DU 2026-07-26, sur ce poste : dans le harnais qui execute les outils d'un agent
 * Claude, `process.stdin.isTTY` vaut `undefined` et `fstat(0)` rend un PERIPHERIQUE CARACTERE
 * — c'est `NUL`, il n'y a rien a lire. Un `child_process.spawn` de Node, lui, rend un TUBE
 * (`isFIFO`) meme quand personne n'y ecrira jamais. Ni `isTTY` ni `fstat` ne distinguent donc
 * « un prompt attend sur stdin » de « stdin est branche sur rien » : la seule facon de trancher
 * serait de LIRE stdin, ce qui pendrait indefiniment sur un tube inactif.
 *
 * Une detection fondee sur l'un ou l'autre transformerait `cmgr open --prompt-file p.md` —
 * l'invocation NOMINALE d'un agent — en erreur d'usage. C'est un defaut, pas une garde.
 *
 * LA REGLE RETENUE REND LE CONFLIT IMPOSSIBLE PLUTOT QUE DETECTABLE : quand `--prompt-file`
 * est present, stdin n'est ni lu ni meme inspecte. Une erreur qu'on ne peut pas commettre vaut
 * mieux qu'une erreur qu'on detecte. Le prix — `cmgr open --prompt-file a.md < b.md` prend
 * `a.md` en silence — est borne et documente, et la sortie porte `prompt.source` pour que
 * l'appelant n'ait jamais a le deviner.
 *
 * L'AUTRE MOITIE DE L'EXIGENCE, ELLE, EST TENUE : « aucun des deux » est bien une erreur.
 * Sur un terminal, c'est une erreur d'USAGE — attendre qu'un humain tape reviendrait a pendre.
 * Sur un flux vide, c'est l'erreur NOMMEE `PROMPT_EMPTY`.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * @throws {ClaudeManagerError} `PROMPT_FILE_UNREADABLE`, `PROMPT_EMPTY`
 */
async function resolvePrompt(
  context: CliContext,
  options: OpenOptions
): Promise<PromptInput | undefined> {
  const input =
    options.promptFile === undefined
      ? await readPromptStdin(context.stdin)
      : readPromptFile(options.promptFile);

  // `undefined` ne dit qu'UNE chose : il n'y a AUCUNE source de prompt — stdin est un terminal
  // et aucun fichier n'a ete nomme. Un flux vide, lui, est bien une source, et son refus est
  // une erreur NOMMEE, pas une erreur d'usage.
  if (input === undefined) return undefined;

  // AVANT l'inventaire des processus, qui coute de 700 ms a 1,3 s : un prompt vide n'a pas
  // besoin qu'on lise la table du poste pour etre refuse.
  assertSubmittablePrompt(input.text);
  return input;
}

/**
 * Ce que `open` rend a l'aiguilleur — un corps, ou un refus d'USAGE.
 *
 * UNION DISCRIMINEE plutot qu'un `CommandBody | Failure` : la premiere forme est un
 * `Record<string, unknown>`, dont rien n'interdit qu'il porte une cle `error`. Distinguer les
 * deux par la presence d'un champ aurait donc exige une conversion de type, c'est-a-dire une
 * affirmation que le compilateur ne verifie pas.
 */
export type OpenOutcome =
  | { readonly kind: 'opened'; readonly body: CommandBody }
  | { readonly kind: 'usage'; readonly failure: Failure };

/**
 * CE QU'UN HUMAIN DOIT LIRE DE L'OUVERTURE, en une phrase — le JSON, lui, porte les champs.
 *
 * TROIS CAS, ET LE TROISIEME N'EST PAS DECORATIF : une fenetre portant une version anterieure
 * de l'extension rend `firstTurnVerified: false` sur une voie amorcee, parce qu'elle n'observait
 * que le demarrage d'un processus. Rendre la meme phrase que pour un tour verifie serait affirmer
 * ce qu'on n'a pas constate ; la taire laisserait croire au succes complet. On dit donc lequel
 * des deux on a sous les yeux, et quoi faire.
 */
function openingNote(conversation: {
  readonly mode: string;
  readonly firstTurnVerified: boolean;
}): string {
  if (conversation.mode === 'fallback') {
    return 'repli V5 : la conversation est ouverte, le prompt est PRE-REMPLI dans le champ de saisie et N A PAS ete soumis. Un geste humain est requis.';
  }
  return conversation.firstTurnVerified
    ? 'le tour 1 a EU LIEU (firstTurnVerified: true) : le transcript de la session existe sur le disque. Son CONTENU n est pas lu — la REPONSE du tour ne sera restituee que par cmgr open --wait, lot D.'
    : "le tour 1 n est PAS verifie (firstTurnVerified: false) : cette fenetre porte une version de l extension qui n observait que le demarrage d un processus, jamais le tour lui-meme — c est la combinaison mesuree comme pouvant rendre un panneau VIDE. Un panneau a ete ouvert : NE PAS RELANCER, ce serait ouvrir une seconde conversation. Comparer son extensionVersion avec cmgr windows, puis la mettre a jour.";
}

/**
 * « Ouvre une conversation dans MA fenetre, avec ce prompt. »
 *
 * TOUT CE QUI DECIDE EST DANS LE COEUR (`openConversationInWindow`) : resolution de la fenetre,
 * confirmation du canal, relecture du port et du jeton, mise en forme des refus. Cette fonction
 * lit le prompt, passe l'instantane des processus — LU UNE SEULE FOIS —, et met en forme.
 *
 * CE QUE LA SORTIE DIT, ET QU'ELLE NE DOIT PAS TAIRE :
 *   - `firstTurnVerified` est rendu AU PREMIER NIVEAU, tel que la fenetre le dit. Il vaut `true`
 *     quand la fenetre a constate le transcript de la session, `false` en repli V5 comme sur une
 *     fenetre trop ancienne pour le verifier. Un agent qui lirait `ok: true` sans ce champ
 *     conclurait, a tort, que le tour a eu lieu ; une ligne de `stderr` le redit en clair.
 *   - `channelConfirmed` NOMME la confirmation de canal : une verification silencieuse est une
 *     verification dont personne ne peut dire si elle a eu lieu.
 *   - `degradedFrom`, en repli, est rendu TEL QUEL — le repli s'ajoute a l'erreur, il ne la
 *     remplace jamais.
 */
export async function openCommand(
  context: CliContext,
  diagnostics: Diagnostics,
  options: OpenOptions
): Promise<OpenOutcome> {
  const prompt = await resolvePrompt(context, options);
  if (prompt === undefined) {
    return {
      kind: 'usage',
      failure: usageFailure(
        'No prompt: cmgr open reads it from --prompt-file, or from stdin when stdin is not a terminal'
      ),
    };
  }

  const opening = await openConversationInWindow(
    { prompt: prompt.text },
    {
      pid: context.pid,
      // UN SEUL instantane, comme les commandes de lecture (alerte n.15). Le coeur, lui,
      // relit le REGISTRE a chaque appel : c'est le port et le jeton qui ne se mettent jamais
      // en cache, pas la table des processus.
      snapshot: await context.readSnapshot(),
      registryDir: context.registryDir,
      transport: context.transport,
      // `diagnostics` EST le rapport que le coeur remplit : `skipped` sera la meme en succes
      // comme en echec, sans que la CLI ait a le recopier.
      report: diagnostics,
    }
  );

  const { conversation } = opening;
  /**
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * UN TOUR 1 NON VERIFIE N'EST PAS UN SUCCES NOMINAL, ET SORTAIT POURTANT EN `0`.
   *
   * Le repli V5 seul portait le code 4. Une ouverture `mode: 'seeded'` avec
   * `firstTurnVerified: false` sortait donc en `0` — c'est-a-dire sur la combinaison meme que la
   * recette du 2026-07-26 a mesuree comme produisant un panneau VIDE, sans prompt ni reponse.
   * Le champ etait dans le JSON et la phrase sur `stderr`, mais la doctrine de `exit.ts` est
   * qu'un agent doit pouvoir decider SANS analyser la sortie : le seul canal qui satisfait cette
   * exigence disait « succes nominal ». Et le raisonnement qui a cree le code 4 s'applique mot
   * pour mot — un `0` fait enchainer l'agent sur « ma conversation tourne » et attendre une
   * reponse qui ne viendra jamais.
   * ─────────────────────────────────────────────────────────────────────────────────────────
   */
  diagnostics.degraded = conversation.mode === 'fallback' || !conversation.firstTurnVerified;
  diagnostics.notes = [openingNote(conversation)];

  return {
    kind: 'opened',
    body: {
      // AU PREMIER NIVEAU, et c'est delibere : ce sont les champs sur lesquels un agent decide.
      // Les enfouir sous un objet `conversation` ferait de `firstTurnVerified` un detail, quand
      // il est precisement ce qu'il ne faut pas manquer.
      mode: conversation.mode,
      sessionId: conversation.sessionId,
      /** La fenetre qui a REELLEMENT agi, telle qu'elle s'est nommee, canal confirme. */
      extHostPid: conversation.extHostPid,
      humanActionRequired: conversation.humanActionRequired,
      firstTurn: conversation.firstTurn,
      firstTurnVerified: conversation.firstTurnVerified,
      ...(conversation.panelViewType === undefined
        ? {}
        : { panelViewType: conversation.panelViewType }),
      ...(conversation.degradedFrom === undefined
        ? {}
        : { degradedFrom: conversation.degradedFrom }),
      channelConfirmed: opening.channel,
      // Jeton masque, repertoire personnel masque : c'est le seul chemin par lequel une entree
      // devient affichable, et le coeur l'a deja applique.
      window: opening.window,
      // Ce qui a ete envoye, sans jamais le recopier : la SOURCE et la TAILLE suffisent a
      // reconnaitre un prompt pris au mauvais endroit.
      prompt: { source: prompt.source, bytes: prompt.bytes },
    },
  };
}
