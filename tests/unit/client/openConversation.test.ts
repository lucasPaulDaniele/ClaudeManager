import { afterEach, describe, expect, it } from 'vitest';
import {
  ClaudeManagerError,
  createLoopbackTransport,
  HEALTH_TIMEOUT_MS,
  isClaudeManagerError,
  OPEN_TIMEOUT_MS,
  openConversationInWindow,
  type RegistryReport,
  type WindowRequest,
  type WindowTransport,
} from '../../../packages/core/src/index.js';
import {
  CALLER_PID,
  CAPTURED,
  copyLegacyEntriesInto,
  deadPort,
  fallbackResultFor,
  healthPayloadFor,
  makeRegistryDir,
  publishEntry,
  seededResultFor,
  snapshot,
  startCompanion,
  type Companion,
} from './fixtures.js';

/**
 * LE CLIENT, DE BOUT EN BOUT, CONTRE UN VRAI SERVEUR SUR UNE VRAIE SOCKET.
 *
 * Ce qui est eprouve ici n'est pas la lecture des reponses — `protocol.test.ts` s'en charge —
 * mais LA SEQUENCE et LES REFUS : la confirmation de canal a-t-elle lieu AVANT tout effet de
 * bord, le port et le jeton sont-ils relus a chaque appel, et que se passe-t-il quand
 * l'identite ne concorde pas.
 */

const transport = createLoopbackTransport();

const running: Companion[] = [];

afterEach(async () => {
  for (const companion of running.splice(0)) await companion.close();
});

async function companionIn(
  options: Parameters<typeof startCompanion>[0] = {}
): Promise<Companion> {
  const companion = await startCompanion(options);
  running.push(companion);
  return companion;
}

function open(
  registryDir: string,
  prompt: string,
  report: RegistryReport = {},
  wire: WindowTransport = transport
): ReturnType<typeof openConversationInWindow> {
  return openConversationInWindow(
    { prompt },
    { pid: CALLER_PID, snapshot: snapshot(), registryDir, transport: wire, report }
  );
}

async function caught(promise: Promise<unknown>): Promise<ClaudeManagerError> {
  try {
    await promise;
  } catch (error) {
    expect(isClaudeManagerError(error), `erreur nue : ${String(error)}`).toBe(true);
    return error as ClaudeManagerError;
  }
  throw new Error('aucune erreur levee, alors que le test en attendait une');
}

describe('ouverture nominale', () => {
  it('confirme le canal, ouvre, et rend tout ce que l appelant doit savoir', async () => {
    const companion = await companionIn();
    const report: RegistryReport = {};

    const opening = await open(companion.registryDir, 'Reponds OK.', report);

    // La confirmation est NOMMEE : une verification silencieuse est une verification dont
    // personne ne peut dire si elle a eu lieu.
    expect(opening.channel).toEqual({
      probe: 'GET /health',
      extHostPid: companion.entry.extHostPid,
      mainPid: companion.entry.mainPid,
      // RELEVEE PAR LE SERVEUR sur sa propre socket, pas recopiee d'une constante.
      listenAddress: '127.0.0.1',
      extensionVersion: '0.2.0',
      schemaVersion: 1,
      isTrusted: true,
    });

    expect(opening.conversation.mode).toBe('seeded');
    expect(opening.conversation.sessionId).toBe(CAPTURED.openSeeded.result['sessionId']);
    expect(opening.conversation.extHostPid).toBe(companion.entry.extHostPid);
    // RENDU TEL QUE LA FENETRE LE DIT, et plus jamais code en dur cote client : la capture
    // vient d'une fenetre qui a CONSTATE le transcript de la session.
    expect(opening.conversation.firstTurn).toBe('transcript-observed');
    expect(opening.conversation.firstTurnVerified).toBe(true);
    // Le prompt est bien arrive, mot pour mot.
    expect(companion.received).toEqual(['Reponds OK.']);
    expect(report.skipped).toEqual([]);
  });

  it('MASQUE le jeton en sortie, alors que le VRAI jeton a servi a la demande', async () => {
    const companion = await companionIn();

    const opening = await open(companion.registryDir, 'Reponds OK.');

    // La preuve que le vrai jeton a servi : le serveur authentifie AVANT de router, une
    // demande mal jetonnee n'aurait jamais atteint la route.
    expect(companion.received).toHaveLength(1);
    expect(opening.window.token).toBe('***');
    expect(JSON.stringify(opening)).not.toContain(companion.token);
    // L'assertion serait vide si le jeton etait vide : on le verifie.
    expect(companion.token.length).toBeGreaterThan(8);
  });

  it('rend degradedFrom VERBATIM quand la fenetre a repli', async () => {
    const companion = await companionIn({
      open: (entry) => Promise.resolve(fallbackResultFor(entry)),
    });

    const opening = await open(companion.registryDir, 'Reponds OK.');

    expect(opening.conversation.mode).toBe('fallback');
    expect(opening.conversation.sessionId).toBeNull();
    expect(opening.conversation.humanActionRequired).toBe(true);
    expect(opening.conversation.degradedFrom).toEqual(
      CAPTURED.openFallback.result['degradedFrom']
    );
  });
});

