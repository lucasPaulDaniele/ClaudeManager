/**
 * ENUMERER ET FERMER — les deux routes de conversation de MA fenetre, et d'aucune autre.
 *
 * Meme ordre imposé que l'ouverture, et il vient du meme endroit (`channel.node.ts`) :
 * resoudre la fenetre → CONFIRMER LE CANAL par `GET /health` → seulement alors agir. La
 * confirmation est NOMMEE dans les deux resultats.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * UN CONTRAT EN DEUX TEMPS, ET C'EST LE PRIX D'UN IDENTIFIANT QUI NE MENTE PAS.
 *
 * `cmgr close` exige un `cmgr conversations` prealable, dans la meme session de fenetre. Ce
 * n'est pas une commodite d'implementation : l'API `vscode.Tab` NE PORTE AUCUN IDENTIFIANT, et
 * aucun de ses champs n'est stable — le `viewType` est le meme pour tous les panneaux Claude
 * (D2), le `label` est du contenu de conversation (D24), la position change au premier
 * deplacement. La fenetre synthetise donc une poignee opaque au moment de lister, retient ce
 * qu'elle a releve, et REFUSE de fermer si l'onglet designe ne correspond plus.
 *
 * Ce que ce refus achete : on ne ferme JAMAIS un onglet dont on ne peut pas prouver qu'il est
 * celui qui a ete designe. Ce qu'il coute : un aller-retour de plus, et une erreur nommee
 * (`CONVERSATION_HANDLE_STALE`) quand la conversation a bouge entre les deux temps.
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
  CLOSE_ROUTE,
  CONVERSATION_CLOSE_PATH,
  CONVERSATION_HANDLE_SHAPE,
  CONVERSATIONS_PATH,
  LIST_ROUTE,
  readClosedConversation,
  readWindowConversations,
  WINDOW_CLOSE_BUDGET_MS,
  type ClosedConversation,
  type ListedConversation,
  type WindowTransport,
} from './protocol.js';

/**
 * LA MARGE, ET ELLE EST LA MEME POUR LES DEUX DELAIS CI-DESSOUS.
 *
 * Ce qu'elle couvre est ce qu'aucune arithmetique ne sait chiffrer : deux allers-retours sur la
 * boucle locale, et un poste charge qui n'est pas le poste de mesure. Elle ne couvre PAS une
 * seconde fermeture concurrente — cela, c'est le calcul qui s'en charge.
 */
const QUEUE_MARGIN_MS = 5_000;

/**
 * DELAI DE L'ENUMERATION — CELUI D'UNE LECTURE QUI PEUT ATTENDRE SON TOUR, et c'est tout le
 * defaut G3 du gate final.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * IL VALAIT 5 000 MS, AU MOTIF QUE LA ROUTE NE FAIT QUE PARCOURIR `tabGroups` EN MEMOIRE. C'est
 * vrai du TRAVAIL de la route, et faux de son DELAI : les deux routes de conversation partagent
 * une file d'un seul rang (`packages/vscode/src/tabs.ts`), et une fermeture y retient la place
 * pendant `WINDOW_CLOSE_BUDGET_MS`. Une enumeration arrivee derriere une fermeture sortait donc
 * en `WINDOW_UNREACHABLE` — sur une fenetre parfaitement vivante, et en DESIGNANT LA MAUVAISE
 * CAUSE : « son serveur local n'a pas repondu », quand il repondait, en son temps.
 *
 * Le calcul est desormais ECRIT, et il est DERIVE des budgets de la fenetre plutot que recopie :
 * une fermeture devant soi, plus la marge. Il suit tout seul le jour ou la fenetre change les
 * siens — c'est la raison pour laquelle ces trois nombres vivent dans `protocol.ts`.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * CE QU'IL NE COUVRE PAS, ET C'EST NOMME : deux fermetures deja en file devant l'enumeration.
 * C'est le meme presuppose d'appel que celui de `CLAUDE.md` — « les deux operations
 * s'enchainent, elles ne se chevauchent pas » —, et une file plus longue que cela suppose deux
 * appelants dans la meme fenetre, ce qu'aucun montage du produit ne fait.
 */
