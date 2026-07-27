/**
 * Serveur de controle local de CETTE fenetre, et d'aucune autre.
 *
 * QUATRE ROUTES, dont DEUX A EFFET DE BORD :
 *
 *   - `GET /health` — diagnostic, ce que la fenetre dit d'elle-meme ;
 *   - `GET /conversations` — les onglets de conversation de cette fenetre. LECTURE PURE ;
 *   - `POST /conversations` — ouvrir. La premiere route a effet de bord du produit (C1) ;
 *   - `POST /conversations/close` — fermer UN onglet, l'unique appel a `tabGroups.close` du
 *     depot (C4).
 *
 * C'est le changement de nature apporte par les routes AGISSANTES qui impose les gardes de
 * transport ci-dessous — tant qu'aucune route n'agissait, le seul jeton suffisait ; il ne
 * suffit plus. Elles valent pour les QUATRE, `/health` comprise.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  CLOSE_ROUTE,
  HEALTH_ROUTE,
  isClaudeManagerError,
  LIST_ROUTE,
  OPEN_ROUTE,
  systemErrorCode,
} from './core.js';
import type { OpenConversationRequest, OpenConversationResult } from './conversations.js';
import type {
  CloseConversationRequest,
  CloseConversationResult,
  ListConversationsResult,
} from './tabs.js';

/** Ce que la FENETRE dit d'elle-meme. Elle ne porte JAMAIS le jeton (principe n.6). */
export interface HealthPayload {
  readonly ok: true;
  readonly schemaVersion: number;
  readonly extensionVersion: string;
  readonly extHostPid: number;
  readonly mainPid: number;
  readonly isTrusted: boolean;
  readonly workspaceFolders: readonly string[];
  /**
   * Repertoire de journal de l'extension DANS CETTE FENETRE.
   *
   * Le canal de journal (`{ log: true }`) est designe comme la source de diagnostic de
   * `cmgr doctor` (lot D), mais son chemin comporte deux segments qu'aucun consommateur ne
   * peut deviner — l'horodatage de la session et l'index `window<N>` — et rien ne relie cet
   * index a un `extHostPid`. Le journal etait donc introuvable de l'exterieur : capacite
   * annoncee, inatteignable avec ce qui etait livre (finding R5 du gate).
   *
   * La fenetre, elle, le connait (`context.logUri`). Elle le publie ici, sur la route
   * authentifiee — et pas dans l'entree de registre, dont le contenu est un contrat entre
   * versions qu'on n'elargit pas pour un besoin de diagnostic.
   *
   * Le fichier du canal se trouve DANS ce repertoire — mesure par le harnais d'integration
   * (`<...>/window<N>/exthost/claudemanager.claudemanager-vscode/ClaudeManager.log`), et non
   * suppose : c'est une assertion de la suite, pas un commentaire.
   */
  readonly logDirectory: string;
}

/**
 * Ce que le SERVEUR ajoute a ce que la fenetre dit — mesure, jamais redit.
 *
 * `listenAddress` est relu sur la socket reellement ouverte (`server.address()`), pas
 * recopie de la constante d'ecoute. C'est ce qui rend la liaison a la boucle locale
 * VERIFIABLE de l'exterieur : sans elle, un client ne peut que constater qu'il n'obtient pas
 * de reponse ailleurs — ce qu'un pare-feu produit tout aussi bien (finding C6 du gate).
 */
export interface HealthResponse extends HealthPayload {
  readonly listenAddress: string;
}

export interface ServerHandle {
  readonly port: number;
  /** Adresse REELLEMENT liee, relevee sur la socket. */
  readonly address: string;
  /**
   * La socket REELLE, exposee pour UNE raison, et elle est nommee : rien d'autre ne permet de
   * PRODUIRE la mort tardive d'une ecoute. Un serveur HTTP qui ecoute sur la boucle locale ne
   * se ferme pas de lui-meme a la demande — le garde-fou de non-regression de S5 la ferme donc
   * directement, sans passer par `close()`, qui est le seul chemin DELIBERE. C'est exactement
   * l'evenement que le correctif doit rattraper, et la seule facon de l'obtenir sans fabriquer
   * un faux `http` (principe fondateur n.5).
   *
   * Le code de production n'en fait rien : `publication.ts` n'emploie que `port`, `address` et
   * `close()`.
   */
  readonly socket: Server;
  close(): Promise<void>;
}

/** Ce que la route d'ouverture confie au mecanisme V1 — voir `conversations.ts`. */
export type OpenConversationRoute = (
  request: OpenConversationRequest
) => Promise<OpenConversationResult>;

