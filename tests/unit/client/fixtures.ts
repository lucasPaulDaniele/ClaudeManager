/**
 * Montage des tests du client HTTP du coeur.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * AUCUN FAUX `http`, AUCUN FAUX SERVEUR (principe fondateur n.5). Le client est eprouve
 * contre :
 *
 *   - le VRAI serveur local de l'extension compagnon (`packages/vscode/src/server.ts`, qui
 *     n'importe pas `vscode`), sur une VRAIE socket de boucle locale — c'est lui qui produit
 *     les 401, 403, 404 et les reponses de succes ;
 *   - de VRAIES reponses CAPTUREES (`tests/fixtures/client/companion-responses.json`), relevees
 *     le 2026-07-26 par `npm run test:integration` dans une vraie fenetre VSCode ;
 *   - un VRAI `http.createServer` nu pour les seuls cas que notre serveur ne peut pas produire
 *     — un corps illisible, un occupant du port qui ne repond jamais.
 *
 * CE QUI EST ADAPTE DE LA CAPTURE, ET RIEN D'AUTRE : les `extHostPid` / `mainPid`. La capture
 * decrit la fenetre du poste de mesure ; les tests, eux, travaillent sur la table des processus
 * REELLE capturee en B1, dont les pid sont ceux-la. La FORME vient donc de la capture, les
 * IDENTITES du scenario — et c'est exactement ce qu'il faut, puisque c'est la confrontation des
 * identites qu'on eprouve.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  OpenConversationRequest,
  OpenConversationResult,
} from '../../../packages/vscode/src/conversations.js';
import { startServer, type HealthPayload } from '../../../packages/vscode/src/server.js';
import {
  createConversationRoutes,
  type ConversationRoutes,
  type ConversationTabLike,
  type ConversationTabsPort,
} from '../../../packages/vscode/src/tabs.js';
import {
  writeWindowEntry,
  type ProcessSnapshot,
  type WindowEntry,
} from '../../../packages/core/src/index.js';
import { WINDOWS_ROLES } from '../identity/fixtures.js';
import {
  copyLegacyEntriesInto,
  currentSchemaEntry,
  makeRegistryDir,
  REAL_TABLE,
  snapshotOf,
} from '../registry/fixtures.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'client',
  'companion-responses.json'
);

interface CapturedExchange {
  readonly status: number;
  readonly body: string;
}

interface CapturedResponses {
  readonly health: CapturedExchange;
  readonly refusals: Readonly<Record<string, CapturedExchange>>;
  readonly openSeeded: { readonly status: number; readonly result: Record<string, unknown> };
  /**
   * La MEME route, telle qu'une fenetre PLUS ANCIENNE la rend — `firstTurn: 'process-started'`,
   * `firstTurnVerified: false`. Elle n'est pas la pour l'archive : la fenetre et la CLI vivent
   * dans deux processus mis a jour separement, et le client doit lire cette reponse sans casser.
   */
  readonly openSeededLegacy: { readonly status: number; readonly result: Record<string, unknown> };
  readonly openFallback: { readonly status: number; readonly result: Record<string, unknown> };
  /** Les captures de C4 — corps VERBATIM des deux routes nouvelles, et de leurs deux refus. */
  readonly listConversations: CapturedExchange;
  readonly listConversationsEmpty: CapturedExchange;
  readonly closeConversation: CapturedExchange;
  /**
   * LES TROIS REFUS CAPTURES, et les deux premiers sont ceux du defaut G1 : avant la correction
   * du gate final, ils fermaient la conversation du VOISIN au lieu de refuser.
   */
  readonly closeRefusals: {
    readonly alreadyClosed: CapturedExchange;
    readonly handleStale: CapturedExchange;
    readonly handleStaleLabelChanged: CapturedExchange;
  };
}

export const CAPTURED: CapturedResponses = JSON.parse(
  readFileSync(FIXTURE, 'utf8')
) as CapturedResponses;

/** Le corps de `/health` REELLEMENT rendu par une fenetre, relu. */
export const CAPTURED_HEALTH = JSON.parse(CAPTURED.health.body) as HealthPayload & {
  readonly listenAddress: string;
};

/** La fenetre que la table capturee de B1 revendique pour le processus appelant. */
export const OWNING_EXT_HOST_PID = WINDOWS_ROLES.owningExtHostPid;
export const CALLER_PID = WINDOWS_ROLES.callerClaudePid;

export function snapshot(): ProcessSnapshot {
  return snapshotOf(REAL_TABLE);
}

