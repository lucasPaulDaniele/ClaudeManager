/**
 * Scenario OPEN-CONVERSATION — le mecanisme V1, dans une VRAIE fenetre, avec la VRAIE
 * extension Claude et le VRAI binaire `claude`.
 *
 * C'est la preuve que les tests unitaires ne peuvent pas rendre : qu'`editor.open` attache
 * reellement une session, que `hideFromUser` cache reellement le terminal, que `dispose`
 * laisse reellement survivre le panneau. Les unitaires eprouvent l'ORDRE et les REFUS ; celui-ci
 * eprouve le SYSTEME.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * IL OUVRE UNE VRAIE CONVERSATION, DONC UN VRAI TOUR FACTURE. Le prompt est MINUSCULE, et il
 * le restera : cette suite tourne a chaque verification locale.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Ce qu'il verifie, point par point :
 *   1. l'extension Claude se charge, et ses commandes n'existent QU'APRES activation ;
 *   2. `POST /conversations` ouvre une conversation, tour 1 REELLEMENT joue — OU BIEN nomme la
 *      porte du CLI qui l'en a empeche. Jamais un succes muet : c'est le defaut de recette du
 *      2026-07-26, et c'est la que ce scenario MORD desormais ;
 *   3. l'onglet apparu est releve, `viewType` tel quel — un RELEVE, jamais une preuve (D19) ;
 *   4. le terminal n'est JAMAIS visible, ni pendant ni apres ;
 *   5. l'environnement REELLEMENT recu par le terminal, dans la configuration complete ;
 *   6. `Host` etranger -> 403, `Origin` -> refus, sur la vraie socket ;
 *   7. le fichier de prompt transitoire n'existe plus ;
 *   8. le repli V5 : erreur nommee EMISE, PUIS repli execute — dans cet ordre ;
 *   9. les trois causes de l'etape 2, dont « commande disparue », SANS casser l'installation.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  openConversation,
  type EditorPort,
} from '../../../../packages/vscode/src/conversations.js';
import {
  CLAUDE_EXTENSION_ID,
  CLAUDE_OPEN_COMMAND,
  CLAUDE_PANEL_VIEW_TYPE,
  neutralizedTerminalEnvironment,
  type PanelTabLike,
} from '../../../../packages/vscode/src/seed.js';
import { windowEntryPath, type WindowEntry } from '../../../../packages/core/src/index.js';
import { mask } from '../redaction.js';
import { postJson, probe, waitFor, waitForAsync, type ScenarioContext } from '../support.js';

const COMPANION_ID = 'claudemanager.claudemanager-vscode';

/**
 * LE PROMPT DE LA PREUVE — le plus petit qui produise une reponse observable.
 *
 * Il est joue pour de vrai, par un vrai `claude`, contre le vrai service. Tout ce qu'on lui
 * demande est d'exister ; alourdir ce prompt reviendrait a facturer une preuve.
 */
const TINY_PROMPT = 'Reponds exactement OK, sans rien ajouter.';

/**
 * Prompt de la preuve du repli : au-dela du plafond de ligne de commande.
 *
 * IL NE CASSE RIEN ET NE TOUCHE A AUCUNE INSTALLATION — c'est un depassement de taille, donc
 * une defaillance ANTERIEURE a la creation du terminal, la seule ou le repli est autorise. Le
 * repli ouvre un panneau avec le prompt PRE-REMPLI, jamais soumis : aucun tour n'est facture.
 */
const OVERSIZED_PROMPT = 'A'.repeat(40_000);

function allTabs(): readonly vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

/** Les onglets, reduits a ce que la reconnaissance demande — comme le fait l'adaptateur. */
function panelTabs(): readonly PanelTabLike[] {
  return allTabs().map((tab) => ({
    viewType: tab.input instanceof vscode.TabInputWebview ? tab.input.viewType : undefined,
    label: tab.label,
  }));
}

function claudePanels(): readonly PanelTabLike[] {
  return panelTabs().filter(
    (tab) => tab.viewType !== undefined && tab.viewType.includes(CLAUDE_PANEL_VIEW_TYPE)
  );
}

/** Les terminaux VISIBLES de la fenetre — `hideFromUser` doit les en tenir hors. */
function visibleTerminals(): readonly string[] {
  return vscode.window.terminals.map((terminal) => terminal.name);
}

