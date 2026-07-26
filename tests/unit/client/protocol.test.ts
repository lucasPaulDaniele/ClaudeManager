import { describe, expect, it } from 'vitest';
import {
  isClaudeManagerError,
  readHealth,
  readOpenedConversation,
  type ClaudeManagerError,
  type WindowResponse,
} from '../../../packages/core/src/index.js';
import { CAPTURED } from './fixtures.js';

/**
 * RELECTURE DES REPONSES D'UNE FENETRE.
 *
 * Ce fichier ne fait AUCUN reseau : relire une reponse est une decision, pas un acces au
 * systeme. Les corps qui y entrent sont ceux qu'une VRAIE fenetre a rendus le 2026-07-26
 * (`tests/fixtures/client/`), et les formes DEGRADEES en sont derivees champ a champ — jamais
 * inventees de toutes pieces : chacune retire ou altere UN element de la capture, ce qui est
 * exactement la question posee (« que se passe-t-il si ce champ change ? »).
 */

function caught(read: () => unknown): ClaudeManagerError {
  try {
    read();
  } catch (error) {
    // Une erreur nue serait deja un defaut : le coeur ne leve que des erreurs nommees.
    expect(isClaudeManagerError(error), `erreur nue : ${String(error)}`).toBe(true);
    return error as ClaudeManagerError;
  }
  throw new Error('aucune erreur levee, alors que le test en attendait une');
}

/** Reconstruit un corps a partir de la capture, apres l'avoir altere d'UN champ. */
function healthBodyWith(patch: Readonly<Record<string, unknown>>): WindowResponse {
  const captured = JSON.parse(CAPTURED.health.body) as Record<string, unknown>;
  return { status: 200, body: JSON.stringify({ ...captured, ...patch }) };
}

function openBodyWith(
  base: 'openSeeded' | 'openFallback',
  patch: Readonly<Record<string, unknown>>
): WindowResponse {
  return { status: 200, body: JSON.stringify({ ...CAPTURED[base].result, ...patch }) };
}

function openBodyWithout(base: 'openSeeded' | 'openFallback', field: string): WindowResponse {
  const rest: Record<string, unknown> = { ...CAPTURED[base].result };
  // L'assertion serait vide si le champ n'y etait pas : on le verifie avant de le retirer.
  expect(rest, `${base}.${field}`).toHaveProperty(field);
  delete rest[field];
  return { status: 200, body: JSON.stringify(rest) };
}

describe('GET /health, tel qu une vraie fenetre le rend', () => {
  it('relit le corps CAPTURE, champ par champ', () => {
    const health = readHealth({ status: 200, body: CAPTURED.health.body });

    expect(health).toEqual({
      schemaVersion: 1,
      extensionVersion: '0.2.0',
      extHostPid: 14332,
      mainPid: 19520,
      isTrusted: true,
      workspaceFolders: [
        '<tmp>\\cmgr-b3-ws-hNxwPo\\folder-a',
        '<tmp>\\cmgr-b3-ws-hNxwPo\\folder-b',
      ],
      listenAddress: '127.0.0.1',
    });
  });

  it('ne retient PAS logDirectory : ce que le client n exploite pas, il ne le propage pas', () => {
    // Le journal est la source de diagnostic de `cmgr doctor` (lot D), pas du client. Le
    // laisser passer ferait sortir un chemin absolu du poste par une commande d'ouverture.
    const health = readHealth({ status: 200, body: CAPTURED.health.body });
    expect(Object.keys(health)).not.toContain('logDirectory');
    // L'assertion serait vide si la capture ne le portait pas : on le verifie.
    expect(CAPTURED.health.body).toContain('logDirectory');
  });

  const missing: readonly (readonly [string, Record<string, unknown>])[] = [
    ['ok', { ok: false }],
    ['schemaVersion', { schemaVersion: '1' }],
    ['extensionVersion', { extensionVersion: '' }],
    ['extHostPid', { extHostPid: 14332.5 }],
    ['mainPid', { mainPid: null }],
    ['isTrusted', { isTrusted: 'true' }],
    ['workspaceFolders', { workspaceFolders: 'un dossier' }],
    ['listenAddress', { listenAddress: 42 }],
  ];

  for (const [field, patch] of missing) {
    it(`refuse une reponse dont ${field} n est pas de la forme attendue`, () => {
      const error = caught(() => readHealth(healthBodyWith(patch)));

      expect(error.code).toBe('WINDOW_RESPONSE_UNREADABLE');
      expect(error.details).toEqual({ route: 'GET /health', missing: field });
    });
  }

  it('refuse un tableau de chaines dont UN element n en est pas une', () => {
    const error = caught(() => readHealth(healthBodyWith({ workspaceFolders: ['a', 7] })));
    expect(error.details).toEqual({ route: 'GET /health', missing: 'workspaceFolders' });
  });

  it('refuse ce qui n est pas du JSON, et ce qui n est pas un objet', () => {
    for (const body of ['<html>pas notre serveur</html>', '[1, 2]', 'null', '"une chaine"']) {
      const error = caught(() => readHealth({ status: 200, body }));
      expect(error.code).toBe('WINDOW_RESPONSE_UNREADABLE');
      expect(error.details).toEqual({ route: 'GET /health', missing: 'a JSON object' });
    }
  });
});

