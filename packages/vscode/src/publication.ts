/**
 * Le CYCLE DE VIE de la publication d'une fenetre : publier, republier, se retirer.
 *
 * AUCUN IMPORT DE `vscode`, et c'est ce qui rend ce module verifiable. L'etat du workspace —
 * dossiers, confiance — est RELU a la demande par un rappel que l'appelant fournit : c'est la
 * seule chose que cette logique demandait a l'editeur, et c'est desormais un parametre.
 * Ce qui reste dans `extension.ts` est le cablage aux evenements, rien de plus.
 *
 * Le decoupage n'est pas cosmetique. Les defauts que ce module corrige — un refus de
 * publication qui retirait la fenetre DEFINITIVEMENT (C5), un serveur qui survivait a la
 * disparition de son entree (S6), une defaillance TRANSITOIRE d'ecriture qui rendait la
 * fenetre definitivement injoignable (C2), une entree SUBSTITUEE sous son propre nom que rien
 * ne detectait (S2), une ecoute morte que l'entree continuait d'annoncer (S5) — vivaient tous
 * dans un fichier que rien ne pouvait eprouver sans lancer un editeur complet. Ils sont
 * maintenant couverts par des tests qui ouvrent de vraies sockets et ecrivent dans un vrai
 * repertoire de registre.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LE SERVEUR ET L'ENTREE VONT ENSEMBLE, DANS LES DEUX SENS, et c'est l'invariant que tout ce
 * module defend :
 *
 *   - un serveur ouvert que plus aucune entree ne decrit n'est joignable par personne (S6) ;
 *   - une entree qui annonce un port mort envoie le jeton de la fenetre a qui a recupere ce
 *     port (S5).
 *
 * Toute transition ci-dessous dit donc EXPLICITEMENT ce qu'elle fait des deux.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync } from 'node:fs';
import {
  ERROR_CODES,
  isClaudeManagerError,
  resolveRegistryDir,
  writeWindowEntry,
  WINDOW_ENTRY_SCHEMA_VERSION,
  type WindowEntry,
} from './core.js';
import { describe } from './diagnostics.js';
import {
  buildWindowEntry,
  removeWindowEntry,
  windowEntryPath,
  type WindowIdentity,
} from './registry.js';
import {
  startServer,
  type CloseConversationRoute,
  type HealthPayload,
  type ListConversationsRoute,
  type OpenConversationRoute,
  type ServerHandle,
} from './server.js';

/** Ce que l'editeur sait de son workspace, et qu'il est seul a savoir. */
export interface WorkspaceState {
  readonly workspaceFolders: readonly string[];
  readonly isTrusted: boolean;
}

/**
 * ECHELLE DE REPRISE APRES UNE DEFAILLANCE D'ECRITURE — bornee, croissante, en millisecondes.
 *
 * Le scenario qu'elle couvre est celui que la remediation de `REGISTRY_UNWRITABLE` nomme
 * elle-meme : un antivirus ou un indexeur qui verrouille `~/.claudemanager/windows` pendant les
 * quelques millisecondes du `renameSync` d'activation. Les deux premiers echelons suffisent a
 * l'ecrasante majorite de ces verrous ; les deux derniers couvrent un balayage antiviral
 * complet. Au-dela, la defaillance n'est plus transitoire et la fenetre se retire — plutot que
 * d'entretenir indefiniment une ecoute que plus aucune entree ne decrit (defaut S6).
 *
 * BORNEE, et c'est le point : une reprise sans fin masquerait un poste reellement casse.
 */
const WRITE_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 5_000, 30_000];

/**
 * Combien de fois on rouvre une ecoute morte avant de renoncer.
 *
 * Une socket HTTP en ecoute sur la boucle locale ne se ferme pas d'elle-meme : la premiere
 * mort est deja une anomalie, et cinq d'affilee designent un poste ou l'ecoute n'est pas
 * tenable. On le DIT alors, plutot que de rouvrir en boucle (principe fondateur n.3).
 */
const MAX_SERVER_LOSSES = 5;