/** Les deux routes de conversation de l'increment C4 — voir `tabs.ts`. */
export type ListConversationsRoute = () => Promise<ListConversationsResult>;
export type CloseConversationRoute = (
  request: CloseConversationRequest
) => Promise<CloseConversationResult>;

export interface StartServerOptions {
  readonly token: string;
  /**
   * Relu a CHAQUE requete plutot que fige au demarrage : la confiance peut etre accordee
   * et les dossiers du workspace changer pendant la vie de la fenetre.
   */
  readonly health: () => HealthPayload;
  /**
   * Le mecanisme d'ouverture, injecte : le serveur ne connait ni `vscode`, ni terminal, ni
   * commande interne. Il transporte une demande et met en forme un resultat.
   */
  readonly openConversation: OpenConversationRoute;
  /**
   * L'enumeration et la fermeture, injectees pour la MEME raison : le serveur ne connait pas
   * `tabGroups`, et n'a aucune decision a prendre sur ce qui est fermable.
   */
  readonly listConversations: ListConversationsRoute;
  readonly closeConversation: CloseConversationRoute;
  /** Defaillance survenant apres le demarrage — journalisee par l'appelant, jamais tue. */
  readonly onError: (error: unknown) => void;
  /**
   * L'ecoute s'est fermee SANS QU'ON L'AIT DEMANDE — appele AU PLUS UNE FOIS, et jamais
   * derriere `close()`.
   *
   * DEFAUT S5 : apres le demarrage, toute defaillance de la socket n'etait que journalisee.
   * L'entree du registre continuait d'annoncer `port` ET `token` — un couple dont la moitie ne
   * correspond plus a rien. Le port ephemere retourne au systeme, un processus local le
   * reobtient (la plage ephemere est reutilisee agressivement), et le client du lot C envoie
   * alors `Authorization: Bearer <jeton de la fenetre>` a l'occupant : le jeton part a un
   * tiers, sans qu'aucune erreur d'authentification ne signale quoi que ce soit.
   *
   * C'est la SYMETRIE de S6 — une entree sans serveur derriere, la ou S6 laissait un serveur
   * sans entree devant. Une fermeture est donc une TRANSITION DU CYCLE DE VIE, pas une ligne
   * de journal : l'appelant retire l'entree et republie.
   */
  readonly onClosed: () => void;
}

/**
 * BOUCLE LOCALE EXCLUSIVEMENT. Jamais `0.0.0.0`, jamais l'interface par defaut : une
 * fenetre VSCode n'a aucune raison d'etre joignable depuis le reseau, et le jeton ne
 * protege que ce qui a deja franchi la couche reseau.
 */
const LOOPBACK = '127.0.0.1';

/**
 * PORT EPHEMERE : on ecoute sur 0 et on releve le port REELLEMENT attribue. Plusieurs
 * fenetres coexistent sur un poste ; un port fixe les mettrait en concurrence, et le
 * chercher par tatonnement serait une course entre fenetres qui demarrent ensemble.
 */
const EPHEMERAL_PORT = 0;

/**
 * LES ROUTES VIENNENT DU COEUR, ET ELLES N'Y SONT DECLAREES QU'UNE FOIS.
 *
 * Ce fichier en gardait une COPIE LOCALE alors qu'il importait deja `./core.js`, qui les
 * reexporte. Deux declarations de la meme chaine, dans deux paquets, dont l'un sert ce que
 * l'autre appelle : le jour ou une route change, elle change ici et pas la — et le client
 * recevrait un `404 NOT_FOUND` sans que rien, a la compilation, ne l'ait signale. C'est la
 * classe de defaut que `store.node.ts` raconte avoir eliminee pour la convention de nommage du
 * registre, reintroduite ici.
 */

/**
 * Taille maximale du corps LU, en octets.
 *
 * Un serveur qui accumule un corps non borne se fait epuiser la memoire de l'extension host
 * par une seule requete authentifiee mal formee — et c'est l'editeur de l'utilisateur qui
 * tombe avec lui. La borne est LARGE au regard du besoin : le prompt utile plafonne bien plus
 * bas (~32 Ko, voir la garde de plafond du coeur), et c'est ELLE qui rend le refus PRECIS.
 * Celle-ci ne protege que la memoire, elle ne juge pas le prompt.
 */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Le `Host` designe-t-il la boucle locale, sur NOTRE port ?
 *
 * MOTIF : LA RE-LIAISON DNS. Un nom de domaine tiers qui resout vers `127.0.0.1` permet a une
 * page web quelconque d'atteindre ce serveur — la liaison a la boucle locale n'y peut rien,
 * la requete PART de la machine. Le jeton protege encore, mais une route a EFFET DE BORD ne
 * doit pas s'en remettre au seul jeton : la premiere ligne de defense doit refuser la requete
 * avant meme de regarder l'autorisation.
 *
 * Le port est EXIGE et confronte a celui sur lequel on ecoute reellement : un `Host` qui
 * n'annonce pas notre port ne peut pas venir d'un client qui nous a resolus par le registre.
 */
