import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli, type CliResult } from '../../../packages/cli/src/cli.js';
import { EXIT_CODES } from '../../../packages/cli/src/exit.js';
import { CLI_VERSION, USAGE } from '../../../packages/cli/src/usage.js';
import {
  ClaudeManagerError,
  ERROR_CODES,
  readProcessTable,
  writeWindowEntry,
} from '../../../packages/core/src/index.js';
import {
  contextFor,
  contextWithSnapshot,
  copyLegacyEntriesInto,
  currentSchemaEntry,
  expectFailure,
  expectSoleJsonValue,
  expectSuccess,
  makeRegistryDir,
  WINDOWS_ROLES,
} from './fixtures.js';

const CALLER = WINDOWS_ROLES.callerClaudePid;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * CONTRAT DE SORTIE — la propriete que rien ne doit casser.
 *
 * « stdout ne porte QU'UNE valeur JSON, en toutes circonstances » n'est pas un cas de test :
 * c'est une invariante. Elle est donc verifiee sur des invocations qui couvrent chaque
 * chemin de sortie, y compris ceux qui n'atteignent jamais le coeur.
 */
describe('contrat de sortie de cmgr', () => {
  it('rend une seule valeur JSON sur stdout, quel que soit le chemin emprunte', async () => {
    const dir = makeRegistryDir();
    copyLegacyEntriesInto(dir);
    const context = contextFor(dir, CALLER);

    const invocations: readonly (readonly string[])[] = [
      [], // aucune commande
      ['windows'], // succes
      ['whoami'], // erreur nommee du domaine
      ['--help'],
      ['--version'],
      ['nope'], // commande inconnue
      ['--registry-dir'], // option inconnue
      ['windows', '--json'], // argument surnumeraire
      ['open'], // erreur d'usage : aucun prompt, et stdin est un terminal
      ['open', '--prompt-file'], // option sans valeur
      ['open', 'un prompt positionnel'], // la forme que le produit s'interdit
    ];

    for (const argv of invocations) {
      const result = await runCli(argv, context);
      // Echoue si stdout porte deux valeurs, une banniere, ou n'est pas du JSON.
      expectSoleJsonValue(result);
      expect(Object.values(EXIT_CODES), `code de sortie de [${argv.join(' ')}]`).toContain(
        result.exitCode
      );
    }
  });

  it('les diagnostics humains vont sur stderr, jamais sur stdout', async () => {
    const dir = makeRegistryDir();
    copyLegacyEntriesInto(dir);

    const result = await runCli(['whoami'], contextFor(dir, CALLER));

    expect(result.stderr).toContain('cmgr: OWNING_WINDOW_NOT_FOUND');
    // La ligne humaine ne doit pas se retrouver dans le flux machine.
    expect(result.stdout).not.toContain('cmgr:');
  });
});