export async function runOpenConversation(context: ScenarioContext): Promise<void> {
  const { reportPath, userDataDir } = context;
  const report: Record<string, unknown> = { scenario: 'open-conversation', vscodeVersion: vscode.version };
  // ECRIT MEME EN CAS D'ECHEC : une assertion qui leve doit laisser derriere elle ce qui a
  // deja ete mesure, sans quoi le diagnostic se fait a l'aveugle.
  const flush = (): void => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  try {
    // ---- Point 1 : les deux extensions, et l'enregistrement A L'ACTIVATION ---------------
    const claude = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
    assert.ok(claude, `${CLAUDE_EXTENSION_ID} must be loaded in this window (junction mount)`);

    const activeBeforeWeAsked = claude.isActive;
    // ALERTE MESUREE : avant activation, `getCommands(true)` rend ZERO commande
    // `claude-vscode.*`. C'est ce qui rend « extension pas encore activee » et « commande
    // disparue » INDISCERNABLES au point d'appel — et c'est pourquoi le mecanisme active
    // explicitement avant d'interroger l'inventaire.
    const claudeCommandsBefore = (await vscode.commands.getCommands(true)).filter((command) =>
      command.startsWith('claude-vscode.')
    );
    const activationStart = Date.now();
    await claude.activate();
    const activationMs = Date.now() - activationStart;
    const claudeCommandsAfter = (await vscode.commands.getCommands(true)).filter((command) =>
      command.startsWith('claude-vscode.')
    );

    report['claudeExtension'] = {
      id: CLAUDE_EXTENSION_ID,
      version: (claude.packageJSON as { version?: string }).version ?? 'inconnue',
      activeBeforeWeAsked,
      activationMs,
      commandsBeforeActivation: claudeCommandsBefore.length,
      commandsAfterActivation: claudeCommandsAfter.length,
      openCommandPresent: claudeCommandsAfter.includes(CLAUDE_OPEN_COMMAND),
    };
    assert.ok(
      claudeCommandsAfter.includes(CLAUDE_OPEN_COMMAND),
      `${CLAUDE_OPEN_COMMAND} must be registered once the Claude extension is active`
    );
    flush();

    // ---- Le canal de CETTE fenetre, relu dans le registre --------------------------------
    const extHostPid = process.pid;
    const entryFile = windowEntryPath(extHostPid);
    const entry = await waitFor(
      `the companion registry entry ${extHostPid}.json`,
      () =>
        fs.existsSync(entryFile)
          ? (JSON.parse(fs.readFileSync(entryFile, 'utf8')) as WindowEntry)
          : undefined,
      60_000
    );
    const authorization = { authorization: `Bearer ${entry.token}` };
    const health = await probe(entry.port, '/health', authorization);
    assert.equal(
      health.status,
      200,
      'the companion must answer /health before we ask it to act'
    );
    // Le repertoire du journal N'EST PAS dans l'entree de registre — c'est une decision d'ADR-003,
    // le contenu de l'entree etant un contrat entre versions. Il est publie ICI, et c'est par lui
    // que la chronologie du mecanisme devient lisible de l'exterieur.
    const logDirectory = (JSON.parse(health.body) as { logDirectory?: string }).logDirectory ?? '';

    // ---- Point 6 : les deux gardes de transport, sur la VRAIE socket ---------------------
    //
    // Elles sont eprouvees AVANT l'ouverture : une garde qu'on verifie apres coup est une
    // garde qu'on a deja contournee.
    const foreignHost = await postJson(entry.port, '/conversations', { prompt: TINY_PROMPT }, {
      ...authorization,
      host: `evil.example:${entry.port}`,
    });
    const withOrigin = await postJson(entry.port, '/conversations', { prompt: TINY_PROMPT }, {
      ...authorization,
      origin: 'https://claude.ai',
    });
    const withoutToken = await postJson(entry.port, '/conversations', { prompt: TINY_PROMPT }, {});
    report['transportGuards'] = {
      foreignHost: { status: foreignHost.status, body: mask(foreignHost.body) },
      withOrigin: { status: withOrigin.status, body: mask(withOrigin.body) },
      withoutToken: { status: withoutToken.status, body: mask(withoutToken.body) },
    };
    assert.equal(foreignHost.status, 403, 'a foreign Host must be refused');
    assert.equal(withOrigin.status, 403, 'any Origin header must be refused');
    assert.equal(withoutToken.status, 401, 'the token is still required');
    assert.ok(!foreignHost.body.includes('evil.example'), 'the refusal must reflect nothing');
    flush();

    // ---- Point 5 : ce que le terminal RECOIT REELLEMENT ----------------------------------
    //
    // MESURE, pas declaration — et dans la configuration COMPLETE (compagnon + extension
    // Claude), la seule ou `CLAUDE_CODE_SSE_PORT` est injectee. La sonde emprunte la MEME
    // fonction de production que le mecanisme ; elle n'est pas le mecanisme, et c'est dit.
    const environmentReport = await probeTerminalEnvironment(context.scratchDir);
    report['terminalEnvironment'] = environmentReport;
    flush();
    // UNE GARDE QUI N'A RIEN A NEUTRALISER N'EST PAS UNE GARDE EPROUVEE. Le lanceur reinjecte
    // a dessein les noms d'une vraie session Claude dans le processus VSCode : sans eux,
    // l'assertion suivante serait vraie sans avoir rien mesure — c'est ce qu'a montre le
    // premier passage, ou l'extension host n'en portait aucun.
    assert.ok(
      environmentReport.extensionHostClaudeNames.length >= 8,
      `the extension host must carry the reinjected CLAUDE* names, otherwise this proves nothing; got ${environmentReport.extensionHostClaudeNames.length}`
    );
    assert.deepEqual(
      environmentReport.inheritedClaudeNames,
      [],
      `no CLAUDE* variable inherited from the calling session may survive; got ${environmentReport.inheritedClaudeNames.join(', ')}`
    );
    // L'affirmation JUSTE s'arrete la : `CLAUDE_CODE_SSE_PORT` reste, et c'est voulu — elle
    // est injectee par l'extension Claude de CETTE fenetre, jamais heritee de l'appelante.
    assert.ok(
      !environmentReport.extensionHostClaudeNames.includes('CLAUDE_CODE_SSE_PORT'),
      'CLAUDE_CODE_SSE_PORT must not come from the extension host: it is injected into the terminal'
    );

    // ---- Points 2, 3, 4 et 7 : LA VOIE NOMINALE ------------------------------------------
    //
    // La sonde d'environnement a laisse un terminal en cours de disparition : on attend qu'il
    // soit REELLEMENT parti avant de relever l'etat « avant ». Sans cette attente, le releve
    // porterait un terminal deja supprime et la comparaison finale serait fausse des le depart.
    await waitFor(
      'the environment probe terminal to leave window.terminals',
      () => (visibleTerminals().some((name) => name.includes('env probe')) ? undefined : true),
      30_000
    );
    // ---- LA PRECONDITION MACHINE, OBSERVEE ET NOMMEE — jamais supposee -------------------
    //
    // ─────────────────────────────────────────────────────────────────────────────────────
    // MESURE DU 2026-07-26 : dans un dossier NEUF, le CLI interactif s'arrete dans
    // `showSetupScreens()` et n'ecrit AUCUN transcript — constate 180 s durant, journal
    // `--debug-file` a l'appui. Dans un dossier dont la confiance a ete accordee une fois, le
    // meme prompt ecrit son transcript en 2 533 ms. La porte qui reste sur cette machine est
    // donc la CONFIANCE DU DOSSIER, qui se pose PAR REPERTOIRE — l'onboarding global, lui, est
    // franchi (`hasCompletedOnboarding` vaut vrai).
    //
    // CE SCENARIO TOURNE SUR UN DOSSIER TEMPORAIRE NEUF : la porte s'y presente donc, et elle
    // NE DOIT PAS ETRE FRANCHIE (son libelle n'est pas contractuel ; c'est `cmgr doctor`, lot D,
    // qui devra la nommer). On RELEVE l'etat de la confiance, et l'assertion se choisit en
    // consequence — mais il n'existe AUCUN cas ou ce scenario ne mord pas : ou le tour a eu
    // lieu, ou la route a nomme son echec. Le succes muet, lui, est refuse des deux cotes.
    //
    // Pour eprouver la voie complete, pointer le harnais sur un dossier dont la confiance est
    // deja accordee — voir `CMGR_OPEN_WS` dans `runTests.ts`.
    // ─────────────────────────────────────────────────────────────────────────────────────
    const cwd = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath ?? '';
    const folderTrust = readCliFolderTrust(cwd);
    report['cliFolderTrust'] = folderTrust;
    flush();

    const panelsBefore = claudePanels();
    const terminalsBefore = visibleTerminals();
    const promptDirectory = path.join(
      userDataDir,
      'User',
      'globalStorage',
      COMPANION_ID,
      'prompts'
    );

    /**
     * OBSERVATION PAR EVENEMENTS, ET NON PAR SONDAGE — correction d'une preuve VIDE.
     *
     * Une premiere version echantillonnait `window.terminals` toutes les 200 ms pendant
     * l'appel. Mesure : ZERO echantillon, l'ouverture ayant dure moins que la periode. Le
     * « le terminal n'a jamais ete visible » etait alors vrai SANS AVOIR RIEN OBSERVE — la
     * pire forme d'assertion. `onDidOpenTerminal` / `onDidCloseTerminal` ne dependent
     * d'aucune cadence : ils rapportent ce qui a eu lieu.
     */
    const terminalEvents: string[] = [];
    const subscriptions = [
      vscode.window.onDidOpenTerminal((terminal) => terminalEvents.push(`open:${terminal.name}`)),
      vscode.window.onDidCloseTerminal((terminal) => terminalEvents.push(`close:${terminal.name}`)),
    ];
    /** Echantillonnage FIN, en complement : il dit ce que `window.terminals` CONTIENT. */
    const terminalsDuring: string[][] = [];
    const watcher = setInterval(() => terminalsDuring.push([...visibleTerminals()]), 25);

    const openStart = Date.now();
    const opened = await postJson(entry.port, '/conversations', { prompt: TINY_PROMPT }, authorization);
    const openMs = Date.now() - openStart;
    clearInterval(watcher);
    for (const subscription of subscriptions) subscription.dispose();

    const openedBody = JSON.parse(opened.body) as Record<string, unknown>;
    /** LE VERDICT DE LA ROUTE, tel qu'elle le rend — jamais deduit d'autre chose. */
    const turnVerified = opened.status === 200 && openedBody['firstTurnVerified'] === true;
    report['seeded'] = {
      status: opened.status,
      // MESUREE, ET C'EST LE CHIFFRE DU CORRECTIF : la route ne rend plus la main avant que le
      // transcript n'existe. Elle valait 2 s quand le tour n'avait pas lieu.
      openMs,
      mode: openedBody['mode'],
      sessionId: openedBody['sessionId'],
      extHostPid: openedBody['extHostPid'],
      humanActionRequired: openedBody['humanActionRequired'],
      firstTurn: openedBody['firstTurn'],
      firstTurnVerified: openedBody['firstTurnVerified'],
      panelViewType: openedBody['panelViewType'],
      // Le CODE de l'erreur nommee, quand la porte du CLI a empeche le tour. Jamais son message.
      error: openedBody['error'],
      errorDetails: openedBody['details'],
      bodyCarriesToken: opened.body.includes(entry.token),
      turnVerified,
    };
    flush();
    assert.equal(opened.body.includes(entry.token), false, 'no response may carry the token');

    if (folderTrust.accepted) {
      // ---- LA VOIE COMPLETE, et elle MORD ------------------------------------------------
      assert.equal(opened.status, 200, `POST /conversations must succeed; got ${mask(opened.body)}`);
      assert.equal(openedBody['mode'], 'seeded', 'the seeded V1 path must have been taken');
      assert.equal(openedBody['extHostPid'], extHostPid, 'the acting window must be THIS one');
      assert.equal(typeof openedBody['sessionId'], 'string', 'a session id must be returned');
      assert.equal(
        openedBody['firstTurn'],
        'transcript-observed',
        'the transcript of the session must have been OBSERVED before the terminal was disposed'
      );
      assert.equal(
        openedBody['firstTurnVerified'],
        true,
        'the first turn must be VERIFIED: the route may not hand back before the transcript exists'
      );
    } else {
      // ---- LA PORTE DU CLI EST NOMMEE, ET SURTOUT : PAS DE SUCCES MUET -------------------
      //
      // C'est ICI que ce scenario mord sur cette machine. AVANT le correctif, la route rendait
      // `HTTP 200 · firstTurnVerified: false` en 2 s sur ce meme cas — un succes pour une
      // conversation vide. Elle doit desormais NOMMER son echec.
      assert.equal(
        opened.status,
        500,
        `no trust record for this brand-new folder: the route must NAME its failure, not report success; got ${mask(opened.body)}`
      );
      assert.equal(
        openedBody['error'],
        'SEED_TRANSCRIPT_NOT_FOUND',
        `the named failure must be the missing transcript; got ${mask(opened.body)}`
      );
      assert.equal(
        openedBody['firstTurnVerified'],
        undefined,
        'a refusal carries no first-turn verdict at all'
      );
    }

    // Point 3 — L'ONGLET APPARU. RELEVE, ET NON PREUVE : `editor.open` ouvre un panneau meme
    // pour une session jamais amorcee (D19), et reussit en ouvrant un panneau VIDE quand le
    // `cwd` ne correspond pas au workspace (D10).
    const panelsAfter = claudePanels();
    const appeared = panelsAfter.filter(
      (tab) => !panelsBefore.some((seen) => seen.viewType === tab.viewType && seen.label === tab.label)
    );
    report['tabDiff'] = {
      claudePanelsBefore: panelsBefore.length,
      claudePanelsAfter: panelsAfter.length,
      // Releve TEL QUEL : il est PREFIXE par VSCode, c'est ce que le lot C devait apprendre.
      appearedViewTypes: appeared.map((tab) => tab.viewType),
      // Le libelle est derive du contenu de la conversation. RELEVE, jamais asserte : il
      // depend de la reponse du modele, et l'ADR-004 le dit — la verification du CONTENU du
      // panneau (piste D10, `PANEL_ATTACHED_EMPTY`) releve du lot D, qui lit le transcript.
      appearedLabels: appeared.map((tab) => mask(tab.label)),
      closeEverCalled: false,
    };
    flush();
    if (turnVerified) {
      assert.equal(appeared.length, 1, 'exactly one Claude conversation tab must have appeared');
      assert.ok(
        (appeared[0]?.viewType ?? '').includes(CLAUDE_PANEL_VIEW_TYPE),
        'the appeared tab must be recognised by CONTAINS, never by equality'
      );
      assert.notEqual(
        appeared[0]?.viewType,
        CLAUDE_PANEL_VIEW_TYPE,
        'measured: VSCode prefixes the viewType — an equality check would never match'
      );
    } else {
      // AUCUN PANNEAU SUR UNE SESSION SANS TOUR, et c'est une assertion, pas une tolerance :
      // attacher un panneau ici produirait exactement l'onglet « Untitled » vide de la recette,
      // avec une erreur en plus. Le mecanisme s'arrete AVANT l'attachement.
      assert.equal(
        appeared.length,
        0,
        'no panel may be attached when the first turn never took place: that is the very defect'
      );
    }

    // Point 4 — LE TERMINAL, ET CE QUE CHAQUE OBSERVATION PROUVE EXACTEMENT.
    //
    // `window.terminals` n'est PAS une mesure de visibilite : l'API y expose les terminaux
    // `hideFromUser` aussi. Ce qui garantit qu'aucun humain ne voit rien est ailleurs, et
    // c'est STRUCTUREL — `hideFromUser: true` est pose, et `show()` n'est appelable NULLE
    // PART : le port de l'editeur ne l'expose meme pas. La preuve de non-visibilite est le
    // releve de focus (H2 = H3, `IsIconic` vrai a chaque releve), pas cette liste.
    //
    // Ce qui EST prouve ici : plus aucun terminal ne SURVIT a l'operation.
    const disappearedInMs = await measureDisappearance('ClaudeManager seed');
    const terminalsAfter = visibleTerminals();
    report['hiddenTerminal'] = {
      before: terminalsBefore,
      // Evenements REELS, independants de toute cadence d'echantillonnage.
      events: terminalEvents,
      samplesDuring: terminalsDuring.length,
      listedInWindowTerminals: terminalsDuring.some((sample) =>
        sample.some((name) => name.startsWith('ClaudeManager seed'))
      ),
      disappearedInMs,
      after: terminalsAfter,
      // Ce que le mecanisme demande a l'editeur, et qu'aucun chemin ne peut contredire.
      hideFromUserRequested: true,
      showEverReachable: false,
    };
    flush();
    assert.deepEqual(terminalsAfter, terminalsBefore, 'no terminal may survive the operation');
    assert.ok(
      terminalEvents.length > 0 || terminalsDuring.length > 0,
      'the observation window must not be empty: an assertion that observed nothing proves nothing'
    );

    // Point 7 — le fichier transitoire du prompt n'existe plus.
    const leftovers = fs.existsSync(promptDirectory) ? fs.readdirSync(promptDirectory) : [];
    report['promptFile'] = { directoryExists: fs.existsSync(promptDirectory), leftovers };
    flush();
    assert.deepEqual(leftovers, [], 'the transient prompt file must be gone');

    // ---- LE TOUR 1 A-T-IL EU LIEU ? On va le CHERCHER, on ne le suppose pas -------------
    //
    // LIRE LE CONTENU DU TRANSCRIPT EST AUTORISE **ICI, DANS LE TEST, ET LA SEULEMENT**.
    //
    // LA FRONTIERE A BOUGE, ET IL FAUT DIRE OU ELLE EST DESORMAIS : depuis le correctif du
    // 2026-07-26, `packages/vscode` CHERCHE `<sessionId>.jsonl` par son NOM et releve sa TAILLE —
    // c'est le seul fait qui etablisse qu'un tour a eu lieu. Ce qui reste au lot D, et reste
    // interdit au produit, est de LIRE ce fichier : ses enregistrements, la fin de tour,
    // l'extraction de la reponse. Ce test, lui, en lit les TYPES — c'est ainsi qu'il verifie que
    // la route ne ment pas.
    const turn = await lookForFirstTurn(
      // En cas de refus il n'y a pas de `sessionId` : on cherche alors un fichier qui ne peut
      // pas exister, et c'est exactement ce que l'assertion ci-dessous demande de constater.
      typeof openedBody['sessionId'] === 'string' ? openedBody['sessionId'] : 'aucune-session',
      cwd,
      // 45 s SUFFISENT ET NE PROUVENT PLUS RIEN A ELLES SEULES : quand la route rend `true`, le
      // fichier est deja la — c'est elle qui l'a attendu. Ce delai ne sert plus qu'au cas de
      // refus, ou l'on veut CONFIRMER une absence.
      turnVerified ? 45_000 : 5_000
    );
    report['firstTurnOnDisk'] = turn;
    // La MEME ligne d'assertion pour les deux mondes, et c'est ce qui la rend forte : le disque
    // doit dire EXACTEMENT ce que la route a dit. Une route qui promettrait un tour sans
    // transcript, ou qui nierait un transcript existant, echoue ici.
    assert.equal(
      turn['transcriptFound'],
      turnVerified,
      `the disk must confirm what the route claimed (firstTurnVerified=${String(turnVerified)})`
    );
    if (turn['transcriptFound'] === true) {
      assert.ok((turn['lines'] as number) > 0, 'a transcript that exists must carry at least one record');
      // LE PROMPT ET LA REPONSE, tous deux enregistres : c'est la conversation que l'humain
      // ouvre. RELEVE dans le rapport (les types d'enregistrements) et asserte ici sur le seul
      // fait qui compte pour l'utilisateur — le tour ne s'est pas arrete au prompt.
      const types = turn['recordTypes'] as readonly string[];
      assert.ok(types.includes('user'), `the prompt must be recorded; got ${types.join(', ')}`);
      assert.ok(
        types.includes('assistant'),
        `the RESPONSE must be recorded too: disposing the terminal must not truncate the turn; got ${types.join(', ')}`
      );
    }

    // ---- LE JOURNAL DE LA FENETRE — la chronologie REELLE du mecanisme -------------------
    //
    // C'est la seule source qui date chaque etape : le canal de journal est PERSISTE par VSCode
    // sous `logDirectory`, que `/health` publie. Ce qu'on en tire ici est le chiffre qui
    // justifie l'echelle d'attente, mesure dans une VRAIE fenetre plutot que par une sonde.
    report['mechanismTimeline'] = readMechanismTimeline(logDirectory);
    flush();

    // ---- CE QUE LE DIFF D ONGLETS PROUVE, ET CE QU IL NE PROUVE PAS ---------------------
    //
    // FALSIFICATION, parce qu'une preuve qu'on ne cherche pas a casser n'en est pas une.
    // `editor.open(<uuid>)` ouvre-t-il un panneau MEME pour une session qui n'a JAMAIS ete
    // amorcee ? Si oui, l'apparition d'un onglet ne dit rien de l'attachement — elle dit
    // seulement que la commande a repondu, et le lot D devra trancher autrement (D10,
    // `PANEL_ATTACHED_EMPTY`).
    //
    // Aucun cout : aucun tour n'est joue, aucune session n'existe.
    const ghostSession = '00000000-0000-4000-8000-0000000c1c1c';
    const panelsBeforeGhost = claudePanels();
    await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND, ghostSession);
    const ghostPanel = await waitFor(
      'the outcome of attaching a session that was NEVER seeded',
      () => (claudePanels().length !== panelsBeforeGhost.length ? claudePanels() : undefined),
      8_000
    ).catch(() => undefined);

    // LIBELLE DE L'ONGLET ATTACHE, SUIVI DANS LE TEMPS. `docs/compatibilite.md` (D10) designe
    // le libelle — « derive du contenu de la conversation » — comme le moyen de distinguer un
    // panneau attache d'un panneau vide. On RELEVE son evolution, on n'asserte pas dessus :
    // elle depend de la latence du modele, qui n'est le contrat de personne.
    const attachedLabel = appeared[0]?.label ?? '';
    const labelEvolution = await followLabel(attachedLabel, 45_000);
    report['attachmentEvidence'] = {
      ghostSessionOpensAPanel: ghostPanel !== undefined,
      ghostPanelsBefore: panelsBeforeGhost.length,
      ghostPanelsAfter: claudePanels().length,
      labelAtAttach: mask(attachedLabel),
      labelAfterWaiting: mask(labelEvolution.label),
      labelChangedAfterMs: labelEvolution.changedAfterMs,
      whatThisProves:
        "l apparition d un onglet prouve que editor.open a repondu ; le libelle, s il devient derive du contenu, prouve que la SESSION a ete chargee. C1 releve les deux et n asserte que le premier — trancher le second suppose de lire le transcript, donc le lot D.",
    };
    flush();

    // ---- Point 8 : LE REPLI V5, sur la vraie route ---------------------------------------
    const panelsBeforeFallback = claudePanels();
    const fallback = await postJson(
      entry.port,
      '/conversations',
      { prompt: OVERSIZED_PROMPT },
      authorization
    );
    const fallbackBody = JSON.parse(fallback.body) as Record<string, unknown>;
    const degraded = fallbackBody['degradedFrom'] as Record<string, unknown> | undefined;
    report['fallbackV5'] = {
      status: fallback.status,
      mode: fallbackBody['mode'],
      sessionId: fallbackBody['sessionId'],
      humanActionRequired: fallbackBody['humanActionRequired'],
      // LES DEUX, dans la MEME reponse : le repli s'AJOUTE a l'erreur, il ne la remplace pas.
      degradedFromCode: degraded?.['code'],
      degradedFromDetails: degraded?.['details'],
      claudePanelsBefore: panelsBeforeFallback.length,
      claudePanelsAfter: claudePanels().length,
    };
    flush();
    assert.equal(fallback.status, 200, 'the fallback must answer a degraded SUCCESS');
    assert.equal(fallbackBody['mode'], 'fallback', 'an oversized prompt must fall back to V5');
    assert.equal(fallbackBody['sessionId'], null, 'no session is seeded in fallback mode');
    assert.equal(fallbackBody['humanActionRequired'], true, 'the human must validate the prefilled prompt');
    assert.equal(degraded?.['code'], 'PROMPT_TOO_LARGE', 'the response must carry the named cause');

    // LE NOMBRE DE PANNEAUX EST RELEVÉ, JAMAIS ASSERTÉ — et c'est une correction, pas une
    // prudence. Une première version exigeait un panneau de PLUS ; mesuré sur deux exécutions
    // consécutives du même code, `editor.open(null, <prompt>)` a ouvert un troisième panneau
    // une fois (2 → 3) et RÉUTILISÉ un panneau existant l'autre (2 → 2). Le comportement n'est
    // pas contractuel : la commande pré-remplit le champ de saisie, elle ne promet pas
    // d'ouvrir un onglet neuf. Une assertion dessus est un test instable — c'est-à-dire, à
    // terme, un test qu'on désactive.
    //
    // Ce qui EST déterministe, et donc asserté, est le CONTRAT DE LA RÉPONSE : mode dégradé,
    // aucune session, validation humaine requise, et la cause nommée qui l'accompagne.
    assert.ok(
      claudePanels().length >= panelsBeforeFallback.length,
      'the fallback must never CLOSE a conversation'
    );

    // ---- Point 9 : « commande disparue », SANS toucher a l'installation ------------------
    //
    // Le mecanisme est pilote DIRECTEMENT, avec l'editeur REEL — seul l'inventaire de
    // commandes est filtre au point de verification. Rien n'est desinstalle, rien n'est
    // renomme : l'extension Claude reste intacte et active dans cette meme fenetre.
    const missingCommand = await refusalOf(withoutOpenCommand(), context.scratchDir);
    report['commandDisappeared'] = missingCommand;
    flush();
    assert.equal(missingCommand.code, 'CLAUDE_COMMAND_MISSING', 'the third cause must be named');
    assert.equal(
      missingCommand.fallbackAttempted,
      false,
      'no V5 fallback here: the fallback IS that very command'
    );

    // Et la fenetre est intacte : l'inventaire reel porte toujours la commande.
    assert.ok(
      (await vscode.commands.getCommands(true)).includes(CLAUDE_OPEN_COMMAND),
      'the real command inventory must be untouched by the injected refusal'
    );

    report['ok'] = true;
  } catch (error) {
    report['ok'] = false;
    report['failure'] = error instanceof Error ? `${error.name}: ${mask(error.message)}` : String(error);
    flush();
    throw error;
  } finally {
    flush();
  }
}

