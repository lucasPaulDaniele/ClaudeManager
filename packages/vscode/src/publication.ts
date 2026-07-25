/**
 * Le CYCLE DE VIE de la publication d'une fenetre : publier, republier, se retirer.
 *
 * AUCUN IMPORT DE `vscode`, et c'est ce qui rend ce module verifiable. L'etat du workspace —
 * dossiers, confiance — est RELU a la demande par un rappel que l'appelant fournit : c'est la
 * seule chose que cette logique demandait a l'editeur, et c'est desormais un parametre.
 * Ce qui reste dans `extension.ts` est le cablage aux evenements, rien de plus.
 *
 * Le decoupage n'est pas cosmetique. Les deux defauts que ce module corrige — un refus de
 * publication qui retirait la fenetre DEFINITIVEMENT (C5), un serveur qui survivait a la
 * disparition de son entree (S6) — vivaient dans un fichier que rien ne pouvait eprouver
 * sans lancer un editeur complet. Ils sont maintenant couverts par des tests qui ouvrent de
 * vraies sockets et ecrivent dans un vrai repertoire de registre.
 */

import { existsSync } from 'node:fs';
import { resolveRegistryDir, writeWindowEntry, WINDOW_ENTRY_SCHEMA_VERSION } from './core.js';
import { describe } from './diagnostics.js';
import {
  buildWindowEntry,
  removeWindowEntry,
  windowEntryPath,
  type WindowIdentity,
} from './registry.js';
import { startServer, type HealthPayload, type ServerHandle } from './server.js';

/** Ce que l'editeur sait de son workspace, et qu'il est seul a savoir. */
export interface WorkspaceState {
  readonly workspaceFolders: readonly string[];
  readonly isTrusted: boolean;
}

export interface PublisherOptions {
  readonly identity: WindowIdentity;
  readonly extensionVersion: string;
  /** Propre a cette fenetre ET a cette session : il ne survit pas a un redemarrage. */
  readonly token: string;
  readonly logDirectory: string;
  /**
   * Relu a CHAQUE publication et a chaque requete `/health` : la confiance s'accorde en
   * cours de route et les dossiers changent. Un etat fige serait faux des la premiere
   * republication — laquelle n'a d'interet que parce que l'etat a bouge.
   */
  readonly readWorkspace: () => WorkspaceState;
  readonly log: (message: string) => void;
  /** Registre par defaut du poste sauf mention contraire — surcharge par les tests. */
  readonly registryDir?: string;
}

/** Ce qui n'existe QUE tant que la fenetre est publiee. */
interface Live {
  readonly startedAt: string;
  readonly server: ServerHandle;
}

export class WindowPublisher {
  /** Chemin du fichier d'entree de CETTE fenetre : l'appelant l'observe. */
  readonly entryFile: string;

  private readonly options: PublisherOptions;
  private readonly registryDir: string;
  private live: Live | undefined;
  /** Retombe a `false` a la fermeture : plus rien ne republie apres `close`. */
  private open = true;

  /**
   * File d'attente d'un seul rang : les transitions ne se chevauchent pas.
   *
   * Trois sources les declenchent — octroi de confiance, changement de dossiers, disparition
   * de l'entree — et rien ne garantit qu'elles ne se suivent pas de pres. Sans
   * serialisation, deux transitions concurrentes ouvriraient deux serveurs dont un seul
   * serait retenu : une ecoute orpheline, precisement ce que S6 reproche.
   */
  private transitions: Promise<unknown> = Promise.resolve();

  constructor(options: PublisherOptions) {
    this.options = options;
    // Resolu UNE fois : toutes les operations d'un meme cycle de vie portent alors sur le
    // meme repertoire, y compris si le repertoire personnel changeait en cours de route.
    this.registryDir = resolveRegistryDir(options.registryDir);
    this.entryFile = windowEntryPath(options.identity.extHostPid, this.registryDir);
  }

  /** Port en cours d'ecoute, ou `undefined` si la fenetre n'est pas publiee. */
  get port(): number | undefined {
    return this.live?.server.port;
  }