describe('les refus, tels que le vrai serveur les rend', () => {
  it('401 -> WINDOW_TOKEN_REJECTED, et sa remediation dit de NE PAS reessayer en boucle', () => {
    const captured = CAPTURED.refusals['unauthorized'];
    const error = caught(() => readHealth({ status: 401, body: captured?.body ?? '' }));

    expect(error.code).toBe('WINDOW_TOKEN_REJECTED');
    expect(error.details).toEqual({ route: 'GET /health' });
    expect(error.remediation).toContain('NE PAS REESSAYER EN BOUCLE');
  });

  const refusals: readonly (readonly [string, number, string])[] = [
    ['notFound', 404, 'NOT_FOUND'],
    ['forbiddenHost', 403, 'FORBIDDEN_HOST'],
    ['forbiddenOrigin', 403, 'FORBIDDEN_ORIGIN'],
  ];

  for (const [key, status, code] of refusals) {
    it(`${status} ${code} -> WINDOW_REQUEST_REFUSED, code NOMME dans les details`, () => {
      const captured = CAPTURED.refusals[key];
      // L'assertion serait vide si la fixture ne portait pas ce cas : on le verifie.
      expect(captured, key).toBeDefined();
      const error = caught(() =>
        readOpenedConversation({ status, body: (captured as { body: string }).body })
      );

      expect(error.code).toBe('WINDOW_REQUEST_REFUSED');
      expect(error.details).toEqual({ route: 'POST /conversations', status, error: code });
    });
  }

  it('rend TELLE QUELLE une erreur nommee du coeur formulee par la fenetre', () => {
    // C'est ce que la route renvoie en 500 : le code, le message et la remediation ont ete
    // ecrits par le coeur DANS la fenetre. Les reformuler ici les appauvrirait.
    const body = JSON.stringify({
      ok: false,
      error: 'CLAUDE_COMMAND_MISSING',
      message: 'The claude-vscode.editor.open command is not registered although the extension is active',
      remediation: 'peu importe : la remediation est celle du coeur, pas celle de la fenetre',
      details: { command: 'claude-vscode.editor.open' },
    });

    const error = caught(() => readOpenedConversation({ status: 500, body }));

    expect(error.code).toBe('CLAUDE_COMMAND_MISSING');
    expect(error.message).toContain('claude-vscode.editor.open');
    expect(error.details).toEqual({ command: 'claude-vscode.editor.open' });
    // La remediation vient du COEUR local, jamais de ce que la socket a envoye.
    expect(error.remediation).toContain('docs/compatibilite.md');
    expect(error.remediation).not.toContain('peu importe');
  });

  it('accepte une erreur nommee SANS details, et sans message exploitable', () => {
    const error = caught(() =>
      readOpenedConversation({
        status: 500,
        body: JSON.stringify({ ok: false, error: 'WORKSPACE_NOT_TRUSTED', details: [1, 2] }),
      })
    );

    expect(error.code).toBe('WORKSPACE_NOT_TRUSTED');
    expect(error.details).toBeUndefined();
    expect(error.message).toBe('The owning window failed on POST /conversations');
  });

  it('NE RECOPIE JAMAIS un `error` qui n est pas un code — meme envoye par la socket', () => {
    // Ce qui occupe un port ephemere n'est pas forcement notre serveur. Cette sortie part vers
    // un agent, vers un journal, et vers une PR d'un depot PUBLIC.
    const leaks: readonly string[] = [
      'EPERM: operation not permitted, open C:\\Users\\quelqu-un\\.claude\\token',
      'Bearer sk-live-000000000000000000000000',
      'not_found',
      'A'.repeat(200),
    ];

    for (const leak of leaks) {
      const error = caught(() =>
        readOpenedConversation({ status: 500, body: JSON.stringify({ ok: false, error: leak }) })
      );
      expect(error.code).toBe('WINDOW_REQUEST_REFUSED');
      expect(error.details).toEqual({ route: 'POST /conversations', status: 500, error: null });
      expect(JSON.stringify(error.toJSON())).not.toContain('quelqu-un');
      expect(JSON.stringify(error.toJSON())).not.toContain('sk-live');
    }
  });

  it('survit a un refus dont le corps n est meme pas lisible', () => {
    const error = caught(() =>
      readOpenedConversation({ status: 502, body: '<html>un proxy s est interpose</html>' })
    );

    expect(error.code).toBe('WINDOW_REQUEST_REFUSED');
    expect(error.details).toEqual({ route: 'POST /conversations', status: 502, error: null });
  });
});