describe('confirmation de canal — alerte n.43', () => {
  it('IDENTITE DISCORDANTE : erreur nommee, et AUCUNE demande n est emise', async () => {
    // La substitution d'entree est reparee A POSTERIORI, jamais empechee : entre la lecture de
    // l'entree et l'action, le couple port/jeton peut designer une autre fenetre. La route
    // ayant un EFFET DE BORD, c'est le seul moment ou l'on peut encore ne rien faire.
    const companion = await companionIn({
      health: (entry) => ({ ...healthPayloadFor(entry), extHostPid: entry.extHostPid + 1 }),
    });

    const error = await caught(open(companion.registryDir, 'Reponds OK.'));

    expect(error.code).toBe('WINDOW_IDENTITY_MISMATCH');
    expect(error.details).toEqual({
      route: 'GET /health',
      expectedExtHostPid: companion.entry.extHostPid,
      actualExtHostPid: companion.entry.extHostPid + 1,
      expectedMainPid: companion.entry.mainPid,
      actualMainPid: companion.entry.mainPid,
    });
    // LE POINT DU TEST : rien n'a ete demande. Une conversation n'a pas ete ouverte ailleurs.
    expect(companion.received).toEqual([]);
  });

  it('le mainPid seul suffit a faire echouer la confrontation', async () => {
    // Garde anti-reemploi de pid : un pid libere puis reattribue n'a quasiment jamais le meme
    // parent. Ne confronter que l'extHostPid laisserait passer ce cas.
    const companion = await companionIn({
      health: (entry) => ({ ...healthPayloadFor(entry), mainPid: entry.mainPid + 1 }),
    });

    const error = await caught(open(companion.registryDir, 'Reponds OK.'));

    expect(error.code).toBe('WINDOW_IDENTITY_MISMATCH');
    expect(companion.received).toEqual([]);
  });

  it('CONFRONTE AUSSI qui a agi : une fenetre qui repond pour une autre est refusee', async () => {
    // Elle CONSTATE, elle n'empeche pas — et la remediation le dit. Rendre `ok` sur une fenetre
    // qui n'est pas la sienne violerait l'invariant du produit.
    const companion = await companionIn({
      open: (entry) => Promise.resolve({ ...seededResultFor(entry), extHostPid: entry.extHostPid + 7 }),
    });

    const error = await caught(open(companion.registryDir, 'Reponds OK.'));

    expect(error.code).toBe('WINDOW_IDENTITY_MISMATCH');
    expect(error.details).toMatchObject({
      route: 'POST /conversations',
      expectedExtHostPid: companion.entry.extHostPid,
      actualExtHostPid: companion.entry.extHostPid + 7,
      actualMainPid: null,
    });
    // La demande, elle, a bien eu lieu : c'est ce que ce cas a de desagreable, et il est dit.
    expect(companion.received).toEqual(['Reponds OK.']);
  });
});

describe('le port et le jeton sont RELUS a chaque usage — alerte n.41', () => {
  it('deux appels successifs suivent l entree, pas un souvenir', async () => {
    const registryDir = makeRegistryDir();
    const first = await companionIn({ registryDir });
    await open(registryDir, 'premier appel');
    expect(first.received).toEqual(['premier appel']);

    // La fenetre a ete rechargee : nouvelle ecoute, nouveau port, nouveau jeton, MEME identite.
    // C'est exactement le cas « retrait puis reprise » de l'alerte n.41.
    const second = await companionIn({ registryDir });
    expect(second.port).not.toBe(first.port);
    expect(second.token).not.toBe(first.token);

    await open(registryDir, 'second appel');

    expect(second.received).toEqual(['second appel']);
    // Un couple mis en cache aurait envoye le second prompt a la premiere ecoute.
    expect(first.received).toEqual(['premier appel']);
  });

  it('un jeton perime dans l entree sort en WINDOW_TOKEN_REJECTED, pas en succes', async () => {
    const companion = await companionIn();
    // L'entree annonce un jeton qui n'est plus celui du serveur : c'est ce qui arrive quand un
    // autre processus local a repris le port ephemere.
    publishEntry(companion.registryDir, companion.port, 'jeton-perime');

    const error = await caught(open(companion.registryDir, 'Reponds OK.'));

    expect(error.code).toBe('WINDOW_TOKEN_REJECTED');
    expect(error.details).toEqual({ route: 'GET /health' });
    expect(companion.received).toEqual([]);
  });

  it('un port devenu mort sort en WINDOW_UNREACHABLE, avec son code systeme', async () => {
    const registryDir = makeRegistryDir();
    const port = await deadPort();
    publishEntry(registryDir, port, 'peu-importe');

    const error = await caught(open(registryDir, 'Reponds OK.'));

    expect(error.code).toBe('WINDOW_UNREACHABLE');
    expect(error.details).toEqual({ route: 'GET /health', port, cause: 'ECONNREFUSED' });
    // Aucun chemin, aucun jeton : ce champ part vers un agent et vers une PR d un depot public.
    expect(JSON.stringify(error.toJSON())).not.toContain('peu-importe');
  });
});

