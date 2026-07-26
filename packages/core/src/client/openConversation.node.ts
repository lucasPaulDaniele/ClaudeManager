/**
 * LE CLIENT DU SERVEUR LOCAL — demander a MA fenetre, et a aucune autre, d'ouvrir une
 * conversation.
 *
 * Trois etapes, et L'ORDRE FAIT PARTIE DU MECANISME :
 *
 *   1. resoudre la fenetre appelante — table des processus fournie, registre relu ICI ;
 *   2. CONFIRMER LE CANAL par `GET /health`, en confrontant l'identite rendue par la fenetre
 *      a celle de l'entree lue ;
 *   3. seulement alors, `POST /conversations`.
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

import { ClaudeManagerError, ERROR_CODES, systemErrorCode } from '../errors.js';
import { requireOwningWindow } from '../identity/owningWindow.js';
import type { ProcessSnapshot } from '../identity/processTable.js';
import type { WindowEntry } from '../registry/entry.js';
import { redactWindowEntry, type RedactedWindowEntry } from '../registry/redaction.node.js';
import { readRegistry, resolveRegistryDir, type SkippedEntry } from '../registry/store.node.js';
import {
  CONVERSATIONS_PATH,
  HEALTH_PATH,
  HEALTH_ROUTE,
  OPEN_ROUTE,
  readHealth,
  readOpenedConversation,
  type OpenedConversation,
  type WindowRequest,
  type WindowResponse,
  type WindowTransport,
} from './protocol.js';

/**
 * DELAI DE LA CONFIRMATION DE CANAL — court, et c'est le point.
 *
 * Un aller-retour sur la boucle locale vers un extension host vivant se compte en
 * MILLISECONDES : `/health` ne fait que relire un etat deja en memoire. Cinq secondes sont
 * trois ordres de grandeur de marge.
 *
 * Le delai n'est pas la pour couvrir une fenetre lente — il est la pour le cas de l'alerte
 * n.41 : le port ephemere REPRIS par un autre processus local. Une ecoute morte refuse la
 * connexion tout de suite (`ECONNREFUSED`, aucun delai n'est consomme) ; un OCCUPANT SILENCIEUX,
 * lui, accepte la connexion et ne repond jamais. Seule une echeance le distingue, et elle doit
 * etre courte : rien ne doit pendre avant meme d'avoir rien demande.
 */
export const HEALTH_TIMEOUT_MS = 5_000;

/**
 * DELAI DE L'OUVERTURE — long, borne, et calcule sur ce que la FENETRE se donne a elle-meme.
 *
 * La route d'ouverture borne son propre travail (`packages/vscode/src/conversations.ts`), et le
 * calcul est REFAIT ici a chaque fois qu'une de ses echelles change — sans quoi la CLI
 * abandonnerait pendant que la fenetre travaille encore, ce qui est le pire des mensonges :
 *   - attente du processus amorce : 8 lectures de table a 0,7–1,3 s, plus 8 respirations de
 *     250 ms, soit **~12 s** au pire ;
 *   - apparition du transcript : **45 s** — mesure du 2026-07-26, elle survient a 2,5 s ;
 *   - grace accordee a la sortie du tour : **30 s** apres l'apparition — mesure, elle retombe
 *     ~9 s apres l'envoi ;
 *   - echelle d'attachement : 2 + 4 + 8 + 16 + 32 = **62 s**.
 * Pire cas de la fenetre : **~149 s**. Les deux premieres bornes ne s'additionnent pas avec la
 * suite quand elles echouent — une absence de transcript sort par une erreur nommee, sans
 * attacher quoi que ce soit.
 *
 * DEUX FOIS CE PIRE CAS, ET LE FACTEUR EST MOTIVE : les ouvertures d'une meme fenetre sont
 * SERIALISEES (`serializeOpenings`). Une demande peut donc attendre derriere une AUTRE, chacune
 * a sa borne. 300 s couvrent une file d'un rang ; elles ne couvrent pas une file sans fin, et
 * c'est voulu. Le facteur etait de trois quand le pire cas de la fenetre etait de 75 s ; le
 * produit, lui, ne doit pas depasser le `requestTimeout` par defaut de Node (300 s), au-dela
 * duquel le serveur detruirait la socket sans qu'aucun des deux delais ne soit en cause.
 *
 * POURQUOI PAS D'ATTENTE INFINIE, alors que la fenetre se borne deja : parce que ce n'est pas
 * la fenetre qu'on attend, c'est une SOCKET. Un occupant silencieux du port ne se borne pas,
 * lui. Et pourquoi pas moins : abandonner une ouverture NE L'ANNULE PAS — aucun canal ne
 * permet d'interrompre un tour en cours (decision de perimetre).
 */