/**
 * Cherche sur disque la trace du tour 1 — **dans le TEST, jamais dans le produit**.
 *
 * C'est le seul endroit du dépôt qui regarde `<CONFIG>/projects/**`, et c'est délibéré : la
 * route ne PEUT pas s'y fier (frontière du lot D), mais la preuve, elle, doit pouvoir dire si
 * le tour a réellement eu lieu plutôt que de le laisser croire.
 *
 * Le slug de répertoire est la convention D7 (`:` et `\` → `-`). On CHERCHE aussi le fichier
 * par balayage : la convention n'est pas contractuelle, et une preuve qui conclurait « aucun
 * tour » sur un slug devenu faux serait une preuve fausse.
 */
async function lookForFirstTurn(
  sessionId: string,
  cwd: string,
  budgetMs: number
): Promise<Record<string, unknown>> {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const slug = cwd.replace(/[:\\/]/g, '-');
  const expected = path.join(projects, slug, `${sessionId}.jsonl`);

  const started = Date.now();
  let found: string | undefined;
  while (Date.now() - started < budgetMs) {
    if (fs.existsSync(expected)) {
      found = expected;
      break;
    }
    // Balayage : le slug n'est pas contractuel, le nom du fichier l'est davantage.
    for (const dir of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
      const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
    if (found !== undefined) break;
    await new Promise((done) => setTimeout(done, 1_000));
  }

  if (found === undefined) {
    return {
      transcriptFound: false,
      projectDirectoryExists: fs.existsSync(path.join(projects, slug)),
      waitedMs: Date.now() - started,
      // LE CHEMIN N'EST PAS RAPPORTÉ, et `mask` n'aurait pas suffi : le slug du CLI remplace
      // les séparateurs (`c--Users-<compte>-…`), donc il échappe à un masque qui cherche des
      // chemins. Ce rapport est joint à des PR d'un dépôt PUBLIC — seul le VERDICT a une
      // valeur de preuve, le chemin n'en a aucune.
      projectDirectoriesScanned: fs.existsSync(projects) ? fs.readdirSync(projects).length : 0,
    };
  }

  const lines = fs.readFileSync(found, 'utf8').split(/\r?\n/).filter((line) => line.length > 0);
  return {
    transcriptFound: true,
    waitedMs: Date.now() - started,
    lines: lines.length,
    bytes: fs.statSync(found).size,
    // Les TYPES d'enregistrements, jamais leur contenu : le rapport part dans une PR.
    recordTypes: [
      ...new Set(
        lines.map((line) => {
          try {
            return String((JSON.parse(line) as { type?: unknown }).type ?? 'sans-type');
          } catch {
            return 'illisible';
          }
        })
      ),
    ].sort(),
  };
}

/**
 * LA CONFIANCE DU CLI POUR CE REPERTOIRE — observee dans SON etat, jamais supposee.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * POURQUOI CE RELEVE EXISTE. Le CLI interactif pose la question de confiance PAR REPERTOIRE
 * (« Quick safety check », ADR-002) et l'enregistre dans son propre fichier d'etat, sous
 * `projects.<chemin>.hasTrustDialogAccepted`. Ce scenario tourne sur un dossier temporaire NEUF :
 * la question s'y pose donc, et le mecanisme NE DOIT PAS y repondre — le libelle de cette porte
 * n'est pas contractuel, et c'est `cmgr doctor` (lot D) qui devra la nommer.
 *
 * MESURE DU 2026-07-26 qui rend ce releve necessaire : dans un dossier neuf, le CLI s'arrete dans
 * `showSetupScreens()` et n'ecrit AUCUN transcript — 180 s d'observation, journal `--debug-file` a
 * l'appui. Dans un dossier dont la confiance a ete accordee une fois, le meme prompt ecrit son
 * transcript en 2 533 ms et sa reponse a 6 417 ms.
 *
 * CE N'EST PAS UNE INTERPRETATION DE FORMAT AU SENS DU PRODUIT : c'est un TEST qui lit un etat
 * pour choisir laquelle de ses deux assertions s'applique. `packages/**` n'en depend en RIEN.
 * Et si le fichier changeait de forme, ce releve rendrait `recordPresent: false` — le scenario
 * exigerait alors l'erreur nommee, c'est-a-dire le cote le plus severe des deux.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * AUCUN CHEMIN N'EST RAPPORTE : ce rapport part dans une PR d'un depot public, et les cles de ce
 * fichier sont des chemins de travail de l'utilisateur.
 */
function readCliFolderTrust(cwd: string): Record<string, unknown> {
  const stateFile = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(stateFile) || cwd.length === 0) {
    return { stateFileExists: fs.existsSync(stateFile), recordPresent: false, accepted: false };
  }

  let projects: Record<string, { hasTrustDialogAccepted?: unknown }> = {};
  try {
    projects =
      (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
        projects?: Record<string, { hasTrustDialogAccepted?: unknown }>;
      }).projects ?? {};
  } catch {
    // Illisible : on le DIT, et le scenario exigera l'erreur nommee.
    return { stateFileExists: true, unreadable: true, recordPresent: false, accepted: false };
  }

  // Les cles de ce fichier portent des separateurs `/` la ou `vscode` rend `\`, et une casse de
  // lettre de lecteur qui varie d'une entree a l'autre — c'est CONSTATE sur le poste de reference,
  // ou le meme dossier figure deux fois, en `c:/` et en `C:/`. La comparaison normalise donc les
  // deux, et c'est `path.sep` qui la porte plutot qu'un `\` code en dur.
  const normalize = (value: string): string => value.split(/[\\/]/).join('/').toLowerCase();
  const wanted = normalize(cwd);
  const record = Object.entries(projects).find(([key]) => normalize(key) === wanted);

  return {
    stateFileExists: true,
    // Des CHIFFRES et des BOOLEENS, jamais une cle : ce sont des chemins de travail.
    projectsKnown: Object.keys(projects).length,
    recordPresent: record !== undefined,
    accepted: record?.[1]?.hasTrustDialogAccepted === true,
  };
}

