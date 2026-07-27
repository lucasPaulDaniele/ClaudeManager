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
export {
  CONVERSATIONS_PATH,
  HEALTH_PATH,
  HEALTH_ROUTE,
  OPEN_ROUTE,
  readHealth,
  readOpenedConversation,
  type FirstTurnOutcome,
  type OpenedConversation,
  type OpenMode,
  type WindowHealth,
  type WindowRequest,
  type WindowResponse,
  type WindowTransport,
} from './client/protocol.js';
export { createLoopbackTransport } from './client/loopback.node.js';
export {
  assertSubmittablePrompt,
  openConversationInWindow,
  type ChannelConfirmation,
  type ConversationOpening,
  type OpenConversationInWindowOptions,
  type OpenConversationRequest,
  type RegistryReport,
} from './client/openConversation.node.js';

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
