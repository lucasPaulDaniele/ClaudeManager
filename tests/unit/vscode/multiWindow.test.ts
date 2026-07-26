import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  purgeStaleEntries,
  readRegistry,
  resolveOwningWindow,
  writeWindowEntry,
  type ProcessSnapshot,
  type WindowEntry,
} from '../../../packages/core/src/index.js';
import {
  WindowPublisher,
  type WorkspaceState,
} from '../../../packages/vscode/src/publication.js';
import { WINDOWS_ROLES } from '../identity/fixtures.js';
import {
  currentSchemaEntry,
  makeRegistryDir,
  REAL_TABLE,
  snapshotOf,
  tableWithoutExtensionHosts,
} from '../registry/fixtures.js';

/**
 * DEUX FENETRES, SANS LANCER DEUX VSCODE (§4 de l'increment B5).
 *
 * `WindowPublisher` est injectable — `registryDir` et `readWorkspace` (alerte n.29) : le
 * cycle de publication d'une fenetre se scripte donc en Node pur, avec de VRAIES sockets et
 * un VRAI repertoire de registre. Deux instances, deux identites, un seul registre : c'est
 * la mecanique de registre a deux acteurs, celle que la suite d'integration ne peut pas
 * eprouver parce qu'elle n'ouvre qu'une fenetre.
 *
 * CE N'EST PAS L'E2E DU LOT C : ni vraies fenetres, ni ouverture de conversation. Ce qui est
 * eprouve ici est ce qui casse quand deux fenetres coexistent — l'ecriture concurrente, la
 * resolution d'identite, et la purge de l'une face a l'entree VIVANTE de l'autre.
 *
 * `tests/unit/registry/isolation.test.ts` couvre deja l'invariant DANS LE COEUR, sur des
 * entrees ecrites a la main par `writeWindowEntry`. Ce fichier-ci part un cran plus haut :
 * ce sont les deux PUBLICATEURS de l'extension qui agissent, chacun avec son serveur, et
 * c'est le jeton HTTP qui tranche a la fin — pas seulement un champ relu sur disque.
 *
 * LE CAS DE REFERENCE DU PRODUIT EST LE MONTAGE PAR DEFAUT ICI : les deux fenetres portent
 * le MEME chemin de workspace. Rien d'autre que l'`extHostPid` ne peut donc les departager.
 */

/** Les deux extension hosts REELS de la capture, tous deux enfants du meme `Code.exe`. */
const HOST = WINDOWS_ROLES.owningExtHostPid;
const SIBLING = WINDOWS_ROLES.otherExtHostPids[0] as number;

/**
 * Le `claude.exe` appelant de la capture : sa chaine d'ancetres traverse `HOST`.
 *
 * Pour la fenetre voisine, aucun appelant n'a ete releve — elle est « hors chaine ». On en
 * cherche donc un dans la capture elle-meme : n'importe quel enfant reel de `SIBLING` fait
 * l'affaire, et c'en est un VRAI, pas un pid choisi pour arranger le test.
 */
const CALLER_IN_HOST = WINDOWS_ROLES.callerClaudePid;

function firstChildOf(pid: number): number {
  for (const [child, record] of REAL_TABLE) {
    if (record.ppid === pid) return child;
  }
  throw new Error(`aucun enfant de ${pid} dans la capture`);
}

const CALLER_IN_SIBLING = firstChildOf(SIBLING);

/** Un pid que la capture ne porte PAS : deduit d'elle, jamais choisi au hasard. */
function pidAbsentFromCapture(): number {
  for (let pid = 1; ; pid += 1) {
    if (!REAL_TABLE.has(pid)) return pid;
  }
}

/**
 * LE MEME dossier de travail pour les deux fenetres — le cas de reference du produit.
 *
 * Il vient de l'entree 0.1.0 reellement capturee : c'est un vrai chemin de workspace,
 * anonymise, pas une chaine inventee pour l'occasion.
 */
const SHARED_FOLDERS = currentSchemaEntry(HOST).workspaceFolders;
const SHARED_WORKSPACE: WorkspaceState = {
  workspaceFolders: SHARED_FOLDERS,
  isTrusted: true,
};