export const OPEN_TIMEOUT_MS = 300_000;

/**
 * Ce que le client REMPLIT des qu'il le sait, pour que l'appelant en dispose MEME en echec.
 *
 * Meme raison d'etre que le `Diagnostics` de la CLI, et c'est pourquoi celui-ci s'y branche
 * directement : `skipped` est connu des la lecture du registre, mais la resolution peut
 * echouer juste apres — et c'est PRECISEMENT dans ce cas qu'il vaut le plus. « Aucune fenetre
 * ne te revendique, et voici les deux entrees ecartees, avec leur motif » repond a la
 * question, la ou l'erreur seule la laisse entiere.
 *
 * REQUIS, jamais optionnel : un appelant doit DIRE ou il veut ce renseignement, et un champ
 * facultatif ouvrirait une branche dont un cote ne serait jamais emprunte.
 */
export interface RegistryReport {
  skipped?: readonly SkippedEntry[];
}

/**
 * LA CONFIRMATION DE CANAL, NOMMEE.
 *
 * Elle est rendue a l'appelant plutot que gardee : une verification silencieuse est une
 * verification dont personne ne peut dire si elle a eu lieu.
 */
export interface ChannelConfirmation {
  /** La route qui a servi de preuve — sans effet de bord, c'est ce qui la rend emploiable. */
  readonly probe: typeof HEALTH_ROUTE;
  /** L'`extHostPid` que la fenetre a rendu, et qui EGALE celui de l'entree lue. */
  readonly extHostPid: number;
  readonly mainPid: number;
  /**
   * Adresse RELEVEE PAR LE SERVEUR sur sa propre socket, rendue telle quelle.
   *
   * ELLE N'EST PAS ASSERTEE ICI, et c'est un blanc raisonne : nous avons nous-memes compose
   * la demande vers `127.0.0.1`, la joignabilite locale est donc acquise par construction. Ce
   * champ ne devient une preuve que pour un lecteur exterieur — `cmgr doctor`, lot D —, a qui
   * il apprend a quoi le serveur s'est lie plutot qu'a quoi le client s'est adresse.
   */
  readonly listenAddress: string;
  readonly extensionVersion: string;
  readonly schemaVersion: number;
  readonly isTrusted: boolean;
}

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

export interface OpenConversationInWindowOptions {
  /** Le processus dont on cherche la fenetre : `process.pid` en production. */
  readonly pid: number;
  /**
   * Instantane des processus, LU UNE SEULE FOIS PAR L'APPELANT (alerte n.15).
   *
   * `readProcessTable()` coute de 700 ms a 1,3 s sur un poste reel. Le coeur ne garde
   * volontairement aucun etat : la mise en cache appartient a l'appelant, qui sait seul quand
   * son instantane a vieilli.
   */
  readonly snapshot: ProcessSnapshot;
  readonly registryDir: string | undefined;
  readonly transport: WindowTransport;
  readonly report: RegistryReport;
}

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
 * Emet une demande, ou NOMME le fait que la fenetre ne repond pas.
 *
 * Ce que le transport leve est reduit a son seul CODE systeme : le message d'une erreur de
 * socket n'est contraint par rien, et cette sortie part vers un agent, vers un journal, et
 * vers des PR d'un depot PUBLIC.
 *
 * @throws {ClaudeManagerError} `WINDOW_UNREACHABLE`
 */
async function send(
  transport: WindowTransport,
  spec: WindowRequest,
  route: string
): Promise<WindowResponse> {
  try {
    return await transport(spec);
  } catch (cause) {
    throw new ClaudeManagerError(
      ERROR_CODES.WINDOW_UNREACHABLE,
      `The owning window did not answer ${route}`,
      { route, port: spec.port, cause: systemErrorCode(cause) }
    );
  }
}

/**
 * L'ecart d'identite, NOMME — et aucune demande n'a ete emise quand il tombe sur `/health`.
 *
 * Les details sont EXCLUSIVEMENT numeriques : ils partent vers un agent et vers des journaux,
 * ils ne portent ni chemin, ni titre de fenetre, ni jeton.
 */
