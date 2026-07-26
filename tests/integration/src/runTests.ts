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
import { windowEntryFileName, windowEntryPath } from '../../../packages/core/src/index.js';
import {
  acquireHarnessLock,
  findHarnessLeftovers,
  HARNESS_LOCK_FILE,
  releaseHarnessLock,
  removeQuietly,
  type RemovalOutcome,
} from './cleanup.js';
import {
  dismantleClaudeExtension,
  findClaudeExtension,
  mountClaudeExtension,
  type ClaudeExtensionMount,
} from './claudeExtension.js';
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
   *
   * `imposed` dit que le repertoire vient de l'utilisateur (`CMGR_OPEN_WS`) et non de
   * `mkdtemp` : le scenario ouvre alors CE dossier, sans en creer un sous-dossier — c'est son
   * chemin exact qui porte la reponse de confiance du CLI.
   */
  prepare(workspace: string, imposed?: boolean): string;
  /**
   * Arguments de lancement PROPRES a ce scenario, ajoutes aux communs.
   *
   * Le lot B lance tout avec `--disable-extensions` : la fenetre de test ne contient que la
   * notre. L'increment C1 a besoin de l'extension Claude — ce crochet existe pour que ce
   * besoin ne change RIEN aux scenarios existants, dont le comportement doit rester
   * exactement celui qui a ete mesure.
   */
  launchArgs?(workspace: string, mountRoot: string): readonly string[];
  /**
   * Demonte ce que `launchArgs` a monte, AVANT tout menage recursif du lanceur.
   *
   * Rend une ligne de compte-rendu. LEVE si le demontage n'est pas complet : le lanceur ne
   * doit alors rien balayer — voir `claudeExtension.ts`.
   */
  teardown?(workspace: string): string;
  /** Variables supplementaires posees sur le processus VSCode de ce scenario. */
  extraEnv?(): Readonly<Record<string, string>>;
}

/**
 * LES NOMS D'UNE SESSION CLAUDE, REINJECTES A DESSEIN.
 *
 * Le lanceur ASSAINIT son propre environnement avant de demarrer VSCode — sans quoi
 * `ELECTRON_RUN_AS_NODE` fait demarrer le binaire en Node. Consequence : dans la fenetre de
 * test, l'extension host n'a AUCUN `CLAUDE*`, et l'assertion « aucune variable heritee n'a
 * survecu » serait VRAIE SANS RIEN EPROUVER — mesure du premier passage : zero variable a
 * neutraliser, donc zero garde exercee.
 *
 * On les remet donc, sous leurs VRAIS noms — ceux de la capture reelle
 * (`tests/fixtures/environment/claude-session-env-names.json`) — avec des valeurs marquees.
 * C'est la configuration de PRODUCTION de ClaudeManager : une fenetre VSCode lancee depuis
 * une session Claude les porte toutes.
 *
 * `CLAUDE_CODE_SSE_PORT` n'y figure PAS, et c'est voulu : elle n'est jamais heritee, elle est
 * injectee par l'extension Claude de la fenetre elle-meme.
 */
const REINJECTED_CLAUDE_ENVIRONMENT: Readonly<Record<string, string>> = {
  CLAUDECODE: '1',
  CLAUDE_AGENT_SDK_VERSION: 'cmgr-c1-marker',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
  CLAUDE_CODE_ENABLE_TASKS: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_EXECPATH: 'cmgr-c1-marker',
  CLAUDE_CODE_SESSION_ID: 'cmgr-c1-marker',
  CLAUDE_EFFORT: 'cmgr-c1-marker',
  CLAUDE_PID: '424242',
};

/**
 * `--disable-extensions` : la fenetre de test ne contient que la notre.
 *
 * DEFAUT DE TOUS LES SCENARIOS, retire par UN SEUL, qui doit charger l'extension Claude.
 */
