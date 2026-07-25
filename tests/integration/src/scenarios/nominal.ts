/**
 * Scenario NOMINAL — une fenetre reelle, un workspace multi-racine, la confiance accordee.
 *
 * Il porte les points de B3 (activation, entree publiee, identite, `/health`, ecoute locale,
 * isolation, balayage differe, absence de fuite du jeton) ET les points de B5 qui exigent une
 * fenetre publiee :
 *
 *   §1 — l'activation a lieu SANS SOLLICITATION : la suite n'appelle plus `activate()`, elle
 *        attend l'effet EXTERNE de l'activation, l'apparition de l'entree de registre.
 *   §2 — republication sur `onDidChangeWorkspaceFolders`, port MESURE de part et d'autre ;
 *        et ce qu'on peut dire de `onDidGrantWorkspaceTrust` dans ce harnais — mesure a
 *        l'appui, pas par declaration.
 *   §6 — enumeration de `tabGroups`, EN LECTURE. Ouvrir ou fermer une conversation releve du
 *        lot C : `tabGroups.close` n'est appele nulle part ici.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * CE SCENARIO TRAVAILLE SUR LE REGISTRE REEL DU POSTE — c'est VOULU (finding C8 du gate).
 *
 * Pourquoi : la fenetre sous test publie son entree par le chemin de PRODUCTION, sans
 * surcharge de repertoire — c'est precisement ce qui donne son sens au point 6. Prouver
 * l'isolation dans un registre vide et dedie ne prouverait rien : l'invariant du produit,
 * c'est qu'une fenetre ne revendique pas les autres AU MILIEU des autres, entrees heritees
 * du poste comprises.
 *
 * Ce qu'il s'autorise a y ecrire : l'entree de la fenetre de test elle-meme, retiree par
 * `deactivate` ; et UNE entree d'un schema etranger qu'il fabrique et supprime lui-meme,
 * sous comparaison de contenu. Il ne supprime JAMAIS une entree qu'il n'a pas ecrite.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Aucun cadre de test : `node:assert/strict`. Un echec leve, et `runTests` le rapporte.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { mask } from '../redaction.js';
import {
  findLogFile,
  firstNonLoopbackIPv4,
  listeningPortsIn,
  probe,
  probeAddress,
  readLog,
  waitFor,
  type HttpProbe,
  type ScenarioContext,
} from '../support.js';
import {
  readProcessTable,
  readRegistry,
  redactWindowEntry,
  resolveOwningWindow,
  resolveRegistryDir,
  WINDOW_ENTRY_SCHEMA_VERSION,
  type ProcessSnapshot,
  type WindowEntry,
} from '../../../../packages/core/src/index.js';

const EXTENSION_ID = 'claudemanager.claudemanager-vscode';
const EXPECTED_VERSION = '0.2.0';

/**
 * Entrees heritees REELLES du poste de reference.
 *
 * Elles ne portent AUCUNE assertion (correction du finding C6) : nommees par des pid releves
 * le 2026-07-24, elles seront un jour classees `dead` puis supprimees par le balayage — apres
 * quoi toute assertion qui les viserait passerait a vide. Elles restent OBSERVEES et
 * rapportees telles quelles. Aucun chemin de ce scenario ne les supprime.
 */
const LEGACY_ENTRIES = ['11172.json', '17544.json'];

/** Le 0.1.0 reel, capture et anonymise : `tests/fixtures/registry/legacy-0.1.0/`. */
const LEGACY_FIXTURE = ['tests', 'fixtures', 'registry', 'legacy-0.1.0', '11172.json'];

/** Le `viewType` que ce scenario depose lui-meme pour eprouver l'enumeration d'onglets. */
const PROBE_VIEW_TYPE = 'claudemanagerB5TabProbe';

interface PlantedEntry {
  readonly pid: number;
  readonly file: string;
  readonly content: string;
}