/** Reprise differee par defaut — remplacable par les tests, qui n'ont pas a attendre. */
function scheduleLater(task: () => void, delayMs: number): void {
  const timer = setTimeout(task, delayMs);
  // Une reprise ACCOMPAGNE une fenetre vivante, elle ne la prolonge pas : un `--user-data-dir`
  // qui se ferme ne doit pas attendre 30 s qu'un minuteur d'hygiene se declenche.
  timer.unref();
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
  /**
   * Les trois routes de conversation, traversees telles quelles jusqu'au serveur.
   *
   * Elles ne sont PAS appelees ici : ce module porte le cycle de vie de la publication, pas les
   * effets de bord du produit. Il ne fait que les transmettre a chaque serveur qu'il ouvre —
   * y compris a celui d'une reouverture apres une mort d'ecoute.
   */
  readonly openConversation: OpenConversationRoute;
  readonly listConversations: ListConversationsRoute;
  readonly closeConversation: CloseConversationRoute;
  readonly log: (message: string) => void;
  /** Registre par defaut du poste sauf mention contraire — surcharge par les tests. */
  readonly registryDir?: string;
  /**
   * Programme une reprise differee. Defaut : `setTimeout`, non retenant.
   *
   * SEUL POINT D'INJECTION de ce module avec `readWorkspace`, et il est la pour la meme
   * raison : ce qu'il faut prouver est que la reprise A LIEU, pas qu'elle attend 250 ms. Un
   * test qui patienterait reellement ne prouverait rien de plus et couterait trente secondes.
   */
  readonly schedule?: (task: () => void, delayMs: number) => void;
}

/** Ce qui n'existe QUE tant que la fenetre est publiee. */
interface Live {
  readonly startedAt: string;
  readonly server: ServerHandle;
  /**
   * L'entree que cette fenetre a REELLEMENT ecrite, ou `undefined` tant qu'aucune ecriture
   * n'a abouti. C'est la REFERENCE a laquelle le disque est confronte (defaut S2) : sans
   * elle, la seule question qu'on savait poser etait « le fichier existe-t-il ? ».
   */
  published: WindowEntry | undefined;
}

/**
 * Ce que le disque porte encore de cette fenetre, au moment ou on regarde.
 *
 * `gone` et `substituted` appellent la MEME reprise et des motifs de journal DIFFERENTS : une
 * suppression est, dans tous les scenarios identifies, une erreur de tiers ; un remplacement
 * est un acte, et l'humain doit le voir passer.
 */
type EntryVerdict = 'ours' | 'gone' | 'substituted';

export class WindowPublisher {
  /** Chemin du fichier d'entree de CETTE fenetre : l'appelant l'observe. */
  readonly entryFile: string;

  private readonly options: PublisherOptions;
  private readonly registryDir: string;
  private readonly schedule: (task: () => void, delayMs: number) => void;
  private live: Live | undefined;
  /** Retombe a `false` a la fermeture : plus rien ne republie apres `close`. */
  private open = true;
  /** Rang atteint dans l'echelle de reprise. Remis a zero par toute ecriture qui aboutit. */
  private writeFailures = 0;
  /** Une seule reprise en vol a la fois — sinon deux echelles se superposeraient. */
  private retryPending = false;
  /** Morts d'ecoute non demandees depuis le debut du cycle de vie (defaut S5). */
  private serverLosses = 0;

  /**
   * File d'attente d'un seul rang : les transitions ne se chevauchent pas.
   *
   * Cinq sources les declenchent — octroi de confiance, changement de dossiers, disparition
   * ou substitution de l'entree, reprise apres une ecriture refusee, mort de l'ecoute — et
   * rien ne garantit qu'elles ne se suivent pas de pres. Sans serialisation, deux transitions
   * concurrentes ouvriraient deux serveurs dont un seul serait retenu : une ecoute orpheline,
   * precisement ce que S6 reproche.
   */
  private transitions: Promise<unknown> = Promise.resolve();

  constructor(options: PublisherOptions) {
    this.options = options;
    this.schedule = options.schedule ?? scheduleLater;
    // Resolu UNE fois : toutes les operations d'un meme cycle de vie portent alors sur le
    // meme repertoire, y compris si le repertoire personnel changeait en cours de route.
    this.registryDir = resolveRegistryDir(options.registryDir);
    this.entryFile = windowEntryPath(options.identity.extHostPid, this.registryDir);
  }

