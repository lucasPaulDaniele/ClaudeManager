/**
 * LA COUTURE D'ENTREE/SORTIE, ET CE QUE LE SERVEUR LOCAL D'UNE FENETRE REND.
 *
 * Module PUR — aucun `node:http`, aucune plateforme : relire une reponse est une decision, pas
 * un acces au systeme, et le TYPE du transport n'en est pas un davantage. C'est ce qui permet
 * d'eprouver toute la logique du client — confirmation de canal, relecture du port et du jeton,
 * mise en forme des refus — sans supposer quoi que ce soit du transport, exactement comme
 * `readProcessTable({ run })` permet de rejouer une capture reelle sans relancer l'inventaire
 * du poste.
 *
 * CE N'EST PAS UN POINT D'EXTENSION PUBLIC, et la nuance compte : ce que les tests font
 * traverser cette couture reste ce qu'une VRAIE fenetre a reellement rendu
 * (`tests/fixtures/client/`), servi par le VRAI serveur local (`packages/vscode/src/server.ts`)
 * ou par une vraie socket. Le principe fondateur n.5 interdit de fabriquer un faux `http` ;
 * il n'interdit pas de choisir quelle vraie reponse rejouer.
 *
 * Le protocole decrit ici est celui de l'extension compagnon (arbitre a l'ADR-003) : il est LE
 * NOTRE, il n'emprunte rien a l'ecosysteme Claude, et c'est pourquoi il ne figure pas dans
 * `docs/compatibilite.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * RIEN N'EST DEVINE, ET RIEN N'EST TOLERE EN SILENCE. Une reponse dont un champ manque, ou
 * porte un type inattendu, est une reponse qu'on ne comprend pas : elle sort en erreur nommee
 * avec ce qui manquait, jamais en objet a moitie rempli. Le cas n'est pas theorique — une
 * fenetre peut porter une version de l'extension compagnon plus ancienne, ou plus recente, que
 * la CLI qui l'interroge : elles vivent dans deux processus mis a jour separement.
 *
 * DEUX CODES, SELON LA ROUTE, et cette distinction est tout sauf cosmetique :
 * `WINDOW_RESPONSE_UNREADABLE` sur `GET /health` — aucun effet de bord, relancer est sur — et
 * `WINDOW_OPEN_RESPONSE_UNREADABLE` sur `POST /conversations`, ou la validation est POSTERIEURE
 * a l'ouverture. Voir `unreadable`.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import { ClaudeManagerError, ERROR_CODES, isErrorCode } from '../errors.js';

/**
 * CE QUE LA DEMANDE NE PORTE PAS, ET C'EST DELIBERE : ni hote, ni schema, ni URL. Le seul hote
 * joignable est la boucle locale — une entree de registre ne decrit jamais qu'une fenetre de CE
 * poste. Un champ `host` ici serait une surface par laquelle un jeton porteur pourrait partir
 * ailleurs ; il n'existe pas.
 */
export interface WindowRequest {
  readonly port: number;
  readonly method: 'GET' | 'POST';
  /** Chemin absolu de la route, sans chaine de requete. */
  readonly path: string;
  /** Jeton porteur, RELU dans l'entree de registre a cet instant precis (alerte n.41). */
  readonly token: string;
  /** Corps JSON deja serialise, ou `undefined` pour une demande sans corps. */
  readonly body: string | undefined;
  readonly timeoutMs: number;
}

export interface WindowResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * Emet une demande et rend la reponse.
 *
 * LEVE plutot que de rendre un statut fabrique quand la socket n'a rien voulu savoir :
 * « connexion refusee » n'est pas une reponse HTTP, et lui en donner l'apparence obligerait
 * chaque appelant a distinguer un vrai statut d'un statut invente. Le client reduit ce qui
 * est leve a son seul code systeme (`WINDOW_UNREACHABLE`).
 */
export type WindowTransport = (request: WindowRequest) => Promise<WindowResponse>;

export const HEALTH_ROUTE = 'GET /health';
export const OPEN_ROUTE = 'POST /conversations';

