/**
 * Lanceur des tests d'integration : telecharge un VSCode, l'ouvre sur un dossier dedie et
 * y execute `suite.ts` dans l'extension host.
 *
 * POURQUOI `@vscode/test-electron` PLUTOT QUE `--extensionDevelopmentPath` sur le VSCode
 * du poste : il telecharge sa PROPRE instance sous `.vscode-test/`, donc la preuve ne
 * depend plus de l'etat de l'installation locale — laquelle, sur le poste de reference,
 * ne sait plus demarrer d'instance neuve.
 */

import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findHarnessLeftovers, removeQuietly, type RemovalOutcome } from './cleanup.js';
import { VSCODE_VERSION } from './environment.js';
import { mask } from './redaction.js';

/**
 * Ou atterrit le VSCode telecharge (242 Mo).
 *
 * PAS `.vscode-test/` a la racine, bien qu'il soit deja ignore par git : ESLint, lui, ne
 * l'ignore pas — sa configuration n'ecarte que `dist`, `coverage` et `node_modules` — et
 * `npm run lint` part alors analyser tout le code source de VSCode, jusqu'a saturer la
 * memoire de V8. `node_modules/.cache/` est la convention etablie pour les caches
 * d'outils, et il est ecarte par git ET par ESLint. La configuration ESLint n'a donc pas
 * a etre touchee.
 */
const CACHE_DIRECTORY = ['node_modules', '.cache', 'vscode-test'];

/**
 * Le lanceur est le seul a rendre compte a l'humain, mais `tests/**` n'est pas une des
 * surfaces de sortie autorisees par ESLint (`no-console` n'y est pas leve, et le
 * reglage ne se modifie pas depuis cet increment). On ecrit donc directement sur la
 * sortie standard, ce qui revient au meme sans deroger a la regle.
 */
function say(line: string): void {
  // TOUTE sortie du lanceur passe par le masque, y compris le rapport rendu par la suite —
  // qui l'applique deja de son cote, la double application etant sans effet (finding S7).
  process.stdout.write(`${mask(line)}\n`);
}

/**
 * Neutralise, SUR NOTRE PROPRE COPIE TELECHARGEE, le verrou de mise a jour d'Inno Setup.
 *
 * Avant de refuser de demarrer, VSCode teste un mutex nomme `vscode-updating`, GLOBAL A LA
 * MACHINE, qui signale qu'un installeur Inno Setup est en cours. La garde exacte est
 * `isWindows && product.win32MutexName && product.win32VersionedUpdate`.
 *
 * Ce verrou protege une installation geree par Inno Setup contre un demarrage pendant que
 * son repertoire est reecrit. Or la copie de `.vscode-test/` est une simple EXTRACTION
 * D'ARCHIVE : aucun installeur ne la reecrit jamais. Elle se retrouve donc bloquee par la
 * mise a jour d'une installation TIERCE — celle du poste —, sur laquelle elle n'a aucune
 * prise. Le verrou est inapplicable ici par construction, pas contourne par commodite.
 *
 * PORTEE STRICTE : seul `.vscode-test/` est touche — jamais l'installation de
 * l'utilisateur, qui n'est ni lue ni modifiee. Le repertoire est ignore par git et
 * reconstruit a chaque telechargement, donc l'operation est rejouee a l'identique.
 *
 * Rien de ce qui est sous test n'en depend : ni l'activation, ni le registre, ni le
 * serveur, ni le focus. C'est un interverrouillage d'installation, pas un comportement
 * d'editeur.
 */
function neutralizeInnoSetupInterlock(executable: string): string | undefined {
  const root = path.dirname(executable);
  const directories = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => path.join(root, item.name, 'resources', 'app', 'product.json'));
  const file = [path.join(root, 'resources', 'app', 'product.json'), ...directories].find((candidate) =>
    fs.existsSync(candidate)
  );
  if (file === undefined) return undefined;

  const product = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (product['win32VersionedUpdate'] === undefined) return undefined;
  delete product['win32VersionedUpdate'];
  fs.writeFileSync(file, JSON.stringify(product, null, 2), 'utf8');
  return file;
}

