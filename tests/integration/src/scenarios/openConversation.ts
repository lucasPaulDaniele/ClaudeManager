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
 *   2. `POST /conversations` ouvre une conversation, tour 1 REELLEMENT joue ;
 *   3. l'attachement est prouve par DIFF DES ONGLETS, `viewType` releve tel quel ;
 *   4. le terminal n'est JAMAIS visible, ni pendant ni apres ;
 *   5. l'environnement REELLEMENT recu par le terminal, dans la configuration complete ;
 *   6. `Host` etranger -> 403, `Origin` -> refus, sur la vraie socket ;
 *   7. le fichier de prompt transitoire n'existe plus ;
 *   8. le repli V5 : erreur nommee EMISE, PUIS repli execute — dans cet ordre ;
 *   9. les trois causes de l'etape 2, dont « commande disparue », SANS casser l'installation.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    assert.equal(
      (await probe(entry.port, '/health', authorization)).status,
      200,
      'the companion must answer /health before we ask it to act'
    );

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
    report['nominal'] = {
      status: opened.status,
      // MESUREE : c'est elle qui dit si l'attachement attend la session ou la precede.
      openMs,
      mode: openedBody['mode'],
      sessionId: openedBody['sessionId'],
      extHostPid: openedBody['extHostPid'],
      humanActionRequired: openedBody['humanActionRequired'],
      // Le shell a REELLEMENT engendre le processus du tour 1 — fait observe dans la table
      // des processus. Sans lui, l'attachement precedait la naissance de `claude`.
      seedProcessObserved: openedBody['seedProcessObserved'],
      panelViewType: openedBody['panelViewType'],
      bodyCarriesToken: opened.body.includes(entry.token),
    };
    flush();
    assert.equal(opened.status, 200, `POST /conversations must succeed; got ${mask(opened.body)}`);
    assert.equal(openedBody['mode'], 'nominal', 'the nominal V1 path must have been taken');
    assert.equal(openedBody['extHostPid'], extHostPid, 'the acting window must be THIS one');
    assert.equal(typeof openedBody['sessionId'], 'string', 'a session id must be returned');
    assert.equal(opened.body.includes(entry.token), false, 'no response may carry the token');
    assert.equal(
      openedBody['seedProcessObserved'],
      true,
      'the first-turn process must have been OBSERVED before the panel was attached'
    );

    // Point 3 — DIFF DES ONGLETS. L'absence d'erreur ne prouve rien : `editor.open` reussit
    // en ouvrant un panneau VIDE quand le `cwd` ne correspond pas au workspace.
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
    assert.ok(
      claudePanels().length > panelsBeforeFallback.length,
      'the fallback must have opened a conversation, prompt PRE-FILLED and not submitted'
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