interface Window {
  readonly label: string;
  readonly extHostPid: number;
  readonly publisher: WindowPublisher;
  readonly lines: string[];
}

const publishers: WindowPublisher[] = [];
const temporaries: string[] = [];

function makeWindow(label: string, extHostPid: number, dir: string): Window {
  const record = REAL_TABLE.get(extHostPid);
  if (record === undefined) throw new Error(`${extHostPid} absent de la capture`);

  const lines: string[] = [];
  const publisher = new WindowPublisher({
    // `mainPid` est le `ppid` REEL de cet extension host dans la capture : c'est ce qui rend
    // l'entree vivante au regard de la garde anti-reemploi du coeur.
    identity: { extHostPid, mainPid: record.ppid },
    extensionVersion: '0.2.0',
    token: `token-de-la-fenetre-${label}`,
    logDirectory: path.join(dir, `logs-${label}`),
    readWorkspace: () => SHARED_WORKSPACE,
    // Ce module eprouve l'ISOLATION du registre et de l'ecoute : la route d'ouverture n'y
    // est jamais sollicitee. Elle leve donc plutot que de rendre un succes de complaisance —
    // un appel qu'on n'attend pas doit se voir.
    openConversation: () => Promise.reject(new Error('not exercised by this suite')),
    log: (message) => lines.push(message),
    registryDir: dir,
  });
  publishers.push(publisher);
  return { label, extHostPid, publisher, lines };
}

interface Pair {
  readonly dir: string;
  readonly a: Window;
  readonly b: Window;
}

function makePair(): Pair {
  const dir = makeRegistryDir();
  temporaries.push(dir);
  return { dir, a: makeWindow('A', HOST, dir), b: makeWindow('B', SIBLING, dir) };
}

async function publishBoth(pair: Pair): Promise<void> {
  // CONCURRENTES, jamais l'une puis l'autre : deux fenetres qui demarrent ensemble est le cas
  // nominal, pas un cas limite.
  const outcomes = await Promise.all([
    pair.a.publisher.ensurePublished('activation'),
    pair.b.publisher.ensurePublished('activation'),
  ]);
  expect(outcomes).toEqual([true, true]);
}

function readEntry(window: Window): WindowEntry {
  return JSON.parse(readFileSync(window.publisher.entryFile, 'utf8')) as WindowEntry;
}

/** Interroge `/health` d'une fenetre avec un jeton donne, et rend le seul statut. */
function probe(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        headers: { authorization: `Bearer ${token}` },
        agent: false,
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function entryFilesIn(dir: string): readonly string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort();
}

afterEach(async () => {
  for (const publisher of publishers.splice(0)) await publisher.close('test teardown');
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('deux fenetres publient dans le meme registre', () => {
  it('ecrit deux entrees intactes, chacune nommee de SON extension host', async () => {
    const pair = makePair();

    await publishBoth(pair);

    expect(entryFilesIn(pair.dir)).toEqual([`${HOST}.json`, `${SIBLING}.json`]);
    for (const window of [pair.a, pair.b]) {
      const entry = readEntry(window);
      // Le nom du fichier VAUT l'identite revendiquee (decision 5 de l'ADR-003) : si les deux
      // divergeaient, le coeur classerait l'entree `identity-mismatch` et la fenetre
      // disparaitrait de l'inventaire.
      expect(path.basename(window.publisher.entryFile)).toBe(`${entry.extHostPid}.json`);
      expect(entry.extHostPid).toBe(window.extHostPid);
    }
  });

  it('donne a chacune son port et son jeton, jamais ceux de l autre', async () => {
    const pair = makePair();

    await publishBoth(pair);

    const [a, b] = [readEntry(pair.a), readEntry(pair.b)];
    expect(a.port).not.toBe(b.port);
    expect(a.token).not.toBe(b.token);
    // Le port ephemere est ce qui rend la coexistence possible : un port fixe mettrait les
    // deux fenetres en concurrence (ADR-003, decision 8).
    expect(a.port).toBeGreaterThan(0);
    expect(b.port).toBeGreaterThan(0);
  });

  it('les rend TOUTES DEUX pilotables, sans en ecarter une seule', async () => {
    const pair = makePair();
    await publishBoth(pair);

    const registry = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir: pair.dir });

    expect(registry.skipped).toEqual([]);
    expect(registry.windows.map((window) => window.extHostPid).sort()).toEqual(
      [HOST, SIBLING].sort()
    );
  });

  it('ne corrompt jamais une entree sous des republications concurrentes repetees', async () => {
    // L'ecriture est atomique — temporaire puis `rename` (ADR-003, decision 7) —, mais rien
    // ne le rejouait a deux ecrivains. Ici les deux republient en boucle pendant qu'un
    // lecteur relit tout le registre entre chaque tour : c'est exactement la position d'une
    // CLI `cmgr windows` lancee au demarrage de deux fenetres.
    const pair = makePair();
    await publishBoth(pair);

    for (let round = 0; round < 25; round += 1) {
      const reading = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir: pair.dir });
      // Aucune lecture ne doit jamais tomber sur un JSON tronque : `unparsable` serait la
      // signature d'une ecriture en place.
      expect(reading.skipped).toEqual([]);
      expect(reading.windows).toHaveLength(2);

      await Promise.all([
        pair.a.publisher.ensurePublished(`round ${round}`),
        pair.b.publisher.ensurePublished(`round ${round}`),
      ]);
    }

    // Aucun temporaire abandonne : le registre ne porte que les deux entrees.
    expect(readdirSync(pair.dir).sort()).toEqual([`${HOST}.json`, `${SIBLING}.json`]);
  });
});