function hostDesignatesLoopback(request: IncomingMessage, port: number): boolean {
  const header = request.headers.host;
  if (typeof header !== 'string') return false;
  // Aucune forme IPv6 attendue : l'ecoute est liee a `127.0.0.1`, `[::1]` ne l'atteint pas.
  const match = /^([^:]+):(\d+)$/.exec(header.trim());
  if (match === null) return false;
  const name = (match[1] as string).toLowerCase();
  return (name === '127.0.0.1' || name === 'localhost') && Number.parseInt(match[2] as string, 10) === port;
}

/**
 * Lit un corps BORNE.
 *
 * La borne est appliquee AU FIL DE L'EAU, jamais apres coup : accumuler puis mesurer serait
 * exactement l'epuisement qu'on veut empecher. `content-length` n'est pas cru sur parole — un
 * client peut mentir, ou ne rien annoncer du tout en `chunked`.
 */
function readBoundedBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // On cesse de lire : la suite serait de la memoire consentie a un appelant fautif.
        request.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    // Une socket qui meurt en cours de lecture n'est pas un corps : la promesse doit
    // neanmoins se resoudre, sans quoi la requete resterait en suspens pour toujours.
    request.on('error', () => resolve(undefined));
  });
}

/** Le corps, s'il est un objet JSON — sinon `undefined`, et rien n'en est reflete. */
function objectFrom(body: string): Readonly<Record<string, unknown>> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  // Un tableau est bien un objet : il ne porte aucun des champs attendus pour autant.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Longueur maximale d'une poignee ACCEPTEE en entree.
 *
 * La FORME, elle, n'est pas jugee ici, et c'est deliberе : une poignee inconnue du registre de
 * la fenetre sort en `CONVERSATION_HANDLE_STALE`, avec la remediation qui va avec — redire la
 * regle de forme du coeur a cet etage n'ajouterait qu'un second endroit ou elle peut diverger.
 * Ce plafond ne juge donc rien de la valeur : il empeche seulement qu'un corps authentifie de
 * 1 Mio devienne une clef de recherche. 200 caracteres pour un uuid de 36.
 */
const MAX_HANDLE_LENGTH = 200;

/** La poignee telle que la route de fermeture l'accepte, ou `undefined`. */
function handleFrom(body: string): string | undefined {
  const id = objectFrom(body)?.['id'];
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_HANDLE_LENGTH ? id : undefined;
}

/** Le prompt tel que la route l'accepte, ou `undefined` si le corps ne le porte pas. */
function promptFrom(body: string): string | undefined {
  const prompt = objectFrom(body)?.['prompt'];
  // LE PROMPT PASSE PAR LE CORPS, JAMAIS PAR UN CHEMIN DE FICHIER fourni par l'appelant : un
  // chemin venu du reseau est une surface de traversee, un corps n'en est pas une.
  return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : undefined;
}

/**
 * Compare deux jetons sans laisser fuir leur contenu par le temps de reponse.
 *
 * `timingSafeEqual` LEVE si les longueurs different : elles sont donc comparees avant.
 * Cette comparaison-la n'est pas a temps constant, mais elle ne revele que la longueur
 * d'un identifiant aleatoire, ce qui ne reduit pas l'espace de recherche.
 */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const BEARER = /^Bearer[ \t]+(.+)$/i;

function presentedToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  return BEARER.exec(header.trim())?.[1];
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** Le chemin seul, sans la chaine de requete, et jamais reflete dans une reponse. */
function routeOf(request: IncomingMessage): string {
  const target = request.url ?? '/';
  const path = target.split('?')[0] ?? '/';
  return `${request.method ?? 'GET'} ${path}`;
}

/**
 * Sert une route qui DELEGUE, et met en forme sa defaillance — LA MEME REGLE POUR LES TROIS.
 *
 * La reponse porte le CODE STABLE de l'erreur nommee, jamais un texte libre : le consommateur
 * est un agent. Le statut HTTP n'est qu'un signal grossier de transport ; c'est `error` qui
 * fait contrat.
 *
 * FACTORISEE A L'INCREMENT C4, ET C'EST UN CORRECTIF PAR AVANCE : trois routes deleguent
 * desormais, et trois copies de ce `catch` auraient divergé le jour ou l'une aurait ete
 * corrigee. C'est exactement ce qui est arrive aux libelles de route, dont `server.ts` gardait
 * une copie locale.
 */
