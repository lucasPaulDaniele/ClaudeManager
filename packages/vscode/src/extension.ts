/**
 * Extension compagnon ClaudeManager — elle rend CETTE fenetre joignable, et rien d'autre.
 *
 * ACTIVATION TOTALEMENT INVISIBLE (principe fondateur n.1) : aucune notification, aucun
 * `outputChannel.show()`, aucune commande contribuee, aucune vue revelee. L'outil s'execute
 * pendant que l'humain travaille ailleurs — se manifester a l'ecran serait deja un vol
 * d'attention, et rendrait le pilotage non deterministe.
 *
 * SEUL POINT DE CONTACT AVEC L'EDITEUR de tout le paquet, et volontairement mince : il
 * releve l'etat que seule une fenetre connait, cable les evenements, et delegue. Le cycle de
 * vie de la publication vit dans `publication.ts`, la plomberie de registre dans
 * `registry.ts`, le serveur dans `server.ts`, la mise en forme des defaillances dans
 * `diagnostics.ts` — tous sans `vscode`, donc tous verifies en Node pur. Ce qui reste ici
 * est, par construction, ce que seule une vraie fenetre peut eprouver : c'est la raison de
 * son exclusion nommee de la mesure de couverture (`vitest.config.ts`).
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  openConversation,
  serializeOpenings,
  sweepAbandonedPrompts,
  type ClaudeExtensionHandle,
  type EditorPort,
  type HiddenTerminal,
  type HiddenTerminalSpec,
  type OpenConversationRequest,
  type OpenConversationResult,
} from './conversations.js';
import { purgeStaleEntries, readProcessTable } from './core.js';
import { describe, readExtensionVersion } from './diagnostics.js';
import { WindowPublisher, type WorkspaceState } from './publication.js';
import { readWindowIdentity } from './registry.js';
import { CLAUDE_EXTENSION_ID, type PanelTabLike } from './seed.js';

const OUTPUT_CHANNEL = 'ClaudeManager';

let output: vscode.LogOutputChannel | undefined;
let publisher: WindowPublisher | undefined;

/**
 * Journalise dans le canal de journal de la fenetre.
 *
 * CANAL DE JOURNAL (`{ log: true }`) et non canal de sortie ordinaire : VSCode en
 * PERSISTE le contenu dans un fichier, sous
 * `<user-data-dir>/logs/<horodatage>/window<N>/exthost/<id d'extension>/`. Deux consequences
 * voulues : l'activation devient mesurable de l'EXTERIEUR — sans quoi les durees
 * d'activation et de balayage ne seraient lisibles que dans l'UI, donc inverifiables par un
 * agent —, et `cmgr doctor` (lot D) pourra lire ce journal pour diagnostiquer une fenetre
 * muette. Le repertoire est publie sur `GET /health`, sans quoi rien ne permettrait de
 * l'atteindre : son chemin comporte deux segments indevinables.
 *
 * `show()` reste INTERDIT (principe fondateur n.1) : le support change, pas la regle.
 * L'horodatage est fourni par VSCode, il n'est pas redit ici.
 */
function log(message: string): void {
  output?.info(message);
}

/** L'unique chose que le cycle de publication demande a l'editeur. */
function readWorkspace(): WorkspaceState {
  return {
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    isTrusted: vscode.workspace.isTrusted,
  };
}

/**
 * L'ADAPTATEUR D'EDITEUR DU MECANISME V1 — traduction, ZERO decision.
 *
 * Il vit ici pour la meme raison que tout le reste de ce fichier : c'est le SEUL point de
 * contact du paquet avec l'API `vscode`. Chaque membre est un appel direct ; le mecanisme
 * lui-meme — l'ordre des etapes, les refus, le repli, la preuve d'attachement — est dans
 * `conversations.ts`, sans `vscode`, donc mesure et couvert.
 *
 * `show()` n'apparait NULLE PART, et le port ne l'expose meme pas : reveler un terminal
 * volerait le focus (principe fondateur n.1).
 */