const ISOLATED_EXTENSIONS: readonly string[] = ['--disable-extensions'];

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
  {
    key: 'open-conversation',
    title:
      'mecanisme V1 — vraie conversation ouverte, attachement prouve par diff d onglets, repli V5',
    prepare(workspace, imposed) {
      // UN DOSSIER SIMPLE, pas un `.code-workspace` : c'est le `cwd` que le mecanisme donnera
      // au terminal, et il doit etre un vrai dossier de travail de la fenetre.
      //
      // IMPOSE : on ouvre CE dossier, sans sous-dossier. La reponse de confiance du CLI est
      // enregistree pour un CHEMIN EXACT — creer un `projet/` dedans la rendrait sans effet, et
      // le scenario retomberait sur la porte qu'on voulait justement avoir franchie.
      return imposed === true ? workspace : makeFolder(workspace, 'projet');
    },
    launchArgs(workspace, mountRoot) {
      const installed = findClaudeExtension();
      if (installed === undefined) {
        // ECHOUER EN LE DISANT : sans l'extension Claude, ce scenario n'a rien a mesurer.
        throw new Error(
          "No anthropic.claude-code extension found under ~/.vscode/extensions: this scenario measures the real mechanism and cannot be run without it"
        );
      }
      // LA JONCTION NE VA PAS TOUJOURS DANS LE WORKSPACE, et c'est necessaire : quand le dossier
      // ouvert EST le workspace (cas impose), une jonction posee dedans ferait indexer par la
      // fenetre l'installation entiere de l'extension Claude. Le lanceur designe donc la racine
      // de montage ; par defaut, c'est le workspace, comme au premier jour.
      const mount = mountClaudeExtension(mountRoot, installed);
      mounts.set(workspace, mount);
      say(`[runTests] extension Claude jonctionnee : ${mount.installed} (version ${mount.version})`);
      // `--disable-extensions` est RETIRE pour ce scenario, et pour lui seul.
      return ['--extensions-dir', mount.extensionsDir];
    },
    extraEnv: () => REINJECTED_CLAUDE_ENVIRONMENT,
    teardown(workspace) {
      const mount = mounts.get(workspace);
      if (mount === undefined) return 'aucune jonction posee';
      // LEVE si un lien subsiste : le lanceur ne balaiera alors rien recursivement.
      const dismantled = dismantleClaudeExtension(mount);
      mounts.delete(workspace);
      return `jonction(s) retiree(s) AVANT tout menage recursif : ${dismantled.removedLinks.join(', ') || 'aucune'}`;
    },
  },
];

/** Les montages en cours, par workspace : `launchArgs` les pose, `teardown` les retire. */
const mounts = new Map<string, ClaudeExtensionMount>();

interface ScenarioRun {
  readonly scenario: Scenario;
  readonly workspace: string;
  readonly userDataDir: string;
  readonly reportPath: string;
  readonly failure: unknown;
  readonly report: { readonly extHostPid?: number } | undefined;
  /**
   * Le harnais a-t-il CREE ce workspace ? S'il ne l'a pas cree, il ne le supprime pas.
   *
   * Un seul cas rend cette distinction necessaire, et il est nomme : `CMGR_OPEN_WS`. Le
   * repertoire designe appartient alors a l'utilisateur — c'est meme tout son interet, la
   * confiance du CLI y ayant ete accordee une fois — et le menage de fin de run est RECURSIF.
   */
  readonly removable: boolean;
}