async function serveDelegated(
  response: ServerResponse,
  produce: () => Promise<unknown>
): Promise<void> {
  try {
    // Les resultats ne portent JAMAIS le jeton, jamais un chemin absolu : ni les mecanismes ni
    // les erreurs nommees n'en mettent dans leurs details.
    send(response, 200, await produce());
  } catch (error) {
    if (isClaudeManagerError(error)) {
      // `error` porte le CODE, comme sur toutes les autres reponses de refus de ce serveur
      // (`UNAUTHORIZED`, `NOT_FOUND`, `FORBIDDEN_*`) : un consommateur qui est un agent lit
      // UN champ, pas deux selon la nature de l'echec.
      const { code, ...rest } = error.toJSON();
      send(response, 500, { ok: false, error: code, ...rest });
      return;
    }
    // Tout le reste est reduit a son seul CODE systeme, comme partout ailleurs : un message
    // d'erreur `fs` porterait le chemin, donc le nom du compte, dans une reponse.
    send(response, 500, { ok: false, error: 'UNEXPECTED_FAILURE', cause: systemErrorCode(error) });
  }
}

/**
 * Lit un corps BORNE et en tire ce que la route attend — ou refuse, sans rien refleter.
 *
 * Rend `undefined` quand elle a DEJA repondu : le statut differe selon la cause (413 pour un
 * corps hors borne, 400 pour un corps qu'on ne comprend pas), et l'appelant n'a plus rien a
 * faire dans ce cas.
 */
async function bodyValue<V>(
  request: IncomingMessage,
  response: ServerResponse,
  extract: (body: string) => V | undefined
): Promise<V | undefined> {
  const body = await readBoundedBody(request);
  if (body === undefined) {
    send(response, 413, { ok: false, error: 'BODY_TOO_LARGE', limitBytes: MAX_BODY_BYTES });
    return undefined;
  }

  const value = extract(body);
  if (value === undefined) {
    // Rien de la requete n'est reflete : ni le corps recu, ni sa longueur.
    send(response, 400, { ok: false, error: 'BAD_REQUEST' });
    return undefined;
  }
  return value;
}

/** Sert `POST /conversations` — ouvrir. */
async function serveOpenConversation(
  request: IncomingMessage,
  response: ServerResponse,
  open: OpenConversationRoute
): Promise<void> {
  const prompt = await bodyValue(request, response, promptFrom);
  if (prompt === undefined) return;
  await serveDelegated(response, () => open({ prompt }));
}

/** Sert `POST /conversations/close` — fermer UN onglet, et un seul. */
async function serveCloseConversation(
  request: IncomingMessage,
  response: ServerResponse,
  close: CloseConversationRoute
): Promise<void> {
  const id = await bodyValue(request, response, handleFrom);
  if (id === undefined) return;
  await serveDelegated(response, () => close({ id }));
}

