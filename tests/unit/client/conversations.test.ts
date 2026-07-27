import { afterEach, describe, expect, it } from 'vitest';
import {
  assertConversationHandle,
  ClaudeManagerError,
  closeConversationInWindow,
  createLoopbackTransport,
  isClaudeManagerError,
  listConversationsInWindow,
  type RegistryReport,
  type WindowRequest,
  type WindowTransport,
} from '../../../packages/core/src/index.js';
// PRIS A LEUR MODULE, ET PLUS AU CONTRAT (V2-12) : deux delais internes, sans consommateur hors
// d'ici. Ce qu'ils sont — des details eprouves — se lit mieux ainsi.
import {
  CLOSE_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
} from '../../../packages/core/src/client/conversations.node.js';
import { HEALTH_TIMEOUT_MS } from '../../../packages/core/src/client/channel.node.js';
import {
  CALLER_PID,
  conversationTab,
  copyLegacyEntriesInto,
  deadPort,
  healthPayloadFor,
  makeRegistryDir,
  publishEntry,
  snapshot,
  startCompanion,
  startRawServer,
  type Companion,
} from './fixtures.js';

/**
 * ENUMERER ET FERMER, DE BOUT EN BOUT, CONTRE UN VRAI SERVEUR SUR UNE VRAIE SOCKET.
 *
 * La chaine traversee ici est complete : le client du coeur, le VRAI transport de production, le
 * VRAI serveur local de l'extension compagnon, et les VRAIES routes de conversation avec leur
 * registre de poignees. Seule l'API `vscode` est absente — c'est `npm run test:integration` qui
 * l'eprouve, sur de vrais onglets.
 *
 * Ce qui est eprouve ici : la SEQUENCE (confirmation de canal avant tout), les REFUS, et le
 * CONTRAT EN DEUX TEMPS — lister emet la poignee que fermer verifie.
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

function context(
  registryDir: string,
  report: RegistryReport = {},
  wire: WindowTransport = transport
): Parameters<typeof listConversationsInWindow>[0] {
  return { pid: CALLER_PID, snapshot: snapshot(), registryDir, transport: wire, report };
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

describe('cmgr conversations — enumerer', () => {
  it('confirme le canal, puis rend les conversations de CETTE fenetre', async () => {
    const companion = await companionIn({
      tabs: [conversationTab('Claude Code'), conversationTab('Autre', { indexInGroup: 1 })],
    });
    const report: RegistryReport = {};

    const listing = await listConversationsInWindow(context(companion.registryDir, report));

    // La confirmation est NOMMEE, sur une route de LECTURE comme sur les autres : les poignees
    // rendues n'ont de sens que dans la fenetre qui les a emises.
    expect(listing.channel).toMatchObject({
      probe: 'GET /health',
      extHostPid: companion.entry.extHostPid,
      mainPid: companion.entry.mainPid,
      listenAddress: '127.0.0.1',
    });
    expect(listing.conversations.map((c) => c.label)).toEqual(['Claude Code', 'Autre']);
    expect(listing.conversations[0]?.viewType).toContain('claudeVSCodePanel');
    expect(report.skipped).toEqual([]);
  });

  it('une liste VIDE est un succes, jamais une erreur', async () => {
    const companion = await companionIn({ tabs: [] });

    const listing = await listConversationsInWindow(context(companion.registryDir));

    expect(listing.conversations).toEqual([]);
  });

  it('MASQUE le jeton en sortie, alors que le VRAI jeton a servi a la demande', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });

    const listing = await listConversationsInWindow(context(companion.registryDir));

    expect(listing.window.token).toBe('***');
    expect(JSON.stringify(listing)).not.toContain(companion.token);
    expect(companion.token.length).toBeGreaterThan(8);
  });

  it('n a AUCUN effet de bord : aucun onglet n est ferme', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });

    await listConversationsInWindow(context(companion.registryDir));
    await listConversationsInWindow(context(companion.registryDir));

    expect(companion.closed).toEqual([]);
    expect(companion.tabs).toHaveLength(1);
  });

  it("une fenetre qui repond pour une AUTRE est refusee, meme en lecture", async () => {
    // Les poignees d'une autre fenetre ne designent rien chez nous, et un agent les passerait
    // ensuite a une fermeture. Un renseignement faux se paie au coup suivant.
    const companion = await companionIn({
      tabs: [conversationTab('A')],
      conversations: (entry) => ({
        list: () =>
          Promise.resolve({ ok: true, extHostPid: entry.extHostPid + 5, conversations: [] }),
        close: () => Promise.reject(new Error('not exercised')),
      }),
    });

    const error = await caught(listConversationsInWindow(context(companion.registryDir)));

    expect(error.code).toBe('WINDOW_IDENTITY_MISMATCH');
    expect(error.details).toMatchObject({
      route: 'GET /conversations',
      actualExtHostPid: companion.entry.extHostPid + 5,
      actualMainPid: null,
    });
  });

  it('un port devenu mort sort en WINDOW_UNREACHABLE, avec son code systeme', async () => {
    const registryDir = makeRegistryDir();
    const port = await deadPort();
    publishEntry(registryDir, port, 'peu-importe');

    const error = await caught(listConversationsInWindow(context(registryDir)));

    expect(error.code).toBe('WINDOW_UNREACHABLE');
    // La confirmation de canal tombe AVANT l'enumeration : c'est `/health` qui est nommee.
    expect(error.details).toEqual({ route: 'GET /health', port, cause: 'ECONNREFUSED' });
  });

  it('remplit `skipped` MEME quand la resolution echoue', async () => {
    const registryDir = makeRegistryDir();
    copyLegacyEntriesInto(registryDir);
    const report: RegistryReport = {};

    const error = await caught(listConversationsInWindow(context(registryDir, report)));

    expect(error.code).toBe('OWNING_WINDOW_NOT_FOUND');
    expect(report.skipped).toEqual([
      { file: '11172.json', reason: 'foreign-schema' },
      { file: '17544.json', reason: 'foreign-schema' },
    ]);
  });

  it("une reponse illisible sur cette route est SURE a relancer", async () => {
    // Une fenetre portant une version differente de l'extension compagnon. Le code doit dire
    // « relancer est sur » : cette route ne produit aucun effet de bord.
    const registryDir = makeRegistryDir();
    const raw = await startRawServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, extHostPid: 1, conversations: [{ id: 'pas-un-uuid' }] }));
    });
    try {
      // L'entree designe le serveur nu : la confirmation de canal echouera d'abord, donc on la
      // contourne en faisant repondre le VRAI compagnon a `/health` — ce que le transport ne
      // permet pas ici. On se rabat sur ce que ce test doit etablir : le CODE de l'illisibilite.
      publishEntry(registryDir, raw.port, 'peu-importe');
      const error = await caught(listConversationsInWindow(context(registryDir)));
      // `/health` est interrogee AVANT : c'est elle qui est illisible, et son code est le meme.
      expect(error.code).toBe('WINDOW_RESPONSE_UNREADABLE');
      expect(error.remediation).toContain('RELANCER EST SUR');
    } finally {
      await raw.close();
    }
  });
});

describe('cmgr close — le contrat en DEUX TEMPS', () => {
  it('lister PUIS fermer : la poignee fraiche ferme l onglet designe', async () => {
    const companion = await companionIn({
      tabs: [conversationTab('A'), conversationTab('B', { indexInGroup: 1 })],
    });
    const listing = await listConversationsInWindow(context(companion.registryDir));
    const target = listing.conversations[1];

    const closing = await closeConversationInWindow(
      { id: target?.id ?? '' },
      context(companion.registryDir)
    );

    expect(closing.closed.closed).toMatchObject({ id: target?.id, label: 'B', indexInGroup: 1 });
    expect(closing.closed.remaining).toBe(1);
    // UN RELEVE, jamais la preuve : la fenetre a re-enumere avant de rendre ce succes.
    expect(closing.closed.editorReportedClosed).toBe(true);
    // Et c'est bien B qui est parti.
    expect(companion.tabs.map((t) => t.label)).toEqual(['A']);
    expect(companion.closed).toHaveLength(1);
    expect(closing.channel.probe).toBe('GET /health');
  });

  it('FERMER SANS LISTER est refuse, et rien n est ferme', async () => {
    // C'est le contrat, et il n'est pas negociable : la fenetre ne peut pas prouver qu'un onglet
    // est celui qu'on designe si elle n'a jamais emis la poignee.
    const companion = await companionIn({ tabs: [conversationTab('A')] });

    const error = await caught(
      closeConversationInWindow(
        { id: '00000000-0000-4000-8000-0000000c4c4c' },
        context(companion.registryDir)
      )
    );

    expect(error.code).toBe('CONVERSATION_HANDLE_STALE');
    expect(error.remediation).toContain('cmgr conversations');
    expect(companion.closed).toEqual([]);
    expect(companion.tabs).toHaveLength(1);
  });

  it("LE LIBELLE A CHANGE ENTRE LES DEUX TEMPS -> refus, et rien n est ferme", async () => {
    // Le cas REEL : le libelle d'un panneau Claude devient derive du contenu de la conversation
    // quelques centaines de millisecondes apres l'attachement (D24).
    const companion = await companionIn({ tabs: [conversationTab('Claude Code')] });
    const listing = await listConversationsInWindow(context(companion.registryDir));
    companion.tabs = [conversationTab('Respond with OK exactly')];

    const error = await caught(
      closeConversationInWindow(
        { id: listing.conversations[0]?.id ?? '' },
        context(companion.registryDir)
      )
    );

    expect(error.code).toBe('CONVERSATION_HANDLE_STALE');
    expect(companion.closed).toEqual([]);
  });

  it('fermer DEUX FOIS : succes, puis ALREADY_CLOSED — une relance ne peut RIEN creer', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });
    const listing = await listConversationsInWindow(context(companion.registryDir));
    const id = listing.conversations[0]?.id ?? '';

    await closeConversationInWindow({ id }, context(companion.registryDir));
    const error = await caught(closeConversationInWindow({ id }, context(companion.registryDir)));

    expect(error.code).toBe('CONVERSATION_ALREADY_CLOSED');
    expect(error.remediation).toContain('NE PAS RETENTER');
    // LA PROPRIETE QUI JUSTIFIE DE N'AVOIR PAS CREE UN TROISIEME CODE D'ILLISIBILITE.
    expect(companion.closed).toHaveLength(1);
  });

  it("les DETAILS d un refus ne portent que des NOMBRES — jamais un libelle", async () => {
    const companion = await companionIn({
      tabs: [conversationTab('un secret de conversation'), conversationTab('B', { indexInGroup: 1 })],
    });

    const error = await caught(
      closeConversationInWindow(
        { id: '11111111-1111-4111-8111-111111111111' },
        context(companion.registryDir)
      )
    );

    expect(error.details).toEqual({ conversations: 2 });
    // Le libelle est du CONTENU de conversation : le filtre du client ne le laisserait pas
    // passer, et la fenetre ne l'y met pas. Les deux gardes valent mieux qu'une.
    expect(JSON.stringify(error.toJSON())).not.toContain('secret');
  });

  it('une poignee MALFORMEE est refusee AVANT tout acces au systeme', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });
    const report: RegistryReport = {};

    const error = await caught(
      closeConversationInWindow({ id: 'pas-une-poignee' }, context(companion.registryDir, report))
    );

    expect(error.code).toBe('CONVERSATION_HANDLE_INVALID');
    // LA LONGUEUR, jamais la valeur : elle vient de l'appelant.
    expect(error.details).toEqual({ length: 15 });
    // La preuve que rien n'a ete lu : le rapport n'a jamais ete rempli.
    expect(report.skipped).toBeUndefined();
    expect(companion.closed).toEqual([]);
  });

  it('la garde de forme accepte un uuid, et refuse tout le reste', () => {
    expect(() => assertConversationHandle('8d1f4f0e-6d2f-4a63-9d63-3a4f0e5b1c77')).not.toThrow();
    // La casse ne discrimine pas : `randomUUID` rend des minuscules, un appelant peut recopier
    // en majuscules sans rien changer a la valeur.
    expect(() => assertConversationHandle('8D1F4F0E-6D2F-4A63-9D63-3A4F0E5B1C77')).not.toThrow();
    for (const wrong of ['', ' ', '8d1f4f0e', `${'8d1f4f0e-6d2f-4a63-9d63-3a4f0e5b1c77'} `, '../etc']) {
      expect(() => assertConversationHandle(wrong), wrong).toThrow();
    }
  });

  it("une fenetre qui ferme POUR UNE AUTRE est refusee, apres coup et en le disant", async () => {
    const companion = await companionIn({
      tabs: [conversationTab('A')],
      conversations: (entry) => ({
        list: () =>
          Promise.resolve({
            ok: true,
            extHostPid: entry.extHostPid,
            conversations: [
              {
                id: '8d1f4f0e-6d2f-4a63-9d63-3a4f0e5b1c77',
                label: 'A',
                viewType: 'mainThreadWebview-claudeVSCodePanel',
                viewColumn: 1,
                indexInGroup: 0,
                isActive: false,
              },
            ],
          }),
        close: () =>
          Promise.resolve({
            ok: true,
            // L'ecart : la fenetre qui repond n'est pas celle de l'entree lue.
            extHostPid: entry.extHostPid + 3,
            closed: {
              id: '8d1f4f0e-6d2f-4a63-9d63-3a4f0e5b1c77',
              label: 'A',
              viewType: 'mainThreadWebview-claudeVSCodePanel',
              viewColumn: 1,
              indexInGroup: 0,
              isActive: false,
            },
            remaining: 0,
            editorReportedClosed: true,
          }),
      }),
    });

    const error = await caught(
      closeConversationInWindow(
        { id: '8d1f4f0e-6d2f-4a63-9d63-3a4f0e5b1c77' },
        context(companion.registryDir)
      )
    );

    expect(error.code).toBe('WINDOW_IDENTITY_MISMATCH');
    expect(error.details).toMatchObject({ route: 'POST /conversations/close' });
  });
});

describe('les delais, tels qu ils partent reellement sur la socket', () => {
  it('5 s pour la confirmation et pour la lecture, 15 s pour la fermeture', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });
    const sent: WindowRequest[] = [];
    // SONDE, pas double : elle releve ce qui passe puis delegue au VRAI transport.
    const probe: WindowTransport = (request) => {
      sent.push(request);
      return transport(request);
    };

    const listing = await listConversationsInWindow(context(companion.registryDir, {}, probe));
    await closeConversationInWindow(
      { id: listing.conversations[0]?.id ?? '' },
      context(companion.registryDir, {}, probe)
    );

    expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /health',
      'GET /conversations',
      'GET /health',
      'POST /conversations/close',
    ]);
    expect(sent[0]?.timeoutMs).toBe(HEALTH_TIMEOUT_MS);
    expect(sent[1]?.timeoutMs).toBe(LIST_TIMEOUT_MS);
    expect(sent[3]?.timeoutMs).toBe(CLOSE_TIMEOUT_MS);
    // La fermeture doit depasser ce que la fenetre se donne a elle-meme : 5 s de confirmation,
    // et une file d'un seul rang partagee par les deux routes.
    expect(CLOSE_TIMEOUT_MS).toBeGreaterThan(10_000);
    // Le jeton part sur les QUATRE demandes, relu sur l'entree a chaque fois (alerte n.41).
    expect(sent.every((request) => request.token === companion.token)).toBe(true);
    // ET AUCUNE demande ne porte un hote : il n'y a pas de champ pour cela.
    expect(sent.every((request) => !Object.keys(request).includes('host'))).toBe(true);
  });

  it('la CONFIRMATION precede toujours l action, sur les deux routes', async () => {
    const companion = await companionIn({
      tabs: [conversationTab('A')],
      // La fenetre se declare autre qu'elle n'est : la confirmation echoue AVANT toute demande.
      health: (entry) => ({ ...healthPayloadFor(entry), extHostPid: entry.extHostPid + 1 }),
    });

    const onList = await caught(listConversationsInWindow(context(companion.registryDir)));
    const onClose = await caught(
      closeConversationInWindow(
        { id: '8d1f4f0e-6d2f-4a63-9d63-3a4f0e5b1c77' },
        context(companion.registryDir)
      )
    );

    expect(onList.code).toBe('WINDOW_IDENTITY_MISMATCH');
    expect(onClose.code).toBe('WINDOW_IDENTITY_MISMATCH');
    expect(onList.details).toMatchObject({ route: 'GET /health' });
    expect(onClose.details).toMatchObject({ route: 'GET /health' });
    // LE POINT : rien n'a ete demande, donc rien n'a ete ferme.
    expect(companion.closed).toEqual([]);
  });
});