function editorPort(): EditorPort {
  return {
    readWorkspace,

    getClaudeExtension(): ClaudeExtensionHandle | undefined {
      const extension = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
      if (extension === undefined) return undefined;
      return {
        // Relu a CHAQUE lecture : `isActive` bascule pendant l'activation qu'on demande.
        get isActive(): boolean {
          return extension.isActive;
        },
        extensionPath: extension.extensionUri.fsPath,
        activate: async (): Promise<void> => {
          await extension.activate();
        },
      };
    },

    // `true` : l'inventaire COMPLET, commandes internes comprises. Les `claude-vscode.*` sont
    // enregistrees a l'activation, elles n'y figurent pas avant.
    listCommands: (): Promise<readonly string[]> =>
      Promise.resolve(vscode.commands.getCommands(true)),

    executeCommand: (command, ...args): Promise<unknown> =>
      Promise.resolve(vscode.commands.executeCommand(command, ...args)),

    createHiddenTerminal(spec: HiddenTerminalSpec): HiddenTerminal {
      const terminal = vscode.window.createTerminal({
        name: spec.name,
        cwd: spec.cwd,
        shellPath: spec.shellPath,
        shellArgs: [...spec.shellArgs],
        // `hideFromUser` : le terminal n'apparait meme pas dans la liste des terminaux, et
        // `show()` n'est jamais appele. Duree de visibilite pour l'humain : nulle.
        hideFromUser: true,
        // La carte de neutralisation, telle quelle : `null` supprime, `undefined` n'agirait
        // PAS et `''` laisserait la variable presente (mesure, ADR-004). Le type du port ne
        // permet que `null`.
        env: { ...spec.env },
      });
      return {
        sendText: (line) => terminal.sendText(line, true),
        dispose: () => terminal.dispose(),
        processId: () => Promise.resolve(terminal.processId),
      };
    },

    // ENUMERATION EN LECTURE SEULE. `tabGroups.close` n'est appele nulle part : fermer une
    // conversation releve de l'increment C3.
    //
    // Le diff du mecanisme compare des CLES (`viewType` + `label`), jamais l'identite des
    // objets `Tab` — celle-ci n'est garantie par aucune documentation, et ces enveloppes sont
    // de toute facon reconstruites a chaque releve.
    listPanelTabs: (): readonly PanelTabLike[] =>
      vscode.window.tabGroups.all.flatMap((group) =>
        group.tabs.map((tab) => ({
          viewType: tab.input instanceof vscode.TabInputWebview ? tab.input.viewType : undefined,
          label: tab.label,
        }))
      ),
  };
}

/**
 * Balaie les entrees dont la fenetre n'existe plus.
 *
 * L'INVENTAIRE EST ASYNCHRONE, ET C'EST CE QUI REND LA MAIN A L'EDITEUR :
 * `readProcessTable` coute de 700 ms a 1,3 s (PowerShell + `Get-CimInstance`), et
 * l'extension host n'a qu'UNE boucle d'evenements, partagee par toutes les extensions de
 * la fenetre. Un appel synchrone la bloquait pendant tout ce temps — et le differer d'un
 * tick n'y changeait rien, la tache repartant sur la meme boucle. Attendre reellement une
 * commande asynchrone est la seule forme qui ne fige personne.
 *
 * Son echec n'empeche jamais la publication : publier est la fonction vitale, balayer n'est
 * que de l'hygiene. L'erreur est nommee et journalisee, puis l'extension continue.
 */