describe('refus en amont de tout reseau', () => {
  it('un prompt vide est refuse AVANT meme la lecture du registre', async () => {
    const companion = await companionIn();
    const report: RegistryReport = {};

    const error = await caught(open(companion.registryDir, '   \n\t  ', report));

    expect(error.code).toBe('PROMPT_EMPTY');
    // La LONGUEUR, jamais le contenu : un prompt de blancs reste un prompt de l'appelant.
    expect(error.details).toEqual({ length: 7 });
    // La preuve que rien n'a ete lu : le rapport n'a jamais ete rempli.
    expect(report.skipped).toBeUndefined();
    expect(companion.received).toEqual([]);
  });

  it("aucune fenetre hote : erreur nommee, et `skipped` est REMPLI malgre l echec", async () => {
    const registryDir = makeRegistryDir();
    // Les DEUX entrees 0.1.0 reellement capturees sur le poste : vivantes, d'un schema
    // etranger, donc ecartees. Aucune fenetre pilotable, et deux motifs a rapporter — c'est
    // l'etat exact d'un poste ou seule une version anterieure de l'extension a tourne.
    copyLegacyEntriesInto(registryDir);
    const report: RegistryReport = {};

    const error = await caught(open(registryDir, 'Reponds OK.', report));

    expect(error.code).toBe('OWNING_WINDOW_NOT_FOUND');
    // C'est en cas d'echec que ce renseignement vaut le plus : « aucune fenetre ne te
    // revendique, et voici ce qu'on a ecarte, avec le motif ».
    expect(report.skipped).toEqual([
      { file: '11172.json', reason: 'foreign-schema' },
      { file: '17544.json', reason: 'foreign-schema' },
    ]);
  });
});

describe('une erreur nommee de la fenetre traverse telle quelle', () => {
  it('rend le code, le message et les details que la FENETRE a formules', async () => {
    const companion = await companionIn({
      open: () =>
        Promise.reject(
          new ClaudeManagerError(
            'CLAUDE_PANEL_VIEWTYPE_UNKNOWN',
            'No Claude conversation tab appeared after the attach command was issued',
            { attempts: 5, waitedMs: 62_000 }
          )
        ),
    });

    const error = await caught(open(companion.registryDir, 'Reponds OK.'));

    expect(error.code).toBe('CLAUDE_PANEL_VIEWTYPE_UNKNOWN');
    expect(error.details).toEqual({ attempts: 5, waitedMs: 62_000 });
    expect(error.remediation).toContain('cmgr doctor');
  });
});

describe('les delais, tels qu ils partent reellement sur la socket', () => {
  it('5 s pour la confirmation, 180 s pour l ouverture', async () => {
    const companion = await companionIn();
    const sent: WindowRequest[] = [];
    // SONDE, pas double : elle releve ce qui passe puis delegue au VRAI transport.
    const probe: WindowTransport = (request) => {
      sent.push(request);
      return transport(request);
    };

    await open(companion.registryDir, 'Reponds OK.', {}, probe);

    expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /health',
      'POST /conversations',
    ]);
    expect(sent[0]?.timeoutMs).toBe(HEALTH_TIMEOUT_MS);
    expect(sent[1]?.timeoutMs).toBe(OPEN_TIMEOUT_MS);
    // L'ouverture doit depasser ce que la fenetre se donne a elle-meme : 62 s d'echelle
    // d'attachement plus ~12 s d'attente du processus amorce. Abandonner ne l'annulerait pas.
    expect(OPEN_TIMEOUT_MS).toBeGreaterThan(75_000);
    expect(HEALTH_TIMEOUT_MS).toBeLessThan(OPEN_TIMEOUT_MS);
    // Le jeton part sur les DEUX demandes, relu sur l'entree a chaque fois.
    expect(sent.every((request) => request.token === companion.token)).toBe(true);
  });
});
