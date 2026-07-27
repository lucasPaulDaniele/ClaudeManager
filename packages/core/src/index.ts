export {
  ClaudeManagerError,
  ERROR_CODES,
  isClaudeManagerError,
  isErrorCode,
  systemErrorCode,
  type ErrorCode,
  type SerializedError,
} from './errors.js';

/**
 * CE FICHIER EST LE CONTRAT, ET IL S'EST RESSERRE (V2-12).
 *
 * Six symboles y figuraient sans aucun consommateur hors des tests :
 * `measureCommandLineBudget`, `quotedArgumentCost`, `WINDOWS_COMMAND_LINE_LIMIT`,
 * `COMMAND_LINE_SAFETY_MARGIN`, `HEALTH_TIMEOUT_MS` et `OPEN_TIMEOUT_MS`. Ce n'est pas une
 * question de rangement : `packages/vscode/src/core.ts` fait `export *` de ce fichier, si bien
 * que TOUT ce qui entre ici devient surface publique de l'extension aussi. Ils restent exportes
 * de LEUR module — les tests les y prennent directement, ce qui dit d'ailleurs mieux ce qu'ils
 * sont : des details internes eprouves, pas une promesse faite a un appelant.
 */
export {
  assertCommandLineFits,
  type CommandLineBudget,
  type CommandLineDraft,
} from './commandLine.js';

export { ancestorsOf } from './identity/ancestry.js';
export {
  parsePosixProcessTable,
  parseWindowsProcessTable,
  type ProcessSnapshot,
  type ProcessTable,
} from './identity/processTable.js';
export {
  readProcessTable,
  type CommandRunner,
  type ReadProcessTableOptions,
} from './identity/processTable.node.js';
export {
  requireOwningWindow,
  resolveOwningWindow,
  type WindowLike,
} from './identity/owningWindow.js';

export {
  parseWindowEntry,
  WINDOW_ENTRY_SCHEMA_VERSION,
  type EntryIdentity,
  type EntryRejectionReason,
  type ParseResult,
  type WindowEntry,
  type WindowEntryAccepted,
  type WindowEntryRejected,
} from './registry/entry.js';
export {
  maskHomeDirectory,
  redactWindowEntry,
  type RedactedWindowEntry,
} from './registry/redaction.node.js';
/**
 * LES BORNES DE LA FERMETURE ET DU CORPS Y FIGURENT DEPUIS LA CORRECTION DU GATE FINAL, et elles
 * respectent la regle du fichier : chacune a un consommateur HORS des tests. Les trois budgets
 * sont lus par `packages/vscode/src/tabs.ts` (a travers `./core.js`) et par le calcul de delai de
 * `conversations.node.ts` ; `MAX_BODY_BYTES` l'est par le serveur de la fenetre et par le
 * transport du client. C'est ce qui empeche les deux cotes de diverger en silence.
 *
 * `WINDOW_CLOSE_BUDGET_MS` n'y figure PAS : sa somme n'est lue que par le calcul de delai du
 * client, qui la prend a son module. Un symbole sans consommateur hors des tests n'entre pas
 * dans ce contrat (V2-12).
 */
export {
  CLOSE_CALL_BUDGET_MS,
  CLOSE_CONFIRMATION_BUDGET_MS,
  CLOSE_POLL_INTERVAL_MS,
  CLOSE_ROUTE,
  CONVERSATION_CLOSE_PATH,
  CONVERSATION_HANDLE_SHAPE,
  CONVERSATIONS_PATH,
  HEALTH_PATH,
  HEALTH_ROUTE,
  LIST_ROUTE,
  MAX_BODY_BYTES,
  OPEN_ROUTE,
  readClosedConversation,
  readHealth,
  readOpenedConversation,
  readWindowConversations,
  type ClosedConversation,
  type FirstTurnOutcome,
  type ListedConversation,
  type OpenedConversation,
  type OpenMode,
  type WindowConversations,
  type WindowHealth,
  type WindowRequest,
  type WindowResponse,
  type WindowTransport,
} from './client/protocol.js';
export { createLoopbackTransport } from './client/loopback.node.js';
/**
 * Les types du CANAL viennent de leur propre module depuis C4 — trois commandes les partagent.
 * `HEALTH_TIMEOUT_MS`, lui, reste hors du contrat : c'est un detail interne eprouve, que les
 * tests prennent a son module (V2-12).
 */
export {
  type ChannelConfirmation,
  type RegistryReport,
  type WindowChannelOptions,
} from './client/channel.node.js';
export {
  assertSubmittablePrompt,
  openConversationInWindow,
  type ConversationOpening,
  type OpenConversationInWindowOptions,
  type OpenConversationRequest,
} from './client/openConversation.node.js';
export {
  assertConversationHandle,
  closeConversationInWindow,
  listConversationsInWindow,
  type CloseConversationOptions,
  type CloseConversationRequest,
  type ConversationClosing,
  type ConversationsListing,
  type ListConversationsOptions,
} from './client/conversations.node.js';

export {
  purgeStaleEntries,
  readRegistry,
  resolveRegistryDir,
  windowEntryFileName,
  windowEntryPath,
  writeWindowEntry,
  type KeptEntry,
  type KeptReason,
  type PurgeResult,
  type PurgeStaleEntriesOptions,
  type ReadRegistryOptions,
  type RegistryReadResult,
  type SkipReason,
  type SkippedEntry,
  type WriteWindowEntryOptions,
} from './registry/store.node.js';