export const LIST_TIMEOUT_MS = WINDOW_CLOSE_BUDGET_MS + QUEUE_MARGIN_MS;

/**
 * DELAI DE LA FERMETURE — calcule sur ce que la FENETRE se donne, comme celui de l'ouverture.
 *
 * La route de fermeture borne son propre travail (`packages/vscode/src/tabs.ts`), et depuis la
 * correction du gate final elle le borne EN ENTIER : l'appel a `tabGroups.close` — qui n'etait
 * borne par rien, defaut G4 — puis la CONFIRMATION par re-enumeration. Leur somme est
 * `WINDOW_CLOSE_BUDGET_MS`, et c'est ce qu'une fermeture retient au pire la file d'un rang que
 * les deux routes partagent.
 *
 * Ce delai couvre donc UNE fermeture devant soi, LA SIENNE, et la marge. On ne va pas plus loin :
 * abandonner une fermeture N'EMPECHE RIEN — l'onglet peut partir apres coup —, et la relance ne
 * peut RIEN fermer depuis que la poignee est depensee des que l'editeur a ete sollicite. C'est ce
 * qui distingue cette borne de celle de l'ouverture, ou l'abandon laisse une conversation
 * orpheline.
 */
export const CLOSE_TIMEOUT_MS = 2 * WINDOW_CLOSE_BUDGET_MS + QUEUE_MARGIN_MS;

export interface ConversationsListing {
  /** L'entree du registre, MASQUEE — c'est la seule forme affichable (jeton, chemins). */
  readonly window: RedactedWindowEntry;
  readonly channel: ChannelConfirmation;
  /** VIDE N'EST PAS UNE ERREUR : c'est l'etat d'une fenetre sans conversation ouverte. */
  readonly conversations: readonly ListedConversation[];
  readonly skipped: readonly SkippedEntry[];
}

export interface ConversationClosing {
  readonly window: RedactedWindowEntry;
  readonly channel: ChannelConfirmation;
  readonly closed: ClosedConversation;
  readonly skipped: readonly SkippedEntry[];
}

export type ListConversationsOptions = WindowChannelOptions;
export type CloseConversationOptions = WindowChannelOptions;

export interface CloseConversationRequest {
  /** La poignee que `GET /conversations` a rendue, telle quelle. */
  readonly id: string;
}

/**
 * Une poignee qui n'en a pas la forme est refusee AVANT le moindre acces au systeme.
 *
 * Meme raison d'etre qu'`assertSubmittablePrompt` : la fenetre refuserait aussi — une valeur
 * inconnue de son registre de poignees sort en `CONVERSATION_HANDLE_STALE` —, mais ce refus-la
 * coute un inventaire de processus (0,7 a 1,3 s), une lecture de registre et deux allers-retours
 * pour dire ce qu'une expression rationnelle dit en 2 ms. Et il le dirait MOINS BIEN : « la
 * fenetre ne reconnait pas cette poignee » envoie relister, quand la vraie cause est que la
 * valeur passee n'est pas une poignee du tout.
 *
 * Exportee parce que la CLI s'en sert AUSSI, des l'analyse de ses arguments.
 *
 * @throws {ClaudeManagerError} `CONVERSATION_HANDLE_INVALID`
 */
export function assertConversationHandle(id: string): void {
  if (CONVERSATION_HANDLE_SHAPE.test(id)) return;

  throw new ClaudeManagerError(
    ERROR_CODES.CONVERSATION_HANDLE_INVALID,
    'The conversation id is not a handle this product could have issued',
    // LA LONGUEUR, JAMAIS LA VALEUR : elle vient de l'appelant, rien ne dit ce qu'elle porte,
    // et cette sortie part vers un agent comme vers un journal (meme discipline que
    // `SEED_SESSION_ID_INVALID`).
    { length: id.length }
  );
}