function identityMismatch(
  route: string,
  expected: WindowEntry,
  actual: { readonly extHostPid: number; readonly mainPid: number | undefined }
): ClaudeManagerError {
  return new ClaudeManagerError(
    ERROR_CODES.WINDOW_IDENTITY_MISMATCH,
    `The window that answered ${route} is not the one the registry entry described`,
    {
      route,
      expectedExtHostPid: expected.extHostPid,
      actualExtHostPid: actual.extHostPid,
      expectedMainPid: expected.mainPid,
      actualMainPid: actual.mainPid ?? null,
    }
  );
}

/**
 * CONFIRME LE CANAL avant tout effet de bord.
 *
 * LE PORT ET LE JETON SONT LUS SUR L'ENTREE BRUTE, jamais sur sa forme masquee (alerte n.39) :
 * `redactWindowEntry` masque des CHEMINS autant que des jetons, c'est une fonction d'AFFICHAGE.
 * Comparer deux valeurs masquees reviendrait a comparer deux `***`.
 *
 * @throws {ClaudeManagerError} `WINDOW_UNREACHABLE`, `WINDOW_TOKEN_REJECTED`,
 * `WINDOW_REQUEST_REFUSED`, `WINDOW_RESPONSE_UNREADABLE`, `WINDOW_IDENTITY_MISMATCH`
 */
async function confirmChannel(
  entry: WindowEntry,
  transport: WindowTransport
): Promise<ChannelConfirmation> {
  const health = readHealth(
    await send(
      transport,
      {
        port: entry.port,
        method: 'GET',
        path: HEALTH_PATH,
        token: entry.token,
        body: undefined,
        timeoutMs: HEALTH_TIMEOUT_MS,
      },
      HEALTH_ROUTE
    )
  );

  // L'IDENTITE, ET RIEN D'AUTRE : ni le titre, ni le chemin du workspace — deux fenetres sur
  // le meme dossier physique sont le cas de reference du produit. `mainPid` accompagne
  // l'`extHostPid` pour la meme raison que dans le registre : c'est la garde anti-reemploi de
  // pid, un pid libere puis reattribue n'a quasiment jamais le meme parent.
  if (health.extHostPid !== entry.extHostPid || health.mainPid !== entry.mainPid) {
    throw identityMismatch(HEALTH_ROUTE, entry, health);
  }

  return {
    probe: HEALTH_ROUTE,
    extHostPid: health.extHostPid,
    mainPid: health.mainPid,
    listenAddress: health.listenAddress,
    extensionVersion: health.extensionVersion,
    schemaVersion: health.schemaVersion,
    isTrusted: health.isTrusted,
  };
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
 * @throws {ClaudeManagerError} `WINDOW_UNREACHABLE`, `WINDOW_TOKEN_REJECTED`,
 * `WINDOW_REQUEST_REFUSED`, `WINDOW_RESPONSE_UNREADABLE`, `WINDOW_IDENTITY_MISMATCH`, ou
 * toute erreur nommee que la FENETRE a formulee, rendue telle quelle.
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
 * LE REGISTRE EST RELU ICI, A CHAQUE APPEL, et rien n'est retenu entre deux : le port change
 * dans trois cas — retrait puis reprise, mort de l'ecoute, echelle d'ecriture epuisee — et
 * jamais sur une republication ordinaire (mesure du 2026-07-26). Un couple port/jeton mis en
 * cache serait donc juste presque toujours, et faux exactement quand il compte.
 *
 * AUCUNE FENETRE N'EST FABRIQUEE : la liste passee a `requireOwningWindow` provient TOUJOURS
 * de `readRegistry`, ou l'identite est verifiee — validation de schema, confrontation du
 * contenu au NOM du fichier, garde anti-reemploi de pid. C'est ce qui interdit qu'une fenetre
 * decrite depuis une ligne de commande devienne pilotable.
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

  const registry = readRegistry({
    snapshot: options.snapshot,
    dir: resolveRegistryDir(options.registryDir),
  });
  // Rempli AVANT la resolution : c'est en cas d'echec qu'il vaut le plus.
  options.report.skipped = registry.skipped;

  const owner = requireOwningWindow(options.pid, options.snapshot.table, registry.windows);

  const channel = await confirmChannel(owner, options.transport);
  const conversation = await postConversation(owner, request.prompt, options.transport);

  return {
    // `redactWindowEntry` n'intervient qu'ICI, en SORTIE : tout ce qui precede a travaille sur
    // l'entree brute, parce qu'un chemin masque ne se compare pas et qu'un `***` ne s'envoie pas.
    window: redactWindowEntry(owner),
    channel,
    conversation,
    skipped: registry.skipped,
  };
}
