/**
 * LE TRANSPORT REEL — `node:http`, sur la boucle locale, et rien d'autre.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * POURQUOI `node:http` ET NON `fetch`, QUE NODE 20 FOURNIT POURTANT. Trois raisons, et la
 * troisieme suffirait :
 *
 *   1. `fetch` SUIT LES REDIRECTIONS par defaut. Chaque demande porte un JETON PORTEUR ; une
 *      `302` renvoyee par ce qui occupe le port ferait repartir ce jeton ailleurs, sans qu'une
 *      seule ligne de notre code l'ait decide. `node:http` ne suit rien : il rend la reponse.
 *   2. `fetch` REDUIT TOUTE DEFAILLANCE RESEAU a `TypeError: fetch failed`, dont il faut
 *      deballer la `cause` pour retrouver un `ECONNREFUSED`. Or `systemErrorCode` — la
 *      discipline de tout ce depot — lit un `code` sur ce qui est leve. Avec `node:http`,
 *      l'erreur EST le `NodeJS.ErrnoException`, et l'appelant recoit `ECONNREFUSED`, pas
 *      `UNKNOWN`. C'est exactement le cas de l'alerte n.41, celui qu'il faut nommer.
 *   3. L'INJECTABILITE QUE LE COEUR EXIGE ne depend d'aucun des deux : la couture est
 *      `WindowTransport`, ce module n'en est qu'une implementation. Le choix se fait donc sur
 *      les seuls points 1 et 2 — et sur un quatrieme, mineur mais reel : `undici` fabrique des
 *      en-tetes que nous ne controlons pas, quand le serveur refuse TOUTE demande portant un
 *      `Origin`, quelle que soit sa valeur.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Il ne connait ni VSCode, ni le registre : on lui donne un port, un jeton et un chemin.
 */

import { request as httpRequest } from 'node:http';
import type { WindowRequest, WindowResponse, WindowTransport } from './protocol.js';

/**
 * BOUCLE LOCALE EXCLUSIVEMENT, en miroir de l'ecoute du serveur.
 *
 * Aucune entree de registre ne decrit jamais autre chose qu'une fenetre de CE poste : il n'y
 * a pas d'hote a parametrer, donc pas de champ par lequel un jeton pourrait partir ailleurs.
 */
const LOOPBACK = '127.0.0.1';

/**
 * Le `Host` que le serveur EXIGE : la boucle locale, sur SON port.
 *
 * Ce n'est pas une politesse de protocole, c'est la garde anti re-liaison DNS du serveur
 * (`packages/vscode/src/server.ts`) : un `Host` qui n'annonce pas son port exact est refuse
 * en `403 FORBIDDEN_HOST` avant meme que l'autorisation ne soit regardee.
 */
function hostHeader(port: number): string {
  return `${LOOPBACK}:${port}`;
}

export function createLoopbackTransport(): WindowTransport {
  return (spec: WindowRequest): Promise<WindowResponse> =>
    new Promise<WindowResponse>((resolve, reject) => {
      const payload = spec.body === undefined ? undefined : Buffer.from(spec.body, 'utf8');

      const outgoing = httpRequest(
        {
          host: LOOPBACK,
          port: spec.port,
          path: spec.path,
          method: spec.method,
          headers: {
            host: hostHeader(spec.port),
            authorization: `Bearer ${spec.token}`,
            // AUCUN `Origin` N'EST POSE, JAMAIS : le serveur refuse toute demande qui en
            // porte un, quelle que soit sa valeur — c'est la regle la plus simple qui soit
            // complete, et notre client est du bon cote parce qu'il n'en pose aucun.
            ...(payload === undefined
              ? {}
              : {
                  'content-type': 'application/json; charset=utf-8',
                  'content-length': payload.byteLength,
                }),
          },
          /**
           * Delai d'INACTIVITE de la socket, et non echeance absolue de la demande.
           *
           * La nuance est sans effet ici, et c'est pourquoi elle suffit : entre l'envoi et la
           * reponse, RIEN ne circule sur cette socket — le serveur ne repond qu'une fois. Une
           * inactivite de `timeoutMs` est donc, pour cette route-la, la meme chose qu'une
           * echeance. Elle ne le serait plus le jour ou une route rendrait un flux.
           */
          timeout: spec.timeoutMs,
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          // Le corps est concatene AVANT d'etre decode : un caractere multi-octets peut etre
          // coupe en deux par une frontiere de paquet, et le decoder morceau par morceau le
          // mutilerait.
          incoming.on('end', () =>
            resolve({
              // `statusCode` est declare `number | undefined` parce qu'il l'est cote SERVEUR,
              // avant `writeHead`. Cote CLIENT, Node ne remet jamais de reponse sans ligne de
              // statut : une garde ici serait un chemin qu'aucune socket ne peut produire,
              // donc une ligne qu'aucun test ne pourrait mesurer.
              status: incoming.statusCode as number,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          );
          // Une reponse interrompue en cours de corps : la promesse doit se resoudre, sans
          // quoi la demande resterait en suspens pour toujours.
          incoming.on('error', reject);
        }
      );

      outgoing.on('timeout', () => {
        // `'timeout'` ne ferme RIEN de lui-meme — c'est un signal, pas une action. On detruit
        // donc la demande, et AVEC un code systeme : `systemErrorCode` a alors `ETIMEDOUT` a
        // rendre plutot que `UNKNOWN`, et l'appelant sait que la fenetre s'est tue, pas
        // qu'elle a refuse.
        outgoing.destroy(Object.assign(new Error('the owning window did not answer in time'), {
          code: 'ETIMEDOUT',
        }));
      });
      outgoing.on('error', reject);

      if (payload === undefined) outgoing.end();
      else outgoing.end(payload);
    });
}
