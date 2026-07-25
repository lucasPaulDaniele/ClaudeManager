/**
 * Scenario EMPTY-WORKSPACE — une fenetre reelle SANS dossier de travail (§3 de B5).
 *
 * Le coeur REFUSE de publier une entree sans `workspaceFolders`, et ce refus n'est pas une
 * coquetterie de validation : sans workspace, `claude-vscode.editor.open` ouvre un panneau
 * VIDE sans lever d'erreur (piege D10). Une fenetre qui se declarerait pilotable dans cet
 * etat mentirait a son appelant.
 *
 * Quatre choses a prouver EN FENETRE REELLE, et la quatrieme est le garde-fou de C5 :
 *   1. aucune entree publiee ;
 *   2. le refus est NOMME au journal (`REGISTRY_ENTRY_INVALID`), jamais un silence ;
 *   3. AUCUN serveur laisse en ecoute — un serveur ouvert sans entree pour le joindre n'est
 *      joignable par personne, et c'est exactement le defaut S6 pris par l'autre bout ;
 *   4. un dossier ajoute APRES le refus declenche bien la publication. Avant le correctif du
 *      gate, le retrait consecutif au refus effacait l'etat que les abonnements de reprise
 *      testaient : la fenetre restait injoignable jusqu'a un rechargement complet.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * POURQUOI UN FICHIER `.code-workspace` SANS AUCUN DOSSIER, ET PAS UNE FENETRE VIDE.
 *
 * Les deux donnent bien `workspaceFolders` vide. Mais la reprise du point 4 exige d'AJOUTER
 * un dossier, et `updateWorkspaceFolders` n'a pas le meme effet dans les deux cas : hors
 * d'un workspace identifie (fenetre vide ou dossier unique), VSCode cree un workspace et y
 * ENTRE — la fenetre est rechargee, l'extension host redemarre, et la suite de test meurt
 * avec lui. Dans un workspace deja identifie, il se contente d'editer le fichier de
 * workspace : aucun rechargement, la fenetre survit, et le point est observable de bout en
 * bout depuis l'interieur.
 *
 * Le montage n'est donc pas un raccourci : c'est le SEUL qui rende le point 4 mesurable sans
 * perdre l'observateur en cours de route.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Ce scenario ecrit dans le registre REEL du poste, comme le nominal : l'entree qu'il finit
 * par publier est la sienne, et `deactivate` la retire a la fermeture de la fenetre. Il ne
 * supprime jamais une entree qu'il n'a pas ecrite.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { mask } from '../redaction.js';
import {
  findLogFile,
  listeningPortsIn,
  probe,
  readLog,
  waitFor,
  type ScenarioContext,
} from '../support.js';
import {
  redactWindowEntry,
  resolveRegistryDir,
  type WindowEntry,
} from '../../../../packages/core/src/index.js';

const EXTENSION_ID = 'claudemanager.claudemanager-vscode';

export async function runEmptyWorkspace(context: ScenarioContext): Promise<void> {
  const { reportPath, userDataDir, scratchDir } = context;

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not installed in this window`);

  const extHostPid = process.pid;
  const registryDir = resolveRegistryDir();
  const entryFile = path.join(registryDir, `${extHostPid}.json`);
  const readEntry = (): WindowEntry | undefined =>
    fs.existsSync(entryFile)
      ? (JSON.parse(fs.readFileSync(entryFile, 'utf8')) as WindowEntry)
      : undefined;

  // La fenetre est bien celle qu'on croit : un workspace IDENTIFIE, mais sans un dossier.
  const foldersAtStart = vscode.workspace.workspaceFolders ?? [];
  assert.equal(foldersAtStart.length, 0, 'this scenario requires a window with NO workspace folder');
  assert.ok(
    vscode.workspace.workspaceFile !== undefined,
    'the window must be on a .code-workspace file, otherwise adding the first folder reloads it'
  );

  // ---- §1 ici aussi : on ATTEND l'activation, on ne la provoque pas --------------------
  //
  // Il n'y a pas d'entree de registre a guetter — c'est tout l'objet du scenario. L'effet
  // externe observable est donc le JOURNAL PERSISTE, que VSCode ecrit sur disque : il ne
  // depend d'aucun appel de la suite, et `activate()` n'est appele nulle part ici non plus.
  const logFile = await waitFor(
    'the persisted log channel to appear WITHOUT the suite asking for activation',
    () => findLogFile(userDataDir),
    60_000
  );
  const logAfterActivation = await waitFor(
    'the extension to report the end of its activation',
    () => {
      const text = readLog(logFile);
      return text.includes('activation completed') ? text : undefined;
    },
    60_000
  );
  assert.equal(extension.isActive, true, 'the extension logged its activation but does not report itself active');

  // ---- Point 1 : AUCUNE entree publiee -------------------------------------------------
  assert.equal(
    readEntry(),
    undefined,
    `no entry may be published for a window without a workspace folder (${extHostPid}.json exists)`
  );

  // ---- Point 2 : le refus est NOMME ----------------------------------------------------
  //
  // On exige le CODE STABLE, pas une tournure de phrase : c'est lui que le principe fondateur
  // n.3 rend contractuel, et lui que `cmgr doctor` (lot D) lira.
  assert.ok(
    logAfterActivation.includes('refusing to publish this window (activation)'),
    'the refusal must be logged, never silent'
  );
  assert.ok(
    logAfterActivation.includes('REGISTRY_ENTRY_INVALID'),
    'the refusal must carry the core error code, not a free-form sentence'
  );
  assert.ok(
    logAfterActivation.includes('window withdrawn (entry rejected (activation))'),
    'the withdrawal that follows the refusal must be logged under its own reason'
  );

  // ---- Point 3 : AUCUN serveur laisse en ecoute ---------------------------------------
  //
  // MESURE, et non deduction. L'extension ouvre son serveur AVANT de tenter la publication —
  // le journal en porte le port —, puis le referme en se retirant. Ce port est donc la seule
  // trace, de l'exterieur, d'une ecoute qui aurait survecu au refus. On la sonde.
  const portsBeforeRecovery = listeningPortsIn(logAfterActivation);
  assert.equal(
    portsBeforeRecovery.length,
    1,
    'the extension must have opened exactly one listener before being refused'
  );
  const refusedPort = portsBeforeRecovery[0] as number;
  const orphanProbe = await probe(refusedPort, '/health', {});
  assert.equal(
    orphanProbe.status,
    'ERR(ECONNREFUSED)',
    `the listener opened before the refusal must be CLOSED; port ${refusedPort} answered ${orphanProbe.status}`
  );

  // ---- Point 4 : un dossier ajoute APRES le refus declenche la publication -------------
  //
  // LE GARDE-FOU DE NON-REGRESSION DE C5, en fenetre reelle. Le correctif du gate a pose les
  // abonnements de reprise AVANT la premiere tentative de publication, et fait du retrait une
  // operation qui n'efface plus le cycle de vie.
  const lateFolder = path.join(scratchDir, 'late-folder');
  assert.ok(fs.existsSync(lateFolder), 'the launcher must have prepared the folder to add');

  const folderChange = new Promise<vscode.WorkspaceFoldersChangeEvent>((resolve) => {
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      subscription.dispose();
      resolve(event);
    });
  });
  const accepted = vscode.workspace.updateWorkspaceFolders(0, 0, {
    uri: vscode.Uri.file(lateFolder),
  });
  assert.equal(accepted, true, 'updateWorkspaceFolders must accept the first folder of a workspace file');

  const changeEvent = await Promise.race([
    folderChange,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('onDidChangeWorkspaceFolders never fired')), 30_000)
    ),
  ]);
  assert.equal(changeEvent.added.length, 1, 'exactly one folder must have been added');

  const recovered = await waitFor(
    'the window to publish itself once a workspace folder exists',
    readEntry,
    30_000
  );
  assert.equal(recovered.extHostPid, extHostPid, 'the recovered entry must describe THIS window');
  assert.equal(recovered.workspaceFolders.length, 1, 'the recovered entry must carry the added folder');

  /**
   * LE PIEGE DU PORT — ET C'EST ICI QU'IL EST REEL.
   *
   * L'ADR-003 l'annonce de toute republication ; MESURE, il ne vaut que d'une republication
   * qui suit un RETRAIT — le seul cas ou `publishNow` rouvre un serveur. C'est exactement le
   * chemin de ce scenario : refus, retrait, serveur ferme, puis reprise sur un dossier
   * ajoute. Le port change, et le jeton NON : il est propre a la fenetre et a la session, pas
   * a l'ecoute.
   *
   * Un consommateur du lot C qui cacherait un port lu une fois s'adresserait donc a une
   * socket fermee — sans erreur d'authentification pour le mettre sur la voie, juste un refus
   * de connexion.
   */
  const portsAfterRecovery = listeningPortsIn(readLog(logFile));
  assert.equal(portsAfterRecovery.length, 2, 'the recovery must have opened a NEW listener');
  assert.notEqual(
    recovered.port,
    refusedPort,
    'the port MUST change across a withdrawal: the first listener was closed'
  );
  assert.equal(recovered.port, portsAfterRecovery[1], 'the entry must carry the port actually reopened');

  const recoveredProbe = await probe(recovered.port, '/health', {
    authorization: `Bearer ${recovered.token}`,
  });
  assert.equal(recoveredProbe.status, 200, 'the recovered window must be reachable on its new port');
  const recoveredHealth = JSON.parse(recoveredProbe.body) as Record<string, unknown>;
  assert.equal(recoveredHealth['extHostPid'], extHostPid);
  assert.equal((recoveredHealth['workspaceFolders'] as readonly string[]).length, 1);

  // L'ancien port reste ferme : la reprise a ouvert une NOUVELLE ecoute, elle n'a pas
  // ressuscite l'ancienne.
  const staleProbe = await probe(refusedPort, '/health', {});
  assert.equal(staleProbe.status, 'ERR(ECONNREFUSED)', 'the first listener must still be closed');

  const finalLog = readLog(logFile);
  assert.ok(
    finalLog.includes('published (workspace folders changed)'),
    'the recovery must be logged under the event that caused it'
  );
  assert.equal(finalLog.includes(recovered.token), false, 'the token must never reach the persisted log');

  const report = {
    scenario: 'empty-workspace',
    vscodeVersion: vscode.version,
    extHostPid,
    workspaceFileOpened: true,
    workspaceFoldersAtStart: foldersAtStart.length,
    activationWithoutSolicitation: {
      suiteCalledActivate: false,
      activeAfterObserving: extension.isActive,
    },
    refusal: {
      entryPublished: false,
      namedInLog: 'REGISTRY_ENTRY_INVALID',
      withdrawalLogged: true,
      listenerOpenedBeforeRefusal: refusedPort,
      listenerAfterRefusal: orphanProbe.status,
    },
    recovery: {
      folderAddedAfterRefusal: true,
      published: true,
      workspaceFolders: recovered.workspaceFolders.length,
      portBefore: refusedPort,
      portAfter: recovered.port,
      // §2 — LE port qui change, et le seul cas ou il change.
      portChanged: recovered.port !== refusedPort,
      listenersOpenedOverWindowLifetime: portsAfterRecovery.length,
      healthStatus: recoveredProbe.status,
      previousPortStillClosed: staleProbe.status,
    },
    entry: redactWindowEntry({
      ...recovered,
      workspaceFolders: recovered.workspaceFolders.map(mask),
    }),
    log: { file: path.basename(logFile) },
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
}