export const HEALTH_PATH = '/health';
export const CONVERSATIONS_PATH = '/conversations';

/** Ce que la fenetre dit d'elle-meme. Elle ne porte JAMAIS le jeton. */
export interface WindowHealth {
  readonly schemaVersion: number;
  readonly extensionVersion: string;
  readonly extHostPid: number;
  readonly mainPid: number;
  readonly isTrusted: boolean;
  readonly workspaceFolders: readonly string[];
  /** Adresse REELLEMENT liee, relevee par le serveur sur sa propre socket. */
  readonly listenAddress: string;
}

/** Quel chemin l'ouverture a pris — voir `packages/vscode/src/conversations.ts`. */
export type OpenMode = 'seeded' | 'fallback';

/**
 * Ce que l'ouverture a etabli du tour 1 — jamais plus que ce qui a ete observe.
 *
 * `'transcript-observed'` — le transcript de la session existe : le tour a eu lieu.
 * `'not-attempted'` — repli V5, aucune session amorcee.
 * `'process-started'` — CE QUE LES VERSIONS ANTERIEURES DE L'EXTENSION RENDENT, et rien d'autre.
 *   Il est accepte EN LECTURE, et il ne faut pas le retirer sans y penser : la fenetre et cette
 *   CLI vivent dans deux processus mis a jour separement, et une fenetre encore en 0.3.0 rend
 *   cette valeur. La refuser transformerait un ecart de version en
 *   `WINDOW_OPEN_RESPONSE_UNREADABLE` sur une ouverture parfaitement reussie. Le mecanisme, lui, ne la produit plus : ce qu'elle
 *   observait — « un enfant du shell existe » — ne discriminait pas un CLI qui joue le tour d'un
 *   CLI arrete a une porte.
 */
export type FirstTurnOutcome = 'transcript-observed' | 'process-started' | 'not-attempted';

export interface OpenedConversation {
  readonly mode: OpenMode;
  /** `null` en repli : aucune session n'a ete amorcee. */
  readonly sessionId: string | null;
  /** La fenetre qui a REELLEMENT agi, telle qu'elle se nomme elle-meme. */
  readonly extHostPid: number;
  /** `true` OBLIGATOIRE en repli : le prompt n'y est que pre-rempli. Libre ailleurs. */
  readonly humanActionRequired: boolean;
  /** COHERENT avec `mode` et `firstTurnVerified` — deux equivalences, voir `requireFirstTurn`. */
  readonly firstTurn: FirstTurnOutcome;
  /**
   * LE TOUR 1 A-T-IL EU LIEU ? RENDU TEL QUE LA FENETRE LE DIT — et il peut valoir `true`.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * CE CHAMP ETAIT LE LITTERAL `false`, ET LE CLIENT REFUSAIT TOUTE AUTRE VALEUR. C'etait juste
   * tant que rien, dans la fenetre, ne pouvait verifier le tour : a travers une socket, aucun
   * type ne rompt a la compilation, et refuser etait la seule facon d'honorer un litteral.
   *
   * DEPUIS LE CORRECTIF DU 2026-07-26, LA FENETRE LE VERIFIE : elle constate l'existence de
   * `<sessionId>.jsonl` avant de rendre la main. Laisser le refus en place ferait rejeter
   * EXACTEMENT les ouvertures reussies — et la compilation resterait verte, puisque ce
   * validateur lit un `unknown` venu d'une socket. C'est le piege que ce paragraphe existe pour
   * empecher de reintroduire.
   * ─────────────────────────────────────────────────────────────────────────────────────────
   *
   * CE QUI RESTE VERIFIE, ET C'EST UN COUPLE, PAS UNE VALEUR : en repli V5, ce champ doit valoir
   * `false`. Aucune session n'y est amorcee — un `true` designerait le tour d'une session que
   * personne n'a ouverte.
   *
   * `false` en voie amorcee est LEGITIME : c'est ce qu'une fenetre portant une version
   * anterieure de l'extension rend, et le client ne doit pas casser sur un ecart de version.
   */
  readonly firstTurnVerified: boolean;
  /**
   * `viewType` de l'onglet apparu, releve tel quel — EXIGE en voie amorcee.
   *
   * En repli, il est absent aujourd'hui (le repli ne diffe pas les onglets) mais il est RELAYE
   * s'il est la : le repli ouvre un vrai panneau, un `viewType` n'y designerait rien
   * d'inexistant. Voir `requirePanelViewType` pour pourquoi il n'est pas couple au `mode`.
   */
  readonly panelViewType: string | undefined;
  /**
   * L'ERREUR QUI A CAUSE LE REPLI, RENDUE VERBATIM — jamais relue, jamais reinterpretee.
   *
   * Le repli s'AJOUTE a l'erreur nommee, il ne la remplace jamais (dette D18) : sans ce champ,
   * l'appelant croirait le mecanisme nominal intact. Sa forme appartient a la FENETRE, pas au
   * client : la relire champ a champ ferait echouer une ouverture parfaitement reussie le jour
   * ou l'extension y ajouterait quoi que ce soit. On exige donc qu'il SOIT LA en mode repli,
   * et rien de plus.
   */
  readonly degradedFrom: Readonly<Record<string, unknown>> | undefined;
}