/**
 * Depose dans le registre REEL une entree d'un schema etranger, nommee d'apres un pid VIVANT
 * choisi a l'execution.
 *
 * Le pid retenu est `process.ppid` — le `Code.exe` principal de l'instance de test —, vivant
 * par construction puisqu'il nous heberge, et qui n'est jamais un extension host, donc jamais
 * le nom d'une entree legitime. Le CONTENU est la fixture 0.1.0 reelle : seul l'`extHostPid`
 * y est repointe, le nom du fichier devant correspondre a l'identite revendiquee.
 *
 * Rend `undefined` si un fichier porte deja ce nom : on n'ecrase jamais une entree qui n'est
 * pas la notre, quitte a perdre le point.
 */
function plantForeignEntry(repoRoot: string, registryDir: string): PlantedEntry | undefined {
  const pid = process.ppid;
  const file = path.join(registryDir, `${pid}.json`);
  if (fs.existsSync(file)) return undefined;

  const fixture = JSON.parse(
    fs.readFileSync(path.join(repoRoot, ...LEGACY_FIXTURE), 'utf8')
  ) as Record<string, unknown>;
  const content = `${JSON.stringify({ ...fixture, extHostPid: pid }, null, 2)}\n`;

  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return { pid, file, content };
}

/**
 * Retire l'entree fabriquee — et ELLE SEULE.
 *
 * Garde de contenu : si le fichier a change depuis qu'on l'a ecrit, il n'est plus le notre et
 * on n'y touche pas.
 */
function unplantForeignEntry(planted: PlantedEntry | undefined): string {
  if (planted === undefined) return 'aucune entree fabriquee';
  let onDisk: string;
  try {
    onDisk = fs.readFileSync(planted.file, 'utf8');
  } catch {
    return 'deja disparue';
  }
  if (onDisk !== planted.content) {
    return 'LAISSEE EN PLACE : le contenu a change, elle n est plus la notre';
  }
  fs.rmSync(planted.file, { force: true });
  return 'retiree';
}

function allTabs(): readonly vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