/**
 * LA CHRONOLOGIE DU MECANISME, tiree du journal PERSISTE de la fenetre.
 *
 * Le canal de journal de l'extension (`{ log: true }`) est ecrit dans un fichier sous
 * `logDirectory`, que `/health` publie. C'est la seule source qui DATE chaque etape du mecanisme :
 * l'envoi de la ligne, le demarrage du processus, l'apparition du transcript, son retour au
 * silence, la reponse de la commande d'attachement.
 *
 * Les lignes sont rendues MASQUEES et filtrees sur les etapes : le journal porte par ailleurs des
 * chemins et des identifiants de session.
 */
function readMechanismTimeline(logDirectory: string): Record<string, unknown> {
  const file = path.join(logDirectory, 'ClaudeManager.log');
  if (logDirectory.length === 0 || !fs.existsSync(file)) {
    return { logFileFound: false, logDirectoryPublished: logDirectory.length > 0 };
  }

  const interesting =
    /seed line sent|seed process started|transcript appeared|turn output settled|had not settled|attach command answered/;
  const lines = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => interesting.test(line))
    .map((line) => mask(line));

  return { logFileFound: true, steps: lines };
}

/** Combien de temps un terminal met a QUITTER `window.terminals` apres sa suppression. */
async function measureDisappearance(prefix: string): Promise<number> {
  const started = Date.now();
  await waitFor(
    `terminals named "${prefix}…" to leave window.terminals`,
    () => (visibleTerminals().some((name) => name.startsWith(prefix)) ? undefined : true),
    30_000
  );
  return Date.now() - started;
}