/** Le champ `error` d'un refus : un CODE, en majuscules, et jamais une phrase. */
const REFUSAL_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * LA MEME REGLE QUE `REFUSAL_CODE`, APPLIQUEE AUX `details` — et elle y manquait.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * Le champ `error` etait filtre par un motif strict, au motif ecrit plus bas : cette valeur
 * vient d'une SOCKET, ce qui occupe le port n'est pas forcement notre serveur, et cette sortie
 * part vers un agent, vers un journal, et vers une PR d'un depot PUBLIC. La branche voisine —
 * celle qui relaie une erreur nommee — reprenait pourtant `message` ET `details` VERBATIM,
 * depuis la meme source. Un occupant du port ephemere y placait donc une consigne dans l'entree
 * de l'agent appelant, un chemin ou un jeton dans un journal public, et de fausses lignes
 * `cmgr: …` sur `stderr` par un simple saut de ligne. Rien de tout cela n'exigeait le moindre
 * privilege, et la confirmation de canal ne protege pas ce chemin : `readHealth` appelle
 * `refusalOf` AVANT que `confirmChannel` n'ait compare le moindre pid.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * CE QUI PASSE : des nombres finis, des booleens, et UN SEUL texte — le `sessionId`, sous la
 * forme d'un uuid. Cette exception n'est pas une commodite : sans elle, l'appelant recevrait
 * `SEED_TRANSCRIPT_NOT_FOUND` ou `CLAUDE_PANEL_VIEWTYPE_UNKNOWN` sans le seul identifiant par
 * lequel il peut retrouver la session DEJA amorcee, et il relancerait a l'aveugle. Un uuid ne
 * porte ni chemin, ni jeton, ni phrase — c'est exactement le critere de `REFUSAL_CODE`.
 *
 * Tout autre texte est ECARTE, y compris sous une clef qui nous est familiere : le nom du champ
 * ne prouve rien de sa valeur.
 */
const DETAIL_SESSION_ID = 'sessionId';
const DETAIL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Les CLEFS viennent aussi de la socket : ni separateur, ni espace, ni longueur de phrase. */
const DETAIL_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
/** Ce qui a ete ecarte est COMPTE, jamais tu — voir `relayedDetails`. */
const OMITTED_DETAILS = 'detailsOmitted';

/**
 * Reduit les `details` d'un refus a ce qu'un texte venu d'une socket ne peut pas empoisonner.
 *
 * LE COMPTE DES ECARTES EST RENDU, et ce n'est pas de la coquetterie : sans lui, une fenetre
 * plus recente qui ajouterait un detail textuel semblerait n'en avoir envoye AUCUN — la
 * degradation silencieuse que l'en-tete de ce module interdit.
 */
