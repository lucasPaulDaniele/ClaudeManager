import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../../packages/cli/src/cli.js';
import { EXIT_CODES } from '../../../packages/cli/src/exit.js';
import {
  fallbackResultFor,
  publishEntry,
  startCompanion,
  type Companion,
} from '../client/fixtures.js';
import { contextFor, expectFailure, expectSuccess, WINDOWS_ROLES } from './fixtures.js';

/**
 * `cmgr open` — l'interface de la commande vis-a-vis de son appelant.
 *
 * CE QUI EST EPROUVE ICI : d'ou vient le prompt, ce qui est refuse, ce qui sort sur `stdout`,
 * ce qui sort sur `stderr`, et le code de sortie. La MECANIQUE de l'ouverture — confirmation de
 * canal, relecture du port et du jeton, refus d'identite — est eprouvee dans
 * `tests/unit/client/`, contre le meme vrai serveur.
 *
 * Le serveur d'en face est le VRAI serveur local de l'extension compagnon, sur une VRAIE
 * socket, servant des reponses REELLEMENT capturees. Aucun faux `http`.
 */

const CALLER = WINDOWS_ROLES.callerClaudePid;

/**
 * La marque d'ordre des octets, ECRITE EN ECHAPPEMENT.
 *
 * Un litteral invisible dans une source est exactement ce que le piege n.7 recense : on ne le
 * voit pas, donc on ne le relit pas, donc le premier outil qui normalise le fichier l'emporte —
 * et le test passerait alors sans avoir rien eprouve.
 */
const BOM = '\uFEFF';

const running: Companion[] = [];
const scratch = mkdtempSync(path.join(os.tmpdir(), 'cmgr-open-'));

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