/**
 * La charge de `/health` de la capture, RECALEE sur l'identite du scenario.
 *
 * Seuls `extHostPid` et `mainPid` changent : tout le reste — `schemaVersion`,
 * `extensionVersion`, `isTrusted`, `workspaceFolders`, `logDirectory` — vient de la fenetre
 * reelle. `listenAddress` n'y figure pas : le serveur le releve lui-meme sur sa socket, et
 * c'est bien ce qu'on veut mesurer.
 */
export function healthPayloadFor(entry: WindowEntry): HealthPayload {
  return {
    ok: true,
    schemaVersion: CAPTURED_HEALTH.schemaVersion,
    extensionVersion: CAPTURED_HEALTH.extensionVersion,
    isTrusted: CAPTURED_HEALTH.isTrusted,
    workspaceFolders: CAPTURED_HEALTH.workspaceFolders,
    logDirectory: CAPTURED_HEALTH.logDirectory,
    // Les DEUX seuls champs recales : la capture decrit la fenetre du poste de mesure, les
    // tests travaillent sur la table des processus capturee en B1.
    extHostPid: entry.extHostPid,
    mainPid: entry.mainPid,
  };
}

/** Le resultat d'ouverture CAPTURE, recale sur la fenetre du scenario. */
export function seededResultFor(entry: WindowEntry): OpenConversationResult {
  return {
    ...CAPTURED.openSeeded.result,
    extHostPid: entry.extHostPid,
  } as unknown as OpenConversationResult;
}

/** Le MEME resultat, tel qu'une fenetre trop ancienne pour verifier le tour le rend. */
export function legacySeededResultFor(entry: WindowEntry): OpenConversationResult {
  return {
    ...CAPTURED.openSeededLegacy.result,
    extHostPid: entry.extHostPid,
  } as unknown as OpenConversationResult;
}

export function fallbackResultFor(entry: WindowEntry): OpenConversationResult {
  return {
    ...CAPTURED.openFallback.result,
    extHostPid: entry.extHostPid,
  } as unknown as OpenConversationResult;
}

/** Le `viewType` REELLEMENT releve sur un panneau Claude — VSCode prefixe (D2, mesure C1). */
export const CLAUDE_VIEW_TYPE = 'mainThreadWebview-claudeVSCodePanel';

/** Un onglet de conversation, tel que l'adaptateur de l'extension en produit. */
export function conversationTab(
  label: string,
  partial: Partial<ConversationTabLike> = {}
): ConversationTabLike {
  return {
    viewType: CLAUDE_VIEW_TYPE,
    label,
    viewColumn: 1,
    indexInGroup: 0,
    isActive: false,
    ...partial,
  };
}

/** Renumerote les onglets par groupe, comme l'editeur le fait apres une fermeture. */
export function reindexed(
  tabs: readonly ConversationTabLike[]
): readonly ConversationTabLike[] {
  const ranks = new Map<number, number>();
  return tabs.map((item) => {
    const rank = ranks.get(item.viewColumn) ?? 0;
    ranks.set(item.viewColumn, rank + 1);
    return { ...item, indexInGroup: rank };
  });
}

export interface Companion {
  readonly entry: WindowEntry;
  readonly registryDir: string;
  readonly token: string;
  readonly port: number;
  /** Les prompts REELLEMENT recus par la route, dans l'ordre. */
  readonly received: readonly string[];
  /**
   * Les onglets que la fenetre porte — MODIFIABLES en cours de scenario.
   *
   * C'est ce qui permet d'eprouver la peremption d'une poignee de bout en bout : un libelle qui
   * change entre l'enumeration et la fermeture est exactement ce que la vraie extension Claude
   * fait quelques centaines de millisecondes apres l'attachement (D24).
   */
  tabs: readonly ConversationTabLike[];
  /** Ce que la route de fermeture a REELLEMENT demande a l'editeur. */
  readonly closed: readonly ConversationTabLike[];
  close(): Promise<void>;
}

export interface CompanionOptions {
  /** Ce que la route d'ouverture rend — ou leve. Defaut : le resultat `seeded` capture. */
  readonly open?: (entry: WindowEntry, request: OpenConversationRequest) => Promise<OpenConversationResult>;
  /** La charge de `/health`. Defaut : celle de la capture, recalee. */
  readonly health?: (entry: WindowEntry) => HealthPayload;
  /** Registre a reutiliser — sinon un neuf est cree. */
  readonly registryDir?: string;
  /** Identite publiee dans l'entree. Defaut : la fenetre hote de la table capturee. */
  readonly extHostPid?: number;
  /** Les onglets que la fenetre porte au depart. Defaut : aucun. */
  readonly tabs?: readonly ConversationTabLike[];
  /**
   * Les deux routes de conversation, REMPLACEES — pour les seuls cas que la vraie logique ne
   * peut pas produire : une fenetre qui rend un corps illisible, ou un `extHostPid` qui n'est
   * pas le sien. Defaut : les VRAIES routes (`createConversationRoutes`).
   */
  readonly conversations?: (entry: WindowEntry) => ConversationRoutes;
}