function relayedDetails(raw: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;

  const relayed: Record<string, unknown> = {};
  let omitted = 0;

  for (const [key, value] of Object.entries(raw as Readonly<Record<string, unknown>>)) {
    const keeps =
      DETAIL_KEY.test(key) &&
      // NOTRE PROPRE CLEF EST RESERVEE : elle vient d'une socket comme les autres, et un
      // `detailsOmitted` forge mentirait sur ce que ce filtre a fait — le compte qu'on rend
      // doit etre le notre, jamais celui d'en face.
      key !== OMITTED_DETAILS &&
      ((typeof value === 'number' && Number.isFinite(value)) ||
        typeof value === 'boolean' ||
        (key === DETAIL_SESSION_ID && typeof value === 'string' && DETAIL_UUID.test(value)));

    if (keeps) relayed[key] = value;
    else omitted += 1;
  }

  if (omitted > 0) relayed[OMITTED_DETAILS] = omitted;
  return Object.keys(relayed).length === 0 ? undefined : relayed;
}

/**
 * L'ILLISIBILITE, NOMMEE — ET LA ROUTE EST DANS LE CODE, PAS SEULEMENT DANS LES DETAILS.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * DEUX CODES, PARCE QUE L'APPELANT EN TIRE DEUX CONDUITES OPPOSEES. Sur `GET /health`, la
 * validation precede tout effet de bord : relancer est sur. Sur `POST /conversations`, elle lui
 * est POSTERIEURE — une fenetre plus recente qui rendrait un champ que ce client ne comprend pas
 * sort en erreur alors que la conversation est ouverte et le tour 1 joue. Un `1` y ferait
 * retenter, donc ouvrir une SECONDE conversation.
 *
 * La route etait deja dans les `details` ; elle ne servait a rien la ou l'appelant decide sans
 * lire la sortie. La remediation, elle, ne peut varier qu'avec le CODE — elle est relue dans la
 * table de `ClaudeManagerError`.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
function unreadable(route: string, missing: string): ClaudeManagerError {
  return new ClaudeManagerError(
    route === OPEN_ROUTE
      ? ERROR_CODES.WINDOW_OPEN_RESPONSE_UNREADABLE
      : ERROR_CODES.WINDOW_RESPONSE_UNREADABLE,
    `The owning window answered ${route} with a payload this client does not understand`,
    // Le NOM du champ fautif, jamais sa valeur : elle vient d'une socket, rien ne la contraint.
    { route, missing }
  );
}

function asRecord(route: string, body: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw unreadable(route, 'a JSON object');
  }
  // Un tableau est bien un objet : il ne porte aucun des champs attendus pour autant.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw unreadable(route, 'a JSON object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(route: string, raw: Readonly<Record<string, unknown>>, field: string): string {
  const value = raw[field];
  if (typeof value !== 'string' || value.length === 0) throw unreadable(route, field);
  return value;
}

function requireInteger(route: string, raw: Readonly<Record<string, unknown>>, field: string): number {
  const value = raw[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw unreadable(route, field);
  return value;
}

function requireBoolean(route: string, raw: Readonly<Record<string, unknown>>, field: string): boolean {
  const value = raw[field];
  if (typeof value !== 'boolean') throw unreadable(route, field);
  return value;
}

function requireStringArray(
  route: string,
  raw: Readonly<Record<string, unknown>>,
  field: string
): readonly string[] {
  const value = raw[field];
  if (!Array.isArray(value)) throw unreadable(route, field);
  for (const item of value as readonly unknown[]) {
    if (typeof item !== 'string') throw unreadable(route, field);
  }
  return value as readonly string[];
}

/**
 * Le refus d'une fenetre devient une erreur NOMMEE — celle du coeur quand elle en est une.
 *
 * `401` d'abord et separement : c'est le seul refus qui apprenne quelque chose d'ACTIONNABLE
 * a l'appelant — l'entree de registre ne correspond plus a ce qui occupe le port —, et le
 * confondre avec les autres ferait perdre sa remediation propre, qui est de ne PAS reessayer
 * en boucle.
 */