describe('POST /conversations, tel qu une vraie fenetre le rend', () => {
  it('relit le resultat CAPTURE de la voie amorcee', () => {
    const conversation = readOpenedConversation({
      status: 200,
      body: JSON.stringify(CAPTURED.openSeeded.result),
    });

    expect(conversation).toEqual({
      mode: 'seeded',
      sessionId: 'f0bd7609-81b9-414f-bb6b-af35237ef276',
      extHostPid: 8188,
      humanActionRequired: false,
      firstTurn: 'transcript-observed',
      firstTurnVerified: true,
      // Releve TEL QUEL : VSCode le PREFIXE, une comparaison par egalite ne matcherait jamais.
      panelViewType: 'mainThreadWebview-claudeVSCodePanel',
      degradedFrom: undefined,
    });
  });

  it('relit le resultat CAPTURE du repli, et rend degradedFrom VERBATIM', () => {
    const conversation = readOpenedConversation({
      status: 200,
      body: JSON.stringify(CAPTURED.openFallback.result),
    });

    expect(conversation.mode).toBe('fallback');
    expect(conversation.sessionId).toBeNull();
    expect(conversation.humanActionRequired).toBe(true);
    expect(conversation.firstTurn).toBe('not-attempted');
    expect(conversation.panelViewType).toBeUndefined();
    // VERBATIM : la forme de ce champ appartient a la FENETRE. Le relire champ a champ ferait
    // echouer une ouverture reussie le jour ou l'extension y ajouterait quoi que ce soit.
    expect(conversation.degradedFrom).toEqual(CAPTURED.openFallback.result['degradedFrom']);
  });

  it('relit le resultat CAPTURE d une fenetre PLUS ANCIENNE, sans casser', () => {
    // ─────────────────────────────────────────────────────────────────────────────────────
    // LE PIEGE QUE CE TEST GARDE, ET IL A ETE MESURE SUR CE LOT. Le validateur portait
    // `if (raw['firstTurnVerified'] !== false) throw` : c'etait juste tant que la fenetre ne
    // pouvait PAS verifier le tour. Depuis qu'elle le peut, ce refus rejetterait EXACTEMENT les
    // ouvertures reussies — et la compilation resterait verte, ce validateur lisant un `unknown`
    // venu d'une socket.
    //
    // La symetrie compte autant : une fenetre encore en 0.3.0 rend `process-started` /
    // `firstTurnVerified: false`, et le client doit la lire TELLE QUELLE. Refuser transformerait
    // un ecart de version en reponse illisible sur une ouverture parfaitement reussie.
    // ─────────────────────────────────────────────────────────────────────────────────────
    const conversation = readOpenedConversation({
      status: 200,
      body: JSON.stringify(CAPTURED.openSeededLegacy.result),
    });

    expect(conversation.mode).toBe('seeded');
    expect(conversation.firstTurn).toBe('process-started');
    expect(conversation.firstTurnVerified).toBe(false);
  });

  it('REFUSE firstTurnVerified: true EN REPLI — personne n a amorce cette session', () => {
    // Le couple est le meme que celui de `sessionId` : le repli V5 pre-remplit un champ de
    // saisie, il n'amorce AUCUNE session. Un tour « verifie » y designerait le tour de personne.
    const error = caught(() =>
      readOpenedConversation(openBodyWith('openFallback', { firstTurnVerified: true }))
    );

    expect(error.code).toBe('WINDOW_RESPONSE_UNREADABLE');
    expect(error.details).toEqual({ route: 'POST /conversations', missing: 'firstTurnVerified' });
  });

  it('refuse un firstTurnVerified qui n est pas un booleen', () => {
    for (const value of ['true', 1, null]) {
      expect(
        caught(() => readOpenedConversation(openBodyWith('openSeeded', { firstTurnVerified: value })))
          .details
      ).toEqual({ route: 'POST /conversations', missing: 'firstTurnVerified' });
    }
  });

  it('EXIGE degradedFrom en repli : le repli s AJOUTE a l erreur, il ne la remplace pas (D18)', () => {
    const error = caught(() => readOpenedConversation(openBodyWithout('openFallback', 'degradedFrom')));

    expect(error.details).toEqual({ route: 'POST /conversations', missing: 'degradedFrom' });
  });

  it('REFUSE degradedFrom hors repli : une voie amorcee n a rien degrade', () => {
    const error = caught(() =>
      readOpenedConversation(openBodyWith('openSeeded', { degradedFrom: { code: 'X' } }))
    );

    expect(error.details).toEqual({ route: 'POST /conversations', missing: 'degradedFrom' });
  });

  it('refuse un degradedFrom qui n est pas un objet, en repli', () => {
    for (const value of ['PROMPT_TOO_LARGE', ['PROMPT_TOO_LARGE'], null]) {
      const error = caught(() =>
        readOpenedConversation(openBodyWith('openFallback', { degradedFrom: value }))
      );
      expect(error.details).toEqual({ route: 'POST /conversations', missing: 'degradedFrom' });
    }
  });

  it('EXIGE un sessionId en voie amorcee, et sa NULLITE en repli', () => {
    expect(
      caught(() => readOpenedConversation(openBodyWith('openSeeded', { sessionId: null }))).details
    ).toEqual({ route: 'POST /conversations', missing: 'sessionId' });

    expect(
      caught(() => readOpenedConversation(openBodyWith('openSeeded', { sessionId: '' }))).details
    ).toEqual({ route: 'POST /conversations', missing: 'sessionId' });

    // Un identifiant en repli designerait une session que PERSONNE n'a amorcee.
    expect(
      caught(() =>
        readOpenedConversation(openBodyWith('openFallback', { sessionId: 'ae19d1fc' }))
      ).details
    ).toEqual({ route: 'POST /conversations', missing: 'sessionId' });
  });

  it('EXIGE panelViewType en voie amorcee — c est la trace de la preuve d attachement', () => {
    expect(
      caught(() => readOpenedConversation(openBodyWithout('openSeeded', 'panelViewType'))).details
    ).toEqual({ route: 'POST /conversations', missing: 'panelViewType' });
  });

  const shapes: readonly (readonly [string, Record<string, unknown>])[] = [
    ['ok', { ok: false }],
    ['mode', { mode: 'nominal' }],
    ['firstTurn', { firstTurn: 'played' }],
    ['extHostPid', { extHostPid: '22424' }],
    ['humanActionRequired', { humanActionRequired: 'non' }],
  ];

  for (const [field, patch] of shapes) {
    it(`refuse une reponse dont ${field} n est pas de la forme attendue`, () => {
      const error = caught(() => readOpenedConversation(openBodyWith('openSeeded', patch)));

      expect(error.code).toBe('WINDOW_RESPONSE_UNREADABLE');
      expect(error.details).toEqual({ route: 'POST /conversations', missing: field });
    });
  }
});