/**
 * Suit le libelle de l'onglet attache, et dit s'il a change — sans jamais l'asserter.
 *
 * Le libelle est le seul indice, cote `vscode`, de ce que le panneau porte REELLEMENT. Sa
 * valeur et son delai dependent du modele : les relever informe, les asserter ferait dependre
 * un critere de merge d'une latence de service.
 */
async function followLabel(
  initial: string,
  budgetMs: number
): Promise<{ readonly label: string; readonly changedAfterMs: number | null }> {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    const current = claudePanels().map((tab) => tab.label);
    const changed = current.find((label) => label !== initial && label.length > 0);
    if (changed !== undefined) return { label: changed, changedAfterMs: Date.now() - started };
    await new Promise((done) => setTimeout(done, 500));
  }
  return { label: initial, changedAfterMs: null };
}

/**
 * Mesure l'environnement REELLEMENT recu par un terminal monte comme celui du mecanisme.
 *
 * Ce n'est PAS le mecanisme : c'est une sonde, qui emprunte sa fonction de neutralisation et
 * son montage de terminal pour rendre observable ce que le mecanisme, lui, ne rend pas — la
 * sortie de son terminal n'est pas capturee, par construction.
 *
 * L'ecart que cette sonde documente : VSCode INJECTE dans un terminal des variables absentes
 * du `process.env` de l'extension host, et l'extension Claude y ajoute `CLAUDE_CODE_SSE_PORT`
 * par `EnvironmentVariableCollection`. L'affirmation juste est donc « aucun `CLAUDE*` HERITE
 * de la session appelante », jamais « aucun `VSCODE_*` ».
 */