function refusalOf(route: string, response: WindowResponse): ClaudeManagerError {
  if (response.status === 401) {
    return new ClaudeManagerError(
      ERROR_CODES.WINDOW_TOKEN_REJECTED,
      `The owning window rejected the bearer token its registry entry advertises on ${route}`,
      { route }
    );
  }

  // Le corps d'un refus n'est pas garanti lisible : ce qui occupe le port peut n'etre pas
  // notre serveur. On le lit s'il l'est, on s'en passe sinon — sans jamais echouer ici.
  let payload: Readonly<Record<string, unknown>> | undefined;
  try {
    payload = asRecord(route, response.body);
  } catch {
    payload = undefined;
  }
  const named = payload?.['error'];

  // LE CODE D'UNE ERREUR DU COEUR TRAVERSE — LUI, ET RIEN D'AUTRE DE CE QUE LA SOCKET ECRIT.
  //
  // La remediation est celle du coeur LOCAL : `ClaudeManagerError` la relit dans sa propre
  // table, elle n'a jamais transite. Le message, lui, est REECRIT ici, et il le faut : celui
  // de la reponse est du texte libre venu d'une socket (voir `relayedDetails`). Ce qu'il
  // apportait — la nuance entre deux formulations d'un meme code — ne vaut pas une consigne
  // injectee dans l'entree d'un agent.
  if (isErrorCode(named)) {
    return new ClaudeManagerError(
      named,
      `The owning window named ${named} on ${route}`,
      relayedDetails(payload?.['details'])
    );
  }

  return new ClaudeManagerError(
    ERROR_CODES.WINDOW_REQUEST_REFUSED,
    `The owning window refused ${route}`,
    {
      route,
      status: response.status,
      // FILTRE, ET IL N'EST PAS COSMETIQUE : cette valeur vient d'une socket. Notre serveur
      // n'y met qu'un code stable, mais ce qui occupe le port n'est pas forcement notre
      // serveur — et cette sortie part vers un agent, vers un journal, et vers une PR d'un
      // depot PUBLIC. Un motif strict ne peut porter ni chemin, ni jeton, ni phrase.
      error: typeof named === 'string' && REFUSAL_CODE.test(named) ? named : null,
    }
  );
}

/** @throws {ClaudeManagerError} tout refus, ou une reponse illisible. */
export function readHealth(response: WindowResponse): WindowHealth {
  if (response.status !== 200) throw refusalOf(HEALTH_ROUTE, response);

  const raw = asRecord(HEALTH_ROUTE, response.body);
  if (raw['ok'] !== true) throw unreadable(HEALTH_ROUTE, 'ok');

  return {
    schemaVersion: requireInteger(HEALTH_ROUTE, raw, 'schemaVersion'),
    extensionVersion: requireString(HEALTH_ROUTE, raw, 'extensionVersion'),
    extHostPid: requireInteger(HEALTH_ROUTE, raw, 'extHostPid'),
    mainPid: requireInteger(HEALTH_ROUTE, raw, 'mainPid'),
    isTrusted: requireBoolean(HEALTH_ROUTE, raw, 'isTrusted'),
    workspaceFolders: requireStringArray(HEALTH_ROUTE, raw, 'workspaceFolders'),
    listenAddress: requireString(HEALTH_ROUTE, raw, 'listenAddress'),
  };
}

function requireMode(raw: Readonly<Record<string, unknown>>): OpenMode {
  const mode = raw['mode'];
  if (mode !== 'seeded' && mode !== 'fallback') throw unreadable(OPEN_ROUTE, 'mode');
  return mode;
}

