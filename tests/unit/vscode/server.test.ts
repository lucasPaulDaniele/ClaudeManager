import { Agent, request } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeManagerError, ERROR_CODES } from '../../../packages/core/src/index.js';
import type { OpenConversationResult } from '../../../packages/vscode/src/conversations.js';
import {
  startServer,
  type HealthPayload,
  type OpenConversationRoute,
  type ServerHandle,
} from '../../../packages/vscode/src/server.js';

/**
 * Le serveur de controle local, eprouve SUR DE VRAIES SOCKETS.
 *
 * `server.ts` n'importe pas `vscode` : rien n'exigeait une instance d'editeur pour le
 * verifier, et il n'avait pourtant aucun test (finding C7 du gate). Aucun faux `http` n'est
 * construit ici — on ouvre le serveur et on lui parle par le reseau, comme le fera la CLI.
 */

const TOKEN = '00000000-0000-0000-0000-000000000000';

const HEALTH: HealthPayload = {
  ok: true,
  schemaVersion: 1,
  extensionVersion: '0.2.0',
  extHostPid: 11172,
  mainPid: 16196,
  isTrusted: true,
  workspaceFolders: ['c:\\Users\\user\\Documents\\Github\\ClaudeManager'],
  logDirectory: 'c:\\Users\\user\\AppData\\Roaming\\Code\\logs\\x\\window1\\claudemanager',
};

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers: NodeJS.Dict<string | string[]>;
}

