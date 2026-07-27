import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../../packages/cli/src/cli.js';
import { EXIT_CODES } from '../../../packages/cli/src/exit.js';
import { conversationTab, startCompanion, type Companion } from '../client/fixtures.js';
import {
  contextFor,
  expectFailure,
  expectSoleJsonValue,
  expectSuccess,
  WINDOWS_ROLES,
} from './fixtures.js';

/**
 * `cmgr conversations` et `cmgr close` — l'interface des deux commandes vis-a-vis de l'appelant.
 *
 * CE QUI EST EPROUVE ICI : ce que la ligne de commande accepte, ce qui sort sur `stdout`, ce qui
 * sort sur `stderr`, et le code de sortie. La MECANIQUE — confirmation de canal, verification de
 * poignee, refus — est eprouvee dans `tests/unit/client/` et `tests/unit/vscode/`, contre le meme
 * vrai serveur et les memes vraies routes.
 *
 * Le serveur d'en face est le VRAI serveur local de l'extension compagnon, sur une VRAIE socket,
 * servant les VRAIES routes de conversation. Aucun faux `http`, aucun faux `tabGroups`.
 */

const CALLER = WINDOWS_ROLES.callerClaudePid;

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

/** Le contrat en deux temps, joue : lister, puis lire la poignee de la premiere conversation. */
async function firstHandle(companion: Companion): Promise<string> {
  const payload = expectSuccess(
    await runCli(['conversations'], contextFor(companion.registryDir, CALLER))
  );
  const conversations = payload['conversations'] as readonly Record<string, unknown>[];
  return conversations[0]?.['id'] as string;
}

describe('cmgr conversations', () => {
  it('enumere les conversations de la fenetre hote, avec leur poignee', async () => {
    const companion = await companionIn({
      tabs: [conversationTab('Claude Code'), conversationTab('Autre', { indexInGroup: 1 })],
    });
    const context = contextFor(companion.registryDir, CALLER);

    const payload = expectSuccess(await runCli(['conversations'], context));

    expect(payload['count']).toBe(2);
    const conversations = payload['conversations'] as readonly Record<string, unknown>[];
    expect(conversations.map((c) => c['label'])).toEqual(['Claude Code', 'Autre']);
    // La poignee est OPAQUE : un uuid, jamais un libelle ni une position deguisee.
    expect(conversations[0]?.['id']).toMatch(/^[0-9a-f-]{36}$/);
    // UNE SEULE lecture de la table des processus (alerte n.15).
    expect(context.snapshotReads()).toBe(1);
  });

  it('NOMME la confirmation de canal, comme `open` — meme sur une lecture', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });

    const payload = expectSuccess(
      await runCli(['conversations'], contextFor(companion.registryDir, CALLER))
    );

    expect(payload['channelConfirmed']).toEqual({
      probe: 'GET /health',
      extHostPid: companion.entry.extHostPid,
      mainPid: companion.entry.mainPid,
      listenAddress: '127.0.0.1',
      extensionVersion: '0.2.0',
      schemaVersion: 1,
      isTrusted: true,
    });
  });

  it('une liste VIDE sort en code 0, et le DIT a l humain', async () => {
    const companion = await companionIn({ tabs: [] });

    const result = await runCli(['conversations'], contextFor(companion.registryDir, CALLER));
    const payload = expectSuccess(result);

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(payload['conversations']).toEqual([]);
    expect(payload['count']).toBe(0);
    // Un agent lit le champ ; un humain lit la phrase, et elle dit que ce n'est pas une panne.
    expect(result.stderr).toContain('aucune conversation ouverte');
  });

  it('AVERTIT que les poignees PERIMENT — le contrat en deux temps se lit sur stderr', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });

    const result = await runCli(['conversations'], contextFor(companion.registryDir, CALLER));

    expect(result.stderr).toContain('cmgr close');
    expect(result.stderr).toContain('relister');
  });

  it("n'accepte AUCUN argument", async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });

    for (const argv of [
      ['conversations', '--json'],
      ['conversations', '11172'],
      ['conversations', '--ext-host-pid', '11172'],
    ]) {
      const error = expectFailure(
        await runCli(argv, contextFor(companion.registryDir, CALLER)),
        EXIT_CODES.USAGE_ERROR
      );
      expect(error['code']).toBe('CLI_USAGE');
    }
  });

  it('ne porte NI jeton NI repertoire personnel, sur aucun des deux flux', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });

    const result = await runCli(['conversations'], contextFor(companion.registryDir, CALLER));

    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toContain(companion.token);
      expect(stream).not.toContain(os.homedir());
      expect(stream).not.toContain(JSON.stringify(os.homedir()).slice(1, -1));
    }
    expect((JSON.parse(result.stdout)['window'] as Record<string, unknown>)['token']).toBe('***');
  });
});

