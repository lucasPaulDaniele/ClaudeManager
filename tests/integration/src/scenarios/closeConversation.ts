/**
 * Scenario CLOSE-CONVERSATION — l'enumeration et la fermeture, dans une VRAIE fenetre, sur de
 * VRAIS onglets, par le VRAI serveur local.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * IL PORTE LE PREMIER APPEL A `tabGroups.close` DU DEPOT. Jusqu'a l'increment C4, ce depot
 * comptait 17 occurrences de `tabGroups` et ZERO de `tabGroups.close` : la fermeture etait
 * decrite dans `CLAUDE.md` et couverte par rien. C'est ce que ce fichier corrige.
 *
 * L'EXTENSION CLAUDE N'EST PAS CHARGEE ICI, ET C'EST DELIBERE. Ce que ce scenario eprouve est
 * la reconnaissance, la verification d'identite et la fermeture d'un onglet — pas le mecanisme
 * d'ouverture, qui a son propre scenario et facture un vrai tour. Les onglets sont donc CREES
 * PAR LE SCENARIO, avec un `viewType` qui CONTIENT `claudeVSCodePanel` : ce sont de vrais
 * onglets de webview, enumeres par le vrai `tabGroups`, juges par le vrai code de production.
 * Aucun faux `tabGroups`, aucun faux `http` (principe fondateur n.5).
 *
 * CE QUE CE MONTAGE NE COUVRE PAS, ET IL FAUT LE DIRE : que l'extension Claude reelle produise
 * bien un `viewType` contenant ce motif. Cela, c'est `open-conversation` qui le releve, sur la
 * vraie extension (D2), et la preuve d'execution de C4 le rejoue a la main.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Ce qu'il verifie, point par point :
 *   1. l'enumeration ne voit QUE les onglets de conversation — l'onglet de texte temoin en est
 *      exclu — et n'a AUCUN effet de bord ;
 *   2. la fermeture retire CELUI-LA et AUCUN AUTRE : les autres panneaux et le temoin survivent ;
 *   3. le succes n'est rendu qu'apres que l'onglet a REELLEMENT quitte `tabGroups` ;
 *   4. une poignee PERIMEE est refusee sans rien fermer — quatre formes : deja employee,
 *      arrangement change, libelle change, jamais emise ;
 *   5. l'onglet ACTIF ne change pas quand on ferme un onglet qui ne l'est pas — c'est ce que
 *      `preserveFocus: true` achete, observable de l'interieur ;
 *   6. aucune reponse ne porte le jeton.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LES DEUX SCENARIOS DU DEFAUT G1, SUR DE VRAIS ONGLETS — et c'est ce que ce fichier a gagne a
 * la correction du gate final. Il etait MOINS ADVERSE QUE LE REEL sur deux points, tous deux
 * corriges ici : ses panneaux portaient des `viewType` DISTINCTS quand les vrais partagent le
 * meme (D2), et il fermait deliberement le DERNIER onglet — le seul cas ou aucun voisin ne
 * glisse sur la coordonnee liberee.
 *
 * Il ferme desormais un onglet QUI A UN VOISIN, et il rejoue les deux etats ou le produit
 * fermait la conversation de ce voisin :
 *
 *   - LA RELANCE (etape 4a) : apres une fermeture reussie, le voisin a glisse sur la place et on
 *     le RENOMME du libelle du disparu. Il est alors, dans ses quatre champs, la poignee du
 *     mort. Avant correctif, la relance le fermait ;
 *   - LA FERMETURE A LA MAIN (etape 4b) : l'humain ferme un onglet entre les deux temps, le
 *     voisin glisse, on le renomme de meme, et l'on presente une poignee JAMAIS employee. Avant
 *     correctif, elle fermait ce voisin en rendant `ok: true`.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as vscode from 'vscode';
import { windowEntryPath, type WindowEntry } from '../../../../packages/core/src/index.js';
import { CLAUDE_PANEL_VIEW_TYPE } from '../../../../packages/vscode/src/seed.js';
import { mask } from '../redaction.js';
import { postJson, probe, waitFor, type ScenarioContext } from '../support.js';

/**
 * LE `viewType` QUE CE SCENARIO ENREGISTRE — LE MEME POUR TOUS SES PANNEAUX.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * IL Y EN AVAIT DEUX, DISTINCTS, ET C'ETAIT UN ANGLE MORT DU GATE FINAL : ce montage etait
 * MOINS ADVERSE QUE LE REEL. Sur une vraie fenetre, TOUS les panneaux Claude portent le meme
 * `viewType` (D2, re-mesure du 2026-07-27 sur VSCode 1.130.0) — c'est meme la premiere raison
 * pour laquelle une poignee ne peut pas s'y adosser. Deux `viewType` distincts rendaient les
 * onglets discernables par un champ qui, en vrai, ne discrimine rien.
 *
 * Il CONTIENT `claudeVSCodePanel` sans l'egaler, comme le vrai : VSCode prefixe le `viewType`
 * d'une webview (`mainThreadWebview-…`, mesure du lot B), et la reconnaissance du produit se
 * fait par « contient » (D2).
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
const PROBE_VIEW_TYPE = `${CLAUDE_PANEL_VIEW_TYPE}CloseProbe`;

/**
 * TROIS conversations, et le nombre est un choix : il en faut une AVANT et une APRES celle
 * qu'on ferme. Fermer le DERNIER onglet est le seul cas ou aucun voisin ne glisse sur la
 * coordonnee liberee — c'est-a-dire le seul cas ou le defaut G1 ne peut pas se produire.
 */
