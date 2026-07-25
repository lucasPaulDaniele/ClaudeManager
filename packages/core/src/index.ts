export {
  ClaudeManagerError,
  ERROR_CODES,
  isClaudeManagerError,
  type ErrorCode,
  type SerializedError,
} from './errors.js';

export { ancestorsOf } from './identity/ancestry.js';
export {
  parsePosixProcessTable,
  parseWindowsProcessTable,
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