/** Un VRAI fichier sur un VRAI systeme de fichiers temporaire. */
function promptFile(name: string, content: string): string {
  const file = path.join(scratch, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

describe('d ou vient le prompt', () => {
  it('--prompt-file : le fichier est lu en UTF-8 et arrive MOT POUR MOT dans la fenetre', async () => {
    const companion = await companionIn();
    const prompt = 'Reponds exactement OK.\nDeuxieme ligne, avec des accents : eleve, ete, ou.';
    const file = promptFile('nominal.md', prompt);
    const context = contextFor(companion.registryDir, CALLER);

    const payload = expectSuccess(await runCli(['open', '--prompt-file', file], context));

    expect(companion.received).toEqual([prompt]);
    expect(payload['prompt']).toEqual({ source: 'file', bytes: Buffer.byteLength(prompt, 'utf8') });
    // Le prompt LUI-MEME n'est jamais recopie dans la sortie : la source et la taille suffisent
    // a reconnaitre un prompt pris au mauvais endroit.
    expect(JSON.stringify(payload)).not.toContain('Deuxieme ligne');
    // UNE SEULE lecture de la table des processus (alerte n.15).
    expect(context.snapshotReads()).toBe(1);
  });

  it('sans --prompt-file : le prompt est lu sur stdin', async () => {
    const companion = await companionIn();
    const context = contextFor(companion.registryDir, CALLER, undefined, {
      stdinText: 'Reponds exactement OK.',
    });

    const payload = expectSuccess(await runCli(['open'], context));

    expect(companion.received).toEqual(['Reponds exactement OK.']);
    expect(payload['prompt']).toEqual({ source: 'stdin', bytes: 22 });
    expect(context.stdinReads()).toBe(1);
  });

  it('--prompt-file PRIME, et stdin n est alors NI lu NI inspecte', async () => {
    // ECART ASSUME AU CAHIER DES CHARGES, mesure a l'appui : ni `isTTY` ni `fstat(0)` ne
    // distinguent « un prompt attend sur stdin » de « stdin est branche sur rien ». Dans le
    // harnais qui execute les outils d'un agent, `isTTY` vaut `undefined` et `fstat(0)` rend un
    // peripherique caractere ; un `spawn` de Node rend un TUBE meme quand personne n'y ecrira.
    // Detecter « les deux fournis » transformerait l'invocation NOMINALE d'un agent en erreur
    // d'usage. On rend donc le conflit IMPOSSIBLE plutot que detectable.
    const companion = await companionIn();
    const file = promptFile('prioritaire.md', 'celui du fichier');
    const context = contextFor(companion.registryDir, CALLER, undefined, {
      stdinText: 'celui de stdin',
    });

    const payload = expectSuccess(await runCli(['open', '--prompt-file', file], context));

    expect(companion.received).toEqual(['celui du fichier']);
    expect(payload['prompt']).toMatchObject({ source: 'file' });
    // LE POINT DU TEST : stdin n'a pas ete lu du tout.
    expect(context.stdinReads()).toBe(0);
  });

  it('retire un BOM : il partirait sinon en tete du prompt, invisible et bien reel', async () => {
    const companion = await companionIn();
    const file = promptFile('avec-bom.md', `${BOM}Reponds exactement OK.`);
    const context = contextFor(companion.registryDir, CALLER);

    const payload = expectSuccess(await runCli(['open', '--prompt-file', file], context));

    expect(companion.received).toEqual(['Reponds exactement OK.']);
    expect(companion.received[0]?.startsWith(BOM)).toBe(false);
    // La taille rendue est celle du prompt RETENU, BOM exclu.
    expect(payload['prompt']).toEqual({ source: 'file', bytes: 22 });
  });

  it('retire aussi le BOM lu sur stdin', async () => {
    const companion = await companionIn();
    const context = contextFor(companion.registryDir, CALLER, undefined, {
      stdinText: `${BOM}Reponds exactement OK.`,
    });

    expectSuccess(await runCli(['open'], context));

    expect(companion.received).toEqual(['Reponds exactement OK.']);
  });
});

describe('ce qui est refuse, et comment', () => {
  it('aucun prompt et stdin est un TERMINAL -> erreur d USAGE, jamais une attente', async () => {
    // Attendre qu'un humain tape puis ferme le flux reviendrait a pendre, pour un outil dont
    // le consommateur est un agent.
    const companion = await companionIn();
    const context = contextFor(companion.registryDir, CALLER);

    const result = await runCli(['open'], context);
    const error = expectFailure(result, EXIT_CODES.USAGE_ERROR);

    expect(error['code']).toBe('CLI_USAGE');
    expect(error['message']).toContain('--prompt-file');
    // La commande fautive EST nommee : l'analyse d'arguments, elle, ne le pouvait pas.
    expect(JSON.parse(result.stdout)['command']).toBe('open');
    expect(context.stdinReads()).toBe(0);
    expect(companion.received).toEqual([]);
  });

  it('un prompt VIDE est une erreur NOMMEE, pas une ouverture silencieuse', async () => {
    const companion = await companionIn();
    const file = promptFile('vide.md', '   \n\n  \t ');
    const context = contextFor(companion.registryDir, CALLER);

    const error = expectFailure(
      await runCli(['open', '--prompt-file', file], context),
      EXIT_CODES.DOMAIN_ERROR
    );

    expect(error['code']).toBe('PROMPT_EMPTY');
    expect(companion.received).toEqual([]);
    // Refuse AVANT l'inventaire des processus, qui coute de 700 ms a 1,3 s.
    expect(context.snapshotReads()).toBe(0);
  });

  it('un flux stdin vide est refuse de la meme facon', async () => {
    const companion = await companionIn();
    const context = contextFor(companion.registryDir, CALLER, undefined, { stdinText: '' });

    const error = expectFailure(await runCli(['open'], context), EXIT_CODES.DOMAIN_ERROR);

    expect(error['code']).toBe('PROMPT_EMPTY');
  });

  it('un fichier introuvable sort en erreur nommee, SANS son chemin', async () => {
    const companion = await companionIn();
    const absent = path.join(scratch, 'ce-fichier-n-existe-pas.md');
    const context = contextFor(companion.registryDir, CALLER);

    const result = await runCli(['open', '--prompt-file', absent], context);
    const error = expectFailure(result, EXIT_CODES.DOMAIN_ERROR);

    expect(error['code']).toBe('PROMPT_FILE_UNREADABLE');
    expect(error['details']).toEqual({ cause: 'ENOENT' });
    // Le chemin porte le nom du compte, et cette sortie part vers une PR d'un depot PUBLIC.
    expect(result.stdout).not.toContain(absent);
    expect(result.stdout).not.toContain(os.homedir());
    expect(result.stderr).not.toContain(os.homedir());
  });

  it('un REPERTOIRE passe en --prompt-file est refuse, avec son code systeme', async () => {
    const companion = await companionIn();
    const context = contextFor(companion.registryDir, CALLER);

    const error = expectFailure(
      await runCli(['open', '--prompt-file', scratch], context),
      EXIT_CODES.DOMAIN_ERROR
    );

    expect(error['code']).toBe('PROMPT_FILE_UNREADABLE');
    expect(error['details']).toEqual({ cause: 'EISDIR' });
  });
});

describe('la ligne de commande ne porte NI prompt NI fenetre', () => {
  const refused: readonly (readonly [string, readonly string[]])[] = [
    ['un prompt positionnel', ['open', 'Reponds exactement OK.']],
    ['--prompt-file sans valeur', ['open', '--prompt-file']],
    ['--prompt-file deux fois', ['open', '--prompt-file', 'a.md', '--prompt-file', 'b.md']],
    ['une option inconnue', ['open', '--wait']],
    // Alerte n.19 : la garantie d'identite vit dans `parseWindowEntry`. Une fenetre decrite en
    // ligne de commande n'aurait traverse ni la validation de schema, ni la confrontation au
    // nom de fichier, ni la garde anti-reemploi de pid. L'enjeu est ENTIER ici : `open` agit.
    ['un extHostPid', ['open', '--ext-host-pid', '11172']],
    ['un port', ['open', '--port', '50933']],
    ['un jeton', ['open', '--token', 'sk-live-000000000000000000000000']],
    ['un hote', ['open', '--host', '10.0.0.1']],
  ];

  for (const [label, argv] of refused) {
    it(`${label} -> code 2, et rien n est ouvert`, async () => {
      const companion = await companionIn();
      const context = contextFor(companion.registryDir, CALLER);

      const result = await runCli(argv, context);
      const error = expectFailure(result, EXIT_CODES.USAGE_ERROR);

      expect(error['code']).toBe('CLI_USAGE');
      expect(companion.received).toEqual([]);
      // Le jeton fautif n'est JAMAIS recopie : seule la position est rendue.
      expect(result.stdout).not.toContain('sk-live');
      expect(result.stderr).not.toContain('sk-live');
    });
  }
});

describe('ce que la sortie DIT, et ne doit pas taire', () => {
  it('rend firstTurnVerified au premier niveau, ET le redit en clair sur stderr', async () => {
    // Un agent qui lit `ok: true` sans ce champ conclurait, a tort, que le tour a eu lieu.
    const companion = await companionIn();
    const file = promptFile('visible.md', 'Reponds exactement OK.');

    const result = await runCli(
      ['open', '--prompt-file', file],
      contextFor(companion.registryDir, CALLER)
    );
    const payload = expectSuccess(result);

    expect(payload['firstTurnVerified']).toBe(false);
    expect(payload['firstTurn']).toBe('process-started');
    expect(result.stderr).toContain('firstTurnVerified: false');
    expect(result.stderr).toContain('lot D');
  });

  it('NOMME la confirmation de canal : une verification silencieuse ne se prouve pas', async () => {
    const companion = await companionIn();
    const file = promptFile('canal.md', 'Reponds exactement OK.');

    const payload = expectSuccess(
      await runCli(['open', '--prompt-file', file], contextFor(companion.registryDir, CALLER))
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
    expect(payload['extHostPid']).toBe(companion.entry.extHostPid);
    expect(payload['mode']).toBe('seeded');
    expect(typeof payload['sessionId']).toBe('string');
  });

  it('un repli V5 sort en code 4 : ni un succes nominal, ni un echec', async () => {
    const companion = await companionIn({
      open: (entry) => Promise.resolve(fallbackResultFor(entry)),
    });
    const file = promptFile('repli.md', 'Reponds exactement OK.');

    const result = await runCli(
      ['open', '--prompt-file', file],
      contextFor(companion.registryDir, CALLER)
    );

    expect(result.exitCode).toBe(EXIT_CODES.DEGRADED_SUCCESS);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    // `ok` reste vrai : la commande a bien produit son resultat, une conversation est ouverte.
    expect(payload['ok']).toBe(true);
    expect(payload['mode']).toBe('fallback');
    expect(payload['sessionId']).toBeNull();
    expect(payload['humanActionRequired']).toBe(true);
    // L'erreur qui a cause le repli est rendue TELLE QUELLE : le repli s'AJOUTE a elle.
    expect((payload['degradedFrom'] as Record<string, unknown>)['code']).toBe('PROMPT_TOO_LARGE');
    // Et un humain le lit sans avoir a interroger le JSON.
    expect(result.stderr).toContain('PRE-REMPLI');
    expect(result.stderr).toContain('geste humain');
    // En repli, aucun panneau n'est diffe : le champ n'a rien a rendre.
    expect(payload['panelViewType']).toBeUndefined();
  });

  it('ne porte NI jeton NI repertoire personnel, sur AUCUN des deux flux', async () => {
    const companion = await companionIn();
    const file = promptFile('secret.md', 'Reponds exactement OK.');

    const result = await runCli(
      ['open', '--prompt-file', file],
      contextFor(companion.registryDir, CALLER)
    );

    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toContain(companion.token);
      expect(stream).not.toContain(os.homedir());
      // Sous Windows le chemin est ECHAPPE dans le JSON : un masque qui ne connaitrait que la
      // forme brute passerait a cote.
      expect(stream).not.toContain(JSON.stringify(os.homedir()).slice(1, -1));
    }
    // L'entree est bien la, masquee : le champ n'a pas simplement disparu.
    expect((JSON.parse(result.stdout)['window'] as Record<string, unknown>)['token']).toBe('***');
  });

  it('rapporte `skipped` MEME quand l ouverture echoue', async () => {
    const companion = await companionIn();
    // L'entree annonce un jeton qui n'est plus celui du serveur : le canal sera refuse.
    publishEntry(companion.registryDir, companion.port, 'jeton-perime');
    const file = promptFile('skipped.md', 'Reponds exactement OK.');

    const result = await runCli(
      ['open', '--prompt-file', file],
      contextFor(companion.registryDir, CALLER)
    );
    const error = expectFailure(result, EXIT_CODES.DOMAIN_ERROR);

    expect(error['code']).toBe('WINDOW_TOKEN_REJECTED');
    // Le champ est present dans l'enveloppe d'echec, comme pour `whoami`.
    expect(JSON.parse(result.stdout)).toHaveProperty('skipped');
    expect(companion.received).toEqual([]);
  });
});
