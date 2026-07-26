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
    // une meme fenetre. Aucun critere de chemin ne doit intervenir — et puisque aucun
    // critere legitime ne reste, il n y a rien a departager : l ambiguite est NOMMEE.
    // Laisser gagner l un des deux reviendrait a faire de l ordre d enumeration un
    // arbitre, c est-a-dire a offrir la victoire a qui choisit son nom de fichier.
    const first: RegisteredWindow = {
      extHostPid: WINDOWS_ROLES.owningExtHostPid,
      label: 'premier',
      workspacePath: '/ws-a',
    };
    const second: RegisteredWindow = { ...first, label: 'second', workspacePath: '/ws-same' };

    for (const order of [[first, second], [second, first]]) {
      const failure = catchFailure(() => resolveOwningWindow(CALLER, TABLE, order));

      expect(failure.code).toBe(ERROR_CODES.DUPLICATE_WINDOW_IDENTITY);
      // Les details ne portent ni chemin ni libelle : ils partent vers un agent.
      expect(failure.details).toEqual({
        extHostPid: WINDOWS_ROLES.owningExtHostPid,
        chainDepth: WINDOWS_ROLES.expectedAncestry.indexOf(WINDOWS_ROLES.owningExtHostPid) + 1,
      });
    }
  });
});

describe('resolveOwningWindow — regles de resolution', () => {
  const table: ProcessTable = new Map([
    [100, { ppid: 50, createdAt: undefined }],
    [50, { ppid: 40, createdAt: undefined }],
    [40, { ppid: 30, createdAt: undefined }],
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

  /**
   * C1 — LE VERDICT NE DOIT PAS DEPENDRE DE L'ORDRE D'ENUMERATION.
   *
   * L'ambiguite se lisait a l'egalite de PROFONDEUR avec la fenetre deja retenue, laquelle
   * n'etait mise a jour que par la branche « plus proche ». Deux fenetres de meme
   * extHostPid situees PLUS LOIN qu'une fenetre deja retenue n'etaient donc jamais
   * comparees entre elles : meme ensemble, trois ordres, deux verdicts. C'est exactement ce
   * que la decision 5 d'ADR-003 interdit — « surtout pas par l'ordre d'enumeration ».
   */
  it('nomme l ambiguite meme quand le doublon est PLUS LOIN que la fenetre retenue', () => {
    const self: WindowLike = { extHostPid: 100 };
    const dupA: WindowLike = { extHostPid: 50 };
    const dupB: WindowLike = { extHostPid: 50 };

    for (const order of [
      [dupA, dupB, self],
      [dupA, self, dupB],
      [self, dupA, dupB],
    ]) {
      const failure = catchFailure(() => resolveOwningWindow(100, table, order));

      expect(failure.code, order.map((w) => w.extHostPid).join(',')).toBe(
        ERROR_CODES.DUPLICATE_WINDOW_IDENTITY
      );
      // La profondeur rendue est celle du pid revendique deux fois, jamais celle de la
      // fenetre retenue : c'est le doublon que l'appelant doit aller inspecter.
      expect(failure.details).toEqual({ extHostPid: 50, chainDepth: 1 });
    }
  });

  it('ne voit AUCUN doublon la ou il n y a que des fenetres distinctes', () => {
    // Contre-epreuve : la garde ne doit pas transformer la regle du plus proche en erreur.
    const near: WindowLike = { extHostPid: 50 };
    const far: WindowLike = { extHostPid: 30 };
    const self: WindowLike = { extHostPid: 100 };

    expect(resolveOwningWindow(100, table, [far, near, self])).toBe(self);
    expect(resolveOwningWindow(100, table, [self, near, far])).toBe(self);
    // Une fenetre hors de la chaine ne revendique rien, fut-elle en double.
    expect(resolveOwningWindow(100, table, [near, { extHostPid: 999 }, { extHostPid: 999 }])).toBe(
      near
    );
  });
});

describe('resolveOwningWindow — pid absurde des DEUX cotes', () => {
  const table: ProcessTable = new Map([[100, { ppid: 50, createdAt: undefined }]]);

  it('ne fait jamais correspondre un pid absurde a un pid absurde', () => {
    // La moitie dangereuse, et la seule qui ne soit pas acquise d avance : `Map#get`
    // emploie SameValueZero, donc `NaN` correspond a `NaN` et `0` a `0`. Un `--pid` mal
    // analyse face a une entree elle-meme corrompue produisait une correspondance — donc
    // le pilotage d une fenetre qui n est pas la sienne.
    for (const absurd of [Number.NaN, 0, -1, 1.5]) {
      expect(
        resolveOwningWindow(absurd, table, [{ extHostPid: absurd }]),
        `callerPid=${absurd}`
      ).toBeUndefined();
    }
  });

  it('ignore une fenetre au pid absurde meme quand l appelant, lui, est reel', () => {
    // Une table corrompue peut porter un ppid non entier : le filtre des analyseurs
    // n ecarte que le non-positif, et `1.5` se retrouverait alors dans la chaine.
    const corrupted: ProcessTable = new Map([[100, { ppid: 1.5, createdAt: undefined }]]);

    expect(resolveOwningWindow(100, corrupted, [{ extHostPid: 1.5 }])).toBeUndefined();
    // Et la fenetre reelle de la meme chaine, elle, reste resolue.
    expect(resolveOwningWindow(100, corrupted, [{ extHostPid: 100 }])?.extHostPid).toBe(100);
  });

  it('ne revendique rien non plus en operation, et le dit', () => {
    const failure = catchFailure(() => requireOwningWindow(Number.NaN, table, [{ extHostPid: Number.NaN }]));

    expect(failure.code).toBe(ERROR_CODES.OWNING_WINDOW_NOT_FOUND);
    // La chaine est VIDE : un pid absurde n en ouvre aucune, il ne se met pas lui-meme en tete.
    expect(failure.details?.['chainLength']).toBe(0);
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