/**
 * WORKSPACE IMPOSE POUR `open-conversation` — et voici pourquoi ce levier existe.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * Le CLI interactif pose la question de confiance PAR REPERTOIRE (ADR-002), et ce harnais
 * travaille par construction sur un dossier temporaire NEUF (piege n.2 : jamais le dossier du
 * depot). MESURE DU 2026-07-26 : dans un dossier neuf, le CLI s'arrete dans `showSetupScreens()`
 * et n'ecrit AUCUN transcript — 180 s d'observation. La voie COMPLETE du mecanisme n'y est donc
 * pas atteignable, et le franchissement de cette porte est INTERDIT (son libelle n'est pas
 * contractuel ; c'est `cmgr doctor`, lot D, qui devra la nommer).
 *
 * Le scenario ne s'en accommode pas en silence : il RELEVE l'etat de la confiance et choisit son
 * assertion — tour verifie d'un cote, erreur NOMMEE de l'autre. Aucun des deux cotes n'accepte le
 * succes muet, qui etait precisement le defaut.
 *
 * Ce levier permet de jouer la voie complete sur un dossier dont un HUMAIN a accorde la confiance
 * une fois, sans rien franchir a la place de personne :
 *
 *     CMGR_OPEN_WS=<dossier deja approuve par le CLI> npm run test:integration
 *
 * Il ne change RIEN au comportement par defaut, et le repertoire designe n'est jamais supprime.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
const IMPOSED_OPEN_WORKSPACE = 'CMGR_OPEN_WS';

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
  const imposed = scenario.key === 'open-conversation' ? process.env[IMPOSED_OPEN_WORKSPACE] : undefined;
  const removable = imposed === undefined || imposed.length === 0;
  const workspace = removable
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'cmgr-b3-ws-'))
    : (fs.mkdirSync(imposed as string, { recursive: true }), imposed as string);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmgr-b3-uds-'));
  const reportPath = path.join(os.tmpdir(), `cmgr-b3-report-${process.pid}-${scenario.key}.json`);
  const launchTarget = scenario.prepare(workspace, !removable);

  say('');
  say(`===== SCENARIO ${scenario.key} : ${scenario.title} =====`);
  say(`[runTests] workspace de test    : ${workspace}`);
  if (!removable) {
    say(
      `[runTests] workspace IMPOSE par ${IMPOSED_OPEN_WORKSPACE} : il n est ni cree ni supprime par ` +
        'le harnais. La voie complete du mecanisme y est jouable si le CLI y a deja recu sa reponse ' +
        'de confiance.'
    );
  }
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
    // La racine de montage est le workspace au cas ordinaire, et le `--user-data-dir` quand le
    // dossier ouvert appartient a l'utilisateur : dans les deux cas un temporaire que le harnais
    // supprime, jamais l'installation du poste.
    const extraArgs =
      scenario.launchArgs?.(workspace, removable ? workspace : userDataDir) ?? ISOLATED_EXTENSIONS;
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
        ...(scenario.extraEnv?.() ?? {}),
      },
      launchArgs: [
        launchTarget,
        '--disable-workspace-trust',
        '--user-data-dir',
        userDataDir,
        ...extraArgs,
      ],
    });
  } catch (error) {
    failure = error;
  }

  // LE DEMONTAGE PASSE AVANT TOUT LE RESTE, echec compris : ce qui a ete monte porte des
  // JONCTIONS vers l'installation de l'utilisateur, et le balayage de fin de run est
  // recursif. Une exception ici est VOLONTAIREMENT laissee remonter — mieux vaut un harnais
  // qui s'arrete qu'un harnais qui efface l'extension Claude du poste.
  const teardown = scenario.teardown?.(workspace);
  if (teardown !== undefined) say(`[runTests] demontage ${scenario.key} : ${teardown}`);

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
  //
  // LE CHEMIN VIENT DU COEUR (finding C5, alerte n.33). Cette ligne reencodait a la main le
  // repertoire ET le nom du fichier, seul endroit du depot a le faire sans aucune garde. Une
  // convention changee au lot C n'y aurait rien casse — l'`existsSync` aurait simplement
  // toujours rendu `false` — et ce bloc aurait imprime « a DISPARU » a chaque execution : une
  // preuve FAUSSE dans un journal joint a une PR, donc dans un critere de merge.
  if (report?.extHostPid !== undefined) {
    const entry = windowEntryPath(report.extHostPid);
    const name = windowEntryFileName(report.extHostPid);
    say(
      fs.existsSync(entry)
        ? `[point 8/${scenario.key}] l entree ${name} EXISTE ENCORE : deactivate n a pas ete joue, elle reste purgeable au prochain balayage.`
        : `[point 8/${scenario.key}] l entree ${name} a DISPARU : deactivate a bien retire cette fenetre du registre.`
    );
  }

  return { scenario, workspace, userDataDir, reportPath, failure, report, removable };
}

/**
 * Deroule les scenarios, verrou en main.
 *
 * Le corps de `main` d'avant le finding S7 : ce qui l'entoure desormais est l'exclusion
 * mutuelle qui rend le balayage des residus d'autrui legitime.
 */