  /** L'ecoute en cours, ou `undefined` si la fenetre n'est pas publiee. */
  get server(): ServerHandle | undefined {
    return this.live?.server;
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
          openConversation: this.options.openConversation,
          listConversations: this.options.listConversations,
          closeConversation: this.options.closeConversation,
          onError: (error) => this.options.log(`local server error — ${describe(error)}`),
          onClosed: () => this.handleServerLoss(),
        });
        live = { startedAt: new Date().toISOString(), server, published: undefined };
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
      return this.refuseToPublish(error, reason);
    }

    // MEMORISEE, et c'est ce qui rend la substitution detectable (defaut S2) : l'entree que
    // nous avons ecrite est desormais la reference a laquelle le disque se confronte.
    live.published = entry;
    // L'ardoise est effacee : une prochaine defaillance d'ecriture repartira du premier
    // echelon, comme la premiere fois.
    this.writeFailures = 0;

    // Le jeton n'est JAMAIS journalise. Les chemins du workspace non plus : seul leur nombre
    // est utile ici, et `GET /health` les rend a qui detient le jeton.
    this.options.log(
      `published (${reason}): extHostPid=${entry.extHostPid} mainPid=${entry.mainPid} ` +
        `port=${entry.port} trusted=${entry.isTrusted} workspaceFolders=${entry.workspaceFolders.length}`
    );
    return true;
  }

  /**
   * DEUX CLASSES DE REFUS, ET ELLES N'APPELLENT PAS LA MEME CONDUITE — c'est le defaut C2.
   *
   * `publishNow` traitait TOUT echec de `writeWindowEntry` de la meme facon : journaliser,
   * puis se retirer. Or le retrait efface `live`, et `republishIfEntryLost` — l'unique chemin
   * de reprise autonome — sort immediatement quand la fenetre n'est pas publiee. Ne
   * restaient alors que l'octroi de confiance et le changement de dossiers, deux CHANGEMENTS
   * D'ETAT DU WORKSPACE.
   *
   *   - REFUS DE VALIDATION (`REGISTRY_ENTRY_INVALID`) : l'entree est impubliable PAR NATURE
   *     — une fenetre sans dossier de travail, typiquement. Se retirer est juste, et la
   *     reprise viendra de l'evenement qui change cet etat. C'est le garde-fou C5, eprouve
   *     deux fois. LE SERVEUR EST FERME : il n'aurait rien a servir.
   *
   *   - DEFAILLANCE D'ECRITURE (`REGISTRY_UNWRITABLE`) : l'etat du workspace n'a PAS bouge et
   *     ne bougera pas. Aucun evenement ne viendra, et l'observateur de suppression ne peut
   *     rien voir d'un fichier qui n'a jamais existe. La fenetre restait utilisable pour
   *     l'humain et DEFINITIVEMENT injoignable pour `cmgr`, qui rendait alors
   *     `OWNING_WINDOW_NOT_FOUND` — invitant a verifier une extension parfaitement installee.
   *     LE SERVEUR RESTE OUVERT et la reprise est PROGRAMMEE : la fenetre est joignable des
   *     que l'entree revient, sans rouvrir un port au passage. L'echelle etant bornee, une
   *     defaillance qui n'etait pas transitoire finit par un vrai retrait — l'ecoute ne
   *     survit donc jamais durablement a l'absence d'entree (defaut S6).
   *
   * Ce qui distingue les deux n'est PAS un controle local rejoue ici : c'est le code stable de
   * l'erreur nommee que le coeur a levee. Une defaillance qu'on ne reconnait pas est traitee
   * comme un refus — on ne suppose transitoire que ce qui l'est nommement.
   */
  private async refuseToPublish(error: unknown, reason: string): Promise<boolean> {
    this.options.log(`refusing to publish this window (${reason}) — ${describe(error)}`);

    const unwritable =
      isClaudeManagerError(error) && error.code === ERROR_CODES.REGISTRY_UNWRITABLE;
    if (!unwritable) {
      await this.withdrawNow(`entry rejected (${reason})`);
      return false;
    }

    const delayMs = WRITE_RETRY_DELAYS_MS[this.writeFailures];
    if (delayMs === undefined) {
      this.options.log(
        `the registry stayed unwritable across ${WRITE_RETRY_DELAYS_MS.length} attempts ` +
          `(${reason}), this window gives up and closes its local server`
      );
      await this.withdrawNow(`registry unwritable (${reason})`);
      return false;
    }

    // Une reprise est deja en vol : un evenement de workspace survenu entre-temps rencontre la
    // meme defaillance, il ne doit pas empiler une seconde echelle.
    if (this.retryPending) return false;
    this.writeFailures += 1;
    this.retryPending = true;
    this.options.log(
      `this window keeps its local server open and retries publishing in ${delayMs} ms (${reason})`
    );
    this.schedule(() => {
      this.retryPending = false;
      // `ensurePublished` et non `publishNow` : la reprise passe par la file comme toute
      // autre transition, elle n'a aucune raison de doubler celles qui attendent.
      void this.ensurePublished(`retrying after an unwritable registry, ${reason}`);
    }, delayMs);
    return false;
  }

  /**
   * Republie si l'entree de cette fenetre n'est plus la SIENNE — disparue OU remplacee.
   *
   * DEFAUT S6 (disparition) : l'entree est un simple fichier, que n'importe quoi peut effacer
   * — une autre fenetre qui balaie sur un instantane tronque, un utilisateur, un installateur.
   * Le serveur, lui, restait ouvert et joignable : une ecoute vivante que plus aucun registre
   * ne decrivait, et une fenetre devenue non pilotable SANS qu'aucune erreur ne soit emise.
   *
   * DEFAUT S2 (substitution) : la garde precedente etait un `existsSync`, et les deux
   * mecanismes de reprise ne defendaient donc que la SUPPRESSION. Or un processus tournant
   * sous le compte de l'utilisateur — l'acteur que vise la decision 5 de l'ADR-003, dont elle
   * nomme desormais la limite — n'a pas besoin de choisir un nom de fichier : il ECRASE celui
   * qui existe. Le contenu forge n'a qu'a satisfaire `parseWindowEntry` et la garde de vivacite,
   * ce qui est trivial : `extHostPid` se lit dans le fichier avant de l'ecraser, `mainPid` est
   * public dans la table des processus, et `port`/`token` sont ceux de l'attaquant. La lecture
   * du registre ne rapporte alors AUCUNE anomalie, et `resolveOwningWindow` rend le canal de
   * l'attaquant. Meme en procedant par `rm` puis `write`, le fichier etait la au moment du
   * test : la fenetre concluait que tout allait bien. Une suppression se repare en quelques
   * millisecondes ; le cas dangereux etait le seul non couvert.
   *
   * PORTEE, ET ELLE EST HONNETE : ce n'est pas une elevation de privilege. L'attaquant est
   * deja dans le compte, et l'ADR-003 assume que le registre est lisible par tout processus
   * du compte. Ce qui est en cause est qu'une reprise couvrait le cas benin en laissant le cas
   * grave ouvert — et qu'au lot C, l'entree portera le canal par lequel on OUVRE ET FERME des
   * conversations : c'est le pilotage qui serait detourne.
   *
   * REPUBLIER PLUTOT QUE SE RETIRER, et c'est un choix : la fenetre est VIVANTE. Se retirer
   * reviendrait a enteriner un acte de tiers et laisserait l'humain sans recours autre qu'un
   * rechargement complet. Republier est idempotent et remet le registre en accord avec la
   * realite. Un retrait reste possible : il suffit que la republication soit refusee.
   *
   * Le retrait DELIBERE ne passe jamais par ici : `withdraw` efface `live` AVANT de
   * supprimer le fichier, et cette methode ne fait rien quand la fenetre n'est pas publiee.
   */
  republishIfEntryLost(reason: string): Promise<void> {
    return this.enqueue(async () => {
      const live = this.live;
      if (!this.open || live === undefined) return;

      const verdict = this.inspectEntry(live);
      if (verdict === 'ours') return;

      // DEUX MOTIFS DISTINCTS, ET C'EST VOULU : une reparation muette ferait passer un
      // remplacement pour l'erreur de tiers qu'il n'est pas. L'humain doit voir le second.
      this.options.log(
        verdict === 'substituted'
          ? `this window's registry entry was REPLACED by an entry that is not ours (${reason}), republishing`
          : `this window's registry entry vanished (${reason}), republishing`
      );
      await this.publishNow(`entry ${verdict}, ${reason}`);
    }).then(() => undefined);
  }

  /**
   * L'entree sur disque decrit-elle TOUJOURS cette fenetre-ci ?
   *
   * La comparaison porte sur l'IDENTITE et le CANAL — `extHostPid`, `mainPid`, `port`,
   * `token` —, c'est-a-dire exactement ce qu'un intrus doit controler pour detourner le
   * pilotage. Les champs qui decrivent l'etat du workspace en sont exclus a dessein : ils
   * changent legitimement entre deux republications, et une entree qui porterait notre canal
   * avec des dossiers perimes reste NOTRE entree — la republication suivante la remettra a
   * jour sans qu'il faille crier a la substitution.
   */
  private inspectEntry(live: Live): EntryVerdict {
    let content: string;
    try {
      content = readFileSync(this.entryFile, 'utf8');
    } catch {
      // Absente, illisible, ou remplacee par un repertoire : dans tous les cas, plus rien de
      // lisible sur disque ne decrit cette fenetre. La republication tranchera — et si le
      // chemin est devenu inecrivable, l'echelle de reprise de C2 prend le relais.
      return 'gone';
    }

    // Un fichier porte notre nom alors qu'aucune de nos ecritures n'a abouti : il n'est pas
    // de nous, quoi qu'il contienne.
    const published = live.published;
    if (published === undefined) return 'substituted';

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return 'substituted';
    }

    const onDisk = value as Partial<WindowEntry>;
    return onDisk.extHostPid === published.extHostPid &&
      onDisk.mainPid === published.mainPid &&
      onDisk.port === published.port &&
      onDisk.token === published.token
      ? 'ours'
      : 'substituted';
  }

  /**
   * L'ecoute de cette fenetre est morte SANS qu'on l'ait demandee — defaut S5.
   *
   * Symetrie exacte de S6, jamais jouee dans l'autre sens : apres le demarrage, toute
   * defaillance de la socket n'etait que journalisee, et l'entree continuait d'annoncer `port`
   * ET `token`. Le port ephemere revient au systeme, un processus local le reobtient — la
   * plage ephemere est reutilisee agressivement —, et le client du lot C presente alors
   * `Authorization: Bearer <jeton de la fenetre>` a l'occupant. Le jeton part a un tiers, sans
   * qu'aucune erreur d'authentification ne signale quoi que ce soit.
   *
   * L'ORDRE EST LE FOND DU CORRECTIF : on RETIRE d'abord — le couple port mort + jeton quitte
   * le disque immediatement —, on rouvre ensuite. L'inverse laisserait ce couple exploitable
   * pendant toute la duree d'une reouverture.
   *
   * Une fermeture DELIBEREE ne passe jamais par ici : `ServerHandle.close` pose son drapeau
   * avant de toucher la socket, et le `'close'` qui suit ne signale rien.
   */
  private handleServerLoss(): void {
    void this.enqueue(async () => {
      if (!this.open || this.live === undefined) return;

      this.serverLosses += 1;
      this.options.log(
        `the local server closed without being asked to (loss ${this.serverLosses}/${MAX_SERVER_LOSSES}), ` +
          'withdrawing this window before it advertises a dead port'
      );
      await this.withdrawNow('local server closed unexpectedly');

      if (this.serverLosses >= MAX_SERVER_LOSSES) {
        this.options.log(
          'the local server could not be kept open, this window stays unpublished until it is reloaded'
        );
        return;
      }
      await this.publishNow('local server reopened');
    });
  }

  /** Retire la fenetre du registre et ferme son serveur, SANS fermer le cycle de vie. */
  withdraw(reason: string): Promise<void> {
    return this.enqueue(() => this.withdrawNow(reason)).then(() => undefined);
  }

  /**
   * Fin de vie : retrait, et plus aucune republication ensuite.
   *
   * `open` tombe EN PREMIER — une transition deja en file, ou une reprise programmee qui se
   * declenche, ne doit pas rouvrir une ecoute derriere la desactivation.
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
