/**
 * ENUMERER ET FERMER LES CONVERSATIONS DE CETTE FENETRE — et d'aucune autre.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LE PROBLEME D'IDENTITE, ET IL EST MESURE. `vscode.Tab` NE PORTE AUCUN IDENTIFIANT : ses
 * champs sont `label`, `group`, `input`, `isActive`, `isDirty`, `isPinned`, `isPreview`, et
 * AUCUN n'est stable.
 *
 *   - le `viewType` NE DISCRIMINE RIEN : il vaut `mainThreadWebview-claudeVSCodePanel` pour
 *     TOUS les panneaux Claude — VSCode prefixe, et le prefixe ne porte aucun numero
 *     d'instance (D2, mesure C1 sur l'extension Claude 2.1.220) ;
 *   - le `label` est derive du CONTENU de la conversation (D24) : il change au fil du tour, et
 *     deux conversations peuvent porter le meme ;
 *   - la POSITION — `viewColumn`, rang dans le groupe — change des qu'un onglet est deplace.
 *
 * C'est le fait a partir duquel ce module est concu. Aucune stabilite n'est inventee.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * LA CONCEPTION, EN UNE PHRASE : la fenetre SYNTHETISE une poignee opaque au moment de lister,
 * retient l'etat qu'elle a releve, et EXIGE — au moment de fermer — que l'onglet designe
 * corresponde encore a ce releve. Sinon elle refuse, sans rien fermer.
 *
 * CE QUE CELA IMPOSE A L'APPELANT, et qui est ecrit partout ou il le lira : `cmgr close` exige
 * un `cmgr conversations` prealable, dans la meme session de fenetre. Un contrat en DEUX TEMPS.
 *
 * LES CINQ INVARIANTS QUE CE MODULE PORTE, et que deux tests garde-fous eprouvent :
 *
 *   1. jamais fermer un onglet dont on ne peut pas prouver qu'il est celui qui a ete designe ;
 *   2. jamais fermer PLUS D'UN onglet par demande — le port ne prend qu'un onglet, jamais un
 *      tableau, et le type l'interdit ;
 *   3. jamais fermer un onglet qui n'est pas reconnu Claude, meme si la poignee correspondait ;
 *   4. ambiguite ⇒ refus, erreur nommee, aucun effet de bord ;
 *   5. CONFIRMER par re-enumeration que l'onglet a REELLEMENT quitte `tabGroups` avant de
 *      rendre un succes — `close` resout un booleen, et le relever ne suffit pas. C'est la
 *      meme discipline que « l'absence d'erreur ne prouve jamais l'attachement » (D10, D19).
 *      LA CONFIRMATION EXIGE DEUX FAITS, ET LE SECOND A ETE AJOUTE SUR FINDING : que plus rien
 *      ne corresponde au releve NE SUFFIT PAS, le libelle pouvant changer tout seul (D24) — il
 *      faut EN PLUS que le nombre d'onglets de conversation ait diminue. Le detail, les deux
 *      regles candidates ecartees et les deux trous residuels sont dans `removalConfirmed`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * AUCUN IMPORT DE `vscode`, et c'est ce qui rend les cinq invariants verifiables sans editeur.
 * L'editeur est atteint par un PORT (`ConversationTabsPort`) que `extension.ts` — seul point de
 * contact du paquet avec l'API — implemente en quelques lignes sans decision. Meme couture, et
 * meme motif, que l'`EditorPort` du mecanisme d'ouverture : ce que les tests unitaires
 * eprouvent a travers elle est la DECISION et les REFUS. Que `tabGroups.close` ferme reellement
 * un onglet, qu'il n'en ferme qu'un, et qu'il n'emprunte pas le focus — cela n'est prouve QUE
 * par `npm run test:integration`, dans une vraie fenetre.
 *
 * LE PORT REND LES ONGLETS QU'IL A LUI-MEME ENUMERES, ET LES RECOIT TELS QUELS. Il n'y a donc
 * AUCUNE seconde recherche dans la couche non mesuree : ce module choisit un element de la
 * liste que l'adaptateur vient de produire et le lui rend. Un port qui prendrait des
 * coordonnees rejouerait la selection hors de portee des tests — c'est-a-dire a l'endroit
 * exact ou une erreur fermerait le mauvais onglet.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from 'node:crypto';
import { ClaudeManagerError, ERROR_CODES, type ListedConversation } from './core.js';
import { isClaudePanel, type PanelTabLike } from './seed.js';

/** Un onglet de CETTE fenetre, reduit a ce que l'identification demande. */
export interface ConversationTabLike extends PanelTabLike {
  /** La colonne du groupe qui porte l'onglet — unique par groupe. */
  readonly viewColumn: number;
  /** Le rang de l'onglet DANS son groupe : unique par groupe, donc la coordonnee est unique. */
  readonly indexInGroup: number;
  readonly isActive: boolean;
}

