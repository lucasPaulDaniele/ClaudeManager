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
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * ET « CORRESPONDRE » A DEUX SENS, PARCE QU'UN SEUL NE SUFFISAIT PAS. Le gate final du lot C a
 * montre, EN L'EXECUTANT, que les quatre champs d'un onglet ne le designent pas : deux panneaux
 * Claude fraichement attaches ne different que par leur RANG, et fermer le premier fait GLISSER
 * le second sur le rang libere. La poignee du mort devenait alors, dans ses quatre champs, celle
 * du vivant — et le produit fermait la conversation du voisin en rendant `ok: true`.
 *
 * DEUX REGLES LE FERMENT, et elles se lisent chacune en une phrase :
 *
 *   - LE RELEVE D'ENSEMBLE. Une poignee ne designe pas un onglet, elle designe UNE PLACE DANS UN
 *     ARRANGEMENT : elle retient le placement de TOUTES les conversations, et la fermeture exige
 *     qu'il n'ait pas bouge. Voir `IssuedHandle.layout` ;
 *   - UNE POIGNEE NE FERME QU'UNE FOIS. Des que l'editeur a ete sollicite avec elle, elle est
 *     DEPENSEE — que la fermeture aboutisse ou non. Voir `HandleState`.
 *
 * CE QUE CELA COUTE : les poignees sont plus fragiles. Toute conversation qui parait, disparait
 * ou se deplace les perime toutes. C'est le prix d'un identifiant qui ne mente pas, et c'est le
 * bon sens de l'echange — un aller-retour de plus contre une conversation qu'on ne tue pas.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * CE QUE CELA IMPOSE A L'APPELANT, et qui est ecrit partout ou il le lira : `cmgr close` exige
 * un `cmgr conversations` prealable, dans la meme session de fenetre, ET SANS QUE RIEN NE
 * CHANGE ENTRE LES DEUX. Corollaire pour le renouvellement de conversation de `/orchestrer` :
 * on ouvre la neuve, PUIS on liste, PUIS on ferme l'ancienne — lister avant d'ouvrir rendrait
 * une poignee que l'ouverture perimerait aussitot.
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
import {
  ClaudeManagerError,
  CLOSE_CALL_BUDGET_MS,
  CLOSE_CONFIRMATION_BUDGET_MS,
  CLOSE_POLL_INTERVAL_MS,
  ERROR_CODES,
  type ListedConversation,
} from './core.js';
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

/** L'etat identifiant d'UN onglet, releve au moment de lister. */
interface TabIdentity {
  readonly viewType: string;
  readonly label: string;
  readonly viewColumn: number;
  readonly indexInGroup: number;
}

/**
 * OU EN EST UNE POIGNEE — et c'est la SECONDE moitie de la correction du defaut G1.
 *
 * `'listed'` — emise par une enumeration, jamais employee : la seule qui puisse fermer.
 * `'closing'` — l'editeur a ete SOLLICITE avec elle, sans que la disparition ait ete confirmee.
 * `'closed'` — la disparition a ete CONSTATEE : elle a ferme sa conversation.
 *
 * UNE POIGNEE NE FERME QU'UNE FOIS, et la transition est posee AVANT l'appel a l'editeur, pas
 * apres : ce qui doit etre impossible est qu'une seconde demande ferme quoi que ce soit, et cela
 * vaut que la premiere ait abouti ou non. Sans cette regle, une poignee survivait a la fermeture
 * qu'elle avait declenchee et redevenait fermable des que l'etat de la fenetre revenait — par
 * hasard — a ce qu'elle avait releve : un voisin qui glisse, ou une conversation neuve ouverte au
 * meme rang avec le meme libelle. C'est l'un des deux chemins par lesquels le gate final a fait
 * fermer la conversation du VOISIN.
 */
type HandleState = 'listed' | 'closing' | 'closed';