function call(
  handle: ServerHandle,
  route: string,
  headers: Record<string, string> = {},
  method = 'GET',
  host = '127.0.0.1',
  body?: string
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    // `agent: false` : une socket neuve a chaque appel. L'agent par defaut en garderait une
    // en vie et la REUTILISERAIT apres fermeture du serveur — l'appel echouerait alors en
    // `ECONNRESET` (socket morte reemployee) et non en `ECONNREFUSED` (personne n'ecoute),
    // ce qui brouillerait exactement la distinction que ces tests etablissent.
    const req = request(
      { host, port: handle.port, path: route, method, headers, agent: false },
      (res) => {
        let received = '';
        res.on('data', (chunk) => (received += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: received, headers: res.headers })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** `POST /conversations` avec un corps JSON, la forme que le client du lot C emploiera. */
function post(handle: ServerHandle, payload: unknown, extra: Record<string, string> = {}): Promise<Reply> {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return call(
    handle,
    '/conversations',
    { ...authorized(), 'content-type': 'application/json', ...extra },
    'POST',
    '127.0.0.1',
    body
  );
}

const OPENED: OpenConversationResult = {
  ok: true,
  mode: 'seeded',
  sessionId: '11111111-2222-3333-4444-555555555555',
  extHostPid: 11172,
  humanActionRequired: false,
  // Ce que le mecanisme etablit depuis le correctif du 2026-07-26 : le transcript de la session
  // EXISTE. Le serveur, lui, ne juge rien de ce couple — il transporte le resultat tel quel, et
  // c'est precisement ce que les tests ci-dessous verifient.
  firstTurn: 'transcript-observed',
  firstTurnVerified: true,
};

function authorized(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

const errors: unknown[] = [];
/** Combien de fois l'appelant a appris que son ecoute etait morte SANS qu'il l'ait demande. */
let closures = 0;
let handles: ServerHandle[] = [];
/** Les prompts REELLEMENT parvenus au mecanisme, dans l'ordre. */
let opened: string[] = [];
/**
 * Ce que le mecanisme rend. Par defaut il LEVE : une route qui repondrait 200 sans avoir ete
 * cablee ferait passer les gardes de transport pour ce qu'elles ne sont pas.
 */
let opener: OpenConversationRoute = () => Promise.reject(new Error('not wired'));

async function open(health: () => HealthPayload = () => HEALTH): Promise<ServerHandle> {
  const handle = await startServer({
    token: TOKEN,
    health,
    openConversation: (request) => {
      opened.push(request.prompt);
      return opener(request);
    },
    onError: (error) => errors.push(error),
    onClosed: () => (closures += 1),
  });
  handles.push(handle);
  return handle;
}

/**
 * Ferme la socket SANS passer par `close()` — le seul chemin DELIBERE.
 *
 * C'est la mort tardive que S5 decrit, produite pour de vrai plutot que simulee. Le rappel de
 * `Server.close` est ajoute APRES l'ecouteur pose par `startServer` : quand il rend la main,
 * la transition a donc deja ete signalee.
 */
function killListener(handle: ServerHandle): Promise<void> {
  return new Promise((done) => handle.socket.close(() => done()));
}

afterEach(async () => {
  const live = handles;
  handles = [];
  for (const handle of live) await handle.close();
  errors.length = 0;
  closures = 0;
  opened = [];
  opener = () => Promise.reject(new Error('not wired'));
});

describe('ecoute', () => {
  it('se lie a la boucle locale, et le DIT — pas seulement en constante', () => {
    // La preuve directe que le harnais d'integration ne pouvait pas fournir : un serveur
    // lie a 0.0.0.0 mais bloque par un pare-feu produit le meme silence qu'une liaison
    // correcte (finding C6). Ici, l'adresse est relevee sur la socket elle-meme.
    return open().then((handle) => expect(handle.address).toBe('127.0.0.1'));
  });

  it('prend un port ephemere reellement attribue, jamais devine', async () => {
    const first = await open();
    const second = await open();

    expect(first.port).toBeGreaterThan(0);
    expect(second.port).toBeGreaterThan(0);
    // Plusieurs fenetres coexistent sur un poste : deux serveurs ne se disputent aucun port.
    expect(first.port).not.toBe(second.port);
  });

  it('ne repond sur AUCUNE adresse non-loopback de la machine', async () => {
    const handle = await open();
    const lan = Object.values(networkInterfaces())
      .flatMap((addresses) => addresses ?? [])
      .find((address) => address.family === 'IPv4' && !address.internal);
    if (lan === undefined) return;

    // Seul un REFUS prouve l'absence d'ecoute : un delai depasse serait indetermine.
    await expect(call(handle, '/health', authorized(), 'GET', lan.address)).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });

  it('rend le port et l adresse coherents avec ce que /health annonce', async () => {
    const handle = await open();

    const reply = await call(handle, '/health', authorized());

    expect(JSON.parse(reply.body)['listenAddress']).toBe(handle.address);
  });
});

describe('S10 — Host et Origin sont juges AVANT l authentification', () => {
  it('refuse un Host qui ne designe pas la boucle locale, sans rien en refleter', async () => {
    const handle = await open();

    // RE-LIAISON DNS : un nom tiers qui resout vers 127.0.0.1 atteint la socket. Le jeton est
    // VALIDE ici — c'est le point : la garde tombe avant qu'il ne soit regarde.
    const reply = await call(handle, '/health', { ...authorized(), host: `evil.example:${handle.port}` });

    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body)).toEqual({ ok: false, error: 'FORBIDDEN_HOST' });
    expect(reply.body).not.toContain('evil.example');
  });

  it('accepte 127.0.0.1 comme localhost, quelle que soit la casse', async () => {
    const handle = await open();

    for (const name of ['127.0.0.1', 'localhost', 'LOCALHOST', 'LocalHost']) {
      expect((await call(handle, '/health', { ...authorized(), host: `${name}:${handle.port}` })).status).toBe(200);
    }
  });

  it('exige NOTRE port : un Host loopback sur un autre port est refuse', async () => {
    const handle = await open();

    const wrongPort = handle.port === 1 ? 2 : handle.port - 1;
    expect((await call(handle, '/health', { ...authorized(), host: `127.0.0.1:${wrongPort}` })).status).toBe(403);
    // Sans port du tout : un client qui nous a resolus par le registre en annonce toujours un.
    expect((await call(handle, '/health', { ...authorized(), host: '127.0.0.1' })).status).toBe(403);
  });

  it('refuse une requete SANS Host — que seule une socket brute peut produire', async () => {
    const handle = await open();

    // `http.request` de Node pose toujours un `Host`, et son ANALYSEUR refuse lui-meme une
    // requete HTTP/1.1 qui n'en porte pas — mesure : `400 Bad Request`, avant notre code.
    // HTTP/1.0, lui, ne l'exige pas : la requete arrive jusqu'a nous, sans `Host`. C'est le
    // seul chemin qui atteint cette garde, et il existe pour de vrai.
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(handle.port, '127.0.0.1', () => {
        socket.write(`GET /health HTTP/1.0\r\nauthorization: Bearer ${TOKEN}\r\n\r\n`);
      });
      let received = '';
      socket.on('data', (chunk: Buffer) => (received += chunk.toString('utf8')));
      socket.on('end', () => resolve(received));
      socket.on('error', reject);
    });

    expect(reply).toContain('403');
    expect(reply).toContain('FORBIDDEN_HOST');
  });

  it('refuse TOUTE requete portant un Origin, quelle que soit sa valeur', async () => {
    const handle = await open();

    // Notre client n'en pose JAMAIS ; un navigateur en pose TOUJOURS, `null` compris.
    for (const origin of ['https://claude.ai', 'null', 'http://127.0.0.1', '']) {
      const reply = await call(handle, '/health', { ...authorized(), origin });
      expect(reply.status).toBe(403);
      expect(JSON.parse(reply.body)).toEqual({ ok: false, error: 'FORBIDDEN_ORIGIN' });
    }
  });

  it('juge Host et Origin AVANT le jeton : un refus de transport ne dit rien de l authentification', async () => {
    const handle = await open();

    // Sans jeton du tout : si l'ordre etait inverse, la reponse serait 401.
    expect((await call(handle, '/health', { host: 'evil.example:1' })).status).toBe(403);
    expect((await call(handle, '/health', { origin: 'https://claude.ai' })).status).toBe(403);
  });

  it('protege /health autant que la route a effet de bord', async () => {
    const handle = await open();

    // La garde ne vaut pas pour la seule route nouvelle : /health publie l'etat de la
    // fenetre et son repertoire de journal.
    expect((await call(handle, '/health', { ...authorized(), origin: 'https://claude.ai' })).status).toBe(403);
    expect((await post(handle, { prompt: 'x' }, { origin: 'https://claude.ai' })).status).toBe(403);
  });
});

