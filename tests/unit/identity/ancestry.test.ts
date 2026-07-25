import { describe, expect, it } from 'vitest';
import {
  ancestorsOf,
  parsePosixProcessTable,
  parseWindowsProcessTable,
  type ProcessTable,
} from '../../../packages/core/src/index.js';
import { POSIX_CAPTURE, POSIX_ROLES, WINDOWS_CAPTURE, WINDOWS_ROLES } from './fixtures.js';

describe('ancestorsOf — topologie reelle', () => {
  const table = parseWindowsProcessTable(WINDOWS_CAPTURE);
  const chain = ancestorsOf(WINDOWS_ROLES.callerClaudePid, table);

  it('rend exactement la chaine relevee a la capture', () => {
    expect(chain).toEqual(WINDOWS_ROLES.expectedAncestry);
  });

  it('traverse l extension host PUIS le processus principal, dans cet ordre', () => {
    // C'est la topologie que CLAUDE.md affirme : claude.exe -> extension host -> Code.exe.
    // Elle est ici confirmee sur des PID mesures, pas supposes.
    const extHostIndex = chain.indexOf(WINDOWS_ROLES.owningExtHostPid);
    const mainIndex = chain.indexOf(WINDOWS_ROLES.mainCodePid);

    expect(extHostIndex).toBeGreaterThanOrEqual(0);
    expect(mainIndex).toBeGreaterThan(extHostIndex);
  });

  it('ne remonte PAS l autre extension host, pourtant frere du sien', () => {
    // Les deux extension hosts de la capture partagent le meme Code.exe principal :
    // c'est precisement pourquoi un PID de processus principal ne discrimine rien.
    for (const other of WINDOWS_ROLES.otherExtHostPids) {
      expect(chain).not.toContain(other);
      expect(table.get(other)?.ppid).toBe(WINDOWS_ROLES.mainCodePid);
    }
  });

  it('exclut le processus appelant lui-meme', () => {
    expect(chain).not.toContain(WINDOWS_ROLES.callerClaudePid);
  });

  it('s arrete sur un parent absent de la table — orphelin reel, non fabrique', () => {
    // Le dernier maillon de la chaine (le parent d'explorer.exe) etait deja mort au moment
    // de la capture : il n'est pas une cle de la table, la remontee s'y arrete.
    const last = chain[chain.length - 1];
    expect(last).toBeDefined();
    expect(table.has(last as number)).toBe(false);
  });
});

describe('ancestorsOf — topologie reelle POSIX', () => {
  const table = parsePosixProcessTable(POSIX_CAPTURE);

  it('remonte la plus longue chaine relevee jusqu a la racine', () => {
    expect(ancestorsOf(POSIX_ROLES.longestChain.from, table)).toEqual(
      POSIX_ROLES.longestChain.ancestors
    );
  });
});

describe('ancestorsOf — cas limites', () => {
  // Ces tables sont construites en memoire : ce ne sont pas des captures mais des
  // structures de donnees exercant explicitement un cas de corruption ou de bord.
  const build = (entries: readonly (readonly [number, number])[]): ProcessTable =>
    new Map(entries.map(([pid, ppid]) => [pid, { ppid, createdAt: undefined }]));

  it('rend une chaine vide quand le pid est absent de la table', () => {
    expect(ancestorsOf(999, build([[100, 10]]))).toEqual([]);
  });

  it('s arrete proprement sur un ppid 0 — la racine sous Windows', () => {
    expect(ancestorsOf(100, build([[100, 10], [10, 0]]))).toEqual([10]);
  });

  it('s arrete sur un processus qui se declare son propre parent', () => {
    expect(ancestorsOf(100, build([[100, 100]]))).toEqual([]);
  });

  it('s arrete sur un cycle sans jamais boucler, chaque pid une seule fois', () => {
    const chain = ancestorsOf(100, build([[100, 10], [10, 20], [20, 10]]));

    expect(chain).toEqual([10, 20]);
    expect(new Set(chain).size).toBe(chain.length);
  });

  it('s arrete sur un cycle qui reboucle sur le pid de depart', () => {
    expect(ancestorsOf(100, build([[100, 10], [10, 100]]))).toEqual([10]);
  });

  it('rend une chaine vide pour un pid non entier, negatif, nul ou NaN', () => {
    const table = build([[100, 10], [10, 1]]);

    expect(ancestorsOf(1.5, table)).toEqual([]);
    expect(ancestorsOf(-1, table)).toEqual([]);
    expect(ancestorsOf(0, table)).toEqual([]);
    expect(ancestorsOf(Number.NaN, table)).toEqual([]);
    expect(ancestorsOf(Number.POSITIVE_INFINITY, table)).toEqual([]);
  });
});