async function probeTerminalEnvironment(scratchDir: string): Promise<{
  readonly extensionHostClaudeNames: readonly string[];
  readonly terminalClaudeNames: readonly string[];
  readonly inheritedClaudeNames: readonly string[];
  readonly neutralizedNames: readonly string[];
  readonly ssePortPresent: boolean;
  readonly totalKeys: number;
}> {
  const output = path.join(scratchDir, 'terminal-env.json');
  fs.rmSync(output, { force: true });

  const neutralized = neutralizedTerminalEnvironment(process.env);
  const terminal = vscode.window.createTerminal({
    name: 'ClaudeManager env probe',
    cwd: scratchDir,
    shellPath: 'pwsh.exe',
    shellArgs: ['-NoLogo'],
    hideFromUser: true,
    env: { ...neutralized },
  });
  // Les seuls NOMS sont ecrits, jamais les valeurs : elles portent des chemins personnels,
  // des tubes nommes et des identifiants de session, et ce rapport est joint a une PR.
  terminal.sendText(
    `[IO.File]::WriteAllText('${output.replace(/'/g, "''")}', ` +
      `(Get-ChildItem env: | Select-Object -ExpandProperty Name | ConvertTo-Json))`,
    true
  );

  try {
    const names = await waitForAsync(
      'the environment probe terminal to report the names it received',
      () =>
        Promise.resolve(
          fs.existsSync(output)
            ? (JSON.parse(fs.readFileSync(output, 'utf8')) as string[] | null) ?? undefined
            : undefined
        ),
      60_000
    );

    const extensionHostClaudeNames = Object.keys(process.env)
      .filter((name) => name.startsWith('CLAUDE'))
      .sort();
    const terminalClaudeNames = names.filter((name) => name.startsWith('CLAUDE')).sort();
    return {
      extensionHostClaudeNames,
      terminalClaudeNames,
      // CE QUI COMPTE : ce qui vient de la session APPELANTE et a survecu.
      inheritedClaudeNames: terminalClaudeNames.filter((name) =>
        extensionHostClaudeNames.includes(name)
      ),
      neutralizedNames: Object.keys(neutralized).sort(),
      // Injectee par l'extension Claude, invisible du `process.env` de l'extension host :
      // GARDEE deliberement, elle designe CETTE fenetre.
      ssePortPresent: terminalClaudeNames.includes('CLAUDE_CODE_SSE_PORT'),
      totalKeys: names.length,
    };
  } finally {
    terminal.dispose();
    fs.rmSync(output, { force: true });
  }
}

