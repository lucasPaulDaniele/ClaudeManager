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
 *   2. la fermeture retire CELUI-LA et AUCUN AUTRE : le second panneau et le temoin survivent ;
 *   3. le succes n'est rendu qu'apres que l'onglet a REELLEMENT quitte `tabGroups` ;
 *   4. une poignee PERIMEE est refusee sans rien fermer — trois formes : deja fermee, libelle
 *      change, jamais emise ;
 *   5. l'onglet ACTIF ne change pas quand on ferme un onglet qui ne l'est pas — c'est ce que
 *      `preserveFocus: true` achete, observable de l'interieur ;
 *   6. aucune reponse ne porte le jeton.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as vscode from 'vscode';
import { windowEntryPath, type WindowEntry } from '../../../../packages/core/src/index.js';
import { CLAUDE_PANEL_VIEW_TYPE } from '../../../../packages/vscode/src/seed.js';
import { mask } from '../redaction.js';
import { postJson, probe, waitFor, type ScenarioContext } from '../support.js';

/**
 * Les `viewType` que ce scenario enregistre lui-meme.
 *
 * Ils CONTIENNENT `claudeVSCodePanel` sans l'egaler, exactement comme le vrai : VSCode prefixe
 * le `viewType` d'une webview (`mainThreadWebview-…`, mesure du lot B), et la reconnaissance du
 * produit se fait par « contient » (D2). Deux panneaux, parce qu'un seul ne prouverait pas que
 * la fermeture ne touche que celui qu'on designe.
 */
