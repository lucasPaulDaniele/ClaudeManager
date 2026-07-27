/**
 * LE CLIENT DU SERVEUR LOCAL — demander a MA fenetre, et a aucune autre, d'ouvrir une
 * conversation.
 *
 * Trois etapes, et L'ORDRE FAIT PARTIE DU MECANISME :
 *
 *   1. resoudre la fenetre appelante — table des processus fournie, registre relu ;
 *   2. CONFIRMER LE CANAL par `GET /health`, en confrontant l'identite rendue par la fenetre
 *      a celle de l'entree lue ;
 *   3. seulement alors, `POST /conversations`.
 *
 * LES DEUX PREMIERES VIVENT DESORMAIS DANS `channel.node.ts`, ET C'EST L'INCREMENT C4 QUI L'A
 * IMPOSE : deux commandes de plus les traversent — enumerer, fermer —, et une sequence recopiee
 * trois fois est une sequence qui divergera une fois. Le motif complet est en tete de ce
 * module-la ; ce qui reste ici est ce qui appartient a l'OUVERTURE seule.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * POURQUOI L'ETAPE 2 EXISTE, ET CE N'EST PAS UNE PRECAUTION DE STYLE.
 *
 * La substitution d'une entree de registre est REPAREE A POSTERIORI, JAMAIS EMPECHEE
 * (ADR-003, decision 5) : un processus tournant sous le compte de l'utilisateur peut ECRASER
 * le fichier qui porte deja le bon nom. La lecture ne rapporte alors aucune anomalie. Entre
 * l'instant ou l'on lit l'entree et celui ou l'on agit, le couple port/jeton peut donc
 * designer autre chose que la fenetre attendue — et `POST /conversations` est LA PREMIERE
 * ROUTE A EFFET DE BORD DU PRODUIT.
 *
 * Le meme risque existe sans le moindre intrus : le port est EPHEMERE, il retourne au systeme
 * quand une ecoute meurt, et la plage ephemere est reutilisee agressivement (alerte n.41).
 *
 * `GET /health` est sans effet de bord : la confronter AVANT de demander une ouverture ne
 * coute qu'un aller-retour sur la boucle locale, et transforme « on a peut-etre agi sur la
 * mauvaise fenetre » en « on n'a rien fait, et on dit pourquoi ». La confirmation est NOMMEE
 * dans le resultat, jamais silencieuse : l'appelant doit savoir qu'elle a eu lieu.
 *
 * CE QU'ELLE NE FAIT PAS : elle ne ferme pas la fenetre de course, elle la RETRECIT. Une
 * substitution survenant entre `/health` et le `POST` reste possible — c'est pourquoi
 * l'identite rendue par le `POST` est confrontee elle aussi, en sortie.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Aucun import de `vscode`, aucune journalisation : ce module rend un resultat.
 */

import { ClaudeManagerError, ERROR_CODES } from '../errors.js';
import type { WindowEntry } from '../registry/entry.js';
import { redactWindowEntry, type RedactedWindowEntry } from '../registry/redaction.node.js';
import type { SkippedEntry } from '../registry/store.node.js';
import {
  identityMismatch,
  openWindowChannel,
  send,
  type ChannelConfirmation,
  type WindowChannelOptions,
} from './channel.node.js';
import {
  CONVERSATIONS_PATH,
  OPEN_ROUTE,
  readOpenedConversation,
  type OpenedConversation,
  type WindowTransport,
} from './protocol.js';