  get isPublished(): boolean {
    return this.live !== undefined;
  }

  /**
   * Enchaine une transition derriere les precedentes.
   *
   * Le `catch` porte sur la CHAINE, pas sur la tache : une transition qui echoue ne doit
   * jamais bloquer les suivantes. Chaque tache journalise deja sa propre defaillance ; ce
   * garde-fou n'est la que pour ce que personne n'a prevu.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T | undefined> {
    // `then(task, task)` : la tache part aussi quand la precedente a echoue — la file ne
    // doit pas se rompre sur un incident deja journalise.
    const settled = this.transitions.then(task, task);
    this.transitions = settled.catch((error: unknown) => {
      this.options.log(`a publication transition failed unexpectedly — ${describe(error)}`);
    });
    return settled.catch(() => undefined);
  }

  private health(): HealthPayload {
    const workspace = this.options.readWorkspace();
    return {
      ok: true,
      schemaVersion: WINDOW_ENTRY_SCHEMA_VERSION,
      extensionVersion: this.options.extensionVersion,
      extHostPid: this.options.identity.extHostPid,
      mainPid: this.options.identity.mainPid,
      isTrusted: workspace.isTrusted,
      workspaceFolders: workspace.workspaceFolders,
      logDirectory: this.options.logDirectory,
    };
  }

  /**
   * Rend la fenetre publiee, quel que soit l'etat d'ou l'on part. IDEMPOTENTE.
   *
   * C'EST LA REPRISE ELLE-MEME, et elle corrige C5 : un refus de publication retirait la
   * fenetre DEFINITIVEMENT, parce que le retrait effacait l'etat que les abonnements de
   * reprise testaient avant d'agir. Une fenetre ouverte sans dossier de travail, a qui l'on
   * en ajoutait un ensuite, ne se publiait donc jamais.
   *
   * Le refus n'est PAS anticipe par un controle local : c'est `writeWindowEntry` qui juge,
   * et son erreur nommee qu'on journalise. Redire ici sa regle de validation la ferait
   * diverger un jour — et le cas le plus frequent, la fenetre sans dossier de travail, est
   * precisement une regle du coeur (`REGISTRY_ENTRY_INVALID`).
   *
   * Une republication REDEMARRE ce qu'un retrait avait arrete : le serveur est rouvert s'il
   * ne l'est plus. Son port change alors, et c'est sans consequence — l'entree qui le porte
   * est reecrite dans la foulee, et personne ne connait un port autrement que par elle.
   */
  ensurePublished(reason: string): Promise<boolean> {
    return this.enqueue(() => this.publishNow(reason)).then((published) => published === true);
  }

  private async publishNow(reason: string): Promise<boolean> {
    // `close` a deja joue : republier rouvrirait une ecoute que plus rien ne fermerait.
    if (!this.open) return false;

    let live = this.live;
    if (live === undefined) {
      try {
        const server = await startServer({
          token: this.options.token,
          health: () => this.health(),
          onError: (error) => this.options.log(`local server error — ${describe(error)}`),
        });
        live = { startedAt: new Date().toISOString(), server };
        this.live = live;
        this.options.log(
          `local server listening (${reason}): port=${server.port} address=${server.address}`
        );
      } catch (error) {
        this.options.log(
          `this window is NOT reachable, the local server failed to listen (${reason}) — ${describe(error)}`
        );
        return false;
      }
    }

    const workspace = this.options.readWorkspace();
    const entry = buildWindowEntry({
      identity: this.options.identity,
      port: live.server.port,
      token: this.options.token,
      extensionVersion: this.options.extensionVersion,
      startedAt: live.startedAt,
      workspaceFolders: workspace.workspaceFolders,
      isTrusted: workspace.isTrusted,
    });

    try {
      writeWindowEntry(entry, { dir: this.registryDir });
    } catch (error) {
      this.options.log(`refusing to publish this window (${reason}) — ${describe(error)}`);
      // La fenetre reste parfaitement utilisable : elle n'est simplement pas pilotable. Et
      // elle le redeviendra des que son etat le permettra — l'objet, lui, survit.
      await this.withdrawNow(`entry rejected (${reason})`);
      return false;
    }

    // Le jeton n'est JAMAIS journalise. Les chemins du workspace non plus : seul leur nombre
    // est utile ici, et `GET /health` les rend a qui detient le jeton.
    this.options.log(
      `published (${reason}): extHostPid=${entry.extHostPid} mainPid=${entry.mainPid} ` +
        `port=${entry.port} trusted=${entry.isTrusted} workspaceFolders=${entry.workspaceFolders.length}`
    );
    return true;
  }