/**
 * LE SEUL CONTACT AVEC L'EDITEUR pour les onglets, declare ici plutot qu'importe.
 *
 * `closeTab` ne prend QU'UN onglet : l'invariant n.2 est porte par le type, pas par une
 * intention en commentaire. `tabGroups.close` accepte un tableau ; ce port ne l'expose pas.
 */
export interface ConversationTabsPort<T extends ConversationTabLike> {
  /** Les onglets de CETTE fenetre, tous groupes confondus. */
  listTabs(): readonly T[];
  /**
   * Ferme UN onglet, sans JAMAIS emprunter le focus (principe fondateur n.1).
   *
   * Rend ce que l'editeur a resolu — un RELEVE, jamais la preuve : c'est la re-enumeration qui
   * fait foi (invariant n.5).
   */
  closeTab(tab: T): Promise<boolean>;
}

/** L'etat identifiant releve au moment de lister — ce que la fermeture doit retrouver. */
interface IssuedHandle {
  readonly viewType: string;
  readonly label: string;
  readonly viewColumn: number;
  readonly indexInGroup: number;
}

/**
 * Combien de poignees la fenetre retient au plus.
 *
 * LES POIGNEES NE SONT PAS PURGEES A CHAQUE ENUMERATION, et c'est deliberе : c'est le SOUVENIR
 * d'une poignee dont l'onglet a disparu qui permet de repondre `CONVERSATION_ALREADY_CLOSED`
 * — « il n'y a rien a fermer » — plutot que d'envoyer relister pour rien. Il faut donc une
 * borne, sans quoi une fenetre qui liste mille fois pendant qu'un libelle evolue accumulerait
 * mille enregistrements pour la vie de l'extension host.
 *
 * 256, et la politique est celle du MOINS RECEMMENT VU : la plus ancienne poignee sort la
 * premiere, et une poignee revue a chaque enumeration ne sort jamais. Une poignee evincee sort
 * en `CONVERSATION_HANDLE_STALE` — « relister, puis retenter » —, c'est-a-dire du cote SUR :
 * jamais un faux « deja ferme », jamais une fermeture non prouvee.
 */
const MAX_ISSUED_HANDLES = 256;

/**
 * DELAI ACCORDE A L'ONGLET POUR QUITTER `tabGroups`.
 *
 * `tabGroups.close` rend un thenable, mais ce qu'il resout est un BOOLEEN, pas la disparition :
 * l'enumeration est la seule preuve (invariant n.5). Elle n'est pas instantanee — la fermeture
 * traverse le processus principal de l'editeur et revient par un evenement.
 *
 * 5 s, ET CE CHIFFRE N'EST PAS MESURE — il est assume comme tel, et le dire vaut mieux que de
 * laisser croire a une mesure : ce que la mesure du 2026-07-27 donne est bien plus bas (voir la
 * preuve d'execution), mais un poste charge n'est pas le poste de mesure. La borne existe pour
 * la meme raison que toutes les autres de ce depot : un onglet qu'une invite de sauvegarde
 * retient ne partira JAMAIS, et une route non bornee pendrait indefiniment.
 */
