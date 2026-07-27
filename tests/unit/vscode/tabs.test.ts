import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONVERSATION_HANDLE_SHAPE, isClaudeManagerError } from '../../../packages/core/src/index.js';
import { isClaudePanel } from '../../../packages/vscode/src/seed.js';
import {
  createConversationRoutes,
  type ConversationTabLike,
  type ConversationTabsPort,
} from '../../../packages/vscode/src/tabs.js';

/**
 * ENUMERER ET FERMER — les DECISIONS et les REFUS, eprouves sans editeur.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * CE QUE CE FICHIER EPROUVE, ET CE QU'IL N'EPROUVE PAS (principe fondateur n.5). Le port des
 * onglets est une couture d'ORDRE, exactement comme l'`EditorPort` du mecanisme d'ouverture : ce
 * qui passe a travers lui ici, ce sont les cinq invariants de `tabs.ts` — jamais fermer sans
 * preuve, jamais plus d'un onglet, jamais un onglet non Claude, refus sur ambiguite, et la
 * CONFIRMATION par re-enumeration. Aucune de ces proprietes ne s'observe dans une vraie fenetre
 * sans provoquer des etats qu'on ne sait pas provoquer — un libelle qui change entre deux
 * requetes, un onglet que l'editeur refuse de fermer.
 *
 * Ce n'est PAS une simulation du comportement de VSCode. Que `tabGroups.close` ferme reellement
 * un onglet, qu'il n'en ferme qu'un, et qu'il n'emprunte pas le focus, n'est prouve QUE par
 * `npm run test:integration`, dans une vraie fenetre, sur de vrais onglets.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

/** Le `viewType` REELLEMENT releve sur un panneau Claude — VSCode prefixe (D2, mesure C1). */
const CLAUDE = 'mainThreadWebview-claudeVSCodePanel';

interface TestTab extends ConversationTabLike {
  /** Marque de reconnaissance dans les assertions — jamais lue par le code de production. */
  readonly tag: string;
}

function tab(partial: Partial<TestTab> & { readonly tag: string }): TestTab {
  return {
    viewType: CLAUDE,
    label: partial.tag,
    viewColumn: 1,
    indexInGroup: 0,
    isActive: false,
    ...partial,
  };
}

/** Un onglet de TEXTE : aucun `viewType`, donc jamais reconnu Claude. */
function textTab(partial: Partial<TestTab> & { readonly tag: string }): TestTab {
  return { ...tab(partial), viewType: undefined };
}

interface TestPort extends ConversationTabsPort<TestTab> {
  /** Les onglets que la fenetre porte — modifiable en cours de scenario. */
  tabs: readonly TestTab[];
  /** Tout ce que la fermeture a REELLEMENT demande a l'editeur, dans l'ordre. */
  readonly closed: readonly TestTab[];
  /** Combien de fois l'enumeration a ete demandee. */
  reads(): number;
}

interface PortOptions {
  /** Ce que l'editeur RESOUT. Defaut : `true`. */
  readonly reports?: boolean;
  /**
   * L'onglet quitte-t-il reellement `tabGroups` ? Defaut : oui, immediatement.
   *
   * `false` produit l'onglet que l'editeur pretend avoir ferme et qui reste enumere — le seul
   * etat que `CONVERSATION_CLOSE_FAILED` existe pour nommer.
   */
  readonly leaves?: boolean;
}

function portOf(tabs: readonly TestTab[], options: PortOptions = {}): TestPort {
  const closed: TestTab[] = [];
  let reads = 0;
  const port: TestPort = {
    tabs,
    closed,
    reads: () => reads,
    listTabs: () => {
      reads += 1;
      return port.tabs;
    },
    closeTab: (target) => {
      closed.push(target);
      if (options.leaves !== false) port.tabs = port.tabs.filter((item) => item !== target);
      return Promise.resolve(options.reports ?? true);
    },
  };
  return port;
}

const EXT_HOST_PID = 11172;

function routesOn(port: TestPort, log: string[] = []): ReturnType<typeof createConversationRoutes> {
  return createConversationRoutes<TestTab>({
    port,
    extHostPid: EXT_HOST_PID,
    log: (message) => log.push(message),
    // L'attente est INJECTEE : ce qu'il faut prouver est que la confirmation est bornee et
    // qu'elle porte sur l'enumeration, pas qu'on patiente cinq secondes.
    wait: () => Promise.resolve(),
  });
}

async function refusalOf(
  promise: Promise<unknown>
): Promise<{ code: string; details: unknown; remediation: string }> {
  try {
    await promise;
  } catch (error) {
    expect(isClaudeManagerError(error), `erreur nue : ${String(error)}`).toBe(true);
    const named = error as { code: string; details: unknown; remediation: string };
    return { code: named.code, details: named.details, remediation: named.remediation };
  }
  throw new Error('aucune erreur levee, alors que le test en attendait une');
}

