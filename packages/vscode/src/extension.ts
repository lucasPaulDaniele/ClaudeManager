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
import { purgeStaleEntries, readProcessTable } from './core.js';
import { describe, readExtensionVersion } from './diagnostics.js';
import { WindowPublisher, type WorkspaceState } from './publication.js';
import { readWindowIdentity } from './registry.js';

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
    const { removed } = purgeStaleEntries({ snapshot: await readProcessTable() });
    const elapsed = Math.round(performance.now() - start);
    const detail = removed.length > 0 ? ` (${removed.join(', ')})` : '';
    log(`sweep completed in ${elapsed} ms: ${removed.length} stale entries removed${detail}`);
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

  const current = new WindowPublisher({
    identity: readWindowIdentity(),
    extensionVersion: readExtensionVersion(context.extension.packageJSON),
    // Propre a cette fenetre ET a cette session : il ne survit pas a un redemarrage.
    token: randomUUID(),
    logDirectory: context.logUri.fsPath,
    readWorkspace,
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