const CLOSE_CONFIRMATION_BUDGET_MS = 5_000;

/** Granularite du sondage de la disparition. */
const CLOSE_POLL_INTERVAL_MS = 100;

export interface ListConversationsResult {
  readonly ok: true;
  /** La fenetre qui a repondu, comme sur la route d'ouverture — le client la confronte. */
  readonly extHostPid: number;
  /** UNE LISTE VIDE N'EST PAS UNE ERREUR. */
  readonly conversations: readonly ListedConversation[];
}

export interface CloseConversationRequest {
  readonly id: string;
}

export interface CloseConversationResult {
  readonly ok: true;
  readonly extHostPid: number;
  /** L'onglet tel qu'il etait AVANT la fermeture — releve avant l'effet de bord. */
  readonly closed: ListedConversation;
  readonly remaining: number;
  /** Ce que `tabGroups.close` a resolu. UN RELEVE : la preuve est la re-enumeration. */
  readonly editorReportedClosed: boolean;
}

export interface ConversationRoutes {
  list(): Promise<ListConversationsResult>;
  close(request: CloseConversationRequest): Promise<CloseConversationResult>;
}

export interface ConversationRoutesDependencies<T extends ConversationTabLike> {
  readonly port: ConversationTabsPort<T>;
  readonly extHostPid: number;
  readonly log: (message: string) => void;
  /**
   * Attente differee — SEUL point d'injection, et pour la meme raison que dans
   * `conversations.ts` : ce qu'il faut prouver est que la confirmation est BORNEE et qu'elle
   * porte sur l'enumeration, pas qu'on patiente cinq secondes.
   */
  readonly wait?: (ms: number) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Un onglet de conversation Claude, ET le type le sait.
 *
 * La reconnaissance elle-meme reste celle de `seed.ts` — « contient », jamais egalite (D2) : une
 * seconde regle de reconnaissance dans le depot serait une regle de trop, et c'est celle qui
 * juge ce qu'on FERME.
 */
function isConversationTab<T extends ConversationTabLike>(
  tab: T
): tab is T & { readonly viewType: string } {
  return isClaudePanel(tab);
}

/**
 * Les onglets de conversation, DANS UN ORDRE DETERMINE.
 *
 * L'ordre de `tabGroups.all` n'est promis par aucune documentation, et la sortie de cette route
 * est lue par un agent : deux enumerations successives doivent rendre la meme liste dans le
 * meme ordre, faute de quoi un agent qui prend « la premiere » ne prend pas deux fois la meme.
 */
function conversationTabs<T extends ConversationTabLike>(
  tabs: readonly T[]
): readonly (T & { readonly viewType: string })[] {
  return tabs
    .filter(isConversationTab)
    .slice()
    .sort((a, b) => a.viewColumn - b.viewColumn || a.indexInGroup - b.indexInGroup);
}

function handleOf(tab: ConversationTabLike & { readonly viewType: string }): IssuedHandle {
  return {
    viewType: tab.viewType,
    label: tab.label,
    viewColumn: tab.viewColumn,
    indexInGroup: tab.indexInGroup,
  };
}

/**
 * L'onglet est-il, DANS TOUS SES CHAMPS RELEVES, celui qui avait ete liste ?
 *
 * Le parametre est type `IssuedHandle` DES DEUX COTES, et ce n'est pas un raccourci : les quatre
 * champs compares sont exactement ceux que la poignee retient, et le typage interdit d'en
 * comparer un cinquieme par inadvertance — `isActive`, par exemple, qui change au moindre clic
 * de l'humain et ferait perimer une poignee sans qu'aucun onglet n'ait bouge.
 */
function matches(candidate: IssuedHandle, handle: IssuedHandle): boolean {
  return (
    candidate.viewType === handle.viewType &&
    candidate.label === handle.label &&
    candidate.viewColumn === handle.viewColumn &&
    candidate.indexInGroup === handle.indexInGroup
  );
}

/**
 * Ce que la resolution rend — ET ELLE REND LA POIGNEE RELEVEE AVEC L'ONGLET.
 *
 * La CONFIRMATION qui suit la fermeture doit reconnaitre le meme releve. Le lui faire rechercher
 * une seconde fois dans le registre ouvrirait un cas « la poignee a disparu entre la resolution et
 * la confirmation » qu'aucun chemin ne peut produire — donc un repli inatteignable, que ce depot
 * refuse d'ecrire : il laisse croire qu'un cas a ete prevu et ne se verifie jamais.
 */
type Resolution<T> =
  | {
      readonly kind: 'close';
      readonly tab: T & { readonly viewType: string };
      readonly handle: IssuedHandle;
      /**
       * Combien d'onglets de conversation la fenetre portait AU MOMENT DE LA RESOLUTION.
       *
       * C'est la seconde moitie de la confirmation — voir `removalConfirmed`. Il est releve ICI,
       * sur l'enumeration qui a servi a resoudre, et non redemande apres coup : entre les deux, un
       * onglet peut deja avoir bouge, et le compte ne dirait plus « avant la fermeture ».
       */
      readonly conversationsBefore: number;
    }
  | { readonly kind: 'refuse'; readonly error: ClaudeManagerError };

/**
 * LE REGISTRE DES POIGNEES DE CETTE FENETRE — synthetise, retient, et VERIFIE.
 *
 * Il n'est jamais partage entre fenetres : chaque extension host a le sien, et une poignee
 * emise par une fenetre est structurellement inconnue de toute autre. C'est l'invariant
 * d'isolation obtenu PAR CONSTRUCTION, et non par une comparaison de plus.
 */
export class ConversationHandles {
  /** Insertion-ordonne : le premier de l'iteration est le moins recemment vu. */
  private readonly issued = new Map<string, IssuedHandle>();