async function sweepStaleEntries(current: WindowPublisher): Promise<void> {
  const start = performance.now();
  try {
    const { removed, removedTemporaries, kept } = purgeStaleEntries({
      snapshot: await readProcessTable(),
    });
    const elapsed = Math.round(performance.now() - start);
    const detail = removed.length > 0 ? ` (${removed.join(', ')})` : '';
    // LES TROIS COMPTES, ET C'EST CE QUI REND LA PROMESSE DE `PurgeResult` VRAIE MAINTENANT
    // (V2-11) : ce type annonce que `kept` existe pour empecher « une disparition
    // silencieuse », et que `removedTemporaries` recense des fichiers QUI PORTAIENT UN JETON
    // EN CLAIR. Leur unique appelant les jetait — la propriete n'etait donc vraie nulle part.
    // Le consommateur NOMME reste `cmgr doctor` (lot D) ; en attendant, une interpolation dans
    // une ligne de journal deja ecrite coute zero et rend la trace consultable.
    log(
      `sweep completed in ${elapsed} ms: ${removed.length} stale entries removed${detail}, ` +
        `${removedTemporaries.length} abandoned write temporaries removed, ${kept.length} kept`
    );
    // Ce qui est LAISSE est nomme un par un, avec son motif : une entree immortelle — pid
    // recycle, suppression refusee par le systeme — n'est utile que si on peut la designer.
    for (const entry of kept) log(`  kept ${entry.file}: ${entry.reason}`);
  } catch (error) {
    const elapsed = Math.round(performance.now() - start);
    log(`sweep failed after ${elapsed} ms, this window stays published — ${describe(error)}`);
  }

  // MOMENT NATUREL, et le seul GARANTI du cycle de vie : on vient de parcourir le registre
  // en entier. Verifier que notre propre entree y est encore et qu'elle est bien LA NOTRE ne
  // coute qu'une lecture de fichier, et couvre le cas ou un balayage — le notre, ou celui
  // d'une fenetre demarree en meme temps — vient de l'emporter. L'observateur ci-dessous
  // couvre la suite ; celui-ci ne depend d'aucune API de surveillance (findings S6 et S2).
  await current.republishIfEntryLost('after the sweep');
}

/**
 * Surveille le fichier d'entree de CETTE fenetre, et rien d'autre.
 *
 * Le controle post-balayage n'a lieu qu'une fois : il ne verrait pas une suppression
 * survenue une heure plus tard. Cet observateur la voit — sans aucun sondage, VSCode
 * s'appuyant sur les notifications du systeme de fichiers. Le motif designe le SEUL fichier
 * de cette fenetre : aucune entree d'une autre fenetre n'est observee, encore moins touchee.
 *
 * LES MODIFICATIONS SONT OBSERVEES, ET C'EST LA CORRECTION DE S2. Elles etaient ignorees au
 * motif que « ce sont les notres, et rien d'autre n'ecrit ce nom » — un presuppose FAUX : tout
 * processus du compte peut ecraser ce fichier sous son propre nom, et c'est meme la voie la
 * plus simple pour lui, puisqu'elle lui evite d'avoir a choisir un nom. L'observateur ne
 * defendait donc que la suppression, c'est-a-dire le cas benin. `republishIfEntryLost`
 * confronte desormais le contenu a ce que la fenetre a ecrit : nos propres republications
 * declenchent bien cet evenement, et s'y reconnaissent sans rien reecrire.
 *
 * Les CREATIONS restent ignorees : l'ecriture du coeur est un `rename` sur un fichier qui, au
 * moment ou l'on republie, existe deja — un remplacement se presente donc en modification, et
 * une suppression suivie d'une reecriture declenche d'abord la suppression.
 *
 * Sa creation est gardee : le repertoire du registre est HORS du workspace, et rien ne
 * garantit qu'un observateur y soit possible partout. S'il ne l'est pas, on le DIT — la
 * fenetre perd la reprise tardive, pas la publication (principe fondateur n.3).
 */