/** Ce que la fenetre retient d'une poignee emise. */
interface IssuedHandle {
  readonly identity: TabIdentity;
  /**
   * LE RELEVE D'ENSEMBLE — le PLACEMENT de toutes les conversations au moment de lister.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * C'EST LA PREMIERE MOITIE DE LA CORRECTION DU DEFAUT G1, ET LE RAISONNEMENT TIENT EN UNE
   * PHRASE : une poignee ne designe pas un onglet, elle designe UNE PLACE DANS UN ARRANGEMENT —
   * et c'est l'arrangement qui fait qu'une place designe un onglet.
   *
   * Les quatre champs de `TabIdentity` NE DISCRIMINENT PAS a eux seuls : le `viewType` est le
   * meme pour tous les panneaux Claude (D2), le libelle vaut `Claude Code` sur tout panneau
   * fraichement attache (D24), et fermer un onglet fait GLISSER son voisin sur le rang libere.
   * Le voisin devient alors, dans ses quatre champs, IDENTIQUE a la poignee du mort — mesure par
   * le gate final, qui a vu la poignee de A fermer B en rendant `ok: true`.
   *
   * Exiger que le placement soit INCHANGE ferme ce chemin : si aucune conversation n'a paru,
   * disparu ni bouge depuis l'enumeration, l'onglet qui occupe la coordonnee relevee EST celui
   * qui y avait ete liste.
   *
   * CE QUE LE RELEVE RETIENT, ET CE QU'IL LAISSE DEHORS — le libelle des AUTRES onglets n'y
   * entre PAS, et c'est un choix, pas un oubli. Un libelle change tout seul quelques centaines
   * de millisecondes apres l'attachement (D24) : l'y faire entrer perimerait toutes les poignees
   * pendant qu'une conversation voisine repond, c'est-a-dire exactement pendant le
   * renouvellement de conversation de `/orchestrer` — ouvrir la neuve, PUIS fermer l'ancienne.
   * Le libelle de l'onglet DESIGNE, lui, reste compare (`matches`) : c'est la verification que
   * D24 impose, et elle porte sur ce qu'on ferme, jamais sur ce qu'on laisse.
   *
   * CE QUI RESTE OUVERT, NOMME PLUTOT QUE TU : deux onglets de conversation identiques en tous
   * leurs champs releves et qui PERMUTENT sans que le placement change — un glisser-deposer de
   * l'humain entre les deux temps. Aucun champ ne les separe, c'est le fait de l'en-tete de
   * module, et aucune regle batie sur `vscode.Tab` ne peut le fermer. PROPRIETAIRE : lot E.
   * ─────────────────────────────────────────────────────────────────────────────────────────
   */
  readonly layout: string;
  readonly state: HandleState;
}

/**
 * Combien de poignees la fenetre retient au plus.
 *
 * LES POIGNEES NE SONT PAS PURGEES A CHAQUE ENUMERATION, et c'est delibere : c'est le SOUVENIR
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
 * LES DEUX BUDGETS DE LA FERMETURE VIENNENT DU COEUR, ET ILS N'Y SONT DECLARES QU'UNE FOIS.
 *
 * `CLOSE_CALL_BUDGET_MS` borne l'APPEL a l'editeur, `CLOSE_CONFIRMATION_BUDGET_MS` borne la
 * CONFIRMATION par re-enumeration. Le sens de chacun est ci-dessous, a l'endroit ou il agit.
 *
 * POURQUOI DANS `protocol.ts` PLUTOT QU'ICI : le CLIENT en derive ses propres delais
 * (`conversations.node.ts`) au lieu de les recopier. Les garder locaux obligeait a redire leur
 * valeur dans un commentaire d'un autre paquet — et c'est precisement ce qui a produit le defaut
 * G3 du gate final, un `LIST_TIMEOUT_MS` a marge ZERO en face de ce budget-ci.
 *
 * NI L'UN NI L'AUTRE N'EST MESURE, et le dire vaut mieux que de laisser croire a une mesure :
 * ce que la mesure du 2026-07-27 donne est bien plus bas, mais un poste charge n'est pas le
 * poste de mesure. Ils existent pour la raison de toutes les bornes de ce depot : un onglet
 * qu'une invite de sauvegarde retient ne partira JAMAIS, et une route non bornee pendrait.
 */

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

function identityOf(tab: ConversationTabLike & { readonly viewType: string }): TabIdentity {
  return {
    viewType: tab.viewType,
    label: tab.label,
    viewColumn: tab.viewColumn,
    indexInGroup: tab.indexInGroup,
  };
}