/**
 * Enumere les conversations de la fenetre hote.
 *
 * AUCUN EFFET DE BORD, et c'est verifiable de l'exterieur : la route est un `GET`, et le
 * scenario d'integration compte les onglets de part et d'autre de l'appel.
 *
 * @throws {ClaudeManagerError} `REGISTRY_UNREADABLE`, `OWNING_WINDOW_NOT_FOUND`,
 * `DUPLICATE_WINDOW_IDENTITY`, puis toutes celles du canal.
 */
export async function listConversationsInWindow(
  options: ListConversationsOptions
): Promise<ConversationsListing> {
  const { entry, channel, skipped } = await openWindowChannel(options);

  const listing = readWindowConversations(
    await send(
      options.transport,
      {
        port: entry.port,
        method: 'GET',
        path: CONVERSATIONS_PATH,
        // RELU SUR L'ENTREE, A CET INSTANT (alerte n.41).
        token: entry.token,
        body: undefined,
        timeoutMs: LIST_TIMEOUT_MS,
      },
      LIST_ROUTE
    )
  );

  // CONFRONTEE ICI AUSSI, sur une route de LECTURE, et ce n'est pas du zele : les poignees
  // rendues n'ont de sens que dans la fenetre qui les a emises. Les relayer sans verifier qui
  // a repondu ferait passer a l'appelant des identifiants d'une AUTRE fenetre, qu'il donnerait
  // ensuite a une fermeture. Un renseignement faux se paie au coup suivant.
  if (listing.extHostPid !== entry.extHostPid) {
    throw identityMismatch(LIST_ROUTE, entry, {
      extHostPid: listing.extHostPid,
      mainPid: undefined,
    });
  }

  return {
    window: redactWindowEntry(entry),
    channel,
    conversations: listing.conversations,
    skipped,
  };
}

/**
 * Demande la fermeture d'UN onglet, puis confronte l'identite de qui a agi.
 *
 * @throws {ClaudeManagerError} `WINDOW_UNREACHABLE`, `WINDOW_TOKEN_REJECTED`,
 * `WINDOW_REQUEST_REFUSED`, `WINDOW_RESPONSE_UNREADABLE`, `WINDOW_IDENTITY_MISMATCH`, ou le
 * CODE de toute erreur nommee que la FENETRE a formulee — `CONVERSATION_HANDLE_STALE`,
 * `CONVERSATION_ALREADY_CLOSED`, `CONVERSATION_CLOSE_FAILED`.
 */
async function postClose(
  entry: WindowEntry,
  id: string,
  transport: WindowTransport
): Promise<ClosedConversation> {
  const closed = readClosedConversation(
    await send(
      transport,
      {
        port: entry.port,
        method: 'POST',
        path: CONVERSATION_CLOSE_PATH,
        token: entry.token,
        // LA POIGNEE PASSE PAR LE CORPS, jamais par le chemin — voir `CLOSE_ROUTE`.
        body: JSON.stringify({ id }),
        timeoutMs: CLOSE_TIMEOUT_MS,
      },
      CLOSE_ROUTE
    )
  );

  if (closed.extHostPid !== entry.extHostPid) {
    throw identityMismatch(CLOSE_ROUTE, entry, {
      extHostPid: closed.extHostPid,
      mainPid: undefined,
    });
  }

  return closed;
}

/**
 * Ferme UNE conversation dans la fenetre qui heberge le processus appelant.
 *
 * @throws {ClaudeManagerError} `CONVERSATION_HANDLE_INVALID`, `REGISTRY_UNREADABLE`,
 * `OWNING_WINDOW_NOT_FOUND`, `DUPLICATE_WINDOW_IDENTITY`, puis toutes celles du canal et de la
 * fermeture.
 */
export async function closeConversationInWindow(
  request: CloseConversationRequest,
  options: CloseConversationOptions
): Promise<ConversationClosing> {
  // AVANT TOUT ACCES AU SYSTEME : une valeur qui n'est pas une poignee n'a jamais pu etre emise.
  assertConversationHandle(request.id);

  const { entry, channel, skipped } = await openWindowChannel(options);

  return {
    window: redactWindowEntry(entry),
    channel,
    closed: await postClose(entry, request.id, options.transport),
    skipped,
  };
}
