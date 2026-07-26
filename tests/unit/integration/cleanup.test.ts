import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireHarnessLock,
  findHarnessLeftovers,
  HARNESS_LOCK_FILE,
  releaseHarnessLock,
  removeQuietly,
} from '../../integration/src/cleanup.js';

/**
 * L'hygiene du lanceur d'integration.
 *
 * Elle n'est pas mesurable par la commande qu'elle sert — `npm run test:integration` sort en
 * 0 aussi bien quand le nettoyage reussit que quand il echoue, c'est tout son objet. Ce qui
 * doit donc etre prouve ici : que l'echec est BORNE, qu'il ne LEVE pas, qu'il se DIT, et que
 * le balayage ne touche que ce que le harnais a lui-meme depose.
 */

const temporaries: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cmgr-cleanup-'));
  temporaries.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('removeQuietly', () => {
  it('supprime un vrai repertoire et son contenu, du premier coup', async () => {
    const dir = makeDir();
    mkdirSync(path.join(dir, 'logs', 'window1'), { recursive: true });
    writeFileSync(path.join(dir, 'logs', 'window1', 'ClaudeManager.log'), 'x', 'utf8');
    const target = path.join(dir, 'logs');

    const outcome = await removeQuietly(target);

    expect(outcome).toMatchObject({ removed: true, code: 'OK', attempts: 1 });
    expect(existsSync(target)).toBe(false);
  });

  it('tient une cible deja absente pour un succes : c est le resultat recherche', async () => {
    const dir = makeDir();

    const outcome = await removeQuietly(path.join(dir, 'jamais-cree'));

    expect(outcome.removed).toBe(true);
  });

  it('NE LEVE PAS quand la suppression echoue, et rend le code systeme', async () => {
    // Le cas de B1 : un `EPERM` que VSCode provoque en gardant des poignees sur son
    // `--user-data-dir` juste apres sa sortie. Il ne se commande pas sur un vrai systeme de
    // fichiers, d'ou l'injection — la borne du reessai est ce qui doit etre prouve.
    const dir = makeDir();
    let calls = 0;
    const outcome = await removeQuietly(dir, {
      attempts: 3,
      delayMs: 1,
      remove: () => {
        calls += 1;
        throw Object.assign(new Error(`EPERM, Permission denied: ${dir}`), { code: 'EPERM' });
      },
    });

    expect(outcome).toMatchObject({ removed: false, code: 'EPERM', attempts: 3 });
    expect(calls).toBe(3);
  });

  it('reessaie de facon BORNEE, et s arrete des que la suppression aboutit', async () => {
    const dir = makeDir();
    let calls = 0;
    const outcome = await removeQuietly(dir, {
      attempts: 5,
      delayMs: 1,
      remove: () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      },
    });

    expect(outcome).toMatchObject({ removed: true, code: 'OK', attempts: 3 });
    expect(calls).toBe(3);
  });

  it('ne rend jamais le message systeme, qui porte le chemin', async () => {
    const dir = makeDir();

    const outcome = await removeQuietly(dir, {
      attempts: 1,
      remove: () => {
        throw new Error(`EPERM, Permission denied: ${dir}`);
      },
    });

    // Une erreur sans champ `code` : on ne devine pas, on le dit.
    expect(outcome.code).toBe('UNKNOWN');
    expect(JSON.stringify(outcome)).not.toContain(os.homedir());
  });
});

describe('findHarnessLeftovers', () => {
  it('reconnait les cinq formes que le harnais depose', () => {
    const dir = makeDir();
    const ours = [
      'cmgr-b3-ws-aB3xZ9',
      'cmgr-b3-uds-jsU8Xe',
      // La forme d'avant B5, encore presente sur le poste : ne plus la reconnaitre rendrait
      // ces rapports immortels.
      'cmgr-b3-report-17900.json',
      // La forme de B5 : un rapport par scenario.
      'cmgr-b3-report-17900-empty-workspace.json',
      'cmgr-b3-current.json',
    ];
    for (const name of ours) writeFileSync(path.join(dir, name), '{}', 'utf8');

    expect(findHarnessLeftovers(dir).map((item) => path.basename(item)).sort()).toEqual(
      [...ours].sort()
    );
  });

  it('ne touche RIEN qui ne corresponde pas exactement a un motif du harnais', () => {
    // Le repertoire temporaire est partage avec tout le systeme, et il porte deja des
    // fichiers `cmgr-*` produits par d'autres outils du chantier.
    const dir = makeDir();
    const others = [
      'cmgr-b3-report-.json',
      'cmgr-b3-report-17900.json.bak',
      'cmgr-b3-report-17900-.json',
      'cmgr-b3-report--nominal.json',
      'cmgr-b3-report-17900-Nominal.json',
      'prefixe-cmgr-b3-current.json',
      'cmgr-b3-current.json.tmp',
      'cmgr-diag-ACS2CX',
      'cmgr-direct-err.txt',
      'cmgr-registry-aB3xZ9',
      'cmgr-b3-ws-tropcourt',
      'important.json',
    ];
    for (const name of others) writeFileSync(path.join(dir, name), '{}', 'utf8');

    expect(findHarnessLeftovers(dir)).toEqual([]);
  });

  it('rend des chemins absolus, tries', () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, 'cmgr-b3-report-99.json'), '{}', 'utf8');
    writeFileSync(path.join(dir, 'cmgr-b3-current.json'), '{}', 'utf8');

    expect(findHarnessLeftovers(dir)).toEqual([
      path.join(dir, 'cmgr-b3-current.json'),
      path.join(dir, 'cmgr-b3-report-99.json'),
    ]);
  });

  it('rend une liste vide sur un repertoire illisible, sans lever', () => {
    expect(findHarnessLeftovers(path.join(makeDir(), 'absent'))).toEqual([]);
  });
});