/**
 * LE PLACEMENT DE TOUTES LES CONVERSATIONS, en une chaine comparable — voir `IssuedHandle.layout`.
 *
 * `viewType` ET coordonnee, jamais le libelle : ce qui doit perimer une poignee est ce qui
 * DEPLACE quelque chose, pas ce qu'une conversation voisine ecrit dans son titre. `JSON.stringify`
 * plutot qu'une concatenation : il echappe, donc aucun `viewType` ne peut se faire passer pour
 * deux entrees en portant le separateur.
 */
function layoutOf(tabs: readonly (ConversationTabLike & { readonly viewType: string })[]): string {
  return JSON.stringify(tabs.map((tab) => [tab.viewType, tab.viewColumn, tab.indexInGroup]));
}

/**
 * L'onglet est-il, DANS TOUS SES CHAMPS RELEVES, celui qui avait ete liste ?
 *
 * Le parametre est type `TabIdentity` DES DEUX COTES, et ce n'est pas un raccourci : les quatre
 * champs compares sont exactement ceux que la poignee retient, et le typage interdit d'en
 * comparer un cinquieme par inadvertance — `isActive`, par exemple, qui change au moindre clic
 * de l'humain et ferait perimer une poignee sans qu'aucun onglet n'ait bouge.
 *
 * IL NE SUFFIT PAS, ET C'EST LE DEFAUT G1 : deux panneaux Claude fraichement attaches sont
 * identiques dans ces quatre champs a l'exception du rang, et le rang GLISSE. C'est le releve
 * d'ensemble qui rend cette comparaison concluante, jamais elle seule.
 */
function matches(candidate: TabIdentity, identity: TabIdentity): boolean {
  return (
    candidate.viewType === identity.viewType &&
    candidate.label === identity.label &&
    candidate.viewColumn === identity.viewColumn &&
    candidate.indexInGroup === identity.indexInGroup
  );
}

