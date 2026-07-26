/**
 * Serveur de controle local de CETTE fenetre, et d'aucune autre.
 *
 * B3 n'expose qu'une route de diagnostic : c'est `cmgr doctor` (lot D) qui l'interrogera.
 * Ouvrir et fermer des conversations relevent du lot C — aucune commande `claude-vscode.*`
 * n'est appelee ici.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

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

export interface StartServerOptions {
  readonly token: string;
  /**
   * Relu a CHAQUE requete plutot que fige au demarrage : la confiance peut etre accordee
   * et les dossiers du workspace changer pendant la vie de la fenetre.
   */
  readonly health: () => HealthPayload;
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

const HEALTH_ROUTE = 'GET /health';

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

export function startServer(options: StartServerOptions): Promise<ServerHandle> {
  // Relevee dans le rappel d'ecoute, donc AVANT que la moindre requete puisse arriver : une
  // socket ne recoit rien tant qu'elle n'ecoute pas. La chaine vide n'est jamais servie.
  let boundAddress = '';

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
    // Le corps est draine meme s'il n'est pas lu : une requete non consommee laisserait
    // la socket en suspens.
    request.resume();

    const token = presentedToken(request);
    // L'authentification passe AVANT le routage : une reponse 404 sur une route inconnue
    // apprendrait a un appelant non authentifie quelles routes existent.
    if (token === undefined || !tokensMatch(token, options.token)) {
      // Aucun indice sur la valeur attendue, ni sur la raison exacte du refus.
      send(response, 401, { ok: false, error: 'UNAUTHORIZED' });
      return;
    }

    if (routeOf(request) !== HEALTH_ROUTE) {
      // Ni la route demandee, ni trace de pile, ni chemin de fichier : la reponse d'erreur
      // ne reflete rien de ce qu'on lui a envoye.
      send(response, 404, { ok: false, error: 'NOT_FOUND' });
      return;
    }

    const payload: HealthResponse = { ...options.health(), listenAddress: boundAddress };
    send(response, 200, payload);
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