/**
 * Familles de variables qu'une session Claude propage a tout ce qu'elle lance.
 *
 * Les huit `CLAUDE*` sont celles de l'alerte n.6 ; s'y ajoutent les `VSCODE_*`, `ELECTRON_*`
 * et `CHROME_*` de l'extension host hote — dix-neuf en tout sur le poste de reference.
 */
const INHERITED_ENVIRONMENT = /^(CLAUDECODE|CLAUDE_|VSCODE_|ELECTRON_|CHROME_)/;

/**
 * Assainit l'environnement du lanceur AVANT de demarrer le VSCode de test.
 *
 * SANS CELA, LE HARNAIS NE FONCTIONNE PAS LA OU IL COMPTE. Lance depuis une session Claude
 * — la configuration de PRODUCTION de ClaudeManager, pas un cas limite —, il herite
 * d'`ELECTRON_RUN_AS_NODE=1` : le binaire VSCode demarre alors en Node et traite le premier
 * argument de lancement comme un script, d'ou un `Cannot find module <dossier de travail>`
 * dont rien n'indique la cause. Mesure a l'appui : identique, l'appel passe depuis un shell
 * propre et echoue depuis un shell contamine.
 *
 * On SUPPRIME les variables, on ne les vide pas : Electron teste leur PRESENCE, une chaine
 * vide serait toujours vue comme definie. C'est la meme regle qui vaudra pour le terminal
 * masque du lot C.
 *
 * On DIT ce qu'on a retire, plutot que d'assainir en silence : l'environnement d'execution
 * fait partie de ce qu'une preuve doit exposer (principe fondateur n.3).
 */
function neutralizeInheritedEnvironment(): readonly string[] {
  const inherited = Object.keys(process.env).filter((name) => INHERITED_ENVIRONMENT.test(name));
  for (const name of inherited) delete process.env[name];
  return inherited.sort();
}