/**
 * `firstTurn` : la valeur, ET SA COHERENCE AVEC LES DEUX AUTRES CHAMPS QUI EN PARLENT.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * TROIS CHAMPS DECRIVENT LE MEME FAIT — `mode`, `firstTurn`, `firstTurnVerified` —, et jusqu'a
 * la correction du gate C ils n'etaient confrontes qu'un a un. L'en-tete de ce module promet
 * pourtant que rien n'est devine et rien n'est tolere en silence.
 *
 * DEUX EQUIVALENCES SUFFISENT A TOUT DETERMINER, et chacune se lit comme une contradiction
 * quand elle est rompue :
 *
 *   - `'not-attempted'` <=> `mode === 'fallback'`. Un « aucun tour tente » sur une voie amorcee
 *     dirait qu'une session a ete ouverte sans qu'on ait rien tente d'y jouer.
 *   - `'transcript-observed'` <=> `firstTurnVerified`. « J'ai vu le transcript » avec un tour
 *     non verifie, ou l'inverse, sont la meme phrase qui se contredit.
 *
 * Il en decoule que `'process-started'` designe exactement l'etat d'une fenetre anterieure :
 * amorcee, non verifiee. Les trois captures reelles le confirment, et aucune quatrieme
 * combinaison n'existe.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
function requireFirstTurn(
  raw: Readonly<Record<string, unknown>>,
  mode: OpenMode,
  verified: boolean
): FirstTurnOutcome {
  const outcome = raw['firstTurn'];
  if (
    outcome !== 'transcript-observed' &&
    outcome !== 'process-started' &&
    outcome !== 'not-attempted'
  ) {
    throw unreadable(OPEN_ROUTE, 'firstTurn');
  }
  if ((outcome === 'not-attempted') !== (mode === 'fallback')) {
    throw unreadable(OPEN_ROUTE, 'firstTurn');
  }
  if ((outcome === 'transcript-observed') !== verified) {
    throw unreadable(OPEN_ROUTE, 'firstTurn');
  }
  return outcome;
}

/**
 * `humanActionRequired` : un booleen, et `true` OBLIGATOIRE en repli.
 *
 * LE COUPLE NE VAUT QUE DANS CE SENS, ET C'EST DELIBERE. En repli V5, la valeur est
 * DETERMINEE : le prompt est seulement pre-rempli dans le champ de saisie, jamais soumis —
 * prouve au source et par mesure (ADR-002). Un `false` y ferait attendre a un agent une reponse
 * que personne n'a demandee.
 *
 * L'INVERSE N'EST PAS EXIGE : rien ne dit qu'une voie amorcee n'aura jamais de geste humain a
 * signaler, et refuser ce cas ferait echouer une ouverture PARFAITEMENT REUSSIE le jour ou une
 * fenetre plus recente aurait quelque chose de plus a dire. C'est exactement le piege du
 * litteral `false` de `firstTurnVerified`, que ce module documente pour ne pas le reintroduire.
 */
function requireHumanActionRequired(
  raw: Readonly<Record<string, unknown>>,
  mode: OpenMode
): boolean {
  const required = requireBoolean(OPEN_ROUTE, raw, 'humanActionRequired');
  if (mode === 'fallback' && !required) throw unreadable(OPEN_ROUTE, 'humanActionRequired');
  return required;
}

/**
 * `firstTurnVerified` : un booleen, et `false` OBLIGATOIRE en repli.
 *
 * Le couple est le meme que celui de `sessionId` : le repli V5 n'amorce AUCUNE session, il
 * pre-remplit un champ de saisie. Un tour « verifie » y designerait le tour d'une session que
 * personne n'a ouverte — la fenetre ne le rend jamais, et le client refuse de le transmettre.
 */
function requireFirstTurnVerified(
  raw: Readonly<Record<string, unknown>>,
  mode: OpenMode
): boolean {
  const verified = requireBoolean(OPEN_ROUTE, raw, 'firstTurnVerified');
  if (mode === 'fallback' && verified) throw unreadable(OPEN_ROUTE, 'firstTurnVerified');
  return verified;
}

/**
 * `sessionId` : une chaine en mode amorce, `null` en repli — et JAMAIS l'inverse.
 *
 * Le couple n'est pas decoratif : un `sessionId` en mode repli designerait une session que
 * personne n'a amorcee, et un `null` en mode amorce priverait le lot D du seul identifiant
 * par lequel il pourra relire le transcript.
 */