describe('POST /conversations', () => {
  it('transmet le prompt du CORPS au mecanisme, et rend son resultat', async () => {
    const handle = await open();
    opener = () => Promise.resolve(OPENED);

    const reply = await post(handle, { prompt: 'Reponds exactement OK' });

    expect(reply.status).toBe(200);
    expect(opened).toEqual(['Reponds exactement OK']);
    expect(JSON.parse(reply.body)).toEqual(OPENED);
  });

  it('rend le mode et la session, jamais le jeton ni un chemin absolu', async () => {
    const handle = await open();
    opener = () => Promise.resolve(OPENED);

    const reply = await post(handle, { prompt: 'x' });

    const payload = JSON.parse(reply.body) as Record<string, unknown>;
    expect(payload['mode']).toBe('seeded');
    expect(payload['sessionId']).toBe(OPENED.sessionId);
    expect(payload['extHostPid']).toBe(11172);
    expect(reply.body).not.toContain(TOKEN);
  });

  it('refuse un corps qui ne porte pas de prompt exploitable', async () => {
    const handle = await open();
    opener = () => Promise.resolve(OPENED);

    for (const payload of ['{', 'null', '[]', '"texte"', {}, { prompt: 42 }, { prompt: '' }, { prompt: '   ' }]) {
      const reply = await post(handle, payload);
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body)).toEqual({ ok: false, error: 'BAD_REQUEST' });
    }
    // Le mecanisme n'a JAMAIS ete sollicite : un refus de forme ne cree aucun terminal.
    expect(opened).toEqual([]);
  });

  it('refuse un chemin de fichier a la place du prompt — la surface de traversee n existe pas', async () => {
    const handle = await open();

    const reply = await post(handle, { promptFile: 'c:\\Windows\\System32\\drivers\\etc\\hosts' });

    expect(reply.status).toBe(400);
    expect(opened).toEqual([]);
  });

  it('BORNE le corps lu, et le dit', async () => {
    const handle = await open();

    // Au-dela de la borne, la lecture CESSE : accumuler puis mesurer serait l'epuisement
    // memoire qu'on veut empecher.
    const reply = await post(handle, { prompt: 'A'.repeat(2 * 1024 * 1024) }).catch(
      (error: NodeJS.ErrnoException) => ({ status: `ERR(${error.code})`, body: '', headers: {} })
    );

    // Selon l'instant ou la socket est detruite, le client voit le 413 ou la coupure : les
    // deux prouvent que le corps n'a pas ete accumule. Ce qui compte est qu'aucune ouverture
    // n'ait ete tentee.
    expect([413, 'ERR(ECONNRESET)', 'ERR(EPIPE)']).toContain(reply.status);
    expect(opened).toEqual([]);
  });

  it('accepte un corps volumineux mais SOUS la borne', async () => {
    const handle = await open();
    opener = () => Promise.resolve(OPENED);

    const prompt = 'A'.repeat(200_000);
    const reply = await post(handle, { prompt });

    expect(reply.status).toBe(200);
    expect(opened[0]?.length).toBe(200_000);
  });

  it('rend l erreur NOMMEE telle quelle, code stable compris', async () => {
    const handle = await open();
    opener = () =>
      Promise.reject(
        new ClaudeManagerError(ERROR_CODES.CLAUDE_EXTENSION_MISSING, 'nope', { extensionId: 'x' })
      );

    const reply = await post(handle, { prompt: 'x' });

    expect(reply.status).toBe(500);
    expect(JSON.parse(reply.body)).toMatchObject({
      ok: false,
      error: ERROR_CODES.CLAUDE_EXTENSION_MISSING,
      remediation: expect.stringContaining('anthropic.claude-code') as unknown,
      details: { extensionId: 'x' },
    });
  });

  it('reduit une defaillance imprevue a son seul CODE systeme', async () => {
    const handle = await open();
    // Un message d'erreur `fs` porterait le chemin absolu, donc le nom du compte, dans une
    // reponse HTTP.
    opener = () => Promise.reject(Object.assign(new Error("EPERM: rename 'c:\\Users\\qui'"), { code: 'EPERM' }));

    const reply = await post(handle, { prompt: 'x' });

    expect(reply.status).toBe(500);
    expect(JSON.parse(reply.body)).toEqual({ ok: false, error: 'UNEXPECTED_FAILURE', cause: 'EPERM' });
    expect(reply.body).not.toContain('Users');
  });

  it('refuse /conversations sans jeton, sans jamais atteindre le mecanisme', async () => {
    const handle = await open();

    const reply = await call(handle, '/conversations', {}, 'POST', '127.0.0.1', '{"prompt":"x"}');

    expect(reply.status).toBe(401);
    expect(opened).toEqual([]);
  });

  it('n existe que sur POST : GET /conversations reste une route inconnue', async () => {
    const handle = await open();

    expect((await call(handle, '/conversations', authorized())).status).toBe(404);
    expect(opened).toEqual([]);
  });
});