const PROBE_VIEW_TYPES = [
  `${CLAUDE_PANEL_VIEW_TYPE}CloseProbeA`,
  `${CLAUDE_PANEL_VIEW_TYPE}CloseProbeB`,
] as const;

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

    for (const [index, viewType] of PROBE_VIEW_TYPES.entries()) {
      create(viewType, `Conversation ${String.fromCharCode(65 + index)}`);
    }
    // Une webview qui n'est PAS une conversation : elle ne doit jamais etre enumeree, et donc
    // jamais etre fermable. C'est la moitie de la garde qu'un `viewType` par egalite raterait.
    create(FOREIGN_VIEW_TYPE, 'Panneau etranger');

    await waitFor(
      'the three webview tabs to show up in tabGroups',
      () => (webviewTabLabels().length >= 3 ? true : undefined),
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
      2,
      `only the two conversation tabs may be enumerated; got ${listed.conversations.map((c) => c.label).join(', ')}`
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
      listed.conversations.every((c) => !PROBE_VIEW_TYPES.includes(c.viewType as never)),
      'measured: VSCode does not return the raw viewType'
    );
    // AUCUN EFFET DE BORD : le compte d'onglets est identique de part et d'autre de l'appel.
    assert.equal(allTabs().length, tabsBeforeListing, 'a read route may not touch any tab');
    // Deux poignees DISTINCTES pour deux onglets.
    assert.notEqual(
      listed.conversations[0]?.id,
      listed.conversations[1]?.id,
      'two tabs must carry two distinct handles'
    );

    // ---- Point 5 : l'onglet ACTIF, releve avant toute fermeture ----------------------------
    const activeBefore = activeTabLabel();
    /**
     * ─────────────────────────────────────────────────────────────────────────────────────
     * ON FERME LA DERNIERE DES DEUX CONVERSATIONS, ET LE CHOIX EST MESURE (2026-07-27).
     *
     * DEUX raisons, et la seconde a ete apprise en echouant :
     *
     *   - elle N'EST PAS l'onglet actif — la webview etrangere l'est, creee en dernier —, ce qui
     *     est la seule facon d'observer `preserveFocus` de l'interieur : fermer l'onglet ACTIF
     *     obligerait forcement l'editeur a en activer un autre ;
     *   - fermer un onglet fait GLISSER ses voisins d'un rang. En fermant celui de rang le plus
     *     eleve, aucune autre conversation ne vient occuper sa coordonnee, et une seconde
     *     fermeture avec la meme poignee sort donc en `CONVERSATION_ALREADY_CLOSED` — la
     *     disparition est etablie POSITIVEMENT. En fermant le premier, le voisin glisse sur sa
     *     place et la reponse est `CONVERSATION_HANDLE_STALE`, ce qui est juste aussi mais dit
     *     autre chose. Les deux etats sont eprouves : celui-ci ici, l'autre en unitaire
     *     (`tests/unit/vscode/tabs.test.ts`), ou l'on peut les provoquer tous les deux.
     * ─────────────────────────────────────────────────────────────────────────────────────
     */
    const ordered = [...listed.conversations].sort((a, b) => a.indexInGroup - b.indexInGroup);
    const target = ordered[ordered.length - 1];
    assert.ok(target, 'the last conversation tab must be identifiable');
    assert.notEqual(target.label, activeBefore, 'the target must NOT be the active tab');
    const survivor = ordered[0];
    assert.ok(survivor, 'the other conversation tab must be identifiable');
    assert.notEqual(survivor.id, target.id, 'the two conversation tabs must be distinct');

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
    assert.equal(closed['remaining'], 1, 'exactly one conversation tab must remain');
    // L'ONGLET A REELLEMENT QUITTE `tabGroups` — la route ne rend un succes qu'apres l'avoir
    // constate, et on le reconstate ici, de l'exterieur de la route.
    assert.ok(
      !webviewTabLabels().includes(target.label),
      `the closed tab must have left tabGroups; still there: ${webviewTabLabels().join(', ')}`
    );
    // ET AUCUN AUTRE : le second panneau, la webview etrangere et le temoin de texte survivent.
    assert.ok(webviewTabLabels().includes(survivor.label), 'the other conversation must survive');
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

    // ---- Point 4 : les trois formes de poignee perimee, et AUCUN effet de bord -------------
    const tabsBeforeRefusals = allTabs().length;

    // (a) la MEME poignee, sur un onglet deja parti.
    const again = await postJson(entry.port, '/conversations/close', { id: target.id }, authorization);
    // (b) une poignee bien formee que cette fenetre n'a jamais emise.
    const unknown = await postJson(entry.port, '/conversations/close', { id: NEVER_ISSUED }, authorization);
    // (c) LE LIBELLE A CHANGE SUR PLACE — c'est ce que fait la vraie extension Claude quelques
    //     centaines de millisecondes apres l'attachement (D24), et c'est le cas qui justifie
    //     tout le dispositif de verification.
    // Le panneau est retrouve par le titre RETENU, jamais par `panel.title` : lire cette
    // propriete sur le panneau que la route vient de fermer LEVE `Webview is disposed`.
    const renamed = created.find((item) => item.title === survivor.label);
    assert.ok(renamed, 'the surviving panel must be identifiable to be renamed');
    renamed.panel.title = 'Libelle change en cours de route';
    await waitFor(
      'the renamed tab label to be visible in tabGroups',
      () => (webviewTabLabels().includes('Libelle change en cours de route') ? true : undefined),
      15_000
    );
    const stale = await postJson(entry.port, '/conversations/close', { id: survivor.id }, authorization);

    report['refusals'] = {
      alreadyClosed: { status: again.status, body: mask(again.body) },
      neverIssued: { status: unknown.status, body: mask(unknown.body) },
      labelChanged: { status: stale.status, body: mask(stale.body) },
      tabsBefore: tabsBeforeRefusals,
      tabsAfter: allTabs().length,
    };
    flush();

    assert.equal(again.status, 500, 'closing an already closed tab must be REFUSED');
    // POSITIVEMENT etabli : aucune conversation n'a glisse sur la coordonnee de celle qu'on
    // vient de fermer, puisqu'elle etait la derniere. Voir le choix de la cible, plus haut.
    assert.equal(
      (JSON.parse(again.body) as { error?: string }).error,
      'CONVERSATION_ALREADY_CLOSED',
      `got ${mask(again.body)}`
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
    // LE POINT DES TROIS REFUS : rien n'a ete ferme.
    assert.equal(allTabs().length, tabsBeforeRefusals, 'a refused close must not touch any tab');

    // ---- Et une poignee FRAICHE ferme ce que la perimee n'a pas ferme ----------------------
    //
    // C'est le contrat en DEUX TEMPS, joue jusqu'au bout : relister, puis fermer.
    const relisting = await probe(entry.port, '/conversations', authorization);
    const relisted = (JSON.parse(relisting.body) as { conversations: Listed[] }).conversations;
    assert.equal(relisted.length, 1, 'exactly one conversation must remain to be relisted');
    const fresh = relisted[0] as Listed;
    assert.notEqual(fresh.id, survivor.id, 'the renamed tab must have been given a NEW handle');

    const finalClose = await postJson(entry.port, '/conversations/close', { id: fresh.id }, authorization);
    report['afterRelisting'] = {
      relistedLabel: fresh.label,
      handleChanged: fresh.id !== survivor.id,
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

    // ---- Point 6 : aucune reponse ne porte le jeton -----------------------------------------
    const bodies = [listing, closing, again, unknown, stale, relisting, finalClose];
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