function requireSessionId(raw: Readonly<Record<string, unknown>>, mode: OpenMode): string | null {
  const sessionId = raw['sessionId'];
  if (mode === 'fallback') {
    if (sessionId !== null) throw unreadable(OPEN_ROUTE, 'sessionId');
    return null;
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw unreadable(OPEN_ROUTE, 'sessionId');
  return sessionId;
}

/**
 * `degradedFrom` : EXIGE en repli, refuse ailleurs.
 *
 * C'est la dette D18 rendue verifiable de bout en bout : « l'erreur nommee est emise D'ABORD,
 * le repli ENSUITE ». Une fenetre qui replierait sans dire de quoi laisserait l'appelant croire
 * le mecanisme nominal intact — le client refuse plutot que de transmettre ce silence.
 */
function requireDegradedFrom(
  raw: Readonly<Record<string, unknown>>,
  mode: OpenMode
): Readonly<Record<string, unknown>> | undefined {
  const degraded = raw['degradedFrom'];
  const present = typeof degraded === 'object' && degraded !== null && !Array.isArray(degraded);

  if (mode === 'fallback') {
    if (!present) throw unreadable(OPEN_ROUTE, 'degradedFrom');
    return degraded as Readonly<Record<string, unknown>>;
  }
  if (degraded !== undefined) throw unreadable(OPEN_ROUTE, 'degradedFrom');
  return undefined;
}

/**
 * `panelViewType` : EXIGE en mode amorce, RELAYE s'il est la en repli — jamais jete en silence.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * IL ETAIT SILENCIEUSEMENT JETE EN REPLI, et c'etait le defaut : la fonction rendait `undefined`
 * sans meme regarder le champ. Une fenetre qui l'aurait envoye voyait son renseignement
 * disparaitre sans trace — exactement ce que l'en-tete de ce module interdit.
 *
 * IL N'EST PAS POUR AUTANT COUPLE AU `mode`, et le refuser en repli serait un CONTRESENS : le
 * repli V5 ouvre BEL ET BIEN un panneau — `editor.open(null, <prompt>)` —, il ne le diffe
 * simplement pas aujourd'hui. Un `panelViewType` en repli ne designerait donc rien
 * d'inexistant, a la difference d'un `sessionId` ou d'un `firstTurnVerified: true`, dont le
 * couple tient parce qu'aucune session n'y est amorcee. Exiger son absence ferait echouer une
 * ouverture parfaitement reussie le jour ou le repli releverait son onglet — c'est le motif meme
 * pour lequel `degradedFrom` n'est pas relu champ a champ.
 *
 * CE QUI EST VERIFIE, DONC : sa presence en voie amorcee — c'est la trace du relevé
 * d'attachement — et son TYPE partout ou il figure. Rien de plus, rien de moins.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
function requirePanelViewType(
  raw: Readonly<Record<string, unknown>>,
  mode: OpenMode
): string | undefined {
  if (mode !== 'fallback') return requireString(OPEN_ROUTE, raw, 'panelViewType');
  return raw['panelViewType'] === undefined
    ? undefined
    : requireString(OPEN_ROUTE, raw, 'panelViewType');
}

/** @throws {ClaudeManagerError} tout refus, ou une reponse illisible. */
export function readOpenedConversation(response: WindowResponse): OpenedConversation {
  if (response.status !== 200) throw refusalOf(OPEN_ROUTE, response);

  const raw = asRecord(OPEN_ROUTE, response.body);
  if (raw['ok'] !== true) throw unreadable(OPEN_ROUTE, 'ok');

  const mode = requireMode(raw);
  // RELU AVANT `firstTurn`, qui le CONFRONTE : les deux champs decrivent le meme fait, et une
  // reponse qui les contredit n'est pas une reponse qu'on comprend a moitie.
  const firstTurnVerified = requireFirstTurnVerified(raw, mode);
  return {
    mode,
    sessionId: requireSessionId(raw, mode),
    extHostPid: requireInteger(OPEN_ROUTE, raw, 'extHostPid'),
    humanActionRequired: requireHumanActionRequired(raw, mode),
    firstTurn: requireFirstTurn(raw, mode, firstTurnVerified),
    // RENDU TEL QUEL, et plus jamais code en dur : c'est la fenetre qui sait si elle a
    // constate le transcript de la session.
    firstTurnVerified,
    panelViewType: requirePanelViewType(raw, mode),
    degradedFrom: requireDegradedFrom(raw, mode),
  };
}