describe('usage', () => {
  const usageCases: readonly (readonly [string, readonly string[]])[] = [
    ['aucune commande', []],
    ['commande inconnue', ['nope']],
    ['option inconnue', ['--registry-dir']],
    ['abreviation non reconnue', ['win']],
    ['argument surnumeraire', ['windows', '--json']],
    ['deux commandes', ['windows', 'whoami']],
  ];

  for (const [label, argv] of usageCases) {
    it(`${label} -> code 2`, async () => {
      const result = await runCli(argv, contextFor(undefined, CALLER));
      const error = expectFailure(result, EXIT_CODES.USAGE_ERROR);

      expect(error['code']).toBe('CLI_USAGE');
      // Le registre n'a meme pas ete lu : une erreur d'usage n'atteint jamais le coeur.
      expect(result.stdout).not.toContain('skipped');
    });
  }

  it('ne recopie JAMAIS l argument fautif — seulement sa position', async () => {
    // Un agent maladroit peut passer n'importe quoi. Un message d'erreur serviable qui
    // recopierait l'argument imprimerait ce secret sur stdout.
    const secret = 'sk-live-000000000000000000000000';
    const result = await runCli([`--token=${secret}`], contextFor(undefined, CALLER));
    const error = expectFailure(result, EXIT_CODES.USAGE_ERROR);

    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(error['details']).toEqual({ argumentIndex: 1 });
  });

  it("il n'existe aucune option pour decrire une fenetre a la main (alerte n.19)", async () => {
    // La garantie d'identite vit dans `parseWindowEntry` : une fenetre qui viendrait de la
    // ligne de commande n'aurait traverse ni la validation de schema, ni la confrontation
    // au nom de fichier, ni la garde anti-reemploi de pid.
    const forged: readonly (readonly string[])[] = [
      ['windows', '--ext-host-pid', '11172'],
      ['whoami', '--window', '11172'],
      ['whoami', '--port=50933'],
    ];

    for (const argv of forged) {
      const result = await runCli(argv, contextFor(undefined, CALLER));
      expectFailure(result, EXIT_CODES.USAGE_ERROR);
    }
  });

  it('--help et --version repondent en JSON, code 0', async () => {
    const help = expectSuccess(await runCli(['--help'], contextFor(undefined, CALLER)));
    const usage = help['usage'] as Record<string, unknown>;
    expect((usage['commands'] as readonly Record<string, unknown>[]).map((c) => c['name'])).toEqual([
      'windows',
      'whoami',
      'open',
    ]);
    // Le cinquieme code est celui du repli V5 : ni un succes nominal, ni un echec.
    expect(Object.keys(usage['exitCodes'] as Record<string, string>)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
    ]);
    expect((usage['options'] as readonly Record<string, unknown>[]).map((o) => o['name'])).toContain(
      '--prompt-file <chemin>'
    );

    const version = expectSuccess(await runCli(['--version'], contextFor(undefined, CALLER)));
    expect(version).toEqual({ command: 'version', ok: true, name: 'cmgr', version: CLI_VERSION });

    // Les formes courtes sont les memes commandes, pas un chemin parallele.
    expect((await runCli(['-h'], contextFor(undefined, CALLER))).stdout).toBe(
      (await runCli(['--help'], contextFor(undefined, CALLER))).stdout
    );
    expect((await runCli(['-v'], contextFor(undefined, CALLER))).stdout).toBe(
      (await runCli(['--version'], contextFor(undefined, CALLER))).stdout
    );
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * `--help` EST MACHINE-LISIBLE : ce qu'il affirme est du CONTRAT, pas de la prose.
   *
   * Le resume d'`open` annoncait « firstTurnVerified, TOUJOURS false ». C'etait vrai en C2 ; le
   * correctif du 2026-07-26 a rendu ce champ `true` sur toute la voie amorcee, et le resume n'a
   * pas suivi — `git show` du correctif ne porte qu'une ligne sur ce fichier, le numero de
   * version. Rien ne gardait ce texte : `contract.test.ts` n'asserait que la structure et les
   * codes de sortie.
   *
   * Un agent qui lit « TOUJOURS false » conclut que le champ ne porte aucune information, alors
   * que c'est le champ sur lequel il decide. La regle verifiee ici est donc mecanique : AUCUNE
   * valeur de champ n'est donnee pour constante dans l'aide — un « toujours <valeur> » est
   * precisement l'affirmation qui se perime en silence au premier changement de comportement.
   * ─────────────────────────────────────────────────────────────────────────────────────────
   */
  describe('l aide ne donne aucune valeur de champ pour constante', () => {
    it("n annonce jamais un « TOUJOURS <valeur> » — c'est ce qui s'est perime en silence", () => {
      const declared = JSON.stringify(USAGE);

      expect(declared).not.toMatch(/TOUJOURS\s+(false|true|null|vide)/i);
      // La forme exacte du defaut, nommee : elle ne doit pas revenir par une reformulation.
      expect(declared).not.toContain('TOUJOURS false');
    });

    it("enonce les TROIS etats de firstTurnVerified, et lequel sort en 0", async () => {
      const summary = USAGE.commands.find((command) => command.name === 'open')?.summary ?? '';

      expect(summary).toContain('firstTurnVerified');
      // Les trois etats, et le code de sortie de chacun : c'est ce que `openingNote` dit deja a
      // l'humain sur `stderr`, et que l'aide taisait.
      expect(summary).toContain('TROIS etats');
      expect(summary).toContain('seeded');
      expect(summary).toContain('fallback');
      expect(summary).toContain('code 4');

      // ET IL EST VRAI : la valeur annoncee pour le cas nominal est celle que `open` rend
      // vraiment. Une aide juste au moment ou elle est ecrite ne prouve rien ; celle-ci est
      // confrontee au comportement.
      expect(summary).toContain('Seul cas qui sorte en code 0');
      const help = expectSuccess(await runCli(['--help'], contextFor(undefined, CALLER)));
      expect(JSON.stringify(help)).toContain('TROIS etats');
    });
  });

  it('la version annoncee est celle du manifeste', () => {
    // Meme garde que `tests/unit/vscode/manifest.test.ts` : deux nombres qui se
    // desolidarisent en silence font mentir `--version` sans qu'aucun test ne bronche.
    // C'est le prix assume de la constante — le manifeste n'est pas lisible depuis le code
    // EMIS sans dependre de la profondeur d'emission, qui est un detail de compilation.
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'packages', 'cli', 'package.json'), 'utf8')
    ) as Record<string, unknown>;

    expect(manifest['version']).toBe(CLI_VERSION);
    // Le binaire designe bien le point d'entree emis, pas une source `.ts`.
    expect((manifest['bin'] as Record<string, string>)['cmgr']).toBe('./dist/cli/src/cmgr.js');
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * UNE REMEDIATION NE RENVOIE JAMAIS A UNE COMMANDE QUI N'EXISTE PAS.
 *
 * Quatre remediations renvoyaient a `cmgr doctor`, qui n'a AUCUNE occurrence dans
 * `packages/cli/src`. Un agent qui recoit `SEED_TRANSCRIPT_NOT_FOUND`, lit « verifier avec
 * cmgr doctor » et l'execute obtient `CLI_USAGE`, exit 2 : la remediation ne se contente pas
 * d'etre inutile, elle FABRIQUE une seconde defaillance, d'une autre nature, qui egare le
 * diagnostic. Et ce sont les erreurs les plus probables du produit — les deux portes du CLI se
 * presentent des la premiere utilisation dans chaque nouveau dossier.
 *
 * La regle verifiee ici est mecanique : toute commande `cmgr <nom>` citee par une remediation
 * est soit livree — donc dans `USAGE` —, soit annoncee comme NON LIVREE dans la meme phrase.
 * Annoncer une cible future est legitime ; laisser croire qu'elle est disponible ne l'est pas.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
describe('la surface annoncee par les remediations est celle qui est livree', () => {
  it('aucune remediation ne renvoie a une commande absente sans le dire', () => {
    // La reference est `USAGE` lui-meme, pas une liste recopiee : le jour ou `cmgr close`
    // arrive, ce test cesse de l'exiger sans qu'on ait a y toucher.
    const delivered = new Set<string>([
      ...USAGE.commands.map((command) => command.name),
      // « --help, -h » -> « --help » : le premier jeton est le nom.
      ...USAGE.options.map((option) => option.name.split(/[ ,]/)[0] as string),
    ]);

    const cited: string[] = [];
    for (const code of Object.values(ERROR_CODES)) {
      const { remediation } = new ClaudeManagerError(code, 'peu importe');
      for (const match of remediation.matchAll(/cmgr (--)?([a-z][a-z-]*)/g)) {
        const name = `${match[1] ?? ''}${match[2] as string}`;
        cited.push(`${code}:${name}`);
        if (delivered.has(name)) continue;
        expect(
          remediation.toUpperCase(),
          `${code} renvoie a \`cmgr ${name}\`, qui n'est pas livre, sans le dire`
        ).toContain('PAS ENCORE LIVRE');
      }
    }

    // L'assertion serait VIDE si aucune remediation ne citait de commande : on le verifie.
    expect(cited.length).toBeGreaterThan(2);
  });

  it('cmgr doctor n est cite que comme une promesse, jamais comme un geste a faire', () => {
    // Contrôle positif : `windows` EST livre, et plusieurs remediations y renvoient sans reserve.
    const promises = Object.values(ERROR_CODES)
      .map((code) => new ClaudeManagerError(code, 'x'))
      .filter((error) => error.remediation.includes('cmgr doctor'));

    // L'assertion serait vide si plus rien ne le citait : on le verifie.
    expect(promises.length).toBeGreaterThan(0);
    for (const error of promises) {
      expect(error.remediation.toUpperCase(), error.code).toContain('PAS ENCORE LIVRE');
      // Le geste MANUEL qui marche, lui, est present : c'est ce que le lecteur peut faire ce soir.
      expect(error.remediation, error.code).toContain('A LA MAIN');
    }
  });
});

describe('defaillances', () => {
  it('PROCESS_TABLE_UNAVAILABLE est rendue telle quelle, code 1', async () => {
    // Le VRAI `readProcessTable`, par sa couture de test documentee : une sortie vide est
    // une anomalie — un processus se lit toujours au moins lui-meme.
    const result = await runCli(
      ['windows'],
      contextWithSnapshot(makeRegistryDir(), CALLER, () =>
        readProcessTable({ platform: 'win32', run: () => Promise.resolve('') })
      )
    );
    const error = expectFailure(result, EXIT_CODES.DOMAIN_ERROR);

    expect(error['code']).toBe('PROCESS_TABLE_UNAVAILABLE');
    expect(error['details']).toEqual({ platform: 'win32' });
  });

  it('REGISTRY_UNREADABLE est rendue telle quelle, sans le chemin du registre', async () => {
    // Un VRAI chemin qui existe sans etre un repertoire : `readdirSync` echoue reellement.
    const notADirectory = path.join(mkdtempSync(path.join(os.tmpdir(), 'cmgr-cli-')), 'registry');
    writeFileSync(notADirectory, 'ce n est pas un repertoire\n', 'utf8');

    const result = await runCli(['windows'], contextFor(notADirectory, CALLER));
    const error = expectFailure(result, EXIT_CODES.DOMAIN_ERROR);

    expect(error['code']).toBe('REGISTRY_UNREADABLE');
    // Le message systeme porterait le chemin, donc le nom du compte.
    expect(result.stdout).not.toContain(notADirectory);
    expect(result.stdout).not.toContain(os.homedir());
  });

  it('une defaillance imprevue sort en code 3, sans trace de pile ni message brut', async () => {
    const leaky = new TypeError(`boom at ${path.join(os.homedir(), 'secret')}`);

    const result = await runCli(
      ['whoami'],
      contextWithSnapshot(makeRegistryDir(), CALLER, () => {
        throw leaky;
      })
    );
    const error = expectFailure(result, EXIT_CODES.UNEXPECTED_ERROR);

    expect(error['code']).toBe('CLI_UNEXPECTED');
    // Le TYPE est conserve, il distingue un defaut de programmation d'une erreur systeme.
    expect(error['message']).toBe('TypeError(UNKNOWN)');
    expect(result.stdout).not.toContain(leaky.message);
    expect(result.stdout).not.toContain(os.homedir());
    // Premiere ligne d'une trace de pile serialisee : elle ne doit apparaitre nulle part.
    expect(result.stdout).not.toContain('TypeError: ');
    expect(result.stderr).not.toContain(os.homedir());
  });

  it('survit a ce qui n est meme pas une Error', async () => {
    // Une chaine levee n'a ni nom ni code : elle ne doit pas pour autant faire sortir la
    // CLI de son contrat.
    const result = await runCli(
      ['windows'],
      contextWithSnapshot(makeRegistryDir(), CALLER, () =>
        Promise.reject('c:\\Users\\quelqu-un\\quelque-chose')
      )
    );
    const error = expectFailure(result, EXIT_CODES.UNEXPECTED_ERROR);

    expect(error['message']).toBe('Unknown(UNKNOWN)');
    expect(result.stdout).not.toContain('quelqu-un');
  });

  it('reduit une defaillance systeme a son seul code', async () => {
    const systemLike = Object.assign(new Error('EPERM: operation not permitted, open ...'), {
      code: 'EPERM',
    });

    const result = await runCli(
      ['windows'],
      contextWithSnapshot(makeRegistryDir(), CALLER, () => Promise.reject(systemLike))
    );
    const error = expectFailure(result, EXIT_CODES.UNEXPECTED_ERROR);

    expect(error['message']).toBe('Error(EPERM)');
    expect(result.stdout).not.toContain('operation not permitted');
  });

  it('nomme la commande dans l enveloppe meme quand elle echoue', async () => {
    const dir = makeRegistryDir();
    copyLegacyEntriesInto(dir);

    const payload = expectSoleJsonValue(await runCli(['whoami'], contextFor(dir, CALLER)));
    expect(payload['command']).toBe('whoami');

    // Une erreur d'usage, elle, n'a pas de commande a nommer.
    const usage: CliResult = await runCli(['nope'], contextFor(dir, CALLER));
    expect(expectSoleJsonValue(usage)['command']).toBeNull();
  });
});

/**
 * S6 — DEUX REGLES CONTRADICTOIRES SUR LE MEME FLUX, et c'est la sortie qui tranchait.
 *
 * `SkippedEntry.file` ne porte JAMAIS de chemin absolu, « parce que ce champ part vers un
 * agent et vers des journaux, et que le chemin du registre porte le nom de l'utilisateur ».
 * Deux champs plus loin, `windows[].workspaceFolders` rendait `c:\Users\<compte>\...` en
 * clair, au MEME destinataire — et un agent colle cette sortie dans la PR d'un depot public,
 * ce que ce chantier fait deja pour ses logs d'integration.
 */
describe('aucun chemin personnel nulle part', () => {
  it('masque le repertoire personnel sans rien retirer du pouvoir de reconnaissance', async () => {
    const dir = makeRegistryDir();
    // Le VRAI repertoire personnel de la machine qui execute le test : un chemin invente ne
    // prouverait que l'existence d'un remplacement, pas qu'il vise le bon repertoire.
    const home = os.homedir();
    const folder = path.join(home, 'Documents', 'Github', 'ClaudeManager');
    const entry = {
      ...currentSchemaEntry(WINDOWS_ROLES.owningExtHostPid),
      workspaceFolders: [folder],
    };
    writeWindowEntry(entry, { dir });

    // L'assertion serait vide si le chemin reel n'etait pas sur disque : on le verifie.
    expect(readFileSync(path.join(dir, `${entry.extHostPid}.json`), 'utf8')).toContain(
      JSON.stringify(home).slice(1, -1)
    );

    for (const command of ['windows', 'whoami']) {
      const result = await runCli([command], contextFor(dir, CALLER));

      for (const stream of [result.stdout, result.stderr]) {
        expect(stream, `${command} — forme brute`).not.toContain(home);
        // La sortie est du JSON : sous Windows le chemin y est ECHAPPE (`c:\\Users\\...`),
        // et un masque qui ne connaitrait que la forme brute passerait a cote.
        expect(stream, `${command} — forme echappee`).not.toContain(
          JSON.stringify(home).slice(1, -1)
        );
      }
      // Ce qui reste identifie toujours la fenetre parmi plusieurs : seul le nom du compte
      // a disparu. Supprimer le champ aurait appauvri `cmgr windows`.
      expect(result.stdout, `${command} — reconnaissance`).toContain('ClaudeManager');
    }
  });
});

describe('aucun jeton nulle part', () => {
  it('ni sur stdout, ni sur stderr, sur AUCUNE des deux commandes', async () => {
    const dir = makeRegistryDir();
    // L'ordre COMPTE : la recopie ecraserait l'entree courante, les deux jeux de fixtures
    // portant les memes noms de fichier.
    copyLegacyEntriesInto(dir);
    const entry = currentSchemaEntry(WINDOWS_ROLES.owningExtHostPid);
    writeWindowEntry(entry, { dir });

    for (const command of ['windows', 'whoami']) {
      const result = await runCli([command], contextFor(dir, CALLER));
      expect(result.stdout, `stdout de ${command}`).not.toContain(entry.token);
      expect(result.stderr, `stderr de ${command}`).not.toContain(entry.token);
    }
  });
});