describe('GET /conversations — enumerer', () => {
  it('ne voit QUE les onglets de conversation, jamais les autres', async () => {
    const port = portOf([
      textTab({ tag: 'notes.md' }),
      tab({ tag: 'A', indexInGroup: 1 }),
      textTab({ tag: 'autre.ts', indexInGroup: 2 }),
    ]);

    const listed = await routesOn(port).list();

    expect(listed.ok).toBe(true);
    expect(listed.extHostPid).toBe(EXT_HOST_PID);
    expect(listed.conversations.map((c) => c.label)).toEqual(['A']);
  });

  it('une liste VIDE n est pas une erreur', async () => {
    const listed = await routesOn(portOf([textTab({ tag: 'seul.md' })])).list();

    expect(listed.ok).toBe(true);
    expect(listed.conversations).toEqual([]);
  });

  it('attribue une poignee OPAQUE, jamais derivee du libelle', async () => {
    const port = portOf([tab({ tag: 'un libelle tres reconnaissable' })]);

    const [first] = (await routesOn(port).list()).conversations;

    expect(first?.id).toMatch(CONVERSATION_HANDLE_SHAPE);
    // Le libelle est du CONTENU de conversation : il n'a rien a faire dans un identifiant qui
    // transitera par des journaux et des sorties d'agent.
    expect(first?.id).not.toContain('libelle');
  });

  it('rend la position et l etat, tels quels', async () => {
    const port = portOf([
      tab({ tag: 'B', viewColumn: 2, indexInGroup: 3, isActive: true }),
    ]);

    const [only] = (await routesOn(port).list()).conversations;

    expect(only).toMatchObject({
      label: 'B',
      viewType: CLAUDE,
      viewColumn: 2,
      indexInGroup: 3,
      isActive: true,
    });
  });

  it('rend un ORDRE DETERMINE, quel que soit celui de l editeur', async () => {
    // L'ordre de `tabGroups.all` n'est promis par aucune documentation, et un agent qui prend
    // « la premiere » doit prendre deux fois la meme.
    const port = portOf([
      tab({ tag: 'c2i1', viewColumn: 2, indexInGroup: 1 }),
      tab({ tag: 'c1i1', viewColumn: 1, indexInGroup: 1 }),
      tab({ tag: 'c2i0', viewColumn: 2, indexInGroup: 0 }),
      tab({ tag: 'c1i0', viewColumn: 1, indexInGroup: 0 }),
    ]);

    const listed = await routesOn(port).list();

    expect(listed.conversations.map((c) => c.label)).toEqual(['c1i0', 'c1i1', 'c2i0', 'c2i1']);
  });

  it('REUTILISE la poignee d un onglet inchange : lister deux fois ne perime rien', async () => {
    const port = portOf([tab({ tag: 'A' }), tab({ tag: 'B', indexInGroup: 1 })]);
    const routes = routesOn(port);

    const first = await routes.list();
    const second = await routes.list();

    expect(second.conversations.map((c) => c.id)).toEqual(first.conversations.map((c) => c.id));
  });

  it('distingue deux conversations aux libelles IDENTIQUES', async () => {
    // Le libelle est derive du contenu : deux conversations peuvent porter le meme.
    const port = portOf([
      tab({ tag: 'Claude Code', indexInGroup: 0 }),
      tab({ tag: 'Claude Code', indexInGroup: 1 }),
    ]);

    const listed = await routesOn(port).list();

    expect(listed.conversations).toHaveLength(2);
    expect(listed.conversations[0]?.id).not.toBe(listed.conversations[1]?.id);
  });

  it('n a AUCUN effet de bord : rien n est ferme, et l enumeration seule est demandee', async () => {
    const port = portOf([tab({ tag: 'A' })]);

    await routesOn(port).list();
    await routesOn(port).list();

    expect(port.closed).toEqual([]);
    expect(port.tabs).toHaveLength(1);
  });
});