export async function runNominal(context: ScenarioContext): Promise<void> {
  const { reportPath, userDataDir, repoRoot, scratchDir } = context;

  // ---- §1 : l'activation a lieu SANS SOLLICITATION ------------------------------------
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not installed in this window`);

  // Releve AVANT toute observation repetee, et sans rien declencher : lire `isActive` ne
  // provoque aucune activation.
  const activeWhenSuiteStarted = extension.isActive;

  const extHostPid = process.pid;
  const mainPid = process.ppid;
  const registryDir = resolveRegistryDir();
  const entryFile = path.join(registryDir, `${extHostPid}.json`);

  const readEntry = (): WindowEntry | undefined =>
    fs.existsSync(entryFile)
      ? (JSON.parse(fs.readFileSync(entryFile, 'utf8')) as WindowEntry)
      : undefined;

  /**
   * LE POINT DE §1, ET IL TIENT DANS CETTE ATTENTE.
   *
   * Le rapport de B3 portait `activeBeforeWeAsked: false` : la suite s'executait avant que
   * `onStartupFinished` n'ait active l'extension, et c'est SON PROPRE `await
   * extension.activate()` qui menait l'activation a terme. Que l'extension s'active seule
   * n'etait donc pas prouve — or personne ne « lance » ClaudeManager, c'est la condition de
   * tout le produit.
   *
   * `activate()` n'est plus appele NULLE PART dans ce scenario. On attend l'effet EXTERNE de
   * l'activation — l'apparition du fichier d'entree —, qui ne depend d'aucun appel de la
   * suite : seule l'extension l'ecrit, et seulement si elle s'est activee d'elle-meme.
   * L'attente LEVE au depassement du delai ; c'est ce qui la rend falsifiable.
   */
  const activationWaitStart = Date.now();
  const rawEntry = await waitFor(
    `the registry entry ${extHostPid}.json to appear WITHOUT the suite asking for activation`,
    readEntry,
    60_000
  );
  const activationWaitMs = Date.now() - activationWaitStart;

  // L'entree est la : l'activation a donc eu lieu. On le CONFIRME sur l'etat de l'extension,
  // toujours sans l'avoir sollicitee.
  assert.equal(
    extension.isActive,
    true,
    'the extension published its entry but does not report itself active'
  );

  // ---- Points 2 et 3 : l'entree publiee decrit CETTE fenetre ---------------------------
  assert.equal(rawEntry.schemaVersion, WINDOW_ENTRY_SCHEMA_VERSION, 'schemaVersion must come from the core');
  assert.equal(rawEntry.extensionVersion, EXPECTED_VERSION, 'extensionVersion must be 0.2.0');
  assert.equal(rawEntry.extHostPid, extHostPid, 'extHostPid must be this extension host');
  assert.equal(rawEntry.mainPid, mainPid, 'mainPid must be the real ppid of this extension host');
  assert.ok(rawEntry.workspaceFolders.length > 0, 'a publishable window always has a workspace');

  const token = rawEntry.token;
  const port = rawEntry.port;

  // ---- Point 4 : /health, et les deux branches de la comparaison a temps constant ------
  const sameLengthWrongToken = token.replace(/./, (c) => (c === '0' ? '1' : '0'));
  assert.equal(sameLengthWrongToken.length, token.length, 'the wrong token must be the same length');

  const probes: HttpProbe[] = [];
  const cases: ReadonlyArray<readonly [string, string, Record<string, string>]> = [
    ['GET /health + jeton valide -> 200', '/health', { authorization: `Bearer ${token}` }],
    ['GET /health sans jeton -> 401', '/health', {}],
    ['GET /health + faux jeton de MEME longueur -> 401', '/health', { authorization: `Bearer ${sameLengthWrongToken}` }],
    ['GET /inconnue + jeton valide -> 404', '/inconnue', { authorization: `Bearer ${token}` }],
  ];
  for (const [label, route, headers] of cases) {
    const result = await probe(port, route, headers);
    probes.push({ label, status: result.status, body: result.body, carriesToken: result.body.includes(token) });
  }

  assert.equal(probes[0]?.status, 200, '/health with a valid token must answer 200');
  assert.equal(probes[1]?.status, 401, '/health without a token must answer 401');
  assert.equal(probes[2]?.status, 401, '/health with a same-length wrong token must answer 401');
  assert.equal(probes[3]?.status, 404, 'an unknown route with a valid token must answer 404');

  const health = JSON.parse(probes[0]?.body ?? '{}') as Record<string, unknown>;
  assert.equal(health['ok'], true);
  assert.equal(health['extHostPid'], extHostPid);
  assert.equal(health['mainPid'], mainPid);
  assert.equal(health['schemaVersion'], WINDOW_ENTRY_SCHEMA_VERSION);
  assert.equal(health['extensionVersion'], EXPECTED_VERSION);

  // Point 9 : aucune reponse ne porte le jeton. MESURE, sur les quatre reponses.
  const tokenInAnyResponse = probes.some((p) => p.carriesToken);
  assert.equal(tokenInAnyResponse, false, `a response carried the token: ${probes.find((p) => p.carriesToken)?.label}`);

  // ---- Point 5 : ecoute strictement locale ---------------------------------------------
  // PREUVE DIRECTE, cote serveur : l'adresse est relevee sur la socket elle-meme.
  assert.equal(health['listenAddress'], '127.0.0.1', 'the server must be bound to the loopback');

  const lanAddress = firstNonLoopbackIPv4();
  const lanResult = lanAddress === undefined ? 'AUCUNE ADRESSE NON-LOOPBACK' : await probeAddress(lanAddress, port);
  if (lanAddress !== undefined) {
    // SEUL UN REFUS PROUVE QUELQUE CHOSE : `ERR(TIMEOUT)` est le verdict qu'un pare-feu rend
    // devant un serveur lie a `0.0.0.0`, donc exactement le cas qu'on veut exclure.
    assert.equal(
      lanResult,
      'ERR(ECONNREFUSED)',
      `the LAN probe must be REFUSED, not merely unanswered; got ${lanResult}`
    );
  }

  // ---- Point 6 : isolation ------------------------------------------------------------
  const snapshot: ProcessSnapshot = await readProcessTable();
  const planted = plantForeignEntry(repoRoot, registryDir);
  let isolation: Record<string, unknown> = {};
  let unplanted = 'jamais tentee';
  try {
    assert.ok(planted, 'the foreign entry must have been planted (a file already claimed that pid?)');
    assert.ok(fs.existsSync(planted.file), 'the planted foreign entry must be on disk');
    assert.ok(snapshot.table.has(planted.pid), 'the planted entry must name a LIVE pid');

    const registry = readRegistry({ snapshot, dir: registryDir });
    const owner = resolveOwningWindow(extHostPid, snapshot.table, registry.windows);
    assert.ok(owner, 'this window must claim its own extension host');
    assert.equal(owner.extHostPid, extHostPid, 'resolveOwningWindow must return THIS window');

    const skip = registry.skipped.find((s) => s.file === `${planted.pid}.json`);
    assert.ok(skip, 'the planted foreign entry must be reported among the skipped ones');
    assert.equal(skip.reason, 'foreign-schema', 'a live entry of another schema is foreign, never invalid');
    assert.ok(
      !registry.windows.some((w) => w.extHostPid === planted.pid),
      'a foreign entry must never appear among steerable windows, even with a live pid'
    );

    isolation = {
      resolvedExtHostPid: owner.extHostPid,
      steerableWindows: registry.windows.map((w) => w.extHostPid),
      skipped: registry.skipped,
      plantedForeignEntry: { pid: planted.pid, classification: skip.reason },
      // Observation, PAS une preuve : ce que le poste porte au moment du rejeu.
      legacyEntriesObserved: registry.skipped.filter((s) => LEGACY_ENTRIES.includes(s.file)),
    };
  } finally {
    unplanted = unplantForeignEntry(planted);
  }
  assert.equal(unplanted, 'retiree', 'the planted entry must have been removed by the suite itself');

  // ---- §2 (a) : ce qu'on peut dire de `onDidGrantWorkspaceTrust` dans ce harnais --------
  //
  // MESURE, PAS DECLARATION — et la mesure a corrige la premiere redaction de ce bloc.
  //
  // `@vscode/test-electron` injecte `--disable-workspace-trust` INCONDITIONNELLEMENT
  // (`out/runTest.js` : le drapeau est dans la liste d'arguments de base, nos `launchArgs`
  // sont concatenes AVANT, et VSCode n'offre aucune negation). La confiance est donc toujours
  // ACQUISE ici — un dossier temporaire NEUF, dans un `user-data-dir` NEUF, ne saurait l'etre
  // autrement. Or `onDidGrantWorkspaceTrust` ne signale qu'une TRANSITION : sur une fenetre
  // deja approuvee, il ne peut pas se produire. C'est LA raison pour laquelle ce chemin reste
  // non eprouve, et elle tient a l'outillage, pas a l'extension.
  //
  // Ce qui suit est releve plutot qu'asserte, parce qu'aucun de ces faits n'est un contrat :
  // `requestWorkspaceTrust` EXISTE a l'execution en 1.122.1 — mesure : `typeof` vaut
  // `function` — alors qu'il est absent d'`@types/vscode` ~1.90 (API proposee). Il n'est
  // PAS appele : il ouvre une boite de dialogue modale et attend un clic humain. L'appeler
  // ferait pendre la suite, et automatiser le clic violerait le principe fondateur n.1.
  const workspaceApi = vscode.workspace as unknown as Record<string, unknown>;
  const trustMembers = Object.keys(workspaceApi).filter((name) => /trust/i.test(name)).sort();
  const trustCommands = (await vscode.commands.getCommands(true)).filter((c) => /trust/i.test(c)).sort();
  const requestTrustAtRuntime = typeof workspaceApi['requestWorkspaceTrust'];

  // LA SEULE ASSERTION QUI PORTE ICI, et c'est elle qui etablit le blocage : la fenetre est
  // deja approuvee, donc aucune transition de confiance n'est possible dans ce harnais. Si
  // un jour le lanceur cessait de forcer le drapeau, elle echouerait — et ce serait le signal
  // qu'il faut reprendre ce point.
  assert.equal(
    vscode.workspace.isTrusted,
    true,
    'the harness forces --disable-workspace-trust, so a brand new folder must already be trusted'
  );

  // ---- §2 (b) : republication sur `onDidChangeWorkspaceFolders`, port MESURE ------------
  const foldersBefore = vscode.workspace.workspaceFolders ?? [];
  assert.ok(
    foldersBefore.length >= 2,
    'this scenario must run on a multi-root workspace: appending a folder then leaves the FIRST one untouched, which is what avoids an extension host restart'
  );
  const entryBeforeChange = rawEntry;

  const lateFolder = path.join(scratchDir, 'late-folder');
  assert.ok(fs.existsSync(lateFolder), 'the launcher must have prepared the folder to append');

  // Abonnement pose AVANT la demande : l'evenement peut arriver avant que l'appel ne rende.
  const folderChange = new Promise<vscode.WorkspaceFoldersChangeEvent>((resolve) => {
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      subscription.dispose();
      resolve(event);
    });
  });
  const accepted = vscode.workspace.updateWorkspaceFolders(foldersBefore.length, 0, {
    uri: vscode.Uri.file(lateFolder),
  });
  assert.equal(accepted, true, 'updateWorkspaceFolders must accept appending a folder');

  const changeEvent = await Promise.race([
    folderChange,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('onDidChangeWorkspaceFolders never fired')), 30_000)
    ),
  ]);
  assert.equal(changeEvent.added.length, 1, 'exactly one folder must have been added');
  assert.equal(changeEvent.removed.length, 0, 'no folder must have been removed');

  const entryAfterChange = await waitFor(
    'the entry to be republished with the added workspace folder',
    () => {
      const entry = readEntry();
      return entry !== undefined && entry.workspaceFolders.length === foldersBefore.length + 1
        ? entry
        : undefined;
    },
    30_000
  );

  /**
   * LE PIEGE DU PORT, MESURE PLUTOT QUE SUPPOSE.
   *
   * L'ADR-003 annonce en consequence « la republication rouvre le serveur sur un port
   * different ». MESURE ICI : c'est FAUX d'une republication ordinaire. `publishNow` ne
   * redemarre le serveur que si `live` est `undefined` — donc uniquement APRES un retrait.
   * Une republication sur changement de dossiers ou octroi de confiance conserve le port ET
   * le jeton.
   *
   * Le port CHANGE bel et bien, mais dans l'autre scenario : refus de publication (retrait,
   * serveur ferme) puis reprise. `empty-workspace` le mesure. Un consommateur du lot C doit
   * donc relire le port a chaque usage — la regle tient —, mais pour la BONNE raison.
   */
  assert.equal(entryAfterChange.port, entryBeforeChange.port, 'a plain republication keeps the port');
  assert.equal(entryAfterChange.token, entryBeforeChange.token, 'a plain republication keeps the token');

  const healthAfterChange = await probe(entryAfterChange.port, '/health', {
    authorization: `Bearer ${entryAfterChange.token}`,
  });
  assert.equal(healthAfterChange.status, 200, 'the window must still answer after republishing');
  const healthAfterBody = JSON.parse(healthAfterChange.body) as Record<string, unknown>;
  assert.equal(
    (healthAfterBody['workspaceFolders'] as readonly string[]).length,
    foldersBefore.length + 1,
    '/health must reflect the new workspace folders'
  );

  // ---- §6 : enumeration de `tabGroups`, EN LECTURE SEULE -------------------------------
  //
  // `tabGroups.close` n'est appele NULLE PART : ouvrir et fermer une conversation relevent du
  // lot C, et l'extension n'a aujourd'hui aucune commande pour cela. Ce qui est eprouve ici
  // est la SEULE moitie dont le lot C aura besoin en premier — reconnaitre un onglet a son
  // `viewType`, ce que `CLAUDE.md` decrit par « l'onglet dont le viewType contient
  // claudeVSCodePanel ».
  //
  // `preserveFocus: true` partout : le principe fondateur n.1 ne s'arrete pas au harnais.
  const document = await vscode.workspace.openTextDocument({
    content: 'temoin d enumeration d onglets',
    language: 'plaintext',
  });
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
  const panel = vscode.window.createWebviewPanel(
    PROBE_VIEW_TYPE,
    'ClaudeManager B5 tab probe',
    { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
    {}
  );

  const webviewTab = await waitFor(
    'the webview tab to show up in tabGroups',
    () => allTabs().find((tab) => tab.input instanceof vscode.TabInputWebview),
    15_000
  );
  const textTab = await waitFor(
    'the text tab to show up in tabGroups',
    () => allTabs().find((tab) => tab.input instanceof vscode.TabInputText),
    15_000
  );

  const observedViewType = (webviewTab.input as vscode.TabInputWebview).viewType;
  // CE QUE CETTE ASSERTION APPREND AU LOT C : le `viewType` rendu par `TabInputWebview` n'est
  // PAS celui que l'extension a fourni — VSCode le prefixe (`mainThreadWebview-…`). Un lot C
  // qui comparerait par EGALITE ne reconnaitrait jamais le panneau ; « contient » est la
  // bonne relation, et ce n'est plus une intuition.
  assert.ok(
    observedViewType.includes(PROBE_VIEW_TYPE),
    `the enumerated viewType must contain the one we registered; got ${observedViewType}`
  );
  assert.notEqual(
    observedViewType,
    PROBE_VIEW_TYPE,
    'measured: VSCode does not return the raw viewType — if that ever changes, lot C should know'
  );

  const tabsWhilePanelOpen = allTabs().length;
  panel.dispose();
  await waitFor(
    'the webview tab to leave tabGroups once its panel is disposed',
    () => (allTabs().some((tab) => tab.input instanceof vscode.TabInputWebview) ? undefined : true),
    15_000
  );
  // On n'a retire QUE ce qu'on a cree : l'onglet de texte, lui, est toujours enumere.
  assert.ok(
    allTabs().some((tab) => tab.input instanceof vscode.TabInputText),
    'disposing our own panel must not have touched any other tab'
  );

  // ---- Points 1, 7 et 9 : le journal persiste -----------------------------------------
  const logFile = await waitFor('the persisted log channel', () => findLogFile(userDataDir), 15_000);
  const logText = await waitFor(
    'the deferred sweep to report in the log',
    () => {
      const text = readLog(logFile);
      return text.includes('sweep completed') || text.includes('sweep failed') ? text : undefined;
    },
    60_000
  );

  const activationMs = /activation completed in ([\d.]+) ms/.exec(logText)?.[1];
  const sweepMs = /sweep completed in (\d+) ms/.exec(logText)?.[1];
  const publishedIndex = logText.indexOf('published (activation)');
  const activationIndex = logText.indexOf('activation completed');
  const sweepIndex = Math.max(logText.indexOf('sweep completed'), logText.indexOf('sweep failed'));
  assert.ok(publishedIndex >= 0, 'the log must record the publication');
  assert.ok(activationIndex >= 0, 'the log must record the end of activation');
  assert.ok(sweepIndex > publishedIndex, 'the sweep must be reported AFTER the publication');
  // Le balayage est rapporte apres la FIN de l'activation : c'est ce qui prouve qu'`activate`
  // a rendu la main sans l'attendre.
  assert.ok(
    sweepIndex > activationIndex,
    'the sweep must be reported AFTER activation completed, which is what proves it is deferred'
  );
  // §2 : la republication est journalisee sous SON motif, pas confondue avec l'activation.
  assert.ok(
    logText.includes('published (workspace folders changed)'),
    'the republication must be logged under the event that caused it'
  );

  const tokenInLog = logText.includes(token);
  assert.equal(tokenInLog, false, 'the token must never reach the persisted log');

  // Le journal designe comme source de diagnostic de `cmgr doctor` doit etre LOCALISABLE.
  const logDirectory = health['logDirectory'];
  assert.equal(typeof logDirectory, 'string', '/health must publish the log directory');
  assert.ok(
    logFile.toLowerCase().startsWith((logDirectory as string).toLowerCase()),
    'the persisted channel must be found INSIDE the log directory published on /health'
  );

  // Un SEUL serveur ouvert sur toute la vie de la fenetre : la republication n'en a pas
  // ouvert un second, et n'en a laisse aucun derriere elle.
  const listeningPorts = listeningPortsIn(logText);
  assert.deepEqual(
    listeningPorts,
    [entryBeforeChange.port],
    'a plain republication must not open a second listener'
  );

  const report = {
    scenario: 'nominal',
    vscodeVersion: vscode.version,
    extensionId: EXTENSION_ID,
    extHostPid,
    mainPid,
    port,
    activationWithoutSolicitation: {
      // §1. `false` ici est le cas INTERESSANT : la suite a demarre AVANT l'activation, et
      // l'entree est pourtant apparue — sans qu'elle appelle `activate()`.
      activeWhenSuiteStarted,
      suiteCalledActivate: false,
      waitedForRegistryEntryMs: activationWaitMs,
      activeAfterObserving: extension.isActive,
    },
    entry: redactWindowEntry({ ...rawEntry, workspaceFolders: rawEntry.workspaceFolders.map(mask) }),
    probes: probes.map((p) => ({ label: p.label, status: p.status, body: mask(p.body) })),
    // L'ADRESSE LAN N'EST PAS IMPRIMEE : seul le verdict a une valeur de preuve (finding S7).
    loopbackOnly: {
      listenAddress: health['listenAddress'],
      lanProbeAttempted: lanAddress !== undefined,
      result: lanResult,
    },
    isolation,
    plantedEntryCleanup: unplanted,
    workspaceTrust: {
      // §2 (a) — ce que le harnais permet d'etablir, et ou il s'arrete.
      isTrusted: vscode.workspace.isTrusted,
      disableWorkspaceTrustForcedByRunner: true,
      apiMembersMatchingTrust: trustMembers,
      workbenchCommandsMatchingTrust: trustCommands,
      // MESURE : present a l'execution en 1.122.1, absent d'@types/vscode ~1.90 (API
      // proposee). Non appele — il ouvre une modale et attend un clic humain.
      requestWorkspaceTrustAtRuntime: requestTrustAtRuntime,
      requestWorkspaceTrustCalled: false,
      grantEventExercised: false,
      whyNot:
        '@vscode/test-electron injecte --disable-workspace-trust inconditionnellement, et VSCode n offre aucune negation de ce drapeau : la fenetre demarre APPROUVEE. onDidGrantWorkspaceTrust ne signalant qu une TRANSITION, il ne peut pas se produire. La seule voie restante, requestWorkspaceTrust, ouvre une modale et exige un clic humain — l automatiser violerait le principe fondateur n.1.',
    },
    workspaceFoldersChanged: {
      // §2 (b) — republication MESUREE, avec le port de part et d'autre.
      foldersBefore: foldersBefore.length,
      foldersAfter: entryAfterChange.workspaceFolders.length,
      portBefore: entryBeforeChange.port,
      portAfter: entryAfterChange.port,
      portChanged: entryAfterChange.port !== entryBeforeChange.port,
      tokenChanged: entryAfterChange.token !== entryBeforeChange.token,
      listenersOpenedOverWindowLifetime: listeningPorts.length,
      healthWorkspaceFolders: (healthAfterBody['workspaceFolders'] as readonly string[]).length,
    },
    tabGroups: {
      // §6 — LECTURE SEULE. `tabGroups.close` n'est appele nulle part.
      closeEverCalled: false,
      groupCount: vscode.window.tabGroups.all.length,
      tabsWhilePanelOpen,
      tabsAfterDisposingOurPanel: allTabs().length,
      registeredViewType: PROBE_VIEW_TYPE,
      enumeratedViewType: observedViewType,
      enumeratedViewTypeContainsRegistered: observedViewType.includes(PROBE_VIEW_TYPE),
      textTabRecognised: textTab.input instanceof vscode.TabInputText,
    },
    log: {
      file: path.basename(logFile),
      pathBelowPublishedLogDirectory: mask(path.relative(logDirectory as string, logFile)),
      activationMs: activationMs ?? null,
      sweepMs: sweepMs ?? null,
      sweepReportedAfterActivationCompleted: sweepIndex > activationIndex,
      tokenInLog,
    },
    tokenInAnyResponse,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
}