/**
 * LE VERROU D'EXECUTION — finding S7.
 *
 * Le balayage ci-dessus supprime les residus des executions PRECEDENTES, `--user-data-dir`
 * compris. Il etait justifie par une affirmation FAUSSE : « deux executions simultanees sont
 * deja impossibles par construction, `cmgr-b3-current.json` etant ecrit a un chemin fixe que la
 * seconde ecraserait ». Un chemin fixe ecrase n'est PAS une exclusion mutuelle — il ne bloque
 * rien, il perd une information. Les deux runs demarraient, et le balayage du premier
 * supprimait le `--user-data-dir` d'un VSCode EN COURS D'EXECUTION.
 *
 * Ce qui suit eprouve l'exclusion mutuelle elle-meme, sur de vrais fichiers.
 */
describe('acquireHarnessLock', () => {
  function lockPath(): string {
    return path.join(makeDir(), HARNESS_LOCK_FILE);
  }

  it('prend le verrou quand il est libre, et inscrit le pid du detenteur', () => {
    const file = lockPath();

    expect(acquireHarnessLock(file)).toEqual({ acquired: true });
    expect(existsSync(file)).toBe(true);
  });

  it('REFUSE de le prendre quand un processus VIVANT le detient, et nomme ce processus', () => {
    // LE GARDE-FOU DE NON-REGRESSION DE S7 : sans exclusion mutuelle, rien n'empechait le
    // second run de demarrer et de balayer le temporaire du premier.
    const file = lockPath();
    // Le pid de CE processus : vivant par construction, aucun pid n'est invente ici.
    writeFileSync(file, `${process.pid}\n`, 'utf8');

    expect(acquireHarnessLock(file)).toEqual({ acquired: false, holder: process.pid });
  });

  it('REPREND le verrou d un run mort, sans quoi un harnais tue le bloquerait pour toujours', () => {
    // Un pid libre du systeme, cherche plutot que choisi : `process.kill(pid, 0)` est la seule
    // autorite sur la question, et c'est un test d'existence — aucun signal n'est envoye.
    let dead = 4_000_000;
    for (; dead > 0; dead -= 1) {
      try {
        process.kill(dead, 0);
      } catch (error) {
        if ((error as { code?: string }).code === 'ESRCH') break;
      }
    }
    expect(dead).toBeGreaterThan(0);

    const file = lockPath();
    writeFileSync(file, `${dead}\n`, 'utf8');

    expect(acquireHarnessLock(file)).toEqual({ acquired: true });
  });

  it('refuse un verrou dont le detenteur est illisible plutot que de l ecraser', () => {
    // On ne conclut pas sur ce qu'on ne sait pas lire : ecraser reviendrait a supprimer
    // l'exclusion mutuelle d'un run peut-etre vivant.
    const file = lockPath();
    writeFileSync(file, 'pas un pid', 'utf8');

    expect(acquireHarnessLock(file)).toEqual({ acquired: false });
  });

  it('le rend, et le rendre deux fois n est pas une defaillance', () => {
    const file = lockPath();
    acquireHarnessLock(file);

    releaseHarnessLock(file);
    releaseHarnessLock(file);

    expect(existsSync(file)).toBe(false);
    expect(acquireHarnessLock(file)).toEqual({ acquired: true });
  });

  it('n est JAMAIS balaye comme un residu : un run concurrent le detient legitimement', () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, HARNESS_LOCK_FILE), `${process.pid}\n`, 'utf8');
    writeFileSync(path.join(dir, 'cmgr-b3-current.json'), '{}', 'utf8');

    expect(findHarnessLeftovers(dir)).toEqual([path.join(dir, 'cmgr-b3-current.json')]);
  });
});
