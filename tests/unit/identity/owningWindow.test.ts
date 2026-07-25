import { describe, expect, it } from 'vitest';
import {
  ClaudeManagerError,
  ERROR_CODES,
  isClaudeManagerError,
  parseWindowsProcessTable,
  requireOwningWindow,
  resolveOwningWindow,
  type ProcessTable,
  type WindowLike,
} from '../../../packages/core/src/index.js';
import { WINDOWS_CAPTURE, WINDOWS_ROLES } from './fixtures.js';

/** Capture l'echec d'une operation, en echouant le test si elle ne leve pas. */
function catchFailure(operation: () => unknown): ClaudeManagerError {
  try {
    operation();
  } catch (error) {
    return error as ClaudeManagerError;
  }
  throw new Error("l'operation devait lever une ClaudeManagerError");
}

/** Une fenetre du registre telle que B2 la portera : identite + contexte non discriminant. */
interface RegisteredWindow extends WindowLike {
  readonly label: string;
  readonly workspacePath: string;
}

const TABLE: ProcessTable = parseWindowsProcessTable(WINDOWS_CAPTURE);
const CALLER = WINDOWS_ROLES.callerClaudePid;

describe("resolveOwningWindow — invariant d'isolation, sur des PID reels", () => {
  const host: RegisteredWindow = {
    extHostPid: WINDOWS_ROLES.owningExtHostPid,
    label: 'fenetre hote',
    workspacePath: '/ws-a',
  };
  const sibling: RegisteredWindow = {
    // extHostPid REEL de la capture, appartenant a l'autre fenetre ouverte au meme moment,
    // et enfant du meme Code.exe principal que `host`.
    extHostPid: WINDOWS_ROLES.otherExtHostPids[0] as number,
    label: 'autre fenetre',
    workspacePath: '/ws-b',
  };

  it('retient la fenetre hote et jamais sa voisine, quel que soit l ordre d enregistrement', () => {
    expect(resolveOwningWindow(CALLER, TABLE, [host, sibling])).toBe(host);
    expect(resolveOwningWindow(CALLER, TABLE, [sibling, host])).toBe(host);
  });

  it('ne revendique rien quand seule la voisine est enregistree', () => {
    expect(resolveOwningWindow(CALLER, TABLE, [sibling])).toBeUndefined();
  });

  it('ignore le Code.exe principal, partage par les deux fenetres', () => {
    // Piege n.4 : le processus principal figure bien dans la chaine, mais il ne designe
    // aucune fenetre. Seul un extHostPid peut faire identite.
    const main: RegisteredWindow = {
      extHostPid: WINDOWS_ROLES.mainCodePid,
      label: 'processus principal',
      workspacePath: '/ws-a',
    };

    // Il est dans la chaine, donc formellement resolvable — d'ou la regle du plus proche :
    // face a l'extension host reel, c'est ce dernier qui l'emporte.
    expect(resolveOwningWindow(CALLER, TABLE, [main, host])).toBe(host);
  });
});

describe("resolveOwningWindow — l'identite ne tient qu'a l'extHostPid", () => {
  it('discrimine deux fenetres portant le MEME chemin de workspace', () => {
    // Le scenario E2E de reference : deux fenetres sur le meme repertoire physique.
    const a: RegisteredWindow = {
      extHostPid: WINDOWS_ROLES.owningExtHostPid,
      label: 'A',
      workspacePath: '/meme/dossier',
    };
    const b: RegisteredWindow = {
      extHostPid: WINDOWS_ROLES.otherExtHostPids[0] as number,
      label: 'B',
      workspacePath: '/meme/dossier',
    };

    expect(resolveOwningWindow(CALLER, TABLE, [a, b])).toBe(a);
    expect(resolveOwningWindow(CALLER, TABLE, [b, a])).toBe(a);
  });

  it('ne departage pas par le chemin deux enregistrements de MEME extHostPid', () => {
    // Angle mort documente de la construction par jonction : deux chemins distincts pour
    // une meme fenetre. Aucun critere de chemin ne doit intervenir — le premier enregistre
    // gagne, et le resultat ne change pas quand seuls les chemins changent.
    const first: RegisteredWindow = {
      extHostPid: WINDOWS_ROLES.owningExtHostPid,
      label: 'premier',
      workspacePath: '/ws-a',
    };
    const second: RegisteredWindow = { ...first, label: 'second', workspacePath: '/ws-same' };

    expect(resolveOwningWindow(CALLER, TABLE, [first, second])).toBe(first);
    expect(resolveOwningWindow(CALLER, TABLE, [second, first])).toBe(second);
  });
});

describe('resolveOwningWindow — regles de resolution', () => {
  const table: ProcessTable = new Map([
    [100, 50],
    [50, 40],
    [40, 30],
  ]);

  it('resout le processus appelant lui-meme — le cas de l extension compagnon', () => {
    // L'extension compagnon EST l'extension host de sa fenetre : elle doit se reconnaitre
    // sans remonter d'un seul cran.
    const self: WindowLike = { extHostPid: 100 };

    expect(resolveOwningWindow(100, table, [self])).toBe(self);
  });

  it('retient la fenetre la PLUS PROCHE quand plusieurs ancetres sont enregistres', () => {
    const near: WindowLike = { extHostPid: 50 };
    const far: WindowLike = { extHostPid: 30 };

    expect(resolveOwningWindow(100, table, [near, far])).toBe(near);
    expect(resolveOwningWindow(100, table, [far, near])).toBe(near);
  });

  it('rend undefined sans lever : c est une requete, pas une operation', () => {
    expect(resolveOwningWindow(100, table, [])).toBeUndefined();
    expect(resolveOwningWindow(100, table, [{ extHostPid: 999 }])).toBeUndefined();
    expect(resolveOwningWindow(Number.NaN, table, [{ extHostPid: 50 }])).toBeUndefined();
  });
});

describe('requireOwningWindow', () => {
  it('rend la fenetre hote quand elle existe', () => {
    const host: WindowLike = { extHostPid: WINDOWS_ROLES.owningExtHostPid };

    expect(requireOwningWindow(CALLER, TABLE, [host])).toBe(host);
  });

  it('leve une erreur nommee, jamais un blanc silencieux', () => {
    const sibling: WindowLike = { extHostPid: WINDOWS_ROLES.otherExtHostPids[0] as number };

    expect(() => requireOwningWindow(CALLER, TABLE, [sibling])).toThrowError(
      /No registered window owns process/
    );

    const failure = catchFailure(() => requireOwningWindow(CALLER, TABLE, [sibling]));

    expect(isClaudeManagerError(failure)).toBe(true);
    expect(failure.code).toBe(ERROR_CODES.OWNING_WINDOW_NOT_FOUND);
    expect(failure.remediation.length).toBeGreaterThan(0);
    expect(failure.details).toEqual({
      callerPid: CALLER,
      chainLength: WINDOWS_ROLES.expectedAncestry.length + 1,
      registeredExtHostPids: [sibling.extHostPid],
    });
  });

  it('ne fait fuiter que des nombres dans ses details', () => {
    const failure = catchFailure(() => requireOwningWindow(CALLER, TABLE, []));

    const flat: unknown[] = [];
    for (const value of Object.values(failure.details ?? {})) {
      if (Array.isArray(value)) flat.push(...(value as unknown[]));
      else flat.push(value);
    }

    expect(flat.length).toBeGreaterThan(0);
    expect(flat.every((value) => typeof value === 'number')).toBe(true);
  });
});
