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
import { neutralizeInheritedEnvironment, VSCODE_VERSION } from './environment.js';
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
  //
  // LIMITE ASSUMEE, ET DITE : ce masque ne couvre que ce que NOUS ecrivons. VSCode et
  // `@vscode/test-electron` ecrivent sur la meme sortie standard, en direct, et y laissent
  // trois lignes portant des chemins absolus (« Found existing install in… »,
  // « Loading development extension at… », la trace du mutex Inno Setup). Les intercepter
  // supposerait de detourner la sortie d'un processus fils, ce qui priverait la preuve de
  // son immediatete. Le harnais l'annonce donc explicitement au debut de chaque execution,
  // plutot que de laisser croire que tout est masque.
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
 * UN LANCEMENT DE VSCODE = UN ETAT DE FENETRE.
 *
 * Ce qui restait a prouver au lot B se joue a l'ETAT de la fenetre — un workspace
 * multi-racine ici, un fichier de workspace SANS dossier la —, et cet etat se fixe au
 * LANCEMENT : aucune commande ne fait passer une fenetre de l'un a l'autre. D'ou plusieurs
 * lancements successifs, chacun avec son workspace, son `user-data-dir` et son rapport.
 *
 * Ils sont joues EN SERIE, jamais en parallele : le harnais ecrit `cmgr-b3-current.json` a
 * un chemin fixe, et deux fenetres de test se disputeraient le registre reel du poste.
 */
interface Scenario {
  readonly key: string;
  readonly title: string;
  /**
   * Prepare le contenu du workspace et rend ce qu'il faut passer a VSCode pour l'ouvrir.
   * Rend un chemin de FICHIER `.code-workspace` ou de dossier, selon le scenario.
   */
  prepare(workspace: string): string;
}