  /**
   * Enumere, attribue les poignees, et retient ce qui a ete releve.
   *
   * UNE POIGNEE EST REUTILISEE quand un onglet se presente EXACTEMENT tel qu'il avait ete
   * releve. Deux enumerations successives sans changement rendent donc la meme liste, ce qui
   * evite de faire perimer la poignee d'un agent qui liste deux fois avant d'agir.
   */
  list<T extends ConversationTabLike>(tabs: readonly T[]): readonly ListedConversation[] {
    const claimed = new Set<string>();
    const listed: ListedConversation[] = [];

    for (const tab of conversationTabs(tabs)) {
      const id = this.reuseOrMint(tab, claimed);
      claimed.add(id);
      listed.push({
        id,
        label: tab.label,
        viewType: tab.viewType,
        viewColumn: tab.viewColumn,
        indexInGroup: tab.indexInGroup,
        isActive: tab.isActive,
      });
    }

    this.evictOldest();
    return listed;
  }

  /**
   * Quel onglet fermer — ou POURQUOI on refuse, sans rien fermer.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * LES TROIS ISSUES, ET LEUR ORDRE EST LE RAISONNEMENT :
   *
   *   1. la poignee n'a jamais ete emise ici → STALE. Elle vient d'une autre fenetre, ou
   *      l'extension host a redemarre depuis (les poignees ne survivent pas), ou elle a ete
   *      evincee. On ne peut RIEN affirmer de l'onglet : relister est la seule conduite.
   *   2. un onglet de conversation occupe la coordonnee relevee :
   *      - il correspond en TOUS points → on ferme celui-la, et lui seul ;
   *      - il ne correspond pas → STALE. Quelque chose est bien la, ce n'est pas provablement
   *        ce qui avait ete designe : refuser. C'est ce cas qui couvre le libelle qui CHANGE
   *        sur place, et le refuser plutot que de le fermer est tout l'objet du dispositif.
   *   3. la coordonnee ne porte aucun onglet de conversation :
   *      - un onglet porte encore ce `viewType` et ce `label` ailleurs → l'onglet a bouge →
   *        STALE, relister le retrouvera ;
   *      - aucun → DEJA FERME. C'est la seule issue qui affirme une disparition, et elle
   *        l'affirme sur une preuve POSITIVE : plus rien ne porte ce releve.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * DEUX ETATS SONT INDISCERNABLES, ET LE CHOIX DE LES CONFONDRE EN `STALE` EST MESURE
   * (2026-07-27, vraie fenetre) :
   *
   *   (a) l'onglet designe est PARTI, et son voisin a GLISSE d'un rang sur sa coordonnee —
   *       c'est ce que VSCode fait a chaque fermeture, et c'est donc le cas ORDINAIRE d'une
   *       seconde fermeture avec la meme poignee ;
   *   (b) l'onglet designe est TOUJOURS LA, au meme rang, et son LIBELLE a change — ce que la
   *       vraie extension Claude fait quelques centaines de millisecondes apres l'attachement
   *       (D24 : `Claude Code` puis `Confirm session response`, mesure de la meme execution).
   *
   * Dans les deux cas, la fenetre voit la MEME chose : un onglet de conversation a la
   * coordonnee relevee, dont le releve ne correspond pas, et plus aucun onglet ne portant le
   * releve d'origine. Aucun champ stable ne les separe — c'est le fait de l'en-tete de module,
   * pas un manque de soin.
   *
   * ON REPOND DONC `STALE` AUX DEUX, et le sens de l'echec est ce qui decide : `STALE` dit « je
   * ne peux pas l'affirmer », ce qui est VRAI dans les deux cas. `ALREADY_CLOSED` dirait « il
   * n'existe plus », ce qui serait FAUX dans le cas (b) — et un appelant qui le croirait
   * abandonnerait une conversation bien vivante. La remediation de `STALE` porte la conduite
   * exacte : relister, REGARDER si la conversation visee y est encore, et ne surtout pas fermer
   * celle qui a pris sa place.
   *
   * `ALREADY_CLOSED` reste donc reserve au cas ou la coordonnee ne porte AUCUN onglet de
   * conversation ET ou plus rien ne porte le releve : la seule situation ou la disparition est
   * etablie POSITIVEMENT.
   * ─────────────────────────────────────────────────────────────────────────────────────────
   */
  resolve<T extends ConversationTabLike>(id: string, tabs: readonly T[]): Resolution<T> {
    const claude = conversationTabs(tabs);
    // Un NOMBRE, jamais un libelle : ces details partent vers un agent et vers un journal
    // persiste, joint en preuve a des PR d'un depot PUBLIC.
    const details = { conversations: claude.length } as const;

    const handle = this.issued.get(id);
    if (handle === undefined) {
      return {
        kind: 'refuse',
        error: new ClaudeManagerError(
          ERROR_CODES.CONVERSATION_HANDLE_STALE,
          'This window never issued that conversation handle',
          details
        ),
      };
    }

    const atCoordinate = claude.find(
      (tab) => tab.viewColumn === handle.viewColumn && tab.indexInGroup === handle.indexInGroup
    );
    if (atCoordinate !== undefined) {
      if (matches(atCoordinate, handle)) {
        return { kind: 'close', tab: atCoordinate, handle, conversationsBefore: claude.length };
      }
      return {
        kind: 'refuse',
        error: new ClaudeManagerError(
          ERROR_CODES.CONVERSATION_HANDLE_STALE,
          'The tab at that position is no longer the one that was listed',
          details
        ),
      };
    }

    const movedElsewhere = claude.some(
      (tab) => tab.viewType === handle.viewType && tab.label === handle.label
    );
    return {
      kind: 'refuse',
      error: movedElsewhere
        ? new ClaudeManagerError(
            ERROR_CODES.CONVERSATION_HANDLE_STALE,
            'The listed tab is no longer where it was listed',
            details
          )
        : new ClaudeManagerError(
            ERROR_CODES.CONVERSATION_ALREADY_CLOSED,
            'No conversation tab matches that handle any more',
            details
          ),
    };
  }