/** Combien d'onglets de conversation portent le releve `viewType` + `label` que voici. */
function bearing<T extends ConversationTabLike & { readonly viewType: string }>(
  tabs: readonly T[],
  identity: TabIdentity
): number {
  return tabs.filter((tab) => tab.viewType === identity.viewType && tab.label === identity.label)
    .length;
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
      readonly identity: TabIdentity;
      /**
       * CE QUE LA FENETRE PORTAIT AU MOMENT DE LA RESOLUTION — les deux comptes que la
       * confirmation compare.
       *
       * Ils sont releves ICI, sur l'enumeration qui a servi a resoudre, et non redemandes apres
       * coup : entre les deux, un onglet peut deja avoir bouge, et le compte ne dirait plus
       * « avant la fermeture ». Voir `removalConfirmed` pour ce que chacun etablit.
       */
      readonly before: { readonly conversations: number; readonly bearing: number };
      /**
       * LES DEUX TRANSITIONS D'ETAT DE LA POIGNEE, rendues avec la resolution plutot qu'offertes
       * en methodes du registre.
       *
       * Meme motif que le releve rendu ci-dessus : elles sont CAPTUREES sur l'entree qu'on vient
       * de lire. Une methode `markAsked(id)` devrait rechercher la poignee une seconde fois et
       * prevoir son absence — un cas qu'aucun chemin ne produit, donc un repli inatteignable, ce
       * que ce module refuse d'ecrire.
       *
       * `spend` : l'editeur va etre sollicite — la poignee ne fermera plus jamais rien.
       * `confirmClosed` : la disparition a ete CONSTATEE — la poignee le dira desormais.
       */
      readonly spend: () => void;
      readonly confirmClosed: () => void;
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
    const claude = conversationTabs(tabs);
    // LE RELEVE D'ENSEMBLE, CALCULE UNE FOIS ET DONNE A TOUTES LES POIGNEES DE CETTE
    // ENUMERATION : elles designent des places dans le MEME arrangement.
    const layout = layoutOf(claude);
    const claimed = new Set<string>();
    const listed: ListedConversation[] = [];

    for (const tab of claude) {
      const id = this.reuseOrMint(tab, layout, claimed);
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
   *   1 bis. LA POIGNEE A DEJA SERVI (correction du gate final, defaut G1) :
   *      - l'editeur a ete sollicite avec elle sans que la disparition soit confirmee → STALE.
   *        On ne peut plus rien affirmer, et surtout pas refermer ce qui occupe la place ;
   *      - la disparition a ete CONSTATEE → DEJA FERME, et c'est une preuve POSITIVE de premiere
   *        main : c'est nous qui l'avons fermee, on ne le deduit plus de ce qu'on ne voit plus.
   *   2. un onglet de conversation occupe la coordonnee relevee :
   *      - il correspond en tous points ET le PLACEMENT D'ENSEMBLE n'a pas bouge → on ferme
   *        celui-la, et lui seul. Les deux conditions, jamais la premiere seule : c'est
   *        exactement la ou le gate final a vu la poignee de A fermer B (voir `IssuedHandle`) ;
   *      - il correspond mais le placement a change → STALE. Quelque chose a paru, disparu ou
   *        bouge depuis l'enumeration : la coordonnee ne prouve plus rien ;
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
    if (handle.state !== 'listed') {
      return {
        kind: 'refuse',
        error:
          handle.state === 'closed'
            ? new ClaudeManagerError(
                ERROR_CODES.CONVERSATION_ALREADY_CLOSED,
                'That handle has already closed its conversation tab',
                details
              )
            : new ClaudeManagerError(
                ERROR_CODES.CONVERSATION_HANDLE_STALE,
                'That handle was already used to ask the editor to close a conversation tab',
                details
              ),
      };
    }

    const { identity } = handle;
    const atCoordinate = claude.find(
      (tab) =>
        tab.viewColumn === identity.viewColumn && tab.indexInGroup === identity.indexInGroup
    );
    if (atCoordinate !== undefined) {
      if (matches(identityOf(atCoordinate), identity)) {
        if (layoutOf(claude) !== handle.layout) {
          return {
            kind: 'refuse',
            error: new ClaudeManagerError(
              ERROR_CODES.CONVERSATION_HANDLE_STALE,
              "The window's conversation tabs are no longer arranged as they were listed",
              details
            ),
          };
        }
        return {
          kind: 'close',
          tab: atCoordinate,
          identity,
          before: { conversations: claude.length, bearing: bearing(claude, identity) },
          spend: () => void this.issued.set(id, { ...handle, state: 'closing' }),
          confirmClosed: () => void this.issued.set(id, { ...handle, state: 'closed' }),
        };
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
      (tab) => tab.viewType === identity.viewType && tab.label === identity.label
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
    layout: string,
    claimed: ReadonlySet<string>
  ): string {
    const identity = identityOf(tab);
    // DU PLUS RECENT AU PLUS ANCIEN : deux poignees peuvent porter un releve identique — un
    // onglet ferme puis rouvert au meme rang avec le meme libelle —, et rien ne les distingue.
    // La plus recente est alors celle que l'appelant vient de voir.
    for (const [id, handle] of [...this.issued].reverse()) {
      // TROIS CONDITIONS, ET LES DEUX DERNIERES SONT DES CORRECTIONS DU GATE FINAL :
      //
      //   - UNE POIGNEE DEPENSEE N'EST JAMAIS REATTRIBUEE. Elle a servi a fermer, ou a essayer.
      //     La reutiliser rendrait a l'appelant un identifiant que la fermeture refusera — et
      //     lui ferait croire que relister n'a rien change, alors que c'est le geste prescrit ;
      //   - LE RELEVE D'ENSEMBLE DOIT ETRE LE MEME. Sans cette condition, la poignee emise pour
      //     A serait REATTRIBUEE au voisin qui a glisse sur sa place : le meme identifiant
      //     designerait deux conversations differentes a deux instants, et un appelant qui
      //     reliste — le geste prescrit — retrouverait « son » identifiant sur la conversation
      //     de quelqu'un d'autre. Un arrangement qui a bouge rend donc des poignees NEUVES, et
      //     les anciennes refusent, ce qui est exactement ce qu'on veut leur faire dire.
      if (
        claimed.has(id) ||
        handle.state !== 'listed' ||
        handle.layout !== layout ||
        !matches(identity, handle.identity)
      ) {
        continue;
      }
      // Reinsertion : la poignee redevient la plus RECEMMENT VUE, donc la derniere a etre
      // evincee. Sans cela, une poignee vivante sortirait avant une poignee morte plus jeune.
      this.issued.delete(id);
      this.issued.set(id, handle);
      return id;
    }

    const id = randomUUID();
    this.issued.set(id, { identity, layout, state: 'listed' });
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
 * conversation doit avoir DIMINUE depuis le releve de resolution, ET il doit y avoir UN DE MOINS
 * portant le releve `viewType` + `label` de celui qu'on a ferme.
 *
 * LE SECOND TERME A CHANGE A LA CORRECTION DU GATE FINAL, ET IL LE FALLAIT. Il exigeait que plus
 * AUCUN onglet ne corresponde a la poignee — COORDONNEE COMPRISE —, ce qui echouait sur le cas le
 * plus ordinaire du produit : deux conversations fraichement attachees portent le meme libelle
 * (D24), et fermer la premiere fait GLISSER la seconde sur sa coordonnee. La confirmation voyait
 * alors « quelque chose qui correspond encore » et rendait `CONVERSATION_CLOSE_FAILED` sur une
 * fermeture parfaitement REUSSIE — apres 5 s d'attente inutile, et en invitant a une relance qui,
 * avant la regle de la poignee depensee, fermait la conversation du VOISIN.
 *
 * Compter plutot que chercher retire la coordonnee de l'equation sans rien perdre : un onglet de
 * moins portant ce libelle est un fait que le glissement ne peut pas fabriquer.
 *
 * LES DEUX AUTRES REGLES CANDIDATES SONT CHACUNE PIRE, et il faut dire pourquoi :
 *
 *   - LE SEUL COMPTE D'ONGLETS DE CONVERSATION, sans le second terme : il suffirait qu'un AUTRE
 *     onglet se ferme pendant l'attente pour confirmer une fermeture qui n'a pas eu lieu. C'est
 *     un faux succes a DEUX evenements, quand le second terme en exige trois ;
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
 *   (a) FAUX SUCCES RESIDUEL : il faut que `close` echoue silencieusement, QUE le libelle de
 *       l'onglet non ferme change, ET qu'un AUTRE onglet de conversation se ferme dans la meme
 *       fenetre de 5 s. Trois evenements, dont un — la defaillance muette de `tabGroups.close` —
 *       n'a jamais ete observe ;
 *   (b) FAUX ECHEC : si la fermeture reussit mais qu'une conversation s'OUVRE dans la meme
 *       fenetre pendant l'attente, le compte ne diminue pas et la route rend
 *       `CONVERSATION_CLOSE_FAILED` sur une fermeture reussie. C'est atteignable — les ouvertures
 *       et les fermetures ont des files distinctes —, mais c'est la direction SURE : la poignee
 *       est depensee, la relance ne peut RIEN fermer, `cmgr conversations` dit l'etat reel, et la
 *       remediation porte les deux.
 *
 * PROPRIETAIRE DE CES DEUX TROUS : le **lot E**, dont l'E2E multi-fenetres est le seul cadre ou
 * une ouverture et une fermeture concurrentes s'observent sur du reel. Aucun montage unitaire ne
 * peut etablir a quelle frequence (b) se produit ; il peut seulement, et il le fait ci-dessous,
 * EPINGLER le comportement pour qu'il soit un choix constate.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
function removalConfirmed<T extends ConversationTabLike>(
  identity: TabIdentity,
  before: { readonly conversations: number; readonly bearing: number },
  tabs: readonly T[]
): boolean {
  const claude = conversationTabs(tabs);
  return claude.length < before.conversations && bearing(claude, identity) < before.bearing;
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

    // LA POIGNEE EST DEPENSEE AVANT MEME QUE L'EDITEUR NE SOIT SOLLICITE, jamais apres : entre
    // les deux, une seconde demande porterait sur une poignee que la premiere a deja engagee.
    resolution.spend();

    /**
     * UN SEUL ONGLET, celui que la resolution a prouve — et l'attente EST BORNEE (defaut G4).
     *
     * `await port.closeTab(...)` ne l'etait par rien, alors que le danger meme qui justifie le
     * budget de confirmation — « un onglet qu'une invite de sauvegarde retient ne partira
     * JAMAIS » — est precisement celui qui peut faire pendre cet appel. La route entiere
     * annoncait « je borne mon propre travail », et c'est sur cette annonce que le client
     * calcule ses delais.
     *
     * LE SONDAGE PASSE PAR LA MEME ATTENTE INJECTEE que la confirmation, et c'est delibere : un
     * second point d'injection — ou un `setTimeout` en dur — rendrait ce chemin ininspectable
     * sans patienter cinq secondes pour de vrai. La course rend la main DES que l'editeur
     * repond : le cas nominal ne paie aucun tour d'attente.
     */
    let answered: boolean | undefined;
    const call = port.closeTab(resolution.tab).then((reported) => {
      answered = reported;
    });
    // Le rejet est traite par la course ci-dessous tant qu'on l'attend encore ; ce garde couvre
    // le cas ou l'on a DEJA abandonne — sans lui, un rejet tardif remonterait en exception non
    // capturee dans l'extension host, c'est-a-dire dans l'editeur de l'utilisateur.
    void call.catch(() => undefined);

    let askedMs = 0;
    while (answered === undefined) {
      if (askedMs >= CLOSE_CALL_BUDGET_MS) {
        throw new ClaudeManagerError(
          ERROR_CODES.CONVERSATION_CLOSE_FAILED,
          'The editor never answered the request to close the conversation tab',
          // `editorAnswered: false` — et non un `editorReportedClosed` fabrique : l'editeur n'a
          // rien resolu du tout, le dire autrement serait inventer un releve.
          {
            editorAnswered: false,
            waitedMs: askedMs,
            conversationsBefore: resolution.before.conversations,
            conversationsAfter: conversationTabs(port.listTabs()).length,
          }
        );
      }
      await Promise.race([call, wait(CLOSE_POLL_INTERVAL_MS)]);
      askedMs += CLOSE_POLL_INTERVAL_MS;
    }
    const editorReportedClosed = answered;

    // ---- INVARIANT n.5 : l'ENUMERATION fait foi, jamais le booleen ------------------------
    //
    // UNE enumeration par tour, et c'est celle qui CONFIRME qui sert ensuite a compter ce qui
    // reste : deux releves distincts pourraient decrire deux etats differents de la fenetre, et
    // `remaining` mentirait sur celui qu'on vient de constater.
    let waitedMs = 0;
    let tabs = port.listTabs();
    while (!removalConfirmed(resolution.identity, resolution.before, tabs)) {
      if (waitedMs >= CLOSE_CONFIRMATION_BUDGET_MS) {
        throw new ClaudeManagerError(
          ERROR_CODES.CONVERSATION_CLOSE_FAILED,
          'The conversation tab was not observed leaving tabGroups after the editor was asked to close it',
          // DES NOMBRES ET DES BOOLEENS, jamais un libelle. Les deux comptes sont rendus parce
          // qu'ils DISCRIMINENT : `conversationsAfter` egal a `conversationsBefore` designe une
          // fenetre ou rien n'a disparu, un compte plus bas designe l'ouverture concurrente que
          // `removalConfirmed` documente comme faux echec possible.
          {
            editorAnswered: true,
            editorReportedClosed,
            waitedMs,
            conversationsBefore: resolution.before.conversations,
            conversationsAfter: conversationTabs(tabs).length,
          }
        );
      }
      await wait(CLOSE_POLL_INTERVAL_MS);
      waitedMs += CLOSE_POLL_INTERVAL_MS;
      tabs = port.listTabs();
    }

    // CONSTATEE, donc DITE : la poignee repondra desormais « deja fermee » en le SACHANT, plutot
    // que de le deduire de ce qu'elle ne retrouve plus.
    resolution.confirmClosed();
    const remaining = conversationTabs(tabs).length;
    // LES DEUX ATTENTES SONT DITES SEPAREMENT : elles ont des causes differentes — un editeur
    // lent a repondre n'est pas un onglet lent a partir —, et ce journal est ce qui reste pour
    // en juger quand la duree deviendra suspecte.
    log(
      `closed one conversation tab after ~${askedMs} ms of editor call and ~${waitedMs} ms of ` +
        `confirmation (editorReportedClosed=${String(editorReportedClosed)}, ${remaining} left)`
    );
    return { ok: true, extHostPid, closed, remaining, editorReportedClosed };
  };

  return {
    list: () => serialize(() => Promise.resolve(list())),
    close: (request) => serialize(() => close(request)),
  };
}