describe('authentification', () => {
  it('repond 200 au porteur du bon jeton', async () => {
    const handle = await open();

    const reply = await call(handle, '/health', authorized());

    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ ok: true, extHostPid: 11172 });
  });

  it('repond 401 sans en-tete d autorisation', async () => {
    const handle = await open();

    const reply = await call(handle, '/health');

    expect(reply.status).toBe(401);
    expect(JSON.parse(reply.body)).toEqual({ ok: false, error: 'UNAUTHORIZED' });
  });

  it('repond 401 a un jeton de MEME longueur, la branche que la comparaison doit trancher', async () => {
    const handle = await open();
    const wrong = TOKEN.replace(/./, (c) => (c === '0' ? '1' : '0'));
    expect(wrong.length).toBe(TOKEN.length);

    expect((await call(handle, '/health', { authorization: `Bearer ${wrong}` })).status).toBe(401);
  });

  it('repond 401 a un jeton de longueur differente, sans lever', async () => {
    const handle = await open();

    // `timingSafeEqual` LEVE si les longueurs different : le chemin doit etre garde.
    expect((await call(handle, '/health', { authorization: 'Bearer x' })).status).toBe(401);
    expect((await call(handle, '/health', { authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
  });

  it('accepte le schema Bearer quelle que soit sa casse et son espacement', async () => {
    const handle = await open();

    expect((await call(handle, '/health', { authorization: `bearer ${TOKEN}` })).status).toBe(200);
    expect((await call(handle, '/health', { authorization: `BEARER \t ${TOKEN}` })).status).toBe(200);
    expect((await call(handle, '/health', { authorization: `  Bearer ${TOKEN}  ` })).status).toBe(200);
  });

  it('refuse un en-tete qui n est pas du Bearer', async () => {
    const handle = await open();

    expect((await call(handle, '/health', { authorization: TOKEN })).status).toBe(401);
    expect((await call(handle, '/health', { authorization: `Basic ${TOKEN}` })).status).toBe(401);
  });

  it('authentifie AVANT de router : une route inconnue ne se revele pas a un inconnu', async () => {
    const handle = await open();

    const reply = await call(handle, '/inconnue');

    expect(reply.status).toBe(401);
    expect(reply.body).not.toContain('NOT_FOUND');
  });
});

describe('routage', () => {
  it('repond 404 a une route inconnue presentee avec le bon jeton', async () => {
    const handle = await open();

    const reply = await call(handle, '/inconnue', authorized());

    expect(reply.status).toBe(404);
    expect(JSON.parse(reply.body)).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('ne reflete NI la route demandee NI la methode dans sa reponse', async () => {
    const handle = await open();

    const reply = await call(handle, '/chemin-tres-reconnaissable', authorized());

    expect(reply.body).not.toContain('chemin-tres-reconnaissable');
  });

  it('ignore la chaine de requete pour identifier la route', async () => {
    const handle = await open();

    expect((await call(handle, '/health?verbose=1', authorized())).status).toBe(200);
  });

  it('refuse /health sur une autre methode que GET', async () => {
    const handle = await open();

    expect((await call(handle, '/health', authorized(), 'POST')).status).toBe(404);
    expect((await call(handle, '/health', authorized(), 'DELETE')).status).toBe(404);
  });
});

describe('reponse', () => {
  it('relit l etat de la fenetre A CHAQUE requete, jamais fige au demarrage', async () => {
    let trusted = false;
    const handle = await open(() => ({ ...HEALTH, isTrusted: trusted }));

    expect(JSON.parse((await call(handle, '/health', authorized())).body)['isTrusted']).toBe(false);
    trusted = true;
    expect(JSON.parse((await call(handle, '/health', authorized())).body)['isTrusted']).toBe(true);
  });

  it('publie le repertoire de journal, sans quoi cmgr doctor ne peut pas le trouver', async () => {
    const handle = await open();

    expect(JSON.parse((await call(handle, '/health', authorized())).body)['logDirectory']).toBe(
      HEALTH.logDirectory
    );
  });

  it('ne porte JAMAIS le jeton, sur aucune des quatre reponses', async () => {
    const handle = await open();

    const replies = [
      await call(handle, '/health', authorized()),
      await call(handle, '/health'),
      await call(handle, '/health', { authorization: 'Bearer faux' }),
      await call(handle, '/inconnue', authorized()),
    ];

    for (const reply of replies) {
      expect(reply.body).not.toContain(TOKEN);
      expect(JSON.stringify(reply.headers)).not.toContain(TOKEN);
    }
  });

  it('interdit toute mise en cache d une reponse qui decrit un etat vivant', async () => {
    const handle = await open();

    const reply = await call(handle, '/health', authorized());

    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
  });
});

describe('fermeture', () => {
  it('cesse d etre joignable', async () => {
    const handle = await open();
    handles = handles.filter((h) => h !== handle);

    await handle.close();

    await expect(call(handle, '/health', authorized())).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });

  it('n attend pas une connexion inactive pour se fermer', async () => {
    const handle = await open();
    handles = handles.filter((h) => h !== handle);
    // Une connexion gardee ouverte : sans `closeAllConnections`, la fermeture l'attendrait.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const keptAlive = request({
      host: '127.0.0.1',
      port: handle.port,
      path: '/health',
      headers: authorized(),
      agent,
    });
    await new Promise<void>((done) => {
      keptAlive.on('response', (res) => {
        res.resume();
        res.on('end', () => done());
      });
      keptAlive.end();
    });

    await handle.close();
    agent.destroy();

    await expect(call(handle, '/health', authorized())).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });

  it('ne remonte aucune defaillance tardive en exception non capturee', async () => {
    await open();

    expect(errors).toEqual([]);
  });

  it('ne signale RIEN a l appelant quand c est LUI qui a ferme', async () => {
    const handle = await open();
    handles = handles.filter((h) => h !== handle);

    await handle.close();

    // Une fermeture voulue qui declencherait une republication rouvrirait une ecoute que plus
    // rien ne fermerait : c'est exactement ce que la desactivation doit eviter.
    expect(closures).toBe(0);
  });
});

describe('S5 — une mort TARDIVE de l ecoute est une transition, pas une ligne de journal', () => {
  it('previent l appelant quand la socket meurt sans qu il l ait demande', async () => {
    // LE GARDE-FOU DE NON-REGRESSION DE S5. Avant le correctif, aucun ecouteur de `'close'`
    // n'existait : l'entree du registre continuait d'annoncer `port` ET `token`, un couple
    // dont la moitie ne correspond plus a rien. Le port ephemere revient au systeme, un
    // processus local le reobtient, et le client du lot C presente le jeton de la fenetre a
    // l'occupant — sans qu'aucune erreur d'authentification ne le signale.
    const handle = await open();
    handles = handles.filter((h) => h !== handle);

    await killListener(handle);

    expect(closures).toBe(1);
    // Et l'ecoute est bien morte : ce n'est pas une alerte sur un serveur vivant.
    await expect(call(handle, '/health', authorized())).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });

  it('ne le previent QU UNE FOIS, quel que soit le chemin emprunte ensuite', async () => {
    const handle = await open();
    handles = handles.filter((h) => h !== handle);

    await killListener(handle);
    // Le retrait qui suit appelle `close()` sur une socket deja morte : il ne doit pas
    // relancer une seconde reprise derriere la premiere.
    await handle.close();
    await killListener(handle);

    expect(closures).toBe(1);
  });
});