  private reuseOrMint(
    tab: ConversationTabLike & { readonly viewType: string },
    claimed: ReadonlySet<string>
  ): string {
    const wanted = handleOf(tab);
    // DU PLUS RECENT AU PLUS ANCIEN : deux poignees peuvent porter un releve identique — un
    // onglet ferme puis rouvert au meme rang avec le meme libelle —, et rien ne les distingue.
    // La plus recente est alors celle que l'appelant vient de voir.
    for (const [id, handle] of [...this.issued].reverse()) {
      if (claimed.has(id) || !matches(wanted, handle)) continue;
      // Reinsertion : la poignee redevient la plus RECEMMENT VUE, donc la derniere a etre
      // evincee. Sans cela, une poignee vivante sortirait avant une poignee morte plus jeune.
      this.issued.delete(id);
      this.issued.set(id, handle);
      return id;
    }

    const id = randomUUID();
    this.issued.set(id, wanted);
    return id;
  }

  private evictOldest(): void {
    const excess = this.issued.size - MAX_ISSUED_HANDLES;
    if (excess <= 0) return;
    // `Map` itere dans l'ordre d'insertion : les premiers sont les moins recemment VUS —
    // `reuseOrMint` reinsere ce qu'il retrouve, ce qui rafraichit son rang.
    for (const oldest of [...this.issued.keys()].slice(0, excess)) this.issued.delete(oldest);
  }
}

/**
 * LA FERMETURE EST-ELLE CONFIRMEE ? Deux conditions, et il en faut DEUX.
 *
 * Fonction libre, et non methode du registre : elle ne consulte RIEN — on lui donne le releve que
 * la resolution a rendu. C'est ce qui evite une seconde recherche, donc un cas d'echec de plus.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * POURQUOI L'ABSENCE DE CORRESPONDANCE NE SUFFIT PAS — C'ETAIT UN FAUX SUCCES.
 *
 * La premiere version de cette confirmation demandait seulement « plus aucun onglet ne correspond
 * au releve ». Or `matches` compare les QUATRE champs, LIBELLE COMPRIS, et le libelle d'un panneau
 * Claude change tout seul (D24). Un onglet qui n'aurait PAS ete ferme — `close` echouant
 * silencieusement — et dont le libelle changeait pendant les 5 s d'attente cessait donc de
 * correspondre, et la route rendait un SUCCES sur un onglet toujours ouvert.
 *
 * Cas etroit — il faut la conjonction de deux evenements —, mais c'est la DIRECTION DANGEREUSE, et
 * c'est la classe de defaut qui a deja coute deux corrections a ce chantier : « succes rendu sur un
 * panneau vide » (C3-FIX) et « le tour est prouve demarre, pas termine » (D20). Un invariant qui
 * annonce « CONSTATER que l'onglet a quitte tabGroups » ne peut pas se contenter d'un fait qui
 * cesse d'etre observable.
 *
 * LA REGLE RETENUE AJOUTE UNE CONJONCTION, ELLE N'EN REMPLACE AUCUNE : le nombre d'onglets de
 * conversation doit avoir DIMINUE depuis le releve de resolution, ET plus rien ne doit correspondre.
 * La propriete qui compte se lit en une ligne : ce qu'elle confirme est un SOUS-ENSEMBLE STRICT de
 * ce que confirmait la regle precedente. Elle ne peut donc introduire AUCUN faux succes nouveau —
 * elle ne peut que refuser de confirmer plus souvent.
 *
 * LES DEUX AUTRES REGLES CANDIDATES SONT CHACUNE PIRE, et il faut dire pourquoi :
 *
 *   - COMPARER SANS LE LIBELLE (coordonnee + `viewType` seuls) : le cas ORDINAIRE d'une fermeture
 *     est qu'un voisin GLISSE d'un rang sur la coordonnee liberee. La confirmation y verrait un
 *     onglet « toujours la » et rendrait `CONVERSATION_CLOSE_FAILED` sur une fermeture parfaitement
 *     REUSSIE — apres 5 s d'attente inutile, et sur le chemin nominal. Inacceptable ;
 *   - `onDidChangeTabs`, dont l'evenement porte `closed: readonly Tab[]` : ce serait la preuve
 *     positive ideale, mais elle exige de comparer des `vscode.Tab` PAR IDENTITE D'OBJET. Or ce
 *     paquet a deja DECIDE l'inverse, et l'a ecrit dans `selectNewPanel` : « rien ne documente que
 *     `tabGroups.all` rende les MEMES instances d'un releve a l'autre ». S'y fier ici contredirait
 *     cette decision, ferait dependre l'invariant d'un comportement non documente, et deplacerait
 *     la comparaison dans `extension.ts` — la seule couche que la mesure de couverture exclut, et
 *     dont l'en-tete de ce module exige qu'elle ne porte AUCUNE decision. Le jour ou l'identite
 *     cesserait de tenir, plus AUCUNE fermeture ne se confirmerait.
 *
 * CE QUI RESTE, NOMME PLUTOT QUE TU — deux trous, et ils sont dans des directions differentes :
 *
 *   (a) FAUX SUCCES RESIDUEL, strictement plus etroit qu'avant : il faut desormais que `close`
 *       echoue silencieusement, QUE le libelle change, ET qu'un AUTRE onglet de conversation se
 *       ferme dans la meme fenetre de 5 s. Trois evenements au lieu de deux ;
 *   (b) FAUX ECHEC NOUVEAU : si la fermeture reussit mais qu'une conversation s'OUVRE dans la meme
 *       fenetre pendant l'attente, le compte ne diminue pas et la route rend
 *       `CONVERSATION_CLOSE_FAILED` sur une fermeture reussie. C'est atteignable — les ouvertures
 *       et les fermetures ont des files distinctes —, mais c'est la direction SURE : relancer est
 *       sans danger, `cmgr conversations` dit l'etat reel, et la remediation le dit.
 *
 * PROPRIETAIRE DE CES DEUX TROUS : le **lot E**, dont l'E2E multi-fenetres est le seul cadre ou
 * une ouverture et une fermeture concurrentes s'observent sur du reel. Aucun montage unitaire ne
 * peut etablir a quelle frequence (b) se produit ; il peut seulement, et il le fait ci-dessous,
 * EPINGLER le comportement pour qu'il soit un choix constate.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
function removalConfirmed<T extends ConversationTabLike>(
  handle: IssuedHandle,
  conversationsBefore: number,
  tabs: readonly T[]
): boolean {
  const claude = conversationTabs(tabs);
  return claude.length < conversationsBefore && !claude.some((tab) => matches(tab, handle));
}

/**
 * Les deux routes de conversation de CETTE fenetre, partageant UN registre de poignees.
 *
 * ELLES SONT SERIALISEES ENSEMBLE, dans une file d'un seul rang, et ce n'est pas de la
 * prudence : `list` MUTE le registre des poignees, et `close` en depend. Deux `close`
 * concurrents sur la meme poignee resoudraient tous deux le meme onglet et rendraient tous deux
 * un succes, dont un seul aurait ferme quelque chose ; un `list` entrelace dans un `close`
 * pourrait reattribuer une poignee entre la resolution et la confirmation. Meme dispositif que
 * `serializeOpenings`, meme motif — sauf qu'ici les deux routes partagent l'etat, donc la file.
 *
 * Une demande qui echoue ne bloque pas les suivantes : le `catch` porte sur la CHAINE, pas sur
 * la tache.
 */
export function createConversationRoutes<T extends ConversationTabLike>(
  dependencies: ConversationRoutesDependencies<T>
): ConversationRoutes {
  const { port, extHostPid, log } = dependencies;
  const wait = dependencies.wait ?? sleep;
  const handles = new ConversationHandles();

  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <R>(task: () => Promise<R>): Promise<R> => {
    const settled = queue.then(task, task);
    queue = settled.catch(() => undefined);
    return settled;
  };

  const list = (): ListConversationsResult => {
    const conversations = handles.list(port.listTabs());
    // LE COMPTE, JAMAIS LES LIBELLES : ils sont du contenu de conversation (D24), et ce journal
    // est persiste par VSCode puis joint en preuve a des PR d'un depot PUBLIC.
    log(`enumerated ${conversations.length} conversation tab(s)`);
    return { ok: true, extHostPid, conversations };
  };

  const close = async (request: CloseConversationRequest): Promise<CloseConversationResult> => {
    const resolution = handles.resolve(request.id, port.listTabs());
    if (resolution.kind === 'refuse') {
      // L'ERREUR EST NOMMEE ET AUCUN EFFET DE BORD N'A EU LIEU. Le code est journalise, jamais
      // la poignee refusee : elle vient du reseau.
      log(`refusing to close a conversation: ${resolution.error.code}`);
      throw resolution.error;
    }

    // RELEVE AVANT L'EFFET DE BORD : apres la fermeture, l'onglet n'est plus la pour etre decrit.
    const closed: ListedConversation = {
      id: request.id,
      label: resolution.tab.label,
      viewType: resolution.tab.viewType,
      viewColumn: resolution.tab.viewColumn,
      indexInGroup: resolution.tab.indexInGroup,
      isActive: resolution.tab.isActive,
    };

    // UN SEUL ONGLET, celui que la resolution a prouve, et le port n'en prend pas d'autre.
    const editorReportedClosed = await port.closeTab(resolution.tab);

    // ---- INVARIANT n.5 : l'ENUMERATION fait foi, jamais le booleen ------------------------
    //
    // UNE enumeration par tour, et c'est celle qui CONFIRME qui sert ensuite a compter ce qui
    // reste : deux releves distincts pourraient decrire deux etats differents de la fenetre, et
    // `remaining` mentirait sur celui qu'on vient de constater.
    let waitedMs = 0;
    let tabs = port.listTabs();
    while (!removalConfirmed(resolution.handle, resolution.conversationsBefore, tabs)) {
      if (waitedMs >= CLOSE_CONFIRMATION_BUDGET_MS) {
        throw new ClaudeManagerError(
          ERROR_CODES.CONVERSATION_CLOSE_FAILED,
          'The conversation tab was not observed leaving tabGroups after the editor was asked to close it',
          // DES NOMBRES ET UN BOOLEEN, jamais un libelle. Les deux comptes sont rendus parce
          // qu'ils DISCRIMINENT : `conversationsAfter` egal a `conversationsBefore` designe une
          // fenetre ou rien n'a disparu, un compte plus bas designe l'ouverture concurrente que
          // `removalConfirmed` documente comme faux echec possible.
          {
            editorReportedClosed,
            waitedMs,
            conversationsBefore: resolution.conversationsBefore,
            conversationsAfter: conversationTabs(tabs).length,
          }
        );
      }
      await wait(CLOSE_POLL_INTERVAL_MS);
      waitedMs += CLOSE_POLL_INTERVAL_MS;
      tabs = port.listTabs();
    }

    const remaining = conversationTabs(tabs).length;
    log(
      `closed one conversation tab after ~${waitedMs} ms ` +
        `(editorReportedClosed=${String(editorReportedClosed)}, ${remaining} left)`
    );
    return { ok: true, extHostPid, closed, remaining, editorReportedClosed };
  };

  return {
    list: () => serialize(() => Promise.resolve(list())),
    close: (request) => serialize(() => close(request)),
  };
}