/** Le port REEL de cette fenetre, dont on retire la seule commande d'attachement. */
function withoutOpenCommand(): EditorPort {
  return {
    readWorkspace: () => ({
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      isTrusted: vscode.workspace.isTrusted,
    }),
    getClaudeExtension: () => {
      const extension = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
      if (extension === undefined) return undefined;
      return {
        get isActive(): boolean {
          return extension.isActive;
        },
        extensionPath: extension.extensionUri.fsPath,
        activate: async (): Promise<void> => {
          await extension.activate();
        },
      };
    },
    // LE SEUL POINT INJECTE — l'editeur est reel, l'extension Claude est reelle et active.
    listCommands: async (): Promise<readonly string[]> =>
      (await vscode.commands.getCommands(true)).filter((command) => command !== CLAUDE_OPEN_COMMAND),
    executeCommand: (command, ...args): Promise<unknown> => {
      executed.push(command);
      return Promise.resolve(vscode.commands.executeCommand(command, ...args));
    },
    createHiddenTerminal: () => {
      throw new Error('no terminal may be created once the attach command is known missing');
    },
    listPanelTabs: panelTabs,
  };
}

const executed: string[] = [];

async function refusalOf(
  editor: EditorPort,
  scratchDir: string
): Promise<{ readonly code: string; readonly fallbackAttempted: boolean; readonly message: string }> {
  executed.length = 0;
  try {
    await openConversation(
      { prompt: TINY_PROMPT },
      {
        editor,
        extHostPid: process.pid,
        promptDirectory: path.join(scratchDir, 'prompts-injected'),
        log: () => undefined,
      }
    );
    return { code: 'AUCUNE ERREUR', fallbackAttempted: executed.includes(CLAUDE_OPEN_COMMAND), message: '' };
  } catch (error) {
    const named = error as { code?: string; message?: string };
    return {
      code: named.code ?? 'INCONNU',
      // Le repli EST `claude-vscode.editor.open` : s'il avait ete tente, il figurerait ici.
      fallbackAttempted: executed.includes(CLAUDE_OPEN_COMMAND),
      message: mask(named.message ?? ''),
    };
  }
}