/**
 * DELAI DE L'OUVERTURE — long, borne, et calcule sur ce que la FENETRE se donne a elle-meme.
 *
 * La route d'ouverture borne son propre travail (`packages/vscode/src/conversations.ts`), et le
 * calcul est REFAIT ici a chaque fois qu'une de ses echelles change — sans quoi la CLI
 * abandonnerait pendant que la fenetre travaille encore, ce qui est le pire des mensonges.
 *
 * ADDITION REFAITE AU VOLET 2 DU GATE C, DEUX BORNES AYANT ETE AJOUTEES :
 *   - activation de l'extension Claude : **10 s** — bornee au volet 2, elle ne l'etait pas ;
 *   - resolution du pid du shell : 8 echelons de 250 ms, soit **2 s** — bornee au volet 2 ;
 *   - attente du processus amorce : 8 lectures de table a 0,7–1,3 s, plus 8 respirations de
 *     250 ms, soit **~12 s** au pire ;
 *   - apparition du transcript : **45 s** — mesure du 2026-07-26, elle survient a 2,5 s ;
 *   - grace accordee a la sortie du tour : **30 s** apres l'apparition — mesure, elle retombe
 *     ~9 s apres l'envoi ;
 *   - echelle d'attachement : 2 + 4 + 8 + 16 + 32 = **62 s**.
 *
 * CES BORNES NE S'ADDITIONNENT PAS TOUTES, et le detail compte : celles qui S'EPUISENT levent
 * une erreur nommee et rien de ce qui suit n'a lieu. Le chemin le plus long est donc celui qui
 * REUSSIT partout, ou chaque etape consomme son pire cas SANS l'epuiser :
 *   10 (activation) + 0,25 (le pid tombe au premier echelon) + 12,4 + 45 + 30 + 62 = **~159,7 s**.
 *
 * LE FACTEUR N'EST PLUS DEUX, ET LE DIRE VAUT MIEUX QUE DE L'ECRIRE FAUX. Les ouvertures d'une
 * meme fenetre sont SERIALISEES (`serializeOpenings`) : une demande peut attendre derriere une
 * AUTRE, chacune a sa borne. Couvrir une file d'un rang exigerait 319 s. Or le plafond n'est pas
 * le notre : c'est le `requestTimeout` par defaut de Node (300 s), au-dela duquel le SERVEUR
 * detruit la socket — un delai client plus long n'attendrait donc rien. 300 s valent **1,88 fois**
 * le pire cas de la fenetre.
 *
 * CE QUI N'EST DONC PLUS GARANTI, ECRIT PLUTOT QUE TU : une demande mise en file derriere une
 * ouverture qui consomme son pire cas peut etre abandonnee cote client ~19 s avant que la
 * fenetre n'ait fini. L'abandon N'ANNULE RIEN — la conversation peut s'ouvrir apres coup —, et
 * c'est pourquoi la remediation de `WINDOW_UNREACHABLE` interdit de relancer a l'aveugle. Le
 * seul moyen de restaurer le facteur deux serait de fixer explicitement `requestTimeout` cote
 * serveur ; ce n'est pas fait, et ce n'est pas un oubli : une CLI qui attendrait plus longtemps
 * que le serveur d'une fenetre restee en version anterieure verrait sa socket detruite a 300 s
 * et rendrait `WINDOW_UNREACHABLE` sur une ouverture peut-etre reussie. Ce compromis se tranche
 * avec le lot E, quand les deux artefacts seront publies ensemble.
 *
 * POURQUOI PAS D'ATTENTE INFINIE, alors que la fenetre se borne deja : parce que ce n'est pas
 * la fenetre qu'on attend, c'est une SOCKET. Un occupant silencieux du port ne se borne pas,
 * lui. Et pourquoi pas moins : abandonner une ouverture NE L'ANNULE PAS — aucun canal ne
 * permet d'interrompre un tour en cours (decision de perimetre).
 */
export const OPEN_TIMEOUT_MS = 300_000;

export interface ConversationOpening {
  /** L'entree du registre, MASQUEE — c'est la seule forme affichable (jeton, chemins). */
  readonly window: RedactedWindowEntry;
  readonly channel: ChannelConfirmation;
  readonly conversation: OpenedConversation;
  readonly skipped: readonly SkippedEntry[];
}

export interface OpenConversationRequest {
  readonly prompt: string;
}

export type OpenConversationInWindowOptions = WindowChannelOptions;

/**
 * Un prompt vide n'ouvre rien — et le refus tombe AVANT le moindre acces au systeme.
 *
 * Le serveur le refuserait aussi (`400 BAD_REQUEST`), mais un refus distant coute un
 * inventaire de processus, une lecture de registre et deux allers-retours, pour finir en un
 * code de transport qui n'apprend rien. Exportee parce que la CLI s'en sert AUSSI, des la
 * lecture de son entree : echouer en 2 ms vaut mieux qu'echouer en 1,3 s.
 *
 * @throws {ClaudeManagerError} `PROMPT_EMPTY`
 */
