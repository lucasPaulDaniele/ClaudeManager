export {
  ClaudeManagerError,
  ERROR_CODES,
  isClaudeManagerError,
  systemErrorCode,
  type ErrorCode,
  type SerializedError,
} from './errors.js';

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
  purgeStaleEntries,
  readRegistry,
  resolveRegistryDir,
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