describe('le cas de reference du produit — meme chemin de workspace, deux fenetres', () => {
  it('ne laisse RIEN d autre que l extHostPid pour les departager', async () => {
    // Cette assertion n'est pas decorative : c'est elle qui donne son sens a toutes les
    // suivantes. Si les deux entrees differaient par leur workspace, une implementation
    // indexant l'identite sur le chemin passerait les tests ci-dessous.
    const pair = makePair();
    await publishBoth(pair);

    const [a, b] = [readEntry(pair.a), readEntry(pair.b)];
    expect(a.workspaceFolders).toEqual(SHARED_FOLDERS);
    expect(b.workspaceFolders).toEqual(a.workspaceFolders);
    expect(b.isTrusted).toBe(a.isTrusted);
    expect(b.extensionVersion).toBe(a.extensionVersion);
    expect(b.mainPid).toBe(a.mainPid);
    expect(b.extHostPid).not.toBe(a.extHostPid);
  });

  it('resout CHAQUE appelant vers SA fenetre, et jamais vers la voisine', async () => {
    const pair = makePair();
    await publishBoth(pair);
    const { windows } = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir: pair.dir });

    const ownerOfA = resolveOwningWindow(CALLER_IN_HOST, REAL_TABLE, windows);
    const ownerOfB = resolveOwningWindow(CALLER_IN_SIBLING, REAL_TABLE, windows);

    expect(ownerOfA?.extHostPid).toBe(HOST);
    expect(ownerOfB?.extHostPid).toBe(SIBLING);
    // Et ce sont bien les entrees des deux PUBLICATEURS, pas deux vues du meme fichier.
    expect(ownerOfA?.port).toBe(pair.a.publisher.port);
    expect(ownerOfB?.port).toBe(pair.b.publisher.port);
  });

  it('fait trancher le JETON au niveau HTTP : celui de A n ouvre jamais le serveur de B', async () => {
    // La preuve d'isolation la plus proche de ce qu'un consommateur fera reellement : il
    // resout SA fenetre, en lit le jeton et le presente. Presenter celui de la voisine doit
    // etre un refus, pas un succes silencieux.
    const pair = makePair();
    await publishBoth(pair);
    const [a, b] = [readEntry(pair.a), readEntry(pair.b)];

    expect(await probe(a.port, a.token)).toBe(200);
    expect(await probe(b.port, b.token)).toBe(200);
    expect(await probe(a.port, b.token)).toBe(401);
    expect(await probe(b.port, a.token)).toBe(401);
  });

  it('ne revendique aucune des deux pour un appelant etranger aux deux chaines', async () => {
    const pair = makePair();
    await publishBoth(pair);
    const { windows } = readRegistry({ snapshot: snapshotOf(REAL_TABLE), dir: pair.dir });

    // Un pid absent de la capture n'a aucune chaine : il n'appartient a aucune fenetre. Le
    // resultat attendu est `undefined`, jamais « la premiere venue ».
    expect(resolveOwningWindow(pidAbsentFromCapture(), REAL_TABLE, windows)).toBeUndefined();
  });
});