/** Cree un dossier de travail sous le workspace du scenario, et rend son chemin. */
function makeFolder(workspace: string, name: string): string {
  const folder = path.join(workspace, name);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

/**
 * Ecrit un fichier `.code-workspace`.
 *
 * Les chemins de dossiers sont RELATIFS au fichier : c'est la forme que VSCode ecrit
 * lui-meme, et elle evite d'inscrire un chemin absolu du poste dans un fichier que le
 * harnais pourrait un jour imprimer.
 */
function writeWorkspaceFile(workspace: string, name: string, folders: readonly string[]): string {
  const file = path.join(workspace, name);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ folders: folders.map((folder) => ({ path: folder })) }, null, 2)}\n`,
    'utf8'
  );
  return file;
}

const SCENARIOS: readonly Scenario[] = [
  {
    key: 'nominal',
    title: 'fenetre publiee — activation autonome, /health, isolation, republication, onglets',
    prepare(workspace) {
      // MULTI-RACINE, ET C'EST UNE CONTRAINTE, PAS UN GOUT. Le scenario ajoute un dossier en
      // cours de route : hors d'un workspace identifie, ou quand le PREMIER dossier change,
      // VSCode recharge la fenetre et redemarre l'extension host — la suite mourrait avec.
      // Deux dossiers au depart, un troisieme ajoute a la fin : le premier ne bouge jamais.
      makeFolder(workspace, 'folder-a');
      makeFolder(workspace, 'folder-b');
      makeFolder(workspace, 'late-folder');
      return writeWorkspaceFile(workspace, 'nominal.code-workspace', ['folder-a', 'folder-b']);
    },
  },
  {
    key: 'empty-workspace',
    title: 'fenetre SANS dossier de travail — refus nomme, aucune ecoute laissee, reprise',
    prepare(workspace) {
      // Un fichier de workspace SANS aucun dossier : `workspaceFolders` est vide, donc le
      // coeur refuse de publier — et la fenetre reste dans l'etat `WORKSPACE`, ce qui permet
      // d'ajouter le premier dossier sans rechargement.
      makeFolder(workspace, 'late-folder');
      return writeWorkspaceFile(workspace, 'empty.code-workspace', []);
    },
  },
];

interface ScenarioRun {
  readonly scenario: Scenario;
  readonly workspace: string;
  readonly userDataDir: string;
  readonly reportPath: string;
  readonly failure: unknown;
  readonly report: { readonly extHostPid?: number } | undefined;
}

async function runScenario(
  scenario: Scenario,
  common: {
    readonly repoRoot: string;
    readonly executable: string;
    readonly extensionDevelopmentPath: string;
    readonly extensionTestsPath: string;
  }
): Promise<ScenarioRun> {
  // PIEGE n.2 : jamais le dossier du depot — un dossier DEDIE, sinon VSCode route la
  // demande vers la fenetre qui l'a deja ouvert et la fenetre de test se retrouve sans
  // workspace, donc sans entree publiee.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cmgr-b3-ws-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmgr-b3-uds-'));
  const reportPath = path.join(os.tmpdir(), `cmgr-b3-report-${process.pid}-${scenario.key}.json`);
  const launchTarget = scenario.prepare(workspace);

  say('');
  say(`===== SCENARIO ${scenario.key} : ${scenario.title} =====`);
  say(`[runTests] workspace de test    : ${workspace}`);
  say(`[runTests] user-data-dir        : ${userDataDir}`);
  say(`[runTests] rapport              : ${reportPath}`);
  // Le script de mesure du focus s'en sert pour reperer puis minimiser la fenetre.
  fs.writeFileSync(
    path.join(os.tmpdir(), 'cmgr-b3-current.json'),
    JSON.stringify({ scenario: scenario.key, workspace, userDataDir, reportPath }),
    'utf8'
  );

  let failure: unknown;
  try {
    await runTests({
      vscodeExecutablePath: common.executable,
      extensionDevelopmentPath: common.extensionDevelopmentPath,
      extensionTestsPath: common.extensionTestsPath,
      extensionTestsEnv: {
        CMGR_B3_SCENARIO: scenario.key,
        CMGR_B3_REPORT: reportPath,
        CMGR_B3_USER_DATA: userDataDir,
        // La suite y lit la fixture 0.1.0 reelle dont elle derive son entree fabriquee :
        // son `__dirname` est sous `dist/`, la racine ne s'en deduit pas sans convention.
        CMGR_B3_REPO_ROOT: common.repoRoot,
        // Ou le scenario trouve ce que le lanceur lui a prepare — le dossier a ajouter en
        // cours de route, notamment : l'extension host ne connait pas nos temporaires.
        CMGR_B3_SCRATCH: workspace,
      },
      launchArgs: [
        launchTarget,
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
    say(`\n===== RAPPORT DU SCENARIO ${scenario.key} (rendu par l extension host) =====`);
    say(fs.readFileSync(reportPath, 'utf8'));
    say(`===== FIN DU RAPPORT ${scenario.key} =====\n`);
  } else {
    say(`\n[runTests] AUCUN RAPPORT POUR ${scenario.key} — la suite a echoue avant son terme.\n`);
  }

  const report = fs.existsSync(reportPath)
    ? (JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { extHostPid?: number })
    : undefined;

  // POINT 8 — la desactivation ne s'observe pas de l'interieur : on la constate ICI, une
  // fois la fenetre fermee. `deactivate` retire l'entree ; s'il n'a pas ete joue (fenetre
  // tuee), l'entree survit et c'est le balayage qui la reprendra. On le dit tel quel.
  if (report?.extHostPid !== undefined) {
    const entry = path.join(os.homedir(), '.claudemanager', 'windows', `${report.extHostPid}.json`);
    say(
      fs.existsSync(entry)
        ? `[point 8/${scenario.key}] l entree ${report.extHostPid}.json EXISTE ENCORE : deactivate n a pas ete joue, elle reste purgeable au prochain balayage.`
        : `[point 8/${scenario.key}] l entree ${report.extHostPid}.json a DISPARU : deactivate a bien retire cette fenetre du registre.`
    );
  }

  return { scenario, workspace, userDataDir, reportPath, failure, report };
}

async function main(): Promise<void> {
  const here = __dirname;
  // `here` vaut <racine>/tests/integration/dist/tests/integration/src, soit SIX segments
  // sous la racine du depot — la double imbrication vient de `rootDir` place a la racine,
  // qui preserve les chemins relatifs entre la suite et le coeur compile a cote.
  const repoRoot = path.resolve(here, '..', '..', '..', '..', '..', '..');
  const extensionDevelopmentPath = path.join(repoRoot, 'packages', 'vscode');
  const extensionTestsPath = path.join(here, 'suite.js');

  const neutralized = neutralizeInheritedEnvironment();
  say(
    neutralized.length === 0
      ? '[runTests] environnement : deja propre, aucune variable heritee.'
      : `[runTests] environnement assaini, ${neutralized.length} variables heritees supprimees : ${neutralized.join(', ')}`
  );

  say(
    '[runTests] AVANT DE COLLER CE LOG DANS UNE PR : les lignes [runTests] et les rapports sont ' +
      'masques ; celles emises par VSCode lui-meme ne le sont pas et portent des chemins absolus.'
  );
  say(`[runTests] version VSCode epinglee : ${VSCODE_VERSION}`);
  say(`[runTests] extension            : ${path.relative(repoRoot, extensionDevelopmentPath)}`);
  say(`[runTests] scenarios            : ${SCENARIOS.map((s) => s.key).join(', ')}`);

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

  const runs: ScenarioRun[] = [];
  for (const scenario of SCENARIOS) {
    // EN SERIE, ET ON NE S'ARRETE PAS AU PREMIER ECHEC : chaque scenario eprouve un etat de
    // fenetre different, et un rapport partiel vaut mieux qu'une preuve interrompue. Le code
    // de sortie, lui, retient le moindre echec.
    runs.push(
      await runScenario(scenario, {
        repoRoot,
        executable,
        extensionDevelopmentPath,
        extensionTestsPath,
      })
    );
  }

  const workspace = runs.map((run) => run.workspace);
  const userDataDir = runs.map((run) => run.userDataDir);
  const failure = runs.find((run) => run.failure !== undefined)?.failure;

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
  const ours = new Set([...workspace, ...userDataDir]);
  const leftovers = findHarnessLeftovers(os.tmpdir()).filter((item) => !ours.has(item));
  const outcomes: RemovalOutcome[] = [];
  for (const target of [...ours, ...leftovers]) {
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

  for (const run of runs) {
    say(
      run.failure === undefined
        ? `[runTests] scenario ${run.scenario.key} : OK`
        : `[runTests] scenario ${run.scenario.key} : ECHEC — ${
            run.failure instanceof Error ? run.failure.message : String(run.failure)
          }`
    );
  }

  if (failure !== undefined) {
    say('[runTests] ECHEC : au moins un scenario n a pas passe ses assertions.');
    process.exit(1);
  }
  say(
    `[runTests] SUCCES — ${SCENARIOS.length} scenarios, tous les points verifies dans de vraies fenetres.`
  );
}

void main();
