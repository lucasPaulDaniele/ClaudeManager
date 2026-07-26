import { afterEach, describe, expect, it } from 'vitest';
import {
  createLoopbackTransport,
  readHealth,
  systemErrorCode,
  type WindowRequest,
} from '../../../packages/core/src/index.js';
import { deadPort, startCompanion, startRawServer, type Companion, type RawServer } from './fixtures.js';

/**
 * LE TRANSPORT REEL, CONTRE DE VRAIES SOCKETS.
 *
 * Rien n'est simule ici : le serveur d'en face est soit le VRAI serveur local de l'extension
 * compagnon, soit un `http.createServer` nu pour les deux cas que le premier ne peut pas
 * produire. Ce sont donc les gardes REELLES du serveur qui prouvent ce que le transport envoie :
 *
 *   - un `Host` qui n'annonce pas le bon port est refuse en `403 FORBIDDEN_HOST` ;
 *   - TOUTE demande portant un `Origin` est refusee en `403 FORBIDDEN_ORIGIN`.
 *
 * Obtenir `200` PROUVE donc, sans qu'on ait a inspecter nos propres en-tetes, que le `Host` est
 * exact et qu'aucun `Origin` n'a ete pose. Une assertion sur nos propres en-tetes n'aurait
 * verifie que ce qu'on croit envoyer.
 */

const transport = createLoopbackTransport();

let companion: Companion | undefined;
let raw: RawServer | undefined;

afterEach(async () => {
  await companion?.close();
  await raw?.close();
  companion = undefined;
  raw = undefined;
});

function specFor(port: number, token: string, overrides: Partial<WindowRequest> = {}): WindowRequest {
  return {
    port,
    method: 'GET',
    path: '/health',
    token,
    body: undefined,
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe('createLoopbackTransport', () => {
  it('atteint /health sur la vraie socket, donc le Host est exact et aucun Origin n est pose', async () => {
    companion = await startCompanion();

    const response = await transport(specFor(companion.port, companion.token));

    expect(response.status).toBe(200);
    // Le corps est bien celui de la fenetre : on le relit par le vrai lecteur.
    expect(readHealth(response).extHostPid).toBe(companion.entry.extHostPid);
    expect(readHealth(response).listenAddress).toBe('127.0.0.1');
  });

  it('poste un corps, et la route le recoit MOT POUR MOT', async () => {
    companion = await startCompanion();
    const prompt = 'Un prompt avec des accents : eleve, ete, ou — et un guillemet " au milieu.';

    const response = await transport(
      specFor(companion.port, companion.token, {
        method: 'POST',
        path: '/conversations',
        body: JSON.stringify({ prompt }),
      })
    );

    expect(response.status).toBe(200);
    expect(companion.received).toEqual([prompt]);
  });

  it('un jeton faux est refuse par le VRAI serveur, en 401', async () => {
    companion = await startCompanion();

    const response = await transport(specFor(companion.port, `${companion.token}-faux`));

    expect(response.status).toBe(401);
    expect(response.body).toBe('{"ok":false,"error":"UNAUTHORIZED"}');
  });

  it('un port sur lequel plus rien n ecoute leve, avec ECONNREFUSED', async () => {
    // Le cas de l'alerte n.41 : l'ecoute est morte, l'entree annonce encore son port.
    const port = await deadPort();

    await expect(transport(specFor(port, 'peu-importe'))).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });

  it('un OCCUPANT SILENCIEUX du port est borne par le delai, avec ETIMEDOUT', async () => {
    // Le cas dangereux de l'alerte n.41 : la plage ephemere est reutilisee agressivement, et
    // ce qui reprend le port peut accepter la connexion sans jamais repondre. Une connexion
    // refusee se voit tout de suite ; ce silence-la, SEUL un delai le distingue.
    raw = await startRawServer(() => undefined);

    const started = Date.now();
    const failure = await transport(specFor(raw.port, 'peu-importe', { timeoutMs: 150 })).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(systemErrorCode(failure)).toBe('ETIMEDOUT');
    // L'assertion serait vide si la demande avait echoue pour une autre raison, immediatement.
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('concatene AVANT de decoder : un caractere multi-octets coupe en deux reste intact', async () => {
    // Un prompt accentue de 20 Ko arrive necessairement en plusieurs morceaux, et une frontiere
    // de paquet peut tomber au MILIEU d'un caractere. Decoder morceau par morceau le
    // remplacerait par deux caracteres de remplacement — silencieusement.
    const payload = JSON.stringify({ ok: true, texte: 'éèêàçùôïœ'.repeat(64) });
    const bytes = Buffer.from(payload, 'utf8');
    // La coupure tombe au milieu du premier « é » (deux octets en UTF-8).
    const cut = bytes.indexOf(Buffer.from('é', 'utf8')) + 1;
    expect(cut).toBeGreaterThan(0);

    raw = await startRawServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.byteLength });
      response.write(bytes.subarray(0, cut));
      // Deux ecritures distinctes, donc deux evenements `data` : la coupure est REELLE.
      setTimeout(() => response.end(bytes.subarray(cut)), 20);
    });

    const response = await transport(specFor(raw.port, 'peu-importe'));

    expect(response.body).toBe(payload);
    expect(response.body).not.toContain('�');
  });

  it('une reponse interrompue en cours de corps leve, plutot que de rester en suspens', async () => {
    raw = await startRawServer((_request, response) => {
      // Un `content-length` que le corps ne tiendra pas, puis la socket meurt.
      response.writeHead(200, { 'content-length': 4_096 });
      response.write('{"ok"');
      setTimeout(() => response.socket?.destroy(), 20);
    });

    // Ce qui compte est qu'elle se REGLE : une promesse en suspens ferait pendre l'appelant.
    await expect(transport(specFor(raw.port, 'peu-importe', { timeoutMs: 5_000 }))).rejects.toBeDefined();
  });
});
