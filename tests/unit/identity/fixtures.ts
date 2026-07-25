import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Racine des captures reelles. Voir `tests/fixtures/identity/README.md` pour leur provenance. */
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'identity'
);

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

/** Roles releves dans la capture Windows : qui est le claude.exe, qui est son extension host. */
export interface WindowsRoles {
  readonly provenance: { readonly command: string; readonly entryCount: number };
  readonly callerClaudePid: number;
  readonly owningExtHostPid: number;
  readonly mainCodePid: number;
  readonly otherExtHostPids: readonly number[];
  readonly expectedAncestry: readonly number[];
  readonly extensionHosts: readonly {
    readonly pid: number;
    readonly ppid: number;
    readonly inCallerChain: boolean;
  }[];
}

/** Provenance et reperes de la capture POSIX. */
export interface PosixRoles {
  readonly provenance: { readonly command: string; readonly args: readonly string[]; readonly lineCount: number };
  readonly rootPid: number;
  readonly usableEntryCount: number;
  readonly longestChain: { readonly from: number; readonly ancestors: readonly number[] };
}

export const WINDOWS_CAPTURE: string = readFixture('windows-process-table.csv');
export const POSIX_CAPTURE: string = readFixture('posix-process-table.txt');

export const WINDOWS_ROLES: WindowsRoles = JSON.parse(
  readFixture('windows-process-table.roles.json')
) as WindowsRoles;

export const POSIX_ROLES: PosixRoles = JSON.parse(
  readFixture('posix-process-table.roles.json')
) as PosixRoles;