function watchOwnEntry(current: WindowPublisher): vscode.Disposable | undefined {
  try {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(current.entryFile)),
        path.basename(current.entryFile)
      ),
      // ignoreCreateEvents, ignoreChangeEvents, ignoreDeleteEvents
      true,
      false,
      false
    );
    watcher.onDidChange(() => {
      void current.republishIfEntryLost('watcher, entry changed');
    });
    watcher.onDidDelete(() => {
      void current.republishIfEntryLost('watcher, entry deleted');
    });
    return watcher;
  } catch (error) {
    log(
      `could not watch this window's registry entry, a late deletion will go unnoticed — ${describe(error)}`
    );
    return undefined;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const activationStart = performance.now();

  const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL, { log: true });
  // `show()` n'est JAMAIS appele : reveler le panneau de sortie volerait le focus.
  context.subscriptions.push(channel);
  output = channel;

  const identity = readWindowIdentity();

  /**
   * LA ROUTE D'OUVERTURE, cablee ici et nulle part ailleurs.
   *
   * `serializeOpenings` : deux ouvertures concurrentes dans la MEME fenetre se voleraient
   * leur preuve d'attachement, qui est un diff d'onglets. Une a la fois.
   *
   * `globalStorageUri` porte le fichier transitoire du prompt : un repertoire propre a
   * l'extension, HORS du workspace de l'utilisateur — un prompt d'orchestration n'a rien a
   * faire dans un depot, fut-ce une milliseconde.
   */
  const promptDirectory = path.join(context.globalStorageUri.fsPath, 'prompts');
  const openRoute = serializeOpenings((request: OpenConversationRequest): Promise<OpenConversationResult> =>
    openConversation(request, {
      editor: editorPort(),
      extHostPid: identity.extHostPid,
      promptDirectory,
      log,
    })
  );

  const current = new WindowPublisher({
    identity,
    extensionVersion: readExtensionVersion(context.extension.packageJSON),
    // Propre a cette fenetre ET a cette session : il ne survit pas a un redemarrage.
    token: randomUUID(),
    logDirectory: context.logUri.fsPath,
    readWorkspace,
    openConversation: openRoute,
    log,
  });
  publisher = current;

  // ORDRE IMPOSE, ET C'EST LA CORRECTION DE C5 : les abonnements de reprise sont poses AVANT
  // la premiere tentative de publication. Auparavant, le chemin d'echec a l'activation
  // rendait la main avant de les enregistrer — la fenetre qui demarrait sans dossier de
  // travail n'avait donc aucun moyen d'apprendre qu'on venait de lui en ajouter un.
  context.subscriptions.push(
    // La confiance accordee en cours de route change `isTrusted` : republier remplace
    // l'entree, la publication etant idempotente.
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void current.ensurePublished('workspace trust granted');
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void current.ensurePublished('workspace folders changed');
    })
  );

  const watcher = watchOwnEntry(current);
  if (watcher !== undefined) context.subscriptions.push(watcher);

  // Publier d'abord, balayer ensuite. Un balayage qui echoue ou qui traine ne doit jamais
  // retarder la joignabilite de la fenetre.
  await current.ensurePublished('activation');

  // Lance sans etre attendu : `activate` rend la main immediatement, et le balayage — qui
  // ne bloque plus rien — rapporte sa ligne de journal quand il aboutit.
  void sweepStaleEntries(current);

  // LE MOMENT QUI MANQUAIT, ET C'EST LE SEUL GARANTI (V2-4) : un host qui demarre prouve que
  // le precedent est mort. Le balayage des prompts abandonnes n'avait qu'un site d'appel,
  // `openConversation` — un prompt laisse en clair par un host tue entre l'ecriture du fichier
  // et l'envoi de la ligne y restait donc indefiniment dans une fenetre qui n'ouvre plus rien.
  // La symetrie avec `sweepStaleEntries`, qui balaie le registre a cet instant precis, est
  // faite. Synchrone et sans risque : un `readdir` sur un repertoire de transit, et la
  // fonction ne leve JAMAIS. L'age reste exige — ce repertoire est partage par toutes les
  // fenetres du poste, voir `sweepAbandonedPrompts`.
  sweepAbandonedPrompts(promptDirectory, Date.now(), log);

  log(`activation completed in ${(performance.now() - activationStart).toFixed(1)} ms`);
}

/**
 * `deactivate` n'est PAS toujours appele — une fenetre tuee ne le joue jamais. C'est
 * exactement pourquoi le balayage existe : l'entree laissee derriere sera reconnue morte
 * par la prochaine fenetre qui demarre.
 */
export async function deactivate(): Promise<void> {
  const current = publisher;
  publisher = undefined;
  if (current === undefined) return;
  await current.close('deactivate');
}