describe('la purge d une fenetre face a l entree VIVANTE de l autre', () => {
  it('epargne la voisine vivante — tout en supprimant reellement une entree morte', async () => {
    // DEUX ASSERTIONS INDISSOCIABLES. « B survit » ne prouverait rien d'une purge qui ne
    // supprime jamais rien : l'entree morte est la pour que la purge soit EFFECTIVE dans le
    // meme appel. C'est la lecon des trois assertions que le gate du lot B a corrigees.
    const pair = makePair();
    await publishBoth(pair);

    const dead = pidAbsentFromCapture();
    writeWindowEntry({ ...currentSchemaEntry(HOST), extHostPid: dead }, { dir: pair.dir });

    // Ce que `sweepStaleEntries` appelle a l'activation de la fenetre A, mot pour mot.
    const result = purgeStaleEntries({ snapshot: snapshotOf(REAL_TABLE), dir: pair.dir });

    expect(result.removed).toEqual([`${dead}.json`]);
    expect(entryFilesIn(pair.dir)).toEqual([`${HOST}.json`, `${SIBLING}.json`]);
    // La voisine n'a pas seulement son fichier : elle est toujours JOIGNABLE.
    const b = readEntry(pair.b);
    expect(await probe(b.port, b.token)).toBe(200);
  });

  it('laisse la voisine se republier quand un instantane perime l a fait passer pour morte', async () => {
    // LE SCENARIO A DEUX ACTEURS DE S6, et il n'a rien d'hypothetique : `readProcessTable`
    // coute de 700 ms a 1,3 s, et deux fenetres demarrent couramment a quelques centaines de
    // millisecondes d'ecart. Une fenetre qui balaie sur un instantane pris AVANT le demarrage
    // de sa voisine la juge morte.
    //
    // L'instantane employe est la MEME capture, moins les deux extension hosts : ce poste une
    // fois les deux fenetres fermees. Rien n'y est ajoute.
    const pair = makePair();
    await publishBoth(pair);
    const before = readEntry(pair.b);

    const stale: ProcessSnapshot = snapshotOf(tableWithoutExtensionHosts());
    const result = purgeStaleEntries({ snapshot: stale, dir: pair.dir });

    expect([...result.removed].sort()).toEqual([`${HOST}.json`, `${SIBLING}.json`]);
    expect(existsSync(pair.b.publisher.entryFile)).toBe(false);
    // Le serveur de B, lui, n'a jamais cesse d'ecouter : c'est precisement l'etat que S6
    // reproche — une ecoute vivante que plus aucun registre ne decrit.
    expect(await probe(before.port, before.token)).toBe(200);

    await pair.b.publisher.republishIfEntryLost('after the sweep');

    expect(existsSync(pair.b.publisher.entryFile)).toBe(true);
    const after = readEntry(pair.b);
    expect(after.port).toBe(before.port);
    expect(after.token).toBe(before.token);
    expect(pair.b.lines.join('\n')).toContain('registry entry vanished');
    // Et A n'a pas ete emportee : elle se republie de son cote, sans rien devoir a B.
    await pair.a.publisher.republishIfEntryLost('after the sweep');
    expect(entryFilesIn(pair.dir)).toEqual([`${HOST}.json`, `${SIBLING}.json`]);
  });

  it('ne retire QUE sa propre entree quand une fenetre se desactive', async () => {
    const pair = makePair();
    await publishBoth(pair);
    const b = readEntry(pair.b);

    await pair.a.publisher.close('deactivate');

    expect(entryFilesIn(pair.dir)).toEqual([`${SIBLING}.json`]);
    expect(await probe(b.port, b.token)).toBe(200);
  });
});