async function main(): Promise<void> {
  const here = __dirname;
  // `here` vaut <racine>/tests/integration/dist/tests/integration/src, soit SIX segments
  // sous la racine du depot — la double imbrication vient de `rootDir` place a la racine,
  // qui preserve les chemins relatifs entre la suite et le coeur compile a cote.
  const repoRoot = path.resolve(here, '..', '..', '..', '..', '..', '..');
  const extensionDevelopmentPath = path.join(repoRoot, 'packages', 'vscode');
  const extensionTestsPath = path.join(here, 'suite.js');

  // PIEGE n.2 : jamais le dossier du depot — un dossier DEDIE, sinon VSCode route la
  // demande vers la fenetre qui l'a deja ouvert et la fenetre de test se retrouve sans
  // workspace, donc sans entree publiee.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cmgr-b3-ws-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmgr-b3-uds-'));
  const reportPath = path.join(os.tmpdir(), `cmgr-b3-report-${process.pid}.json`);

  const neutralized = neutralizeInheritedEnvironment();
  say(
    neutralized.length === 0
      ? '[runTests] environnement : deja propre, aucune variable heritee.'
      : `[runTests] environnement assaini, ${neutralized.length} variables heritees supprimees : ${neutralized.join(', ')}`
  );

  say(`[runTests] version VSCode epinglee : ${VSCODE_VERSION}`);
  say(`[runTests] extension            : ${path.relative(repoRoot, extensionDevelopmentPath)}`);
  say(`[runTests] workspace de test    : ${workspace}`);
  say(`[runTests] user-data-dir        : ${userDataDir}`);
  say(`[runTests] rapport              : ${reportPath}`);
  // Le script de mesure du focus s'en sert pour reperer puis minimiser la fenetre.
  fs.writeFileSync(path.join(os.tmpdir(), 'cmgr-b3-current.json'), JSON.stringify({ workspace, userDataDir, reportPath }), 'utf8');

  // `test-electron` cree le repertoire de cache sans `recursive` : on s'assure qu'il existe.
  const cachePath = path.join(repoRoot, ...CACHE_DIRECTORY);
  fs.mkdirSync(cachePath, { recursive: true });
  const executable = await downloadAndUnzipVSCode({ version: VSCODE_VERSION, cachePath });
  const patched = neutralizeInnoSetupInterlock(executable);
  say(
    patched === undefined
      ? '[runTests] verrou Inno Setup : deja neutralise sur la copie de test.'
      : `[runTests] verrou Inno Setup neutralise sur la copie de test (${path.relative(repoRoot, patched)}).`
  );

  let failure: unknown;
  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: {
        CMGR_B3_REPORT: reportPath,
        CMGR_B3_USER_DATA: userDataDir,
        // La suite y lit la fixture 0.1.0 reelle dont elle derive son entree fabriquee :
        // son `__dirname` est sous `dist/`, la racine ne s'en deduit pas sans convention.
        CMGR_B3_REPO_ROOT: repoRoot,
      },
      launchArgs: [
        workspace,
        '--disable-workspace-trust',
        '--user-data-dir',
        userDataDir,
        // Aucune autre extension : la fenetre de test ne doit contenir que la notre.
        '--disable-extensions',
      ],
    });
  } catch (error) {
    failure = error;
  }

  if (fs.existsSync(reportPath)) {
    say('\n===== RAPPORT DE LA SUITE (rendu par l extension host) =====');
    say(fs.readFileSync(reportPath, 'utf8'));
    say('===== FIN DU RAPPORT =====\n');
  } else {
    say('\n[runTests] AUCUN RAPPORT PRODUIT — la suite a echoue avant son terme.\n');
  }

  // POINT 8 — la desactivation ne s'observe pas de l'interieur : on la constate ICI, une
  // fois la fenetre fermee. `deactivate` retire l'entree ; s'il n'a pas ete joue (fenetre
  // tuee), l'entree survit et c'est le balayage qui la reprendra. On le dit tel quel.
  const report = fs.existsSync(reportPath)
    ? (JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { extHostPid?: number })
    : undefined;
  if (report?.extHostPid !== undefined) {
    const entry = path.join(os.homedir(), '.claudemanager', 'windows', `${report.extHostPid}.json`);
    say(
      fs.existsSync(entry)
        ? `[point 8] l entree ${report.extHostPid}.json EXISTE ENCORE : deactivate n a pas ete joue, elle reste purgeable au prochain balayage.`
        : `[point 8] l entree ${report.extHostPid}.json a DISPARU : deactivate a bien retire cette fenetre du registre.`
    );
  }

  // ---- Hygiene : rapportee, jamais bloquante, jamais silencieuse ------------------------
  // Le code de sortie ci-dessous ne depend QUE des assertions. Une poignee que VSCode n'a
  // pas encore relachee sur son `--user-data-dir` est un fait du systeme, pas un verdict de
  // test : elle se temporise, se dit, et ne fait pas echouer un critere de merge (B1).
  //
  // Sont balayes en meme temps les residus des executions PRECEDENTES : rapports et fichier
  // de position n'etaient effaces par personne et s'accumulaient dans le repertoire
  // temporaire, tout comme le `user-data-dir` d'un run interrompu par cet EPERM meme.
  //
  // Balayer le temporaire d'AUTRUI n'est pas un risque ici : deux executions simultanees
  // sont deja impossibles par construction, `cmgr-b3-current.json` etant ecrit a un chemin
  // fixe que la seconde ecraserait.
  const leftovers = findHarnessLeftovers(os.tmpdir()).filter(
    (item) => item !== workspace && item !== userDataDir
  );
  const outcomes: RemovalOutcome[] = [];
  for (const target of [workspace, userDataDir, ...leftovers]) {
    outcomes.push(await removeQuietly(target));
  }
  const failed = outcomes.filter((outcome) => !outcome.removed);
  say(
    failed.length === 0
      ? `[runTests] hygiene : ${outcomes.length} elements temporaires supprimes.`
      : `[runTests] hygiene : ${outcomes.length - failed.length}/${outcomes.length} supprimes, ` +
          `${failed.length} RESISTANT(S) — ${failed
            .map((outcome) => `${path.basename(outcome.target)} (${outcome.code}, ${outcome.attempts} tentatives)`)
            .join(', ')}. Sans effet sur le verdict : ces elements sont a supprimer a la main.`
  );

  if (failure !== undefined) {
    say(`[runTests] ECHEC : ${failure instanceof Error ? failure.message : String(failure)}`);
    process.exit(1);
  }
  say('[runTests] SUCCES — tous les points verifies dans une vraie fenetre.');
}

void main();