/**
 * Un VRAI serveur compagnon sur la boucle locale, et l'entree de registre qui le designe.
 *
 * L'entree est ecrite par `writeWindowEntry` — le vrai chemin de publication —, derivee de la
 * capture 0.1.0 reelle et recalee sur le port et le jeton du serveur qui vient de demarrer.
 * Rien n'est depose a la main dans le repertoire.
 */
export async function startCompanion(options: CompanionOptions = {}): Promise<Companion> {
  const registryDir = options.registryDir ?? makeRegistryDir();
  const token = randomUUID();
  const received: string[] = [];
  const closed: ConversationTabLike[] = [];

  // L'entree definitive ne peut etre ecrite qu'une fois le port connu : on la construit en
  // deux temps, le serveur ne connaissant son port qu'apres avoir ecoute.
  const draft = currentSchemaEntry(options.extHostPid ?? OWNING_EXT_HOST_PID);

  /**
   * Le PORT DES ONGLETS de cette fenetre de test — le meme role que celui d'`extension.ts`.
   *
   * Les VRAIES routes de conversation tournent derriere le VRAI serveur, sur une VRAIE socket :
   * ce que les tests du client traversent est donc la chaine complete, poignees comprises. Seule
   * l'API `vscode` est absente, parce qu'elle n'est pas ce qu'on eprouve ici.
   */
  const state: { tabs: readonly ConversationTabLike[] } = { tabs: options.tabs ?? [] };
  const tabsPort: ConversationTabsPort<ConversationTabLike> = {
    listTabs: () => state.tabs,
    closeTab: (target) => {
      closed.push(target);
      // IL REINDEXE, COMME L'EDITEUR — correction d'un angle mort du gate final : fermer un
      // onglet fait GLISSER d'un rang tous ceux qui le suivent dans son groupe. Un double qui
      // laisse les rangs inchanges ment sur le seul point ou la fermeture peut se tromper de
      // conversation.
      state.tabs = reindexed(state.tabs.filter((item) => item !== target));
      return Promise.resolve(true);
    },
  };

  const handle = await startServer({
    token,
    health: () => (options.health ?? healthPayloadFor)(published),
    openConversation: async (request) => {
      received.push(request.prompt);
      return await (options.open ?? ((entry) => Promise.resolve(seededResultFor(entry))))(
        published,
        request
      );
    },
    listConversations: () => routes.list(),
    closeConversation: (request) => routes.close(request),
    onError: () => undefined,
    onClosed: () => undefined,
  });

  const published: WindowEntry = { ...draft, port: handle.port, token };
  const routes: ConversationRoutes =
    options.conversations?.(published) ??
    createConversationRoutes({
      port: tabsPort,
      extHostPid: published.extHostPid,
      log: () => undefined,
      wait: () => Promise.resolve(),
    });
  writeWindowEntry(published, { dir: registryDir });

  return {
    entry: published,
    registryDir,
    token,
    port: handle.port,
    received,
    closed,
    get tabs(): readonly ConversationTabLike[] {
      return state.tabs;
    },
    set tabs(value: readonly ConversationTabLike[]) {
      state.tabs = value;
    },
    close: () => handle.close(),
  };
}

export interface RawServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Un `http.createServer` NU — pour les seuls cas que le vrai serveur ne peut pas produire.
 *
 * Deux, et ils sont nommes : un corps que personne ne saurait relire (une extension compagnon
 * d'une autre version), et un OCCUPANT DU PORT qui accepte la connexion sans jamais repondre —
 * exactement le cas de l'alerte n.41, quand la plage ephemere a ete reattribuee.
 */
export function startRawServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<RawServer> {
  const server: Server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Un port sur lequel PLUS RIEN n'ecoute : une ecoute ouverte, puis refermee. */
export async function deadPort(): Promise<number> {
  const server = await startRawServer(() => undefined);
  await server.close();
  return server.port;
}

/** Publie une entree qui designe un port et un jeton donnes, sous la fenetre hote. */
export function publishEntry(
  registryDir: string,
  port: number,
  token: string,
  extHostPid: number = OWNING_EXT_HOST_PID
): WindowEntry {
  const entry: WindowEntry = { ...currentSchemaEntry(extHostPid), port, token };
  writeWindowEntry(entry, { dir: registryDir });
  return entry;
}

export { copyLegacyEntriesInto, makeRegistryDir };