export function assertSubmittablePrompt(prompt: string): void {
  if (prompt.trim().length > 0) return;

  throw new ClaudeManagerError(
    ERROR_CODES.PROMPT_EMPTY,
    'The prompt is empty: no conversation will be opened',
    // La LONGUEUR, jamais le contenu : un prompt de blancs reste un prompt de l'appelant.
    { length: prompt.length }
  );
}

/**
 * Demande l'ouverture, puis CONFRONTE une derniere fois l'identite de qui a agi.
 *
 * LE PROMPT PASSE PAR LE CORPS, JAMAIS PAR UN CHEMIN DE FICHIER : un chemin transmis a la
 * fenetre serait une surface de traversee, et rien ne garantirait qu'elle lise le meme fichier
 * que l'appelant a voulu. Ne pas confondre avec l'interface de `cmgr` vis-a-vis de SON
 * appelant, qui passe bien par fichier : ce sont deux couches distinctes.
 *
 * LA CONFRONTATION FINALE N'EMPECHE RIEN, ELLE CONSTATE — et c'est dit : quand elle echoue,
 * une conversation a DEJA ete ouverte quelque part. On la signale malgre tout, avec les deux
 * pid, plutot que de rendre un succes : rendre `ok` sur une fenetre qui n'est pas la sienne
 * violerait l'invariant du produit, et l'appelant croirait piloter ce qu'il ne pilote pas.
 *
 * TOUT CE QUI ECHOUE ICI ECHOUE APRES L'EFFET DE BORD, et les codes le disent : la relecture
 * rend `WINDOW_OPEN_RESPONSE_UNREADABLE` — jamais `WINDOW_RESPONSE_UNREADABLE`, reserve aux
 * routes dont la relance ne peut rien creer —, dont la remediation avertit qu'une conversation
 * existe peut-etre deja.
 *
 * @throws {ClaudeManagerError} `WINDOW_UNREACHABLE`, `WINDOW_TOKEN_REJECTED`,
 * `WINDOW_REQUEST_REFUSED`, `WINDOW_OPEN_RESPONSE_UNREADABLE`, `WINDOW_IDENTITY_MISMATCH`, ou
 * le CODE de toute erreur nommee que la FENETRE a formulee.
 */
async function postConversation(
  entry: WindowEntry,
  prompt: string,
  transport: WindowTransport
): Promise<OpenedConversation> {
  const conversation = readOpenedConversation(
    await send(
      transport,
      {
        port: entry.port,
        method: 'POST',
        path: CONVERSATIONS_PATH,
        // RELU SUR L'ENTREE, A CET INSTANT : ni le port ni le jeton ne sont jamais retenus
        // d'un appel a l'autre (alerte n.41).
        token: entry.token,
        body: JSON.stringify({ prompt }),
        timeoutMs: OPEN_TIMEOUT_MS,
      },
      OPEN_ROUTE
    )
  );

  if (conversation.extHostPid !== entry.extHostPid) {
    throw identityMismatch(OPEN_ROUTE, entry, {
      extHostPid: conversation.extHostPid,
      mainPid: undefined,
    });
  }

  return conversation;
}

/**
 * Ouvre une conversation dans la fenetre qui heberge le processus appelant.
 *
 * @throws {ClaudeManagerError} `PROMPT_EMPTY`, `REGISTRY_UNREADABLE`,
 * `OWNING_WINDOW_NOT_FOUND`, `DUPLICATE_WINDOW_IDENTITY`, puis toutes celles du canal.
 */
export async function openConversationInWindow(
  request: OpenConversationRequest,
  options: OpenConversationInWindowOptions
): Promise<ConversationOpening> {
  // AVANT TOUT ACCES AU SYSTEME : un prompt vide n'a pas besoin d'un inventaire de processus.
  assertSubmittablePrompt(request.prompt);

  const { entry, channel, skipped } = await openWindowChannel(options);
  const conversation = await postConversation(entry, request.prompt, options.transport);

  return {
    // `redactWindowEntry` n'intervient qu'ICI, en SORTIE : tout ce qui precede a travaille sur
    // l'entree brute, parce qu'un chemin masque ne se compare pas et qu'un `***` ne s'envoie pas.
    window: redactWindowEntry(entry),
    channel,
    conversation,
    skipped,
  };
}