  /**
   * Republie si l'entree de cette fenetre a disparu sous ses pieds.
   *
   * DEFAUT S6 : l'entree est un simple fichier, que n'importe quoi peut effacer — une autre
   * fenetre qui balaie sur un instantane tronque, un utilisateur, un installateur. Le
   * serveur, lui, restait ouvert et joignable : une ecoute vivante que plus aucun registre
   * ne decrivait, et une fenetre devenue non pilotable SANS qu'aucune erreur ne soit emise.
   * Le commentaire de `withdraw` declarait ce couplage impossible ; il ne l'etait que dans
   * un sens.
   *
   * REPUBLIER PLUTOT QUE SE RETIRER, et c'est un choix : la fenetre est VIVANTE. Se retirer
   * reviendrait a enteriner une suppression qui, dans tous les scenarios identifies, est une
   * erreur de tiers — et laisserait l'humain sans recours autre qu'un rechargement complet.
   * Republier est idempotent, sans effet visible, et remet le registre en accord avec la
   * realite. Un retrait reste possible : il suffit que la republication soit refusee, et le
   * chemin de refus ci-dessus s'en charge.
   *
   * Le retrait DELIBERE ne passe jamais par ici : `withdraw` efface `live` AVANT de
   * supprimer le fichier, et cette methode ne fait rien quand la fenetre n'est pas publiee.
   */
  republishIfEntryVanished(reason: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.open || this.live === undefined) return;
      if (existsSync(this.entryFile)) return;

      this.options.log(`this window's registry entry vanished (${reason}), republishing`);
      await this.publishNow(`entry vanished, ${reason}`);
    }).then(() => undefined);
  }

  /** Retire la fenetre du registre et ferme son serveur, SANS fermer le cycle de vie. */
  withdraw(reason: string): Promise<void> {
    return this.enqueue(() => this.withdrawNow(reason)).then(() => undefined);
  }

  /**
   * Fin de vie : retrait, et plus aucune republication ensuite.
   *
   * `open` tombe EN PREMIER — une transition deja en file ne doit pas rouvrir une ecoute
   * derriere la desactivation.
   */
  close(reason: string): Promise<void> {
    this.open = false;
    return this.enqueue(() => this.withdrawNow(reason)).then(() => undefined);
  }

  /**
   * Les deux vont ENSEMBLE : un serveur ouvert sans entree pour le joindre n'est joignable
   * par personne, et une entree sans serveur derriere designe une fenetre morte.
   *
   * `live` est efface AVANT toute suppression, et l'ordre compte : c'est lui qui distingue,
   * pour l'observateur de l'entree, un retrait DELIBERE d'une disparition subie.
   */
  private async withdrawNow(reason: string): Promise<void> {
    const live = this.live;
    this.live = undefined;
    // Rien a retirer : la fenetre n'avait pas ete publiee.
    if (live === undefined) return;

    try {
      removeWindowEntry(this.options.identity.extHostPid, this.registryDir);
    } catch (error) {
      this.options.log(
        `could not remove this window's registry entry (${reason}) — ${describe(error)}`
      );
    }

    try {
      await live.server.close();
    } catch (error) {
      this.options.log(`could not close the local server (${reason}) — ${describe(error)}`);
    }

    this.options.log(
      `window withdrawn (${reason}): extHostPid=${this.options.identity.extHostPid}`
    );
  }
}