describe('POST /conversations/close — la voie nominale', () => {
  it('ferme l onglet designe, et rend ce qu il etait AVANT', async () => {
    const port = portOf([tab({ tag: 'A' }), tab({ tag: 'B', indexInGroup: 1 })]);
    const routes = routesOn(port);
    const [, b] = (await routes.list()).conversations;

    const closed = await routes.close({ id: b?.id ?? '' });

    expect(closed.ok).toBe(true);
    expect(closed.extHostPid).toBe(EXT_HOST_PID);
    // Releve AVANT l'effet de bord : apres, l'onglet n'est plus la pour etre decrit.
    expect(closed.closed).toEqual({
      id: b?.id,
      label: 'B',
      viewType: CLAUDE,
      viewColumn: 1,
      indexInGroup: 1,
      isActive: false,
    });
    expect(closed.remaining).toBe(1);
    expect(closed.editorReportedClosed).toBe(true);
    // Et c'est bien B qui est parti, pas A.
    expect(port.tabs.map((t) => t.tag)).toEqual(['A']);
  });

  it('L ENUMERATION FAIT FOI, pas le booleen de l editeur', async () => {
    // `close` resout un booleen. Un editeur qui rendrait `false` en ayant pourtant ferme
    // l'onglet ne doit pas faire echouer une fermeture reussie : le releve est rendu tel quel,
    // et c'est la disparition qui decide.
    const port = portOf([tab({ tag: 'A' })], { reports: false });
    const routes = routesOn(port);
    const [a] = (await routes.list()).conversations;

    const closed = await routes.close({ id: a?.id ?? '' });

    expect(closed.editorReportedClosed).toBe(false);
    expect(closed.remaining).toBe(0);
  });

  it("l onglet qui ne quitte JAMAIS tabGroups sort en CONVERSATION_CLOSE_FAILED, borne", async () => {
    // L'inverse du precedent, et le plus dangereux : l'editeur dit avoir ferme, l'onglet est
    // toujours la. Rendre un succes ici serait la degradation silencieuse que le principe
    // fondateur n.3 interdit.
    const port = portOf([tab({ tag: 'A' })], { leaves: false });
    const routes = routesOn(port);
    const [a] = (await routes.list()).conversations;

    const refusal = await refusalOf(routes.close({ id: a?.id ?? '' }));

    expect(refusal.code).toBe('CONVERSATION_CLOSE_FAILED');
    // BORNEE : le detail porte la duree attendue, et elle est finie.
    expect(refusal.details).toMatchObject({ editorReportedClosed: true });
    expect((refusal.details as { waitedMs: number }).waitedMs).toBeGreaterThan(0);
  });

  it('attend REELLEMENT entre deux sondages quand aucune attente n est injectee', async () => {
    // CE QUE LA PRODUCTION EMPRUNTE, et qu'aucun test n'exercait : `extension.ts` ne passe PAS de
    // `wait`, donc la confirmation s'appuie sur le `sleep` par defaut. Un port injecte a chaque
    // test laisserait cette ligne hors mesure — c'est-a-dire la seule qui tourne chez
    // l'utilisateur. L'onglet ne part qu'au SECOND sondage : la boucle doit donc patienter.
    const port = portOf([tab({ tag: 'A' })], { leaves: false });
    let polls = 0;
    const target = port.tabs[0] as TestTab;
    port.closeTab = (): Promise<boolean> => Promise.resolve(true);
    const listTabs = port.listTabs.bind(port);
    port.listTabs = (): readonly TestTab[] => {
      polls += 1;
      // LE QUATRIEME RELEVE, et le compte est celui du chemin reel : (1) l'enumeration de
      // `list()`, (2) la resolution de la poignee, (3) la premiere confirmation — qui voit
      // l'onglet ENCORE la et fait donc entrer dans l'attente —, puis (4) celle-ci, qui le voit
      // parti. Sans attente franchie, on n'atteindrait jamais le quatrieme.
      if (polls >= 4) port.tabs = port.tabs.filter((item) => item !== target);
      return listTabs();
    };

    const routes = createConversationRoutes<TestTab>({
      port,
      extHostPid: EXT_HOST_PID,
      log: () => undefined,
      // AUCUN `wait` : c'est le montage de production.
    });
    const [a] = (await routes.list()).conversations;

    const started = Date.now();
    const closed = await routes.close({ id: a?.id ?? '' });
    const elapsed = Date.now() - started;

    expect(closed.ok).toBe(true);
    // Le sondage est a 100 ms : une attente REELLE a eu lieu, elle n'a pas ete court-circuitee.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(polls).toBeGreaterThanOrEqual(4);
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * LA CONFIRMATION, ET LE FAUX SUCCES QU'ELLE A LAISSE PASSER (reprise 1 de C4).
   *
   * `removalConfirmed` exige DEUX faits : plus rien ne correspond au releve, ET le nombre
   * d'onglets de conversation a DIMINUE. La premiere version n'exigeait que le premier — et
   * `matches` comparant le LIBELLE, un onglet non ferme dont le libelle changeait pendant les 5 s
   * d'attente cessait de correspondre : la route rendait un SUCCES sur un onglet toujours ouvert.
   *
   * Les quatre cas ci-dessous couvrent le carre complet : le nominal, le voisin qui glisse (le cas
   * ORDINAIRE, qui ne doit surtout pas devenir un faux echec), le defaut corrige, et les deux trous
   * residuels — epingles pour qu'ils soient un choix constate plutot qu'un angle mort.
   * ─────────────────────────────────────────────────────────────────────────────────────────
   */
  describe('la confirmation exige DEUX faits', () => {
    /**
     * Remplace l'etat de la fenetre AVANT le n-ieme releve, COMPTE A PARTIR DE LA POSE.
     *
     * Les tests posent ce crochet APRES `list()`, si bien que le releve n.1 est celui de la
     * RESOLUTION et le n.2 la PREMIERE verification de confirmation. C'est donc `2` qu'ils
     * emploient tous : l'etat doit avoir change quand la confirmation regarde pour la
     * premiere fois, faute de quoi elle conclurait sur l'etat d'avant.
     */
    function scheduleTabs(port: TestPort, at: number, tabs: readonly TestTab[]): void {
      const enumerate = port.listTabs.bind(port);
      let polls = 0;
      port.listTabs = (): readonly TestTab[] => {
        polls += 1;
        if (polls === at) port.tabs = tabs;
        return enumerate();
      };
    }

    it("LE DEFAUT CORRIGE : un onglet NON FERME dont le libelle change n'est plus un succes", async () => {
      // GARDE-FOU DE NON-REGRESSION. Avec la regle precedente — « plus rien ne correspond » —, ce
      // test rendait `ok: true` sur un onglet parfaitement ouvert. C'est le seul cas ou ce fichier
      // fabriquait un faux succes, et c'est la direction dangereuse.
      const port = portOf([tab({ tag: 'Claude Code' })], { leaves: false });
      const routes = routesOn(port);
      const [a] = (await routes.list()).conversations;
      // Le libelle change AVANT la premiere verification, comme le fait la vraie extension
      // Claude quelques centaines de millisecondes apres l'attachement (D24).
      scheduleTabs(port, 2, [tab({ tag: 'Confirm session response' })]);

      const refusal = await refusalOf(routes.close({ id: a?.id ?? '' }));

      expect(refusal.code).toBe('CONVERSATION_CLOSE_FAILED');
      // Les deux comptes DISCRIMINENT : egaux, ils disent que rien n'a disparu de la fenetre.
      expect(refusal.details).toMatchObject({ conversationsBefore: 1, conversationsAfter: 1 });
    });

    it("LE CAS ORDINAIRE reste un succes : le voisin qui GLISSE ne fait pas echouer", async () => {
      // C'est la contrainte qui elimine la regle « comparer sans le libelle » : fermer un onglet
      // fait glisser ses voisins d'un rang, et une confirmation positionnelle verrait la place
      // « toujours occupee ». Ici, le compte a diminue et plus rien ne correspond : c'est un succes.
      const port = portOf([tab({ tag: 'A', indexInGroup: 0 }), tab({ tag: 'B', indexInGroup: 1 })]);
      const routes = routesOn(port);
      const [a] = (await routes.list()).conversations;
      // L'editeur reindexe : B prend le rang 0, celui que A occupait.
      scheduleTabs(port, 2, [tab({ tag: 'B', indexInGroup: 0 })]);

      const closed = await routes.close({ id: a?.id ?? '' });

      expect(closed.ok).toBe(true);
      expect(closed.remaining).toBe(1);
      expect(port.closed.map((t) => t.tag)).toEqual(['A']);
    });

    it("UN AUTRE onglet ferme pendant l'attente ne confirme rien : le notre correspond encore", async () => {
      // La seconde condition seule ne suffirait pas davantage : le compte diminue, mais c'est un
      // AUTRE onglet qui est parti. La correspondance, elle, tient toujours.
      const port = portOf(
        [tab({ tag: 'A', indexInGroup: 0 }), tab({ tag: 'B', indexInGroup: 1 })],
        { leaves: false }
      );
      const routes = routesOn(port);
      const [a] = (await routes.list()).conversations;
      // L'humain ferme B a la main ; A, que la route croit avoir ferme, est intact.
      scheduleTabs(port, 2, [tab({ tag: 'A', indexInGroup: 0 })]);

      const refusal = await refusalOf(routes.close({ id: a?.id ?? '' }));

      expect(refusal.code).toBe('CONVERSATION_CLOSE_FAILED');
      expect(refusal.details).toMatchObject({ conversationsBefore: 2, conversationsAfter: 1 });
    });

    it('TROU RESIDUEL (a) — faux succes, desormais a TROIS evenements au lieu de deux', async () => {
      // EPINGLE PLUTOT QUE TU. Il faut que `close` echoue silencieusement, QUE le libelle change,
      // ET qu'un autre onglet de conversation se ferme dans la meme fenetre de 5 s. La regle
      // precedente n'exigeait que les deux premiers : le trou s'est strictement retreci, il n'a
      // pas disparu. Aucun champ stable ne permet de le fermer — c'est le fait de l'en-tete de
      // module. PROPRIETAIRE : lot E (E2E multi-fenetres).
      const port = portOf(
        [tab({ tag: 'Claude Code', indexInGroup: 0 }), tab({ tag: 'B', indexInGroup: 1 })],
        { leaves: false }
      );
      const routes = routesOn(port);
      const [a] = (await routes.list()).conversations;
      // Notre onglet est toujours la, renomme ; B est parti.
      scheduleTabs(port, 2, [tab({ tag: 'Confirm session response', indexInGroup: 0 })]);

      const closed = await routes.close({ id: a?.id ?? '' });

      // CE COMPORTEMENT EST UN CONSTAT, PAS UNE PROMESSE : si un incrément ultérieur le rend
      // detectable, ce test doit CHANGER, et c'est precisement pourquoi il existe.
      expect(closed.ok).toBe(true);
      // L'onglet, lui, est toujours ouvert — la fenetre en compte encore un.
      expect(port.tabs).toHaveLength(1);
    });

    it("TROU RESIDUEL (b) — faux echec quand une conversation s'OUVRE pendant l'attente", async () => {
      // La direction SURE, et elle est atteignable : ouvertures et fermetures ont des files
      // distinctes. La fermeture a REUSSI, mais le compte est revenu a son point de depart, donc
      // la confirmation n'a rien pu constater. Relancer est sans danger — un second appel sortira
      // en `CONVERSATION_ALREADY_CLOSED` —, et la remediation le dit.
      const port = portOf([tab({ tag: 'A', indexInGroup: 0 })]);
      const routes = routesOn(port);
      const [a] = (await routes.list()).conversations;
      // A est bien parti, mais une conversation neuve a pris sa place dans le compte.
      scheduleTabs(port, 2, [tab({ tag: 'Neuve', indexInGroup: 0 })]);

      const refusal = await refusalOf(routes.close({ id: a?.id ?? '' }));

      expect(refusal.code).toBe('CONVERSATION_CLOSE_FAILED');
      expect(refusal.details).toMatchObject({ conversationsBefore: 1, conversationsAfter: 1 });
      // L'onglet designe a REELLEMENT ete ferme : c'est bien un faux echec, pas un vrai.
      expect(port.closed.map((t) => t.tag)).toEqual(['A']);
      // Et la remediation prepare le lecteur a ce cas precis.
      expect(refusal.remediation).toContain('FERMETURE POURTANT REUSSIE');
    });
  });

  it('journalise le COMPTE, jamais les libelles — le journal part dans une PR', async () => {
    const log: string[] = [];
    const port = portOf([tab({ tag: 'un secret de conversation' })]);
    const routes = routesOn(port, log);
    const [a] = (await routes.list()).conversations;
    await routes.close({ id: a?.id ?? '' });

    expect(log.join('\n')).not.toContain('un secret de conversation');
    expect(log.join('\n')).toContain('enumerated 1 conversation tab(s)');
    expect(log.join('\n')).toContain('closed one conversation tab');
  });
});

describe('POST /conversations/close — les refus, et AUCUN effet de bord', () => {
  it('une poignee jamais emise par cette fenetre -> STALE', async () => {
    const port = portOf([tab({ tag: 'A' })]);
    const routes = routesOn(port);
    await routes.list();

    const refusal = await refusalOf(
      routes.close({ id: '00000000-0000-4000-8000-000000000000' })
    );

    expect(refusal.code).toBe('CONVERSATION_HANDLE_STALE');
    // DES NOMBRES, jamais un libelle ni la poignee refusee : ces details partent vers un agent.
    expect(refusal.details).toEqual({ conversations: 1 });
    expect(port.closed).toEqual([]);
  });

  it('LE LIBELLE A CHANGE SUR PLACE -> STALE, et rien n est ferme', async () => {
    // C'EST LE CAS QUI JUSTIFIE TOUT LE DISPOSITIF. Le libelle est derive du CONTENU de la
    // conversation (D24) : il devient `Respond with OK exactly` quelques centaines de
    // millisecondes apres l'attachement. Un identifiant qui s'y adosserait sans garde
    // fermerait un onglet qu'il ne sait plus identifier ; ici, on refuse.
    const port = portOf([tab({ tag: 'Claude Code' })]);
    const routes = routesOn(port);
    const [a] = (await routes.list()).conversations;
    port.tabs = [tab({ tag: 'Respond with OK exactly' })];

    const refusal = await refusalOf(routes.close({ id: a?.id ?? '' }));

    expect(refusal.code).toBe('CONVERSATION_HANDLE_STALE');
    expect(port.closed).toEqual([]);
  });

  it("L ONGLET A ETE DEPLACE -> STALE, parce qu'il existe encore ailleurs", async () => {
    const port = portOf([tab({ tag: 'A', viewColumn: 1 })]);
    const routes = routesOn(port);
    const [a] = (await routes.list()).conversations;
    // Meme onglet, autre colonne : la coordonnee relevee ne porte plus rien.
    port.tabs = [tab({ tag: 'A', viewColumn: 2 })];

    const refusal = await refusalOf(routes.close({ id: a?.id ?? '' }));

    expect(refusal.code).toBe('CONVERSATION_HANDLE_STALE');
    expect(port.closed).toEqual([]);
  });

  it("UN AUTRE ONGLET DE CONVERSATION OCCUPE LA COORDONNEE -> STALE", async () => {
    // Le cas le plus couteux s'il etait mal traite : fermer « ce qui est a cette place » plutot
    // que « ce qui a ete designe » fermerait la conversation du voisin.
    const port = portOf([tab({ tag: 'A', indexInGroup: 0 }), tab({ tag: 'B', indexInGroup: 1 })]);
    const routes = routesOn(port);
    const [a] = (await routes.list()).conversations;
    // A ferme a la main par l'humain : B glisse au rang 0.
    port.tabs = [tab({ tag: 'B', indexInGroup: 0 })];

    const refusal = await refusalOf(routes.close({ id: a?.id ?? '' }));

    expect(refusal.code).toBe('CONVERSATION_HANDLE_STALE');
    expect(port.closed).toEqual([]);
    // B est intact : c'est tout l'objet du refus.
    expect(port.tabs.map((t) => t.tag)).toEqual(['B']);
  });

  it("L ONGLET A DISPARU -> ALREADY_CLOSED, sur une preuve POSITIVE", async () => {
    const port = portOf([tab({ tag: 'A' })]);
    const routes = routesOn(port);
    const [a] = (await routes.list()).conversations;
    port.tabs = [];

    const refusal = await refusalOf(routes.close({ id: a?.id ?? '' }));

    expect(refusal.code).toBe('CONVERSATION_ALREADY_CLOSED');
    expect(refusal.details).toEqual({ conversations: 0 });
  });

  it('fermer DEUX FOIS la meme poignee : succes, puis ALREADY_CLOSED', async () => {
    // La propriete sur laquelle repose la decision de NE PAS creer un troisieme code
    // d'illisibilite : relancer une fermeture ne peut RIEN creer.
    const port = portOf([tab({ tag: 'A' })]);
    const routes = routesOn(port);
    const [a] = (await routes.list()).conversations;

    await routes.close({ id: a?.id ?? '' });
    const refusal = await refusalOf(routes.close({ id: a?.id ?? '' }));

    expect(refusal.code).toBe('CONVERSATION_ALREADY_CLOSED');
    expect(port.closed).toHaveLength(1);
  });

  it('LES DEUX ETATS INDISCERNABLES rendent le MEME code, et c est le choix mesure', async () => {
    // ─────────────────────────────────────────────────────────────────────────────────────
    // MESURE DU 2026-07-27, EN VRAIE FENETRE. Deux etats se presentent a la fenetre de facon
    // IDENTIQUE — un onglet de conversation a la coordonnee relevee, dont le releve ne
    // correspond pas, et plus rien ne portant le releve d'origine :
    //
    //   (a) l'onglet est PARTI et son voisin a GLISSE d'un rang — ce que VSCode fait a chaque
    //       fermeture, donc le cas ORDINAIRE d'une seconde fermeture ;
    //   (b) l'onglet est TOUJOURS LA et son LIBELLE a change — ce que la vraie extension Claude
    //       fait quelques centaines de millisecondes apres l'attachement (D24).
    //
    // On repond `STALE` aux deux parce que `STALE` dit « je ne peux pas l'affirmer », ce qui est
    // vrai des deux cotes. `ALREADY_CLOSED` serait FAUX dans le cas (b), et un appelant qui le
    // croirait abandonnerait une conversation vivante.
    // ─────────────────────────────────────────────────────────────────────────────────────
    const states: readonly (readonly [string, readonly TestTab[]])[] = [
      // (a) A ferme a la main, B glisse du rang 1 au rang 0.
      ['le voisin a glisse', [tab({ tag: 'B', indexInGroup: 0 })]],
      // (b) A est toujours au rang 0, son libelle a change.
      ['le libelle a change sur place', [tab({ tag: 'Confirm session response', indexInGroup: 0 })]],
    ];

    for (const [label, after] of states) {
      const port = portOf([tab({ tag: 'A', indexInGroup: 0 }), tab({ tag: 'B', indexInGroup: 1 })]);
      const routes = routesOn(port);
      const [a] = (await routes.list()).conversations;
      port.tabs = after;

      const refusal = await refusalOf(routes.close({ id: a?.id ?? '' }));

      expect(refusal.code, label).toBe('CONVERSATION_HANDLE_STALE');
      expect(refusal.code, label).not.toBe('CONVERSATION_ALREADY_CLOSED');
      expect(port.closed, label).toEqual([]);
    }
  });

  it('UN ONGLET DE TEXTE HOMONYME a la coordonnee relevee n est jamais ferme', async () => {
    // Un onglet de texte n'a pas de `viewType` : meme a la bonne place et avec le meme libelle,
    // il n'est pas reconnu Claude, donc il n'est pas fermable.
    const port = portOf([tab({ tag: 'A' })]);
    const routes = routesOn(port);
    const [a] = (await routes.list()).conversations;
    port.tabs = [textTab({ tag: 'A' })];

    const refusal = await refusalOf(routes.close({ id: a?.id ?? '' }));

    expect(refusal.code).toBe('CONVERSATION_ALREADY_CLOSED');
    expect(port.closed).toEqual([]);
    expect(port.tabs.map((t) => t.tag)).toEqual(['A']);
  });

  it('DEUX FERMETURES CONCURRENTES sur la meme poignee ne ferment qu une fois', async () => {
    // Les deux routes partagent UNE file d'un seul rang. Sans elle, les deux resoudraient le
    // meme onglet et rendraient toutes deux un succes, dont un seul aurait ferme quelque chose.
    const port = portOf([tab({ tag: 'A' })]);
    const routes = routesOn(port);
    const [a] = (await routes.list()).conversations;
    const id = a?.id ?? '';

    const [first, second] = await Promise.allSettled([routes.close({ id }), routes.close({ id })]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect((second as PromiseRejectedResult).reason).toMatchObject({
      code: 'CONVERSATION_ALREADY_CLOSED',
    });
    expect(port.closed).toHaveLength(1);
  });

  it('un refus ne bloque pas les demandes suivantes', async () => {
    const port = portOf([tab({ tag: 'A' })]);
    const routes = routesOn(port);
    const [a] = (await routes.list()).conversations;

    await refusalOf(routes.close({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }));
    // La file est d'un seul rang : un echec qui la romprait rendrait la fenetre inutilisable.
    const closed = await routes.close({ id: a?.id ?? '' });

    expect(closed.ok).toBe(true);
  });

  it('une poignee EVINCEE sort du cote SUR : STALE, jamais un faux « deja ferme »', async () => {
    // Le registre est borne a 256 poignees. Une poignee evincee doit envoyer relister, jamais
    // affirmer une disparition qu'on ne peut plus constater.
    const port = portOf([tab({ tag: 'A' })]);
    const routes = routesOn(port);
    const [a] = (await routes.list()).conversations;
    const evicted = a?.id ?? '';

    // 300 libelles distincts, donc 300 poignees neuves : la premiere sort du registre.
    for (let index = 0; index < 300; index += 1) {
      port.tabs = [tab({ tag: `libelle-${index}` })];
      await routes.list();
    }
    // L'onglet est REMIS dans son etat d'origine : seule la poignee a ete perdue.
    port.tabs = [tab({ tag: 'A' })];

    const refusal = await refusalOf(routes.close({ id: evicted }));

    expect(refusal.code).toBe('CONVERSATION_HANDLE_STALE');
    expect(port.closed).toEqual([]);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * GARDE-FOU MECANIQUE n.1 — JAMAIS PLUS D'UN ONGLET, JAMAIS UN ONGLET NON CLAUDE.
 *
 * Ce sont les deux facons dont cette route peut NUIRE, et une relecture attentive les laisserait
 * passer une fois sur dix. La regle est donc appliquee a TOUS les scenarios du fichier — les
 * refus comme les succes — plutot qu'a un cas choisi.
 *
 * L'INSTRUMENT EST EPROUVE SUR CAS POSITIF, et ce n'est pas une precaution de style : ce
 * chantier a compte trois instruments qui rendaient un zero sans rien mesurer. Les deux tests
 * ci-dessous font DELIBEREMENT echouer la regle.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
function assertClosedAtMostOneConversation(closed: readonly TestTab[]): void {
  if (closed.length > 1) {
    throw new Error(`${closed.length} onglets fermes pour une seule demande de fermeture`);
  }
  for (const target of closed) {
    if (!isClaudePanel(target)) {
      throw new Error(`un onglet NON reconnu Claude a ete ferme : viewType=${String(target.viewType)}`);
    }
  }
}

describe('garde-fou n.1 — un onglet, et un onglet Claude', () => {
  it('la regle ATTRAPE deux fermetures pour une demande', () => {
    expect(() => assertClosedAtMostOneConversation([tab({ tag: 'A' }), tab({ tag: 'B' })])).toThrow(
      /2 onglets fermes/
    );
  });

  it('la regle ATTRAPE la fermeture d un onglet non reconnu Claude', () => {
    expect(() => assertClosedAtMostOneConversation([textTab({ tag: 'notes.md' })])).toThrow(
      /NON reconnu Claude/
    );
    // Et un `viewType` qui ne CONTIENT pas le motif n'en est pas un davantage (D2).
    expect(() =>
      assertClosedAtMostOneConversation([tab({ tag: 'X', viewType: 'mainThreadWebview-autre' })])
    ).toThrow(/NON reconnu Claude/);
  });

  it('AUCUN chemin de la route ne l enfreint, sur tous les etats qui peuvent se presenter', async () => {
    /** Le temoin de TEXTE, present dans tous les etats : il doit survivre a chaque chemin. */
    const witness = (): TestTab => textTab({ tag: 'temoin.md', viewColumn: 9, indexInGroup: 0 });

    const scenarios: readonly (readonly [string, readonly TestTab[]])[] = [
      // L'etat inchange : le seul chemin qui doit REELLEMENT fermer.
      ['nominal', [tab({ tag: 'A' }), witness()]],
      ['libelle change', [tab({ tag: 'autre libelle' }), witness()]],
      ['onglet deplace', [tab({ tag: 'A', viewColumn: 3 }), witness()]],
      ['onglet disparu', [witness()]],
      ['onglet de texte homonyme a la place', [textTab({ tag: 'A' }), witness()]],
      ['un voisin Claude a la coordonnee', [tab({ tag: 'voisin' }), witness()]],
      [
        'plusieurs conversations ouvertes',
        [tab({ tag: 'A' }), tab({ tag: 'B', indexInGroup: 1 }), tab({ tag: 'C', viewColumn: 2 }), witness()],
      ],
    ];

    for (const [label, after] of scenarios) {
      const port = portOf([tab({ tag: 'A' }), witness()]);
      const routes = routesOn(port);
      const [a] = (await routes.list()).conversations;
      // L'etat de la fenetre change ENTRE l'enumeration et la fermeture — c'est tout le cas.
      port.tabs = after;

      await routes.close({ id: a?.id ?? '' }).catch(() => undefined);

      expect(() => assertClosedAtMostOneConversation(port.closed), label).not.toThrow();
      // Le temoin de TEXTE survit a TOUS les chemins, y compris celui qui ferme.
      expect(port.tabs.some((t) => t.tag === 'temoin.md'), `${label} — le temoin`).toBe(true);
      expect(port.closed.every((t) => t.tag !== 'temoin.md'), `${label} — le temoin ferme`).toBe(true);
    }

    // Une poignee jamais emise, sur un etat inchange : elle ne doit rien fermer non plus.
    const port = portOf([tab({ tag: 'A' }), witness()]);
    const routes = routesOn(port);
    await routes.list();
    await routes.close({ id: '11111111-1111-4111-8111-111111111111' }).catch(() => undefined);
    expect(port.closed).toEqual([]);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * GARDE-FOU MECANIQUE n.2 — `preserveFocus: true`, TOUJOURS.
 *
 * Le principe fondateur n.1 est SANS EXCEPTION, et `tabGroups.close(tab, preserveFocus?)` a un
 * second parametre OPTIONNEL : l'omettre compile, passe le typecheck, se relit tres bien, et
 * fait reporter le focus par VSCode sur un autre onglet quand celui qu'on ferme etait actif.
 * C'est un vol de focus dans une fenetre que l'humain n'a pas demande a voir.
 *
 * L'APPEL VIT DANS `extension.ts`, QUE LA MESURE DE COUVERTURE EXCLUT — c'est le seul point de
 * contact du paquet avec l'API `vscode`, et aucun test unitaire ne peut l'executer. La garde est
 * donc une regle SUR LA SOURCE, et c'est le seul instrument qui atteigne cette ligne. Le port
 * (`closeTab(tab)`, un onglet, jamais un tableau) porte le reste par le typage.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
interface CloseCall {
  readonly file: string;
  readonly args: string;
}

/** Tous les appels a `tabGroups.close(...)` d'une source, avec leurs arguments. */
function closeCallsIn(file: string, source: string): readonly CloseCall[] {
  // Aucun appel du depot n'imbrique de parenthese dans ses arguments : la regle le VERIFIE
  // ci-dessous plutot que de le supposer, en exigeant une forme exacte.
  return [...source.matchAll(/tabGroups\s*\.\s*close\s*\(([^)]*)\)/g)].map((match) => ({
    file,
    args: match[1] as string,
  }));
}

/** @throws si un appel omet `preserveFocus: true`, ou ferme un TABLEAU d'onglets. */
function assertPreservesFocus(calls: readonly CloseCall[]): void {
  for (const call of calls) {
    if (!/,\s*true\s*$/.test(call.args)) {
      throw new Error(`${call.file} : tabGroups.close(${call.args}) n impose pas preserveFocus`);
    }
    if (call.args.includes('[')) {
      throw new Error(`${call.file} : tabGroups.close recoit un TABLEAU d onglets`);
    }
  }
}

const PACKAGES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages'
);

function sourcesUnder(directory: string): readonly string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe('garde-fou n.2 — preserveFocus, sur la source', () => {
  const calls = sourcesUnder(PACKAGES).flatMap((file) =>
    closeCallsIn(path.relative(PACKAGES, file), readFileSync(file, 'utf8'))
  );

  it("la regle ATTRAPE un appel qui omet preserveFocus", () => {
    // L'INSTRUMENT, VU ROUGE. Sans ce test, une regle qui ne trouverait jamais rien rendrait un
    // vert identique a celui d'une regle qui verifie.
    expect(() =>
      assertPreservesFocus(closeCallsIn('faux.ts', 'vscode.window.tabGroups.close(tab.tab);'))
    ).toThrow(/n impose pas preserveFocus/);
    expect(() =>
      assertPreservesFocus(closeCallsIn('faux.ts', 'tabGroups.close(tab, false)'))
    ).toThrow(/n impose pas preserveFocus/);
    expect(() =>
      assertPreservesFocus(closeCallsIn('faux.ts', 'tabGroups.close([a, b], true)'))
    ).toThrow(/TABLEAU/);
  });

  it('TOUS les appels du depot imposent preserveFocus: true, sur UN onglet', () => {
    // L'assertion serait VIDE si plus aucun appel n'existait — ou si la regex avait cesse de les
    // reconnaitre, ce qui est exactement la facon dont ce genre de garde meurt en silence.
    expect(calls.length, 'aucun appel a tabGroups.close trouve : la regle ne mesure plus rien').toBe(
      1
    );
    expect(() => assertPreservesFocus(calls)).not.toThrow();
  });

  it("l unique appel vit dans le port de l adaptateur, et nulle part ailleurs", () => {
    // Un second site d'appel serait un second endroit ou l'invariant peut tomber, et il
    // echapperait au port qui, lui, n'accepte qu'un onglet.
    expect(calls.map((call) => call.file)).toEqual([path.join('vscode', 'src', 'extension.ts')]);
  });
});
