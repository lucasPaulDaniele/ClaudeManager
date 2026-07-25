import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseWindowEntry,
  readRegistry,
  WINDOW_ENTRY_SCHEMA_VERSION,
} from '../../../packages/core/src/index.js';
import {
  buildWindowEntry,
  readWindowIdentity,
  removeWindowEntry,
  windowEntryPath,
} from '../../../packages/vscode/src/registry.js';

/**
 * La plomberie de registre de l'extension, verifiee EN NODE PUR.
 *
 * C'est ce que le decouplage de `vscode` rend possible : ces fonctions n'ont jamais eu
 * besoin de l'editeur, elles n'avaient besoin que de l'etat qu'il rapporte. Aucun faux
 * `vscode` n'est construit ici, et les repertoires sont de vrais repertoires temporaires.
 */

const temporaries: string[] = [];

function makeRegistryDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cmgr-vscode-registry-'));
  temporaries.push(dir);
  return dir;
}

const DRAFT = {
  identity: { extHostPid: 11172, mainPid: 16196 },
  port: 50933,
  token: '00000000-0000-0000-0000-000000000000',
  extensionVersion: '0.2.0',
  startedAt: '2026-07-24T22:01:24.603Z',
  workspaceFolders: ['c:\\Users\\user\\Documents\\Github\\ClaudeManager'],
  isTrusted: true,
} as const;

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readWindowIdentity', () => {
  it('releve le pid de CE processus et son vrai parent', () => {
    // La boucle avec le coeur est fermee par une mesure ailleurs
    // (`processTableNode.test.ts`) : ici on verifie seulement que rien n'est invente.
    expect(readWindowIdentity()).toEqual({ extHostPid: process.pid, mainPid: process.ppid });
  });

  it('ne se fie jamais a VSCODE_PID, qui ne discrimine pas une fenetre', () => {
    const previous = process.env['VSCODE_PID'];
    process.env['VSCODE_PID'] = '999999';
    try {
      expect(readWindowIdentity().extHostPid).toBe(process.pid);
    } finally {
      if (previous === undefined) delete process.env['VSCODE_PID'];
      else process.env['VSCODE_PID'] = previous;
    }
  });
});

describe('buildWindowEntry', () => {
  it('produit une entree que le coeur accepte telle quelle', () => {
    const parsed = parseWindowEntry(buildWindowEntry(DRAFT));

    expect(parsed.ok).toBe(true);
  });

  it('prend la version du schema au coeur, jamais une constante locale', () => {
    expect(buildWindowEntry(DRAFT).schemaVersion).toBe(WINDOW_ENTRY_SCHEMA_VERSION);
  });

  it('reporte l identite, l etat du workspace et la confiance tels qu ils sont fournis', () => {
    const entry = buildWindowEntry(DRAFT);

    expect(entry.extHostPid).toBe(DRAFT.identity.extHostPid);
    expect(entry.mainPid).toBe(DRAFT.identity.mainPid);
    expect(entry.workspaceFolders).toEqual(DRAFT.workspaceFolders);
    expect(entry.isTrusted).toBe(true);
  });

  it('ne garde aucune trace d une publication a l autre : chaque appel relit son etat', () => {
    const withoutTrust = buildWindowEntry({ ...DRAFT, isTrusted: false, workspaceFolders: ['/a'] });

    expect(withoutTrust.isTrusted).toBe(false);
    expect(withoutTrust.workspaceFolders).toEqual(['/a']);
    expect(buildWindowEntry(DRAFT).isTrusted).toBe(true);
  });

  it('laisse le coeur juger : une fenetre sans dossier produit bien une entree REFUSEE', () => {
    // La regle de validation appartient au coeur (`REGISTRY_ENTRY_INVALID`) et n'est pas
    // redite ici : ce test verifie qu'elle n'est pas non plus court-circuitee.
    const parsed = parseWindowEntry(buildWindowEntry({ ...DRAFT, workspaceFolders: [] }));

    expect(parsed.ok).toBe(false);
  });
});

describe('windowEntryPath', () => {
  it('nomme le fichier d apres le seul extHostPid', () => {
    const dir = makeRegistryDir();

    expect(windowEntryPath(11172, dir)).toBe(path.join(dir, '11172.json'));
  });

  it('retombe sur le registre par defaut, sous le repertoire personnel', () => {
    expect(windowEntryPath(11172)).toBe(
      path.join(os.homedir(), '.claudemanager', 'windows', '11172.json')
    );
  });

  it('construit un chemin que le coeur relit comme l entree de CE pid', () => {
    // Le coeur exige que le nom du fichier corresponde a l'identite revendiquee
    // (`identity-mismatch` sinon) : les deux conventions doivent rester en phase.
    const dir = makeRegistryDir();
    writeFileSync(windowEntryPath(11172, dir), JSON.stringify(buildWindowEntry(DRAFT)), 'utf8');

    const registry = readRegistry({
      snapshot: {
        table: new Map([[11172, { ppid: 16196, createdAt: undefined }]]),
        capturedAt: Date.now() + 60_000,
      },
      dir,
    });

    expect(registry.skipped).toEqual([]);
    expect(registry.windows.map((w) => w.extHostPid)).toEqual([11172]);
  });
});

describe('removeWindowEntry', () => {
  it('retire l entree de CE pid', () => {
    const dir = makeRegistryDir();
    const file = windowEntryPath(11172, dir);
    writeFileSync(file, '{}', 'utf8');

    removeWindowEntry(11172, dir);

    expect(existsSync(file)).toBe(false);
  });

  it('ne touche AUCUNE autre entree', () => {
    const dir = makeRegistryDir();
    writeFileSync(windowEntryPath(11172, dir), '{}', 'utf8');
    writeFileSync(windowEntryPath(17544, dir), '{}', 'utf8');

    removeWindowEntry(11172, dir);

    expect(existsSync(windowEntryPath(17544, dir))).toBe(true);
  });

  it('accepte une entree deja balayee par une autre fenetre : c est le resultat recherche', () => {
    const dir = makeRegistryDir();

    expect(() => removeWindowEntry(11172, dir)).not.toThrow();
  });
});