describe('cmgr close', () => {
  it('ferme la conversation designee, et rend ce qu elle etait', async () => {
    const companion = await companionIn({
      tabs: [conversationTab('A'), conversationTab('B', { indexInGroup: 1 })],
    });
    const id = await firstHandle(companion);

    const result = await runCli(['close', id], contextFor(companion.registryDir, CALLER));
    const payload = expectSuccess(result);

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(payload['closed']).toMatchObject({ id, label: 'A' });
    expect(payload['remaining']).toBe(1);
    // UN RELEVE, et il est NOMME comme tel : la preuve est la re-enumeration de la fenetre.
    expect(payload['editorReportedClosed']).toBe(true);
    expect(payload['extHostPid']).toBe(companion.entry.extHostPid);
    expect(companion.tabs.map((t) => t.label)).toEqual(['B']);
  });

  it('DIT a l humain que l enumeration fait foi, pas le booleen de l editeur', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });
    const id = await firstHandle(companion);

    const result = await runCli(['close', id], contextFor(companion.registryDir, CALLER));

    expect(result.stderr).toContain('enumeration fait foi');
    expect(result.stderr).toContain('0 conversation(s) restante(s)');
  });

  it('SANS poignee -> erreur d USAGE, et la commande est nommee', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });

    const result = await runCli(['close'], contextFor(companion.registryDir, CALLER));
    const error = expectFailure(result, EXIT_CODES.USAGE_ERROR);

    expect(error['code']).toBe('CLI_USAGE');
    expect(error['message']).toContain('cmgr conversations');
    expect(companion.closed).toEqual([]);
  });

  it('une poignee MALFORMEE est une erreur NOMMEE, refusee avant tout reseau', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });
    const context = contextFor(companion.registryDir, CALLER);

    const error = expectFailure(
      await runCli(['close', 'pas-une-poignee'], context),
      EXIT_CODES.DOMAIN_ERROR
    );

    expect(error['code']).toBe('CONVERSATION_HANDLE_INVALID');
    // Refusee AVANT l'inventaire des processus, qui coute de 700 ms a 1,3 s.
    expect(context.snapshotReads()).toBe(0);
    expect(companion.closed).toEqual([]);
  });

  it('une poignee jamais emise sort en CONVERSATION_HANDLE_STALE, code 1', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });

    const result = await runCli(
      ['close', '00000000-0000-4000-8000-0000000c4c4c'],
      contextFor(companion.registryDir, CALLER)
    );
    const error = expectFailure(result, EXIT_CODES.DOMAIN_ERROR);

    expect(error['code']).toBe('CONVERSATION_HANDLE_STALE');
    // La remediation NOMME le geste, et il est faisable ce soir.
    expect(result.stderr).toContain('cmgr conversations');
    expect(companion.closed).toEqual([]);
  });

  it('fermer DEUX FOIS : succes, puis CONVERSATION_ALREADY_CLOSED', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });
    const id = await firstHandle(companion);

    expectSuccess(await runCli(['close', id], contextFor(companion.registryDir, CALLER)));
    const result = await runCli(['close', id], contextFor(companion.registryDir, CALLER));
    const error = expectFailure(result, EXIT_CODES.DOMAIN_ERROR);

    expect(error['code']).toBe('CONVERSATION_ALREADY_CLOSED');
    expect(result.stderr).toContain('NE PAS RETENTER');
    expect(companion.closed).toHaveLength(1);
  });

  it("LE LIBELLE A CHANGE ENTRE LES DEUX TEMPS -> refus, et rien n'est ferme", async () => {
    const companion = await companionIn({ tabs: [conversationTab('Claude Code')] });
    const id = await firstHandle(companion);
    // Ce que la vraie extension Claude fait quelques centaines de millisecondes apres
    // l'attachement : le libelle devient derive du CONTENU de la conversation (D24).
    companion.tabs = [conversationTab('Respond with OK exactly')];

    const error = expectFailure(
      await runCli(['close', id], contextFor(companion.registryDir, CALLER)),
      EXIT_CODES.DOMAIN_ERROR
    );

    expect(error['code']).toBe('CONVERSATION_HANDLE_STALE');
    expect(companion.closed).toEqual([]);
    // Et relister rend une poignee FRAICHE, qui ferme.
    const fresh = await firstHandle(companion);
    expect(fresh).not.toBe(id);
    expectSuccess(await runCli(['close', fresh], contextFor(companion.registryDir, CALLER)));
    expect(companion.closed).toHaveLength(1);
  });

  it('la ligne de commande ne porte NI fenetre NI option', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });
    const refused: readonly (readonly [string, readonly string[]])[] = [
      ['deux poignees', ['close', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']],
      ['une option inconnue', ['close', '--force']],
      // Alerte n.19 : rien ne decrit une fenetre depuis la ligne de commande. L'enjeu est
      // ENTIER ici, `close` agissant sur un onglet.
      ['un extHostPid', ['close', '--ext-host-pid', '11172']],
      ['un port', ['close', '--port', '50933']],
      ['un jeton', ['close', '--token', 'sk-live-000000000000000000000000']],
    ];

    for (const [label, argv] of refused) {
      const result = await runCli(argv, contextFor(companion.registryDir, CALLER));
      const error = expectFailure(result, EXIT_CODES.USAGE_ERROR);

      expect(error['code'], label).toBe('CLI_USAGE');
      expect(companion.closed, label).toEqual([]);
      // Le jeton fautif n'est JAMAIS recopie : seule la position est rendue.
      expect(result.stdout, label).not.toContain('sk-live');
      expect(result.stderr, label).not.toContain('sk-live');
    }
  });

  it('AUCUN succes degrade : ou l onglet est parti, ou une erreur le nomme', async () => {
    // Le cinquieme code de sortie (`DEGRADED_SUCCESS`) existe pour une conversation OUVERTE dont
    // le tour n'est pas acquis. La fermeture n'a pas d'etat intermediaire de cette nature : le
    // verifier interdit d'en introduire un par accident.
    const companion = await companionIn({ tabs: [conversationTab('A')] });
    const id = await firstHandle(companion);

    const success = await runCli(['close', id], contextFor(companion.registryDir, CALLER));
    const refusal = await runCli(['close', id], contextFor(companion.registryDir, CALLER));

    expect(success.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(refusal.exitCode).toBe(EXIT_CODES.DOMAIN_ERROR);
    for (const result of [success, refusal]) {
      expect(result.exitCode).not.toBe(EXIT_CODES.DEGRADED_SUCCESS);
      expectSoleJsonValue(result);
    }
  });

  it('nomme la commande dans l enveloppe, en succes comme en echec', async () => {
    const companion = await companionIn({ tabs: [conversationTab('A')] });
    const id = await firstHandle(companion);

    expect(
      expectSoleJsonValue(await runCli(['close', id], contextFor(companion.registryDir, CALLER)))[
        'command'
      ]
    ).toBe('close');
    expect(
      expectSoleJsonValue(await runCli(['close', id], contextFor(companion.registryDir, CALLER)))[
        'command'
      ]
    ).toBe('close');
  });
});
