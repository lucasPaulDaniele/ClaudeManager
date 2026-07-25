/**
 * Serveur de controle local de CETTE fenetre, et d'aucune autre.
 *
 * B3 n'expose qu'une route de diagnostic : c'est `cmgr doctor` (lot D) qui l'interrogera.
 * Ouvrir et fermer des conversations relevent du lot C — aucune commande `claude-vscode.*`
 * n'est appelee ici.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

/** Reponse de `GET /health`. Elle ne porte JAMAIS le jeton (principe n.6). */
export interface HealthPayload {
  readonly ok: true;
  readonly schemaVersion: number;
  readonly extensionVersion: string;
  readonly extHostPid: number;
  readonly mainPid: number;
  readonly isTrusted: boolean;
  readonly workspaceFolders: readonly string[];
}

export interface ServerHandle {
  readonly port: number;
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

    send(response, 200, options.health());
  });

  return new Promise<ServerHandle>((resolve, reject) => {
    const onStartupError = (error: unknown): void => reject(error);
    server.once('error', onStartupError);

    server.listen(EPHEMERAL_PORT, LOOPBACK, () => {
      server.removeListener('error', onStartupError);
      // Passe la main a l'appelant : une defaillance tardive se journalise, elle ne doit
      // ni rejeter une promesse deja tenue, ni remonter en exception non capturee.
      server.on('error', options.onError);

      const address = server.address();
      if (address === null || typeof address === 'string') {
        // Impossible sur une ecoute TCP, mais un port devine ne serait jamais joignable.
        server.close();
        reject(new Error('The local server is listening without a resolvable TCP port'));
        return;
      }

      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
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
