import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRegistry, windowEntryPath } from '../../../packages/core/src/index.js';
import {
  plantForeignEntry,
  unplantForeignEntry,
} from '../../integration/src/foreignEntry.js';
import { readLegacyEntry, snapshotOf } from '../registry/fixtures.js';

/**
 * L'entree ETRANGERE que le scenario nominal depose dans le registre REEL du poste.
 *
 * C'est la chose la moins anodine de tout le harnais — une ecriture hors de tout repertoire
 * temporaire, dans le registre de l'utilisateur — et c'etait la seule qu'aucun test
 * n'atteignait : elle vivait dans un module qui importe `vscode`. La sortir de la l'a rendue
 * verifiable en Node pur, contre un vrai repertoire temporaire (finding S8).
 *
 * La fixture employee est la 0.1.0 REELLE du depot, jamais une entree fabriquee a la main
 * (principe fondateur n.5).
 */

const LIVE_PID = process.pid;

const temporaries: string[] = [];

function makeRegistryDir(): string {
  // Un SOUS-repertoire qui n'existe pas encore : c'est `plantForeignEntry` qui le cree, et
  // c'est son `mode` qu'on veut constater.
  const root = mkdtempSync(path.join(os.tmpdir(), 'cmgr-foreign-'));
  temporaries.push(root);
  return path.join(root, 'windows');
}

function fixture(): Record<string, unknown> {
  return readLegacyEntry(11172) as unknown as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('pose d une entree etrangere dans le registre', () => {
  it('nomme le fichier par la convention du COEUR, jamais par un gabarit local', () => {
    const dir = makeRegistryDir();

    const planted = plantForeignEntry(fixture(), LIVE_PID, dir);

    expect(planted?.file).toBe(windowEntryPath(LIVE_PID, dir));
  });

  it('depose une entree que le coeur classe `foreign-schema`, et jamais pilotable', () => {
    // C'est tout l'objet du point d'isolation : une entree d'un autre schema, au pid VIVANT,
    // ne doit ni etre retenue ni etre purgee.
    const dir = makeRegistryDir();
    plantForeignEntry(fixture(), LIVE_PID, dir);

    const registry = readRegistry({
      snapshot: snapshotOf(new Map([[LIVE_PID, { ppid: process.ppid, createdAt: undefined }]])),
      dir,
    });

    expect(registry.windows).toEqual([]);
    expect(registry.skipped.map((entry) => entry.reason)).toEqual(['foreign-schema']);
  });

  it('n ecrase JAMAIS un fichier qui porte deja ce nom', () => {
    const dir = makeRegistryDir();
    const first = plantForeignEntry(fixture(), LIVE_PID, dir);
    const before = readFileSync(first?.file as string, 'utf8');

    expect(plantForeignEntry(fixture(), LIVE_PID, dir)).toBeUndefined();
    expect(readFileSync(first?.file as string, 'utf8')).toBe(before);
  });

  it('ne laisse AUCUN residu quand l ecriture echoue en cours de route', () => {
    // FINDING S8. Un fichier tronque dans le registre reel est classe `unparsable` — donc
    // IMPURGEABLE PAR CONCEPTION, la purge conservatrice ne supprimant que ce dont elle a pu
    // lire le pid. Il serait *immortel*, sur le poste de l'utilisateur. L'ecriture partielle
    // est simulee par le SEUL point d'injection du module : une ecriture qui echoue a
    // mi-parcours ne se provoque pas a volonte sur un vrai systeme de fichiers.
    const dir = makeRegistryDir();
    const half = (file: string, content: string): void => {
      writeFileSync(file, content.slice(0, 12), 'utf8');
      throw Object.assign(new Error('disque plein'), { code: 'ENOSPC' });
    };

    expect(() => plantForeignEntry(fixture(), LIVE_PID, dir, half)).toThrow();

    expect(existsSync(windowEntryPath(LIVE_PID, dir))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')(
    'pose les MEMES droits que le coeur — le harnais ne relache pas ce que writeWindowEntry resserre',
    () => {
      // Sans `mode`, Node applique l'umask : 0755 sur le repertoire et 0644 sur le fichier.
      // Sur un poste POSIX multi-utilisateurs, n'importe quel autre compte lirait alors le
      // jeton et le port de chaque fenetre. Sous Windows ces bits n'ont pas de sens, et c'est
      // l'ACL heritee qui protege : l'assertion y serait fausse pour une bonne raison.
      const dir = makeRegistryDir();

      const planted = plantForeignEntry(fixture(), LIVE_PID, dir);

      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(planted?.file as string).mode & 0o777).toBe(0o600);
    }
  );
});

describe('retrait de l entree etrangere', () => {
  it('retire CE qu il a ecrit, et rien d autre', () => {
    const dir = makeRegistryDir();
    const planted = plantForeignEntry(fixture(), LIVE_PID, dir);

    expect(unplantForeignEntry(planted)).toBe('retiree');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('LAISSE EN PLACE un fichier dont le contenu a change : il n est plus le notre', () => {
    const dir = makeRegistryDir();
    const planted = plantForeignEntry(fixture(), LIVE_PID, dir);
    writeFileSync(planted?.file as string, '{"quelqu un d autre": true}', 'utf8');

    expect(unplantForeignEntry(planted)).toContain('LAISSEE EN PLACE');
    expect(existsSync(planted?.file as string)).toBe(true);
  });

  it('accepte une entree deja disparue, et ne fait rien sans pose prealable', () => {
    const dir = makeRegistryDir();
    const planted = plantForeignEntry(fixture(), LIVE_PID, dir);
    rmSync(planted?.file as string, { force: true });

    expect(unplantForeignEntry(planted)).toBe('deja disparue');
    expect(unplantForeignEntry(undefined)).toBe('aucune entree fabriquee');
  });
});