const PROBE_TITLES = ['Conversation A', 'Conversation B', 'Conversation C'] as const;

/** Un `viewType` de webview qui ne doit JAMAIS etre reconnu : il ne contient pas le motif. */
const FOREIGN_VIEW_TYPE = 'claudemanagerC4NotAConversation';

/** Une poignee bien formee que cette fenetre n'a JAMAIS emise. */
const NEVER_ISSUED = '00000000-0000-4000-8000-0000000c4c4c';

interface Listed {
  readonly id: string;
  readonly label: string;
  readonly viewType: string;
  readonly viewColumn: number;
  readonly indexInGroup: number;
  readonly isActive: boolean;
}

function allTabs(): readonly vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function webviewTabLabels(): readonly string[] {
  return allTabs()
    .filter((tab) => tab.input instanceof vscode.TabInputWebview)
    .map((tab) => tab.label);
}

/** Le libelle de l'onglet ACTIF de la fenetre, ou `null` — releve, jamais provoque. */
function activeTabLabel(): string | null {
  return vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? null;
}

export async function runCloseConversation(context: ScenarioContext): Promise<void> {
  const { reportPath } = context;
  const report: Record<string, unknown> = {
    scenario: 'close-conversation',
    vscodeVersion: vscode.version,
  };
  // ECRIT MEME EN CAS D'ECHEC : une assertion qui leve doit laisser derriere elle ce qui a deja
  // ete mesure, sans quoi le diagnostic se fait a l'aveugle.
  const flush = (): void => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  /**
   * LES PANNEAUX CREES, RETENUS AVEC LE TITRE QU'ON LEUR A DONNE.
   *
   * ET C'EST UN ECUEIL MESURE, PAS UNE PRECAUTION : `panel.title` LEVE `Webview is disposed` des
   * que le panneau a ete ferme. Une premiere version cherchait le panneau a renommer par
   * `panels.find((p) => p.title === ...)` — la recherche traversait le panneau que la route venait
   * de fermer, et le scenario mourait sur cette lecture. Le titre est donc retenu ICI, hors du
   * panneau, et aucun chemin ne relit une propriete d'un panneau qui a pu partir.
   */
  const created: { readonly title: string; readonly panel: vscode.WebviewPanel }[] = [];
  const panels = (): readonly vscode.WebviewPanel[] => created.map((item) => item.panel);
  try {
    // ---- Le canal de CETTE fenetre, relu dans le registre ---------------------------------
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
    assert.equal(health.status, 200, 'the companion must answer /health before we ask it to act');
    report['companion'] = {
      extHostPid,
      extensionVersion: (JSON.parse(health.body) as { extensionVersion?: string }).extensionVersion,
    };
    flush();

    // ---- Les onglets : un temoin de TEXTE, deux conversations, une webview ETRANGERE -------
    //
    // `preserveFocus: true` partout : le principe fondateur n.1 ne s'arrete pas au harnais.
    const document = await vscode.workspace.openTextDocument({
      content: 'temoin de fermeture : cet onglet ne doit JAMAIS etre ferme',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });

    const create = (viewType: string, title: string): void => {
      created.push({
        title,
        panel: vscode.window.createWebviewPanel(
          viewType,
          title,
          { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
          {}
        ),
      });
    };

    // TROIS conversations, LE MEME `viewType` : le montage est aussi peu discriminant que le
    // reel, ou tous les panneaux Claude portent le meme (D2).
    for (const title of PROBE_TITLES) create(PROBE_VIEW_TYPE, title);
    // Une webview qui n'est PAS une conversation : elle ne doit jamais etre enumeree, et donc
    // jamais etre fermable. C'est la moitie de la garde qu'un `viewType` par egalite raterait.
    create(FOREIGN_VIEW_TYPE, 'Panneau etranger');

    await waitFor(
      'the four webview tabs to show up in tabGroups',
      () => (webviewTabLabels().length >= 4 ? true : undefined),
      15_000
    );
    const tabsBeforeListing = allTabs().length;

    // ---- Point 1 : l'enumeration, et son ABSENCE d'effet de bord ---------------------------
    const listing = await probe(entry.port, '/conversations', authorization);
    const listed = JSON.parse(listing.body) as { extHostPid: number; conversations: Listed[] };
    report['listing'] = {
      status: listing.status,
      // LE CORPS VERBATIM : c'est de lui que la fixture versionnee est tiree.
      body: mask(listing.body),
      tabsBefore: tabsBeforeListing,
      tabsAfter: allTabs().length,
      bodyCarriesToken: listing.body.includes(entry.token),
    };
    flush();

    assert.equal(listing.status, 200, `GET /conversations must succeed; got ${mask(listing.body)}`);
    assert.equal(listed.extHostPid, extHostPid, 'the answering window must be THIS one');
    assert.equal(
      listed.conversations.length,
      PROBE_TITLES.length,
      `only the conversation tabs may be enumerated; got ${listed.conversations.map((c) => c.label).join(', ')}`
    );
    // NI le temoin de texte, NI la webview etrangere : la reconnaissance est celle de D2.
    assert.ok(
      listed.conversations.every((c) => c.viewType.includes(CLAUDE_PANEL_VIEW_TYPE)),
      'every enumerated tab must be recognised by CONTAINS'
    );
    assert.ok(
      listed.conversations.every((c) => !c.viewType.includes(FOREIGN_VIEW_TYPE)),
      'the foreign webview must never be enumerated'
    );
    // Mesure : VSCode PREFIXE le viewType — une comparaison par egalite ne reconnaitrait rien.
    assert.ok(
      listed.conversations.every((c) => c.viewType !== PROBE_VIEW_TYPE),
      'measured: VSCode does not return the raw viewType'
    );
    // LE MEME `viewType` POUR TOUS, comme sur une vraie fenetre (D2) : il ne discrimine rien,
    // et c'est le fait a partir duquel la poignee est concue.
    assert.equal(
      new Set(listed.conversations.map((c) => c.viewType)).size,
      1,
      'the probe panels must be as indistinguishable as the real ones'
    );
    // AUCUN EFFET DE BORD : le compte d'onglets est identique de part et d'autre de l'appel.
    assert.equal(allTabs().length, tabsBeforeListing, 'a read route may not touch any tab');
    // Une poignee DISTINCTE par onglet.
    assert.equal(
      new Set(listed.conversations.map((c) => c.id)).size,
      listed.conversations.length,
      'each tab must carry its own handle'
    );

    // ---- Point 5 : l'onglet ACTIF, releve avant toute fermeture ----------------------------
    const activeBefore = activeTabLabel();
    /**
     * ─────────────────────────────────────────────────────────────────────────────────────
     * ON FERME CELLE DU MILIEU, ET LE CHOIX EST LA CORRECTION D'UN ANGLE MORT.
     *
     * Ce scenario fermait le DERNIER onglet — le seul cas ou aucun voisin ne vient occuper la
     * coordonnee liberee, donc le seul ou le defaut G1 ne peut pas se produire. Il ferme
     * desormais un onglet QUI A UN VOISIN de chaque cote :
     *
     *   - `after` GLISSE sur la coordonnee de la cible, et ce glissement est ce qui rendait le
     *     voisin indiscernable du disparu — les etapes 4a et 4b l'exploitent jusqu'au bout ;
     *   - `before` ne bouge pas : il sert de temoin de conversation, comme le temoin de texte ;
     *   - la cible N'EST PAS l'onglet actif — la webview etrangere l'est, creee en dernier —, ce
     *     qui est la seule facon d'observer `preserveFocus` de l'interieur : fermer l'onglet
     *     ACTIF obligerait forcement l'editeur a en activer un autre.
     * ─────────────────────────────────────────────────────────────────────────────────────
     */
    const ordered = [...listed.conversations].sort((a, b) => a.indexInGroup - b.indexInGroup);
    const [before, target, after] = ordered;
    assert.ok(before && target && after, 'the three conversation tabs must be identifiable');
    assert.notEqual(target.label, activeBefore, 'the target must NOT be the active tab');
    assert.equal(after.indexInGroup, target.indexInGroup + 1, 'the neighbour must be adjacent');

    // ---- Points 2 et 3 : la fermeture retire CELUI-LA, et l'enumeration fait foi ------------
    const closing = await postJson(entry.port, '/conversations/close', { id: target.id }, authorization);
    const closed = JSON.parse(closing.body) as Record<string, unknown>;
    report['closing'] = {
      status: closing.status,
      body: mask(closing.body),
      bodyCarriesToken: closing.body.includes(entry.token),
      activeTabBefore: activeBefore,
      activeTabAfter: activeTabLabel(),
      webviewTabsAfter: webviewTabLabels(),
    };
    flush();

    assert.equal(closing.status, 200, `the close must succeed; got ${mask(closing.body)}`);
    assert.equal(closed['extHostPid'], extHostPid, 'the acting window must be THIS one');
    assert.equal((closed['closed'] as Listed).id, target.id, 'the closed tab must be the designated one');
    assert.equal(closed['remaining'], PROBE_TITLES.length - 1, 'exactly one tab must have gone');
    // L'ONGLET A REELLEMENT QUITTE `tabGroups` — la route ne rend un succes qu'apres l'avoir
    // constate, et on le reconstate ici, de l'exterieur de la route.
    assert.ok(
      !webviewTabLabels().includes(target.label),
      `the closed tab must have left tabGroups; still there: ${webviewTabLabels().join(', ')}`
    );
    // ET AUCUN AUTRE : les deux voisins, la webview etrangere et le temoin de texte survivent.
    assert.ok(webviewTabLabels().includes(before.label), 'the tab BEFORE must survive');
    assert.ok(webviewTabLabels().includes(after.label), 'the tab AFTER must survive');
    assert.ok(webviewTabLabels().includes('Panneau etranger'), 'the foreign webview must survive');
    assert.ok(
      allTabs().some((tab) => tab.input instanceof vscode.TabInputText),
      'the text witness must survive'
    );

    // ---- Point 5 : le focus n'a pas bouge --------------------------------------------------
    assert.equal(
      activeTabLabel(),
      activeBefore,
      'closing a NON-active tab must not change which tab is active'
    );

    // ---- Point 4 : les quatre formes de poignee perimee, et AUCUN effet de bord ------------
    //
    // Le panneau est retrouve par le titre RETENU, jamais par `panel.title` : lire cette
    // propriete sur un panneau que la route vient de fermer LEVE `Webview is disposed`.
    const panelTitled = (title: string): vscode.WebviewPanel => {
      const found = created.find((item) => item.title === title);
      assert.ok(found, `the panel titled ${title} must be identifiable`);
      return found.panel;
    };
    const renameTo = async (panel: vscode.WebviewPanel, title: string): Promise<void> => {
      panel.title = title;
      await waitFor(
        `the renamed tab label ${title} to be visible in tabGroups`,
        () => (webviewTabLabels().includes(title) ? true : undefined),
        15_000
      );
    };

    const tabsBeforeRefusals = allTabs().length;
    /**
     * LE PANNEAU SURVIVANT, RETENU UNE FOIS — et jamais recherche par son libelle courant.
     *
     * `panelTitled` cherche par le titre DONNE A LA CREATION, qui ne suit pas les renommages :
     * apres l'etape 4b, le libelle courant du survivant est celui d'un panneau DEJA FERME, et le
     * chercher ainsi rendrait ce panneau-la — dont toute lecture leve `Webview is disposed`.
     */
    const survivorPanel = panelTitled(after.label);

    /**
     * (4a) LA RELANCE — le premier des deux scenarios du gate final, sur de VRAIS onglets.
     *
     * Le voisin a GLISSE sur la coordonnee de la cible ; on le RENOMME du libelle du disparu.
     * Il porte alors, dans ses QUATRE champs releves, exactement la poignee du mort. Avant le
     * correctif, cette relance — que la remediation prescrivait comme sure — le fermait, et
     * fermer un onglet TUE le `claude.exe` de sa session.
     */
    await renameTo(survivorPanel, target.label);
    const again = await postJson(entry.port, '/conversations/close', { id: target.id }, authorization);

    /**
     * (4b) LA FERMETURE A LA MAIN — le second scenario, et la poignee n'a JAMAIS servi.
     *
     * L'humain ferme lui-meme l'onglet qui precede, entre les deux temps du contrat. Le voisin
     * glisse a nouveau, cette fois sur la coordonnee de CELUI-LA, et on le renomme de meme. La
     * poignee presentee est celle du disparu, et elle est INTACTE — aucune regle de « poignee
     * depensee » ne la couvre. Avant le correctif, elle fermait le voisin en rendant `ok: true`.
     */
    const closedByHand = before.label;
    panelTitled(closedByHand).dispose();
    await waitFor(
      'the hand-closed tab to leave tabGroups',
      () => (webviewTabLabels().includes(closedByHand) ? undefined : true),
      15_000
    );
    await renameTo(survivorPanel, closedByHand);
    const slid = await postJson(entry.port, '/conversations/close', { id: before.id }, authorization);

    // (4c) une poignee bien formee que cette fenetre n'a jamais emise.
    const unknown = await postJson(entry.port, '/conversations/close', { id: NEVER_ISSUED }, authorization);

    /**
     * (4d) LE LIBELLE A CHANGE SUR PLACE — c'est ce que fait la vraie extension Claude quelques
     * centaines de millisecondes apres l'attachement (D24), et c'est le cas qui justifie tout le
     * dispositif de verification.
     *
     * IL EXIGE UNE POIGNEE FRAICHE, et c'est le point : « sur place » veut dire que l'onglet n'a
     * PAS bouge depuis l'enumeration. Les etapes 4a et 4b viennent de le deplacer deux fois ; une
     * poignee d'avant ferait porter le refus sur l'ARRANGEMENT, pas sur le libelle. On reliste
     * donc, puis on renomme sans rien deplacer : le seul champ qui change est le libelle.
     */
    const beforeRename = (
      JSON.parse((await probe(entry.port, '/conversations', authorization)).body) as {
        conversations: Listed[];
      }
    ).conversations;
    assert.equal(beforeRename.length, 1, 'one conversation must remain before the rename');
    const inPlace = beforeRename[0] as Listed;
    await renameTo(survivorPanel, 'Libelle change en cours de route');
    const stale = await postJson(entry.port, '/conversations/close', { id: inPlace.id }, authorization);

    const tabsAfterRefusals = allTabs().length;
    report['refusals'] = {
      spentHandleOnSlidNeighbour: { status: again.status, body: mask(again.body) },
      unusedHandleOnSlidNeighbour: { status: slid.status, body: mask(slid.body) },
      neverIssued: { status: unknown.status, body: mask(unknown.body) },
      labelChanged: { status: stale.status, body: mask(stale.body) },
      // Le compte d'AVANT est celui d'avant la fermeture a la main : c'est le seul onglet que
      // ces etapes retirent, et il est retire par l'HUMAIN, jamais par la route.
      tabsBefore: tabsBeforeRefusals,
      tabsAfter: tabsAfterRefusals,
      webviewTabsAfter: webviewTabLabels(),
    };
    flush();

    assert.equal(again.status, 500, 'a SPENT handle must be REFUSED');
    // ETABLI POSITIVEMENT, et c'est mieux qu'une deduction : la fenetre se souvient d'avoir
    // ferme cet onglet. Sans cette memoire, elle verrait le voisin renomme a la coordonnee
    // relevee et conclurait qu'il EST l'onglet designe.
    assert.equal(
      (JSON.parse(again.body) as { error?: string }).error,
      'CONVERSATION_ALREADY_CLOSED',
      `got ${mask(again.body)}`
    );
    assert.equal(slid.status, 500, 'an unused handle whose neighbour slid in must be REFUSED');
    assert.equal(
      (JSON.parse(slid.body) as { error?: string }).error,
      'CONVERSATION_HANDLE_STALE',
      `got ${mask(slid.body)}`
    );
    assert.equal(unknown.status, 500, 'a handle this window never issued must be REFUSED');
    assert.equal(
      (JSON.parse(unknown.body) as { error?: string }).error,
      'CONVERSATION_HANDLE_STALE',
      `got ${mask(unknown.body)}`
    );
    assert.equal(stale.status, 500, 'a tab whose label changed must be REFUSED');
    assert.equal(
      (JSON.parse(stale.body) as { error?: string }).error,
      'CONVERSATION_HANDLE_STALE',
      `got ${mask(stale.body)}`
    );
    // LE POINT DES QUATRE REFUS : le SEUL onglet parti est celui que l'humain a ferme lui-meme.
    assert.equal(tabsAfterRefusals, tabsBeforeRefusals - 1, 'a refused close must not close a tab');
    assert.ok(
      webviewTabLabels().includes('Libelle change en cours de route'),
      'the slid neighbour must have survived all four refusals'
    );

    // ---- Et une poignee FRAICHE ferme ce que la perimee n'a pas ferme ----------------------
    //
    // C'est le contrat en DEUX TEMPS, joue jusqu'au bout : relister, puis fermer.
    const relisting = await probe(entry.port, '/conversations', authorization);
    const relisted = (JSON.parse(relisting.body) as { conversations: Listed[] }).conversations;
    assert.equal(relisted.length, 1, 'exactly one conversation must remain to be relisted');
    const fresh = relisted[0] as Listed;
    // NEUVE, et pour DEUX raisons cumulees : le libelle a change, et l'arrangement des
    // conversations aussi — aucune poignee des enumerations precedentes ne pouvait donc etre
    // reattribuee a cet onglet.
    for (const previous of [...ordered, inPlace]) {
      assert.notEqual(fresh.id, previous.id, 'the relisted tab must have been given a NEW handle');
    }

    const finalClose = await postJson(entry.port, '/conversations/close', { id: fresh.id }, authorization);
    report['afterRelisting'] = {
      relistedLabel: fresh.label,
      handleChanged: [...ordered, inPlace].every((previous) => previous.id !== fresh.id),
      status: finalClose.status,
      body: mask(finalClose.body),
    };
    flush();
    assert.equal(finalClose.status, 200, `a FRESH handle must close; got ${mask(finalClose.body)}`);
    assert.equal((JSON.parse(finalClose.body) as { remaining?: number }).remaining, 0);
    assert.ok(
      !webviewTabLabels().includes(fresh.label),
      'the relisted tab must have left tabGroups too'
    );
    // La webview etrangere et le temoin de texte sont TOUJOURS la, apres deux fermetures.
    assert.ok(webviewTabLabels().includes('Panneau etranger'), 'the foreign webview must still be there');
    assert.ok(
      allTabs().some((tab) => tab.input instanceof vscode.TabInputText),
      'the text witness must still be there'
    );

    // ---- L'etat FINAL de la fenetre : plus aucune conversation, et ce n'est pas une erreur ---
    //
    // Cette enumeration-la est CAPTUREE : une liste vide est l'etat le plus ordinaire d'une
    // fenetre, et un client qui la refuserait casserait dessus. La fixture versionnee la porte.
    const emptyListing = await probe(entry.port, '/conversations', authorization);
    report['emptyListing'] = { status: emptyListing.status, body: mask(emptyListing.body) };
    flush();
    assert.equal(emptyListing.status, 200, 'listing an empty window must succeed');
    assert.deepEqual(
      (JSON.parse(emptyListing.body) as { conversations: Listed[] }).conversations,
      [],
      'no conversation may remain'
    );

    // ---- Point 6 : aucune reponse ne porte le jeton -----------------------------------------
    const bodies = [listing, closing, again, slid, unknown, stale, relisting, finalClose, emptyListing];
    const tokenInAnyResponse = bodies.some((reply) => reply.body.includes(entry.token));
    report['tokenInAnyResponse'] = tokenInAnyResponse;
    assert.equal(tokenInAnyResponse, false, 'no response may carry the token');

    report['ok'] = true;
  } catch (error) {
    report['ok'] = false;
    report['failure'] = error instanceof Error ? `${error.name}: ${mask(error.message)}` : String(error);
    flush();
    throw error;
  } finally {
    // HYGIENE : on ne laisse pas derriere nous les panneaux qu'on a crees. `dispose` est la voie
    // de l'AUTEUR d'un panneau, pas celle du produit — la fermeture, elle, passe par la route.
    for (const panel of panels()) {
      try {
        panel.dispose();
      } catch {
        // Un panneau deja ferme par la route : c'est le cas nominal, et il n'a rien a signaler.
      }
    }
    flush();
  }
}