export function startServer(options: StartServerOptions): Promise<ServerHandle> {
  // Relevee dans le rappel d'ecoute, donc AVANT que la moindre requete puisse arriver : une
  // socket ne recoit rien tant qu'elle n'ecoute pas. La chaine vide n'est jamais servie.
  let boundAddress = '';
  /** Meme chose pour le port : il est confronte au `Host` de chaque requete. */
  let boundPort = 0;

  /**
   * Ce qui distingue une fermeture VOULUE d'une mort subie, et rien d'autre ne le distingue.
   *
   * `close()` le pose AVANT de toucher la socket : le `'close'` qui suit est alors le notre, et
   * ne doit surtout pas declencher une republication — elle rouvrirait une ecoute que plus
   * rien ne fermerait, exactement le defaut que la file de transitions evite par ailleurs.
   */
  let deliberate = false;
  /** L'appelant n'apprend la mort de son ecoute QU'UNE FOIS, quel que soit le chemin. */
  let closedSignalled = false;

  const signalClosed = (): void => {
    if (deliberate || closedSignalled) return;
    closedSignalled = true;
    options.onClosed();
  };

  const server: Server = createServer((request, response) => {
    /**
     * Draine un corps qu'on ne lira pas : une requete non consommee laisserait la socket en
     * suspens. Les chemins qui LISENT le corps ne passent pas par la.
     */
    const drain = (): void => void request.resume();

    // ---- LES DEUX GARDES DE TRANSPORT, AVANT L'AUTHENTIFICATION -------------------------
    //
    // Elles valent pour TOUT le serveur, pas pour la seule route nouvelle : une garde qui ne
    // couvrirait que la route a effet de bord laisserait `/health` — qui publie le
    // `logDirectory` et l'etat de la fenetre — joignable par une page web.
    if (!hostDesignatesLoopback(request, boundPort)) {
      drain();
      // Rien de la requete n'est reflete, pas meme le `Host` refuse.
      send(response, 403, { ok: false, error: 'FORBIDDEN_HOST' });
      return;
    }
    // TOUTE requete portant un `Origin` est refusee, QUELLE QUE SOIT SA VALEUR. Notre client
    // n'en pose JAMAIS ; un navigateur en pose TOUJOURS, y compris `Origin: null`. C'est la
    // regle la plus simple qui soit COMPLETE, et elle ne depend d'aucune liste blanche a
    // tenir a jour.
    if (request.headers.origin !== undefined) {
      drain();
      send(response, 403, { ok: false, error: 'FORBIDDEN_ORIGIN' });
      return;
    }

    const token = presentedToken(request);
    // L'authentification passe AVANT le routage : une reponse 404 sur une route inconnue
    // apprendrait a un appelant non authentifie quelles routes existent. Cet ordre est acquis.
    if (token === undefined || !tokensMatch(token, options.token)) {
      drain();
      // Aucun indice sur la valeur attendue, ni sur la raison exacte du refus.
      send(response, 401, { ok: false, error: 'UNAUTHORIZED' });
      return;
    }

    const route = routeOf(request);
    if (route === HEALTH_ROUTE) {
      drain();
      const payload: HealthResponse = { ...options.health(), listenAddress: boundAddress };
      send(response, 200, payload);
      return;
    }
    if (route === LIST_ROUTE) {
      // LECTURE PURE : aucun corps a lire, aucun effet de bord a produire.
      drain();
      void serveDelegated(response, options.listConversations);
      return;
    }
    // LES DEUX SEULS CHEMINS QUI LISENT LE CORPS : ils ne drainent pas, ils consomment.
    if (route === OPEN_ROUTE) {
      void serveOpenConversation(request, response, options.openConversation);
      return;
    }
    if (route === CLOSE_ROUTE) {
      void serveCloseConversation(request, response, options.closeConversation);
      return;
    }

    drain();
    // Ni la route demandee, ni trace de pile, ni chemin de fichier : la reponse d'erreur
    // ne reflete rien de ce qu'on lui a envoye.
    send(response, 404, { ok: false, error: 'NOT_FOUND' });
  });

  return new Promise<ServerHandle>((resolve, reject) => {
    const onStartupError = (error: unknown): void => reject(error);
    server.once('error', onStartupError);

    server.listen(EPHEMERAL_PORT, LOOPBACK, () => {
      server.removeListener('error', onStartupError);
      // Passe la main a l'appelant : une defaillance tardive se journalise, elle ne doit
      // ni rejeter une promesse deja tenue, ni remonter en exception non capturee.
      //
      // C'EST `'close'` QUI PORTE LA TRANSITION, PAS `'error'`, et ce n'est pas un choix par
      // defaut : une erreur qui EMPORTE l'ecoute la fait fermer, donc emettre `'close'` — le
      // signal est complet par ce seul bout. Une erreur qui LAISSE la socket en ecoute, elle,
      // n'a rien a reprendre : republier fermerait un serveur parfaitement vivant pour en
      // rouvrir un autre, en changeant de port au passage. Journaliser est alors la conduite
      // juste, et la seule.
      server.on('error', options.onError);

      const address = server.address();
      if (address === null || typeof address === 'string') {
        // Impossible sur une ecoute TCP, mais un port devine ne serait jamais joignable.
        // AVANT l'abonnement a `'close'` : cette fermeture-ci est la notre, et l'appelant
        // n'a pas encore de handle a reprendre.
        server.close();
        reject(new Error('The local server is listening without a resolvable TCP port'));
        return;
      }

      boundAddress = address.address;
      boundPort = address.port;
      server.on('close', signalClosed);

      resolve({
        port: address.port,
        address: address.address,
        socket: server,
        close: () =>
          new Promise<void>((done) => {
            // POSE EN PREMIER : le `'close'` qui va suivre est voulu, et ne doit rien
            // declencher chez l'appelant.
            deliberate = true;
            // Les sockets en vie n'empechent pas la fermeture : `close` cesse d'accepter,
            // `closeAllConnections` acheve l'existant. Sans lui, la desactivation
            // pourrait attendre une connexion inactive.
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