async function runAllScenarios(): Promise<boolean> {
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

  // CE QUI EST A NOUS, ET RIEN D'AUTRE : un workspace impose par `CMGR_OPEN_WS` appartient a
  // l'utilisateur, et le menage ci-dessous est RECURSIF. On ne supprime que ce qu'on a cree.
  const workspace = runs.filter((run) => run.removable).map((run) => run.workspace);
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
  // BALAYER LE TEMPORAIRE D'AUTRUI EST SUR PARCE QU'UN VERROU LE GARANTIT, et c'est le
  // correctif du finding S7 : la justification precedente — « deux executions simultanees sont
  // deja impossibles par construction, `cmgr-b3-current.json` etant ecrit a un chemin fixe que
  // la seconde ecraserait » — etait FAUSSE. Un chemin fixe ecrase ne bloque rien, il perd une
  // information : les deux runs demarraient, et ce balayage-ci supprimait le `--user-data-dir`
  // d'un VSCode EN COURS D'EXECUTION. Le verrou est pris au tout debut de `main`, avant le
  // moindre lancement, et rendu ci-dessous.
  //
  // DEUX ENSEMBLES, ET NON UN : ce qu'on SUPPRIME, et ce qu'on PROTEGE du balayage des residus
  // d'autrui. Un workspace impose par `CMGR_OPEN_WS` est dans le second et pas dans le premier —
  // sans cette distinction, un dossier de l'utilisateur nomme comme un temporaire du harnais
  // serait efface par le balayage alors meme qu'on vient de refuser de le supprimer.
  const removals = new Set([...workspace, ...userDataDir]);
  const protectedPaths = new Set(runs.flatMap((run) => [run.workspace, run.userDataDir]));
  const leftovers = findHarnessLeftovers(os.tmpdir()).filter((item) => !protectedPaths.has(item));
  const outcomes: RemovalOutcome[] = [];
  for (const target of [...removals, ...leftovers]) {
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
    // Le VERDICT est rendu a l'appelant plutot que joue ici : `process.exit` court-circuite
    // les `finally`, et le verrou d'execution resterait derriere lui a chaque echec.
    return false;
  }
  say(
    `[runTests] SUCCES — ${SCENARIOS.length} scenarios, tous les points verifies dans de vraies fenetres.`
  );
  return true;
}

/**
 * REFUSER DE DEMARRER PLUTOT QUE DE NUIRE A UN AUTRE RUN (finding S7).
 *
 * Un second harnais n'a de toute facon aucune chance d'etre juste : les deux ecrivent dans le
 * registre REEL du poste, se disputent `cmgr-b3-current.json`, et le balayage de l'un
 * supprimerait le `--user-data-dir` de l'autre pendant que VSCode y ecrit. Sortir en erreur,
 * en NOMMANT le detenteur, vaut mieux que deux runs qui se sabotent — et mieux qu'une
 * limitation tue.
 *
 * Le verrou est rendu dans un `finally` : un scenario qui echoue, ou une assertion qui leve,
 * ne doit pas le laisser derriere lui. Un harnais TUE, lui, le laisse — c'est justement le cas
 * que `acquireHarnessLock` reprend, en constatant que le pid inscrit ne vit plus.
 */
async function main(): Promise<void> {
  const lockFile = path.join(os.tmpdir(), HARNESS_LOCK_FILE);
  const lock = acquireHarnessLock(lockFile);
  if (!lock.acquired) {
    say(
      '[runTests] REFUS DE DEMARRER : une autre execution du harnais detient le verrou' +
        `${lock.holder === undefined ? '' : ` (pid ${lock.holder})`}. ` +
        'Les deux ecriraient dans le registre reel du poste et se supprimeraient mutuellement ' +
        `leur --user-data-dir. Attendre sa fin, ou retirer ${HARNESS_LOCK_FILE} du repertoire ` +
        'temporaire si aucun run n est en cours.'
    );
    process.exit(1);
  }

  let passed = false;
  try {
    passed = await runAllScenarios();
  } finally {
    releaseHarnessLock(lockFile);
  }
  if (!passed) process.exit(1);
}

void main();
