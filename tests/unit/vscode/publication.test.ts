import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRegistry, type WindowEntry } from '../../../packages/core/src/index.js';
import {
  WindowPublisher,
  type PublisherOptions,
  type WorkspaceState,
} from '../../../packages/vscode/src/publication.js';

/**
 * Le cycle de vie de la publication — VRAIES sockets, VRAI repertoire de registre.
 *
 * C'est ici que vivent les garde-fous de non-regression du gate : C5 (un refus de publication
 * retirait la fenetre DEFINITIVEMENT), S6 (un serveur survivait a la disparition de son
 * entree), C2 (une defaillance TRANSITOIRE d'ecriture rendait la fenetre definitivement
 * injoignable), S2 (l'entree pouvait etre SUBSTITUEE sous son propre nom sans que rien ne le
 * voie) et S5 (une ecoute morte restait annoncee par l'entree). Aucun d'eux n'etait eprouvable
 * avant que ce cycle ne soit separe de `vscode` — c'est precisement pourquoi ils avaient
 * echappe a une CI verte.
 *
 * Deux elements seulement sont injectes, et aucun des deux n'est un faux systeme : l'etat du
 * workspace, que seul un editeur connait, et le programmateur des reprises differees — ce
 * qu'il faut prouver etant que la reprise A LIEU, pas qu'elle attend 250 ms.
 */

const IDENTITY = { extHostPid: process.pid, mainPid: process.ppid };
const FOLDERS = ['c:\\Users\\user\\Documents\\Github\\ClaudeManager'];
const TOKEN = '00000000-0000-0000-0000-000000000000';

const temporaries: string[] = [];
const publishers: WindowPublisher[] = [];

/**
 * Rend le chemin du registre — un SOUS-repertoire qui n'existe pas encore.
 *
 * Il est cree par `writeWindowEntry` a la premiere publication, exactement comme sur un poste
 * neuf. C'est aussi ce qui permet de le faire tenir par un FICHIER pour provoquer une vraie
 * defaillance d'ecriture, comme le fait deja `store.test.ts` (garde-fou C2).
 */
function makeRegistryDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cmgr-publication-'));
  temporaries.push(root);
  return path.join(root, 'windows');
}

interface Harness {
  readonly publisher: WindowPublisher;
  readonly dir: string;
  readonly lines: string[];
  /** Le repertoire de journal annonce sur `/health`, et rien d'autre ne le connait. */
  readonly logDirectory: string;
  /** Delais REELLEMENT demandes par les reprises differees, dans l'ordre. */
  readonly delays: number[];
  workspace: WorkspaceState;
  /** Surcharge du releve : par defaut, il rend `workspace`. */
  readWorkspace: () => WorkspaceState;
}

interface HarnessOptions {
  /** Laisse agir le programmateur par defaut (`setTimeout`) au lieu de l'injecter. */
  readonly realSchedule?: boolean;
}

function makePublisher(initial?: Partial<WorkspaceState>, harnessOptions?: HarnessOptions): Harness {
  const dir = makeRegistryDir();
  const lines: string[] = [];
  const delays: number[] = [];
  const logDirectory = path.join(dir, 'logs');
  const harness = {
    dir,
    lines,
    delays,
    logDirectory,
    workspace: {
      workspaceFolders: initial?.workspaceFolders ?? FOLDERS,
      isTrusted: initial?.isTrusted ?? true,
    },
    readWorkspace: (): WorkspaceState => harness.workspace,
  } as Harness & { publisher: WindowPublisher };

  const options: PublisherOptions = {
    identity: IDENTITY,
    extensionVersion: '0.2.0',
    token: TOKEN,
    logDirectory,
    readWorkspace: () => harness.readWorkspace(),
    log: (message) => lines.push(message),
    registryDir: dir,
    // Le DELAI est releve, la tache part au tour suivant : c'est l'echelle qu'on veut
    // eprouver, pas la patience du minuteur de Node.
    ...(harnessOptions?.realSchedule === true
      ? {}
      : {
          schedule: (task: () => void, delayMs: number): void => {
            delays.push(delayMs);
            setTimeout(task, 0);
          },
        }),
  };

  harness.publisher = new WindowPublisher(options);
  publishers.push(harness.publisher);
  return harness;
}

function readEntry(harness: Harness): WindowEntry {
  return JSON.parse(readFileSync(harness.publisher.entryFile, 'utf8')) as WindowEntry;
}

function tryReadEntry(harness: Harness): WindowEntry | undefined {
  try {
    return readEntry(harness);
  } catch {
    return undefined;
  }
}

/** Attend qu'une condition devienne vraie, ou LEVE : c'est ce qui la rend falsifiable. */
async function waitFor(label: string, ready: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > timeoutMs) throw new Error(`delai depasse en attendant ${label}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

function getBody(port: number, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        headers: { authorization: `Bearer ${token}` },
        agent: false,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve(text));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function get(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        headers: { authorization: `Bearer ${token}` },
        agent: false,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  for (const publisher of publishers.splice(0)) await publisher.close('test teardown');
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('publication nominale', () => {
  it('ecrit une entree que le coeur relit, et ouvre une ecoute joignable', async () => {
    const harness = makePublisher();

    expect(await harness.publisher.ensurePublished('activation')).toBe(true);

    const entry = readEntry(harness);
    expect(entry.extHostPid).toBe(IDENTITY.extHostPid);
    expect(entry.workspaceFolders).toEqual(FOLDERS);
    expect(await get(entry.port, entry.token)).toBe(200);
  });

  it('est idempotente : republier remplace l entree sans en creer une seconde', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    const first = readEntry(harness);

    harness.workspace = { workspaceFolders: FOLDERS, isTrusted: false };
    expect(await harness.publisher.ensurePublished('workspace trust changed')).toBe(true);

    const second = readEntry(harness);
    // Meme fichier, meme port : seule la description de la fenetre a suivi son etat.
    expect(second.port).toBe(first.port);
    expect(second.isTrusted).toBe(false);
  });

  it('ne journalise JAMAIS le jeton ni les chemins du workspace', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');

    const journal = harness.lines.join('\n');
    expect(journal).not.toContain(readEntry(harness).token);
    for (const folder of FOLDERS) expect(journal).not.toContain(folder);
  });
});

describe('C5 — un refus de publication ne doit pas retirer la fenetre definitivement', () => {
  it('laisse le coeur refuser, et le dit', async () => {
    // Fenetre sans dossier de travail : `REGISTRY_ENTRY_INVALID`, regle du coeur.
    const harness = makePublisher({ workspaceFolders: [] });

    expect(await harness.publisher.ensurePublished('activation')).toBe(false);

    expect(existsSync(harness.publisher.entryFile)).toBe(false);
    expect(harness.publisher.isPublished).toBe(false);
    expect(harness.lines.join('\n')).toContain('REGISTRY_ENTRY_INVALID');
  });

  it('SE PUBLIE quand un dossier est ajoute APRES le refus initial', async () => {
    // LE GARDE-FOU DE NON-REGRESSION DE C5. Avant le correctif, le retrait consecutif au
    // refus effacait l'etat que les abonnements de reprise testaient : la fenetre restait
    // injoignable jusqu'a un rechargement complet, alors meme que l'evenement qui la rendait
    // valide etait deja cable.
    const harness = makePublisher({ workspaceFolders: [] });
    expect(await harness.publisher.ensurePublished('activation')).toBe(false);

    harness.workspace = { workspaceFolders: FOLDERS, isTrusted: true };
    expect(await harness.publisher.ensurePublished('workspace folders changed')).toBe(true);

    const entry = readEntry(harness);
    expect(entry.workspaceFolders).toEqual(FOLDERS);
    // La republication a REDEMARRE ce que le retrait avait arrete.
    expect(await get(entry.port, entry.token)).toBe(200);
  });

  it('se retire de nouveau si un refus survient apres une publication reussie', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    const port = harness.publisher.port;
    expect(port).toBeDefined();

    harness.workspace = { workspaceFolders: [], isTrusted: true };
    expect(await harness.publisher.ensurePublished('workspace folders changed')).toBe(false);

    // Entree retiree ET ecoute fermee : les deux vont ensemble, dans les deux sens.
    expect(existsSync(harness.publisher.entryFile)).toBe(false);
    await expect(get(port as number, 'peu importe')).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });

  it('reste rattrapable meme apres plusieurs refus consecutifs', async () => {
    const harness = makePublisher({ workspaceFolders: [] });
    await harness.publisher.ensurePublished('activation');
    await harness.publisher.ensurePublished('workspace folders changed');
    await harness.publisher.ensurePublished('workspace folders changed');

    harness.workspace = { workspaceFolders: FOLDERS, isTrusted: true };

    expect(await harness.publisher.ensurePublished('workspace folders changed')).toBe(true);
  });
});

describe('S6 — un serveur ne doit pas survivre a la disparition de son entree', () => {
  it('REPUBLIE quand une autre fenetre a purge son entree', async () => {
    // LE GARDE-FOU DE NON-REGRESSION DE S6. Avant le correctif, le serveur restait ouvert et
    // joignable, porteur d'un jeton valide, sans qu'aucun inventaire ne le mentionne : la
    // fenetre devenait non pilotable en silence.
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    const before = readEntry(harness);

    // Ce que fait `purgeStaleEntries` d'une autre fenetre, ou un utilisateur.
    rmSync(harness.publisher.entryFile, { force: true });
    expect(existsSync(harness.publisher.entryFile)).toBe(false);

    await harness.publisher.republishIfEntryLost('after the sweep');

    expect(existsSync(harness.publisher.entryFile)).toBe(true);
    const after = readEntry(harness);
    // Meme ecoute, meme jeton : la republication remet le registre en accord avec une
    // fenetre qui n'a jamais cesse d'etre joignable.
    expect(after.port).toBe(before.port);
    expect(await get(after.port, after.token)).toBe(200);
    expect(harness.lines.join('\n')).toContain('registry entry vanished');
  });

  it('ne fait RIEN quand l entree est toujours la : aucune ecriture inutile', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    const before = readFileSync(harness.publisher.entryFile, 'utf8');
    harness.lines.length = 0;

    await harness.publisher.republishIfEntryLost('after the sweep');

    expect(readFileSync(harness.publisher.entryFile, 'utf8')).toBe(before);
    expect(harness.lines).toEqual([]);
  });

  it('ne republie JAMAIS derriere un retrait delibere', async () => {
    // Le retrait efface l'etat AVANT de supprimer le fichier : c'est ce qui distingue, pour
    // l'observateur, une disparition subie d'un retrait voulu. Sans cela, `deactivate`
    // rouvrirait une ecoute que plus rien ne fermerait.
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    await harness.publisher.withdraw('deliberate');

    await harness.publisher.republishIfEntryLost('watcher, entry deleted');

    expect(existsSync(harness.publisher.entryFile)).toBe(false);
    expect(harness.publisher.isPublished).toBe(false);
  });

  it('ne republie plus rien apres la fermeture du cycle de vie', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    await harness.publisher.close('deactivate');

    await harness.publisher.republishIfEntryLost('watcher, entry deleted');
    expect(await harness.publisher.ensurePublished('trop tard')).toBe(false);

    expect(existsSync(harness.publisher.entryFile)).toBe(false);
  });
});

describe('C2 — une defaillance TRANSITOIRE d ecriture ne doit pas rendre la fenetre injoignable a jamais', () => {
  /**
   * Une VRAIE defaillance d'ecriture : le repertoire du registre est TENU PAR UN FICHIER.
   *
   * C'est le montage que `store.test.ts` emploie deja pour eprouver `REGISTRY_UNWRITABLE` cote
   * coeur — aucun faux `fs`, un vrai `mkdirSync` qui echoue pour une vraie raison. Il tient
   * lieu du verrou que pose un antivirus ou un indexeur, cause que la remediation de
   * `REGISTRY_UNWRITABLE` nomme elle-meme.
   */
  function holdRegistryDirectory(harness: Harness): void {
    mkdirSync(path.dirname(harness.dir), { recursive: true });
    writeFileSync(harness.dir, 'pas un repertoire', 'utf8');
  }

  function releaseRegistryDirectory(harness: Harness): void {
    rmSync(harness.dir, { force: true });
  }

  it('nomme la defaillance et GARDE son ecoute ouverte', async () => {
    const harness = makePublisher();
    holdRegistryDirectory(harness);

    expect(await harness.publisher.ensurePublished('activation')).toBe(false);

    const journal = harness.lines.join('\n');
    expect(journal).toContain('REGISTRY_UNWRITABLE');
    // L'ECOUTE RESTE OUVERTE : la fenetre redeviendra joignable sans changer de port, donc
    // sans invalider quoi que ce soit chez un appelant. C'est ce qui distingue cette classe
    // du refus de validation, ou le serveur n'aurait rien a servir.
    expect(harness.publisher.isPublished).toBe(true);
    expect(await get(harness.publisher.port as number, TOKEN)).toBe(200);
    expect(journal).toContain('keeps its local server open');
  });

  it('SE REPUBLIE seule des que le registre redevient ecrivable, SANS aucun evenement de workspace', async () => {
    // LE GARDE-FOU DE NON-REGRESSION DE C2. Avant le correctif, toute defaillance d'ecriture
    // menait au meme retrait qu'un refus de validation — lequel efface `live`, l'etat que la
    // reprise autonome teste avant d'agir. Ne restaient alors que l'octroi de confiance et le
    // changement de dossiers : deux CHANGEMENTS D'ETAT DU WORKSPACE, qui ne surviennent jamais
    // quand c'est un antivirus qui a verrouille le repertoire. La fenetre restait utilisable
    // pour l'humain et DEFINITIVEMENT injoignable pour `cmgr`, jusqu'a un rechargement complet.
    //
    // RIEN N'EST DECLENCHE ICI : ni `ensurePublished`, ni un changement de workspace, ni la
    // moindre observation de fichier. Seule la reprise programmee agit.
    const harness = makePublisher();
    holdRegistryDirectory(harness);
    expect(await harness.publisher.ensurePublished('activation')).toBe(false);
    const port = harness.publisher.port as number;

    releaseRegistryDirectory(harness);
    await waitFor('la republication autonome', () => tryReadEntry(harness) !== undefined);

    const entry = readEntry(harness);
    expect(entry.extHostPid).toBe(IDENTITY.extHostPid);
    // MEME port : l'ecoute n'ayant jamais ete fermee, rien n'a eu a etre rouvert.
    expect(entry.port).toBe(port);
    expect(await get(entry.port, entry.token)).toBe(200);
  });

  it('echelonne ses reprises, et les BORNE : une defaillance durable finit par un vrai retrait', async () => {
    // L'echelle est bornee a dessein — sans quoi une ecoute vivante que plus aucune entree ne
    // decrit survivrait indefiniment, ce qui EST le defaut S6 pris par l'autre bout.
    const harness = makePublisher();
    holdRegistryDirectory(harness);
    await harness.publisher.ensurePublished('activation');
    const port = harness.publisher.port as number;

    await waitFor('le renoncement borne', () => !harness.publisher.isPublished);

    expect(harness.delays).toEqual([250, 1_000, 5_000, 30_000]);
    expect(harness.lines.join('\n')).toContain('gives up and closes its local server');
    await expect(get(port, 'peu importe')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('n echelonne RIEN derriere un refus de validation : celui-la se retire tout de suite', async () => {
    // La distinction est le fond du correctif. Une entree impubliable PAR NATURE — fenetre
    // sans dossier de travail — ne redeviendra pas publiable en reessayant : c'est l'evenement
    // de workspace qui la rattrape, et le garde-fou C5 le prouve deja.
    const harness = makePublisher({ workspaceFolders: [] });

    expect(await harness.publisher.ensurePublished('activation')).toBe(false);

    expect(harness.delays).toEqual([]);
    expect(harness.publisher.isPublished).toBe(false);
    expect(harness.lines.join('\n')).toContain('REGISTRY_ENTRY_INVALID');
  });

  it('n empile JAMAIS deux echelles quand deux evenements echouent de suite', async () => {
    // Un octroi de confiance survenu pendant qu'une reprise est en vol rencontre la meme
    // defaillance : il ne doit pas programmer une seconde suite de reprises, qui doublerait
    // les tentatives et fausserait la borne.
    const harness = makePublisher();
    holdRegistryDirectory(harness);

    const outcomes = await Promise.all([
      harness.publisher.ensurePublished('activation'),
      harness.publisher.ensurePublished('workspace trust granted'),
    ]);

    expect(outcomes).toEqual([false, false]);
    expect(harness.delays).toEqual([250]);
  });

  it('attend REELLEMENT le premier echelon quand rien n est injecte', async () => {
    // Le programmateur par defaut est `setTimeout`, non retenant. Ce test-ci est le seul a le
    // laisser agir : il eprouve que la reprise n'a besoin d'AUCUNE injection pour exister.
    const harness = makePublisher({}, { realSchedule: true });
    holdRegistryDirectory(harness);
    expect(await harness.publisher.ensurePublished('activation')).toBe(false);

    releaseRegistryDirectory(harness);
    await waitFor('le premier echelon reel (250 ms)', () => tryReadEntry(harness) !== undefined);

    expect(readEntry(harness).extHostPid).toBe(IDENTITY.extHostPid);
  });

  it('tient une entree deposee sous son nom pour une SUBSTITUTION tant qu elle n a rien publie', async () => {
    // Cas limite du couple C2 + S2 : l'ecoute est ouverte, aucune ecriture n'a abouti, et un
    // fichier porte deja notre nom. Il n'est pas de nous, quoi qu'il contienne.
    const harness = makePublisher();
    holdRegistryDirectory(harness);
    await harness.publisher.ensurePublished('activation');
    releaseRegistryDirectory(harness);
    mkdirSync(harness.dir, { recursive: true });
    writeFileSync(harness.publisher.entryFile, '{"extHostPid": 1}', 'utf8');
    harness.lines.length = 0;

    await harness.publisher.republishIfEntryLost('after the sweep');

    expect(harness.lines.join('\n')).toContain('was REPLACED by an entry that is not ours');
    expect(readEntry(harness).token).toBe(TOKEN);
  });

  it('ne republie plus rien apres la fermeture, meme si une reprise etait programmee', async () => {
    const harness = makePublisher();
    holdRegistryDirectory(harness);
    await harness.publisher.ensurePublished('activation');
    expect(harness.delays).toHaveLength(1);

    await harness.publisher.close('deactivate');
    releaseRegistryDirectory(harness);
    // De quoi laisser toutes les reprises programmees se declencher dans le vide.
    await new Promise((done) => setTimeout(done, 50));

    expect(existsSync(harness.publisher.entryFile)).toBe(false);
    expect(harness.publisher.isPublished).toBe(false);
  });
});

describe('S2 — une entree SUBSTITUEE sous son propre nom doit etre vue', () => {
  /**
   * Ce qu'un processus tournant SOUS LE COMPTE DE L'UTILISATEUR peut ecrire — et il n'a besoin
   * de rien de plus.
   *
   * `extHostPid` et `mainPid` se lisent dans le fichier avant de l'ecraser (le second est de
   * toute facon public dans la table des processus), `startedAt` vaut l'instant present. Seul
   * le CANAL — port et jeton — est celui de l'attaquant. Le nom du fichier, lui, n'a pas a
   * etre choisi : c'est le sien qu'on ecrase.
   */
  function forgeEntry(harness: Harness, port: number): WindowEntry {
    const ours = readEntry(harness);
    const forged: WindowEntry = {
      ...ours,
      port,
      token: 'jeton-de-l-attaquant',
      startedAt: new Date().toISOString(),
    };
    writeFileSync(harness.publisher.entryFile, `${JSON.stringify(forged, null, 2)}\n`, 'utf8');
    return forged;
  }

  function snapshotOfThisProcess(): Parameters<typeof readRegistry>[0]['snapshot'] {
    return {
      table: new Map([[IDENTITY.extHostPid, { ppid: IDENTITY.mainPid, createdAt: undefined }]]),
      capturedAt: Date.now() + 60_000,
    };
  }

  it('la substitution ne laisse AUCUNE anomalie derriere elle — c est ce qui la rend dangereuse', async () => {
    // La decision 5 de l'ADR-003 affirmait que « le nom du fichier est la seule chose qu'un
    // intrus ne controle pas librement ». Mesure ici : il n'a pas besoin de le controler —
    // c'est CE test qui a fait corriger l'ADR, le 2026-07-26.
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    const forged = forgeEntry(harness, 65_000);

    const registry = readRegistry({ snapshot: snapshotOfThisProcess(), dir: harness.dir });

    expect(registry.skipped).toEqual([]);
    expect(registry.windows.map((window) => window.port)).toEqual([forged.port]);
    expect(registry.windows[0]?.token).toBe('jeton-de-l-attaquant');
  });

  it('REPUBLIE quand l entree n est plus la notre, et le dit sous un motif DISTINCT', async () => {
    // LE GARDE-FOU DE NON-REGRESSION DE S2. Avant le correctif, la garde etait un `existsSync`
    // et l'observateur ignorait les modifications : les deux mecanismes de reprise ne
    // defendaient que la SUPPRESSION — le cas benin, repare en quelques millisecondes — et
    // laissaient le REMPLACEMENT passer. Le fichier etant la, la fenetre concluait que tout
    // allait bien.
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    const ours = readEntry(harness);
    forgeEntry(harness, 65_000);

    await harness.publisher.republishIfEntryLost('watcher, entry changed');

    const after = readEntry(harness);
    expect(after.port).toBe(ours.port);
    expect(after.token).toBe(ours.token);
    const journal = harness.lines.join('\n');
    // Un motif NOMME et distinct : un remplacement est un acte, pas l'erreur de tiers qu'une
    // suppression est dans tous les scenarios identifies. L'humain doit le voir passer.
    expect(journal).toContain('was REPLACED by an entry that is not ours');
    expect(journal).not.toContain('vanished');
  });

  it('voit la substitution meme quand l attaquant a conserve le port', async () => {
    // Le jeton suffit a detourner le pilotage : le port peut parfaitement etre le notre si
    // l'attaquant se contente d'attendre que la fenetre libere son ecoute.
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    const ours = readEntry(harness);
    forgeEntry(harness, ours.port);

    await harness.publisher.republishIfEntryLost('watcher, entry changed');

    expect(readEntry(harness).token).toBe(TOKEN);
  });

  it('traite une entree devenue ILLISIBLE comme une substitution, jamais comme la notre', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    writeFileSync(harness.publisher.entryFile, '{ tronque', 'utf8');

    await harness.publisher.republishIfEntryLost('watcher, entry changed');

    expect(readEntry(harness).token).toBe(TOKEN);
    expect(harness.lines.join('\n')).toContain('was REPLACED');
  });

  it('ne confond PAS une republication legitime avec une substitution', async () => {
    // Nos propres ecritures declenchent desormais l'evenement de modification : elles doivent
    // s'y reconnaitre, sans une reecriture ni une ligne de journal. Sans cela, l'observateur
    // se repondrait a lui-meme indefiniment.
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    harness.workspace = { workspaceFolders: ['/ailleurs'], isTrusted: false };
    await harness.publisher.ensurePublished('workspace folders changed');
    const before = readFileSync(harness.publisher.entryFile, 'utf8');
    harness.lines.length = 0;

    await harness.publisher.republishIfEntryLost('watcher, entry changed');

    expect(readFileSync(harness.publisher.entryFile, 'utf8')).toBe(before);
    expect(harness.lines).toEqual([]);
  });
});

describe('S5 — une ecoute morte ne doit jamais rester annoncee par l entree', () => {
  it('RETIRE puis republie quand la socket meurt sans qu on l ait demande', async () => {
    // LE GARDE-FOU DE NON-REGRESSION DE S5, symetrie exacte de S6. Avant le correctif, une
    // defaillance tardive de la socket n'etait que journalisee : l'entree continuait
    // d'annoncer `port` ET `token`. Le port ephemere revient au systeme, un processus local le
    // reobtient — la plage ephemere est reutilisee agressivement —, et le client du lot C
    // presente alors le jeton de la fenetre a l'occupant, sans qu'aucune erreur
    // d'authentification ne le signale.
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    const before = readEntry(harness);

    // MORT TARDIVE ET REELLE : la socket est fermee sans passer par `close()`, seul chemin
    // DELIBERE. Rien n'est simule.
    const socket = harness.publisher.server?.socket;
    expect(socket).toBeDefined();
    await new Promise<void>((done) => socket?.close(() => done()));

    await waitFor(
      'la reouverture sur un nouveau port',
      () => tryReadEntry(harness)?.port !== undefined && tryReadEntry(harness)?.port !== before.port
    );

    const after = readEntry(harness);
    expect(after.port).not.toBe(before.port);
    // Le jeton, lui, est propre a la FENETRE et a la session, pas a l'ecoute : il ne change pas.
    expect(after.token).toBe(before.token);
    expect(await get(after.port, after.token)).toBe(200);
    expect(harness.lines.join('\n')).toContain('closed without being asked to');
  });

  it('ne laisse JAMAIS le couple port mort + jeton sur disque', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    const before = readEntry(harness);

    const socket = harness.publisher.server?.socket;
    await new Promise<void>((done) => socket?.close(() => done()));
    await waitFor('la reprise', () => tryReadEntry(harness)?.port !== before.port);

    // L'ancien port est bien mort, et plus rien ne l'annonce.
    await expect(get(before.port, before.token)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(readEntry(harness).port).not.toBe(before.port);
  });

  it('RENONCE apres cinq morts d ecoute, plutot que de rouvrir indefiniment', async () => {
    // Une socket en ecoute sur la boucle locale ne meurt pas d'elle-meme : cinq morts
    // d'affilee designent un poste ou l'ecoute n'est pas tenable. On le DIT alors, au lieu de
    // rouvrir en boucle un serveur que rien ne garde ouvert (principe fondateur n.3).
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');

    const gaveUp = (): boolean =>
      harness.lines.join('\n').includes('stays unpublished until it is reloaded');

    for (let loss = 0; loss < 5; loss += 1) {
      const socket = harness.publisher.server?.socket;
      expect(socket, `mort n.${loss + 1}`).toBeDefined();
      await new Promise<void>((done) => socket?.close(() => done()));
      // Le retrait efface `live` AVANT de rouvrir : attendre « plus le meme serveur » suffirait
      // a repartir au milieu de la transition. On attend son ABOUTISSEMENT — une ecoute neuve,
      // ou le renoncement.
      await waitFor(
        `la transition de la mort n.${loss + 1}`,
        () => gaveUp() || (harness.publisher.server !== undefined && harness.publisher.server.socket !== socket)
      );
    }

    expect(harness.publisher.isPublished).toBe(false);
    expect(existsSync(harness.publisher.entryFile)).toBe(false);
    expect(harness.lines.join('\n')).toContain('stays unpublished until it is reloaded');
  });

  it('ne republie RIEN derriere une fermeture DELIBEREE', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');

    await harness.publisher.close('deactivate');
    // Une republication rouvrirait une ecoute que plus rien ne fermerait.
    await new Promise((done) => setTimeout(done, 50));

    expect(existsSync(harness.publisher.entryFile)).toBe(false);
    expect(harness.publisher.isPublished).toBe(false);
  });
});

describe('retrait', () => {
  it('retire l entree ET ferme l ecoute — les deux vont ensemble', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    const port = harness.publisher.port as number;

    await harness.publisher.close('deactivate');

    expect(existsSync(harness.publisher.entryFile)).toBe(false);
    await expect(get(port, 'peu importe')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('accepte une entree deja balayee par une autre fenetre', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    rmSync(harness.publisher.entryFile, { force: true });

    await expect(harness.publisher.close('deactivate')).resolves.toBeUndefined();
  });

  it('ne touche AUCUNE autre entree du registre', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    const neighbour = path.join(harness.dir, '11172.json');
    writeFileSync(neighbour, '{}', 'utf8');

    await harness.publisher.close('deactivate');

    expect(existsSync(neighbour)).toBe(true);
  });

  it('rapporte le retrait dans le journal, jamais en silence', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');

    await harness.publisher.close('deactivate');

    expect(harness.lines.join('\n')).toContain('window withdrawn (deactivate)');
  });

  it('ne fait rien quand la fenetre n avait jamais ete publiee', async () => {
    const harness = makePublisher({ workspaceFolders: [] });

    await expect(harness.publisher.close('deactivate')).resolves.toBeUndefined();
  });

  it('ferme l ecoute meme si l entree resiste, et le dit sans laisser passer le chemin', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    const port = harness.publisher.port as number;
    // Une VRAIE defaillance de suppression : le nom de l'entree porte desormais un
    // repertoire non vide, que `rmSync` sans `recursive` refuse de retirer.
    rmSync(harness.publisher.entryFile, { force: true });
    mkdirSync(harness.publisher.entryFile);
    writeFileSync(path.join(harness.publisher.entryFile, 'intrus'), 'x', 'utf8');

    await harness.publisher.close('deactivate');

    const journal = harness.lines.join('\n');
    expect(journal).toContain("could not remove this window's registry entry");
    expect(journal).not.toContain(harness.dir);
    // L'ecoute est fermee malgre tout : un echec de retrait n'abandonne pas une socket.
    await expect(get(port, 'peu importe')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});

describe('serialisation des transitions', () => {
  it('n ouvre JAMAIS deux serveurs quand deux evenements se suivent de pres', async () => {
    // Sans file d'attente, deux transitions concurrentes ouvriraient deux ecoutes dont une
    // seule serait retenue : une socket orpheline, exactement ce que S6 reproche.
    const harness = makePublisher();

    const [a, b, c] = await Promise.all([
      harness.publisher.ensurePublished('activation'),
      harness.publisher.ensurePublished('workspace trust granted'),
      harness.publisher.ensurePublished('workspace folders changed'),
    ]);

    expect([a, b, c]).toEqual([true, true, true]);
    const listening = harness.lines.filter((line) => line.startsWith('local server listening'));
    expect(listening).toHaveLength(1);
  });

  it('ne rompt pas la file quand une transition echoue', async () => {
    // L'etat suit l'ORDRE des transitions : la premiere voit une fenetre sans dossier — donc
    // refusee —, les suivantes une fenetre valide. Si un refus rompait la chaine, les deux
    // dernieres ne partiraient jamais.
    const harness = makePublisher({ workspaceFolders: [] });
    let reads = 0;
    harness.readWorkspace = () =>
      reads++ === 0 ? { workspaceFolders: [], isTrusted: true } : { workspaceFolders: FOLDERS, isTrusted: true };

    const outcomes = await Promise.all([
      harness.publisher.ensurePublished('activation'),
      harness.publisher.ensurePublished('workspace folders changed'),
      harness.publisher.ensurePublished('workspace trust granted'),
    ]);

    expect(outcomes).toEqual([false, true, true]);
    expect(existsSync(harness.publisher.entryFile)).toBe(true);
  });

  it('journalise ce que personne n a prevu, et la file repart', async () => {
    // L'API de l'editeur peut lever : `workspace.workspaceFolders` est lu a chaque
    // publication, et une transition qui remonte une exception ne doit ni disparaitre en
    // silence, ni emporter les suivantes.
    const harness = makePublisher();
    harness.readWorkspace = () => {
      throw new TypeError('the editor said no');
    };

    expect(await harness.publisher.ensurePublished('activation')).toBe(false);
    expect(harness.lines.join('\n')).toContain('a publication transition failed unexpectedly');

    harness.readWorkspace = () => harness.workspace;
    expect(await harness.publisher.ensurePublished('retry')).toBe(true);
  });
});

describe('/health', () => {
  it('relit l etat du workspace a chaque requete, jamais fige a la publication', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    const entry = readEntry(harness);

    harness.workspace = { workspaceFolders: ['/ailleurs'], isTrusted: false };

    const body = await getBody(entry.port, entry.token);

    // L'entree sur disque, elle, decrit toujours l'etat publie : c'est `/health` qui vit.
    expect(JSON.parse(body)).toMatchObject({ isTrusted: false, workspaceFolders: ['/ailleurs'] });
    expect(readEntry(harness).isTrusted).toBe(true);
  });

  it('rend le chemin REEL du workspace — le masque d affichage ne l atteint jamais', async () => {
    // CONTRE-EPREUVE DE S6. `redactWindowEntry` masque desormais le prefixe du repertoire
    // personnel, mais c'est une fonction d'AFFICHAGE : ni l'entree ecrite, ni `/health` —
    // qui ne repond qu'a qui detient le jeton — ne doivent en dependre. Le lot C y compare
    // le `cwd` d'une session au workspace de la fenetre (piege n.3), et un chemin masque ne
    // se compare pas.
    const folder = path.join(os.homedir(), 'Documents', 'Github', 'ClaudeManager');
    const harness = makePublisher({ workspaceFolders: [folder] });

    expect(await harness.publisher.ensurePublished('activation')).toBe(true);
    const entry = readEntry(harness);

    expect(entry.workspaceFolders).toEqual([folder]);
    expect(JSON.parse(await getBody(entry.port, entry.token))).toMatchObject({
      workspaceFolders: [folder],
    });
  });

  it('publie le repertoire de journal, sans quoi cmgr doctor ne peut pas le trouver', async () => {
    // DEFAUT C6 : l'intitule annoncait cette garde et l'assertion verifiait que `entryFile`
    // commence par le repertoire du registre — propriete vraie PAR CONSTRUCTION, sans le
    // moindre rapport avec `logDirectory`. Le report de `options.logDirectory` vers
    // `HealthPayload.logDirectory` etait donc couvert a 100 % et eprouve par RIEN : le
    // remplacer par une chaine vide laissait les tests verts, et `cmgr doctor` (lot D) ne
    // trouvait plus le journal — dont le chemin comporte deux segments indevinables.
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    const entry = readEntry(harness);

    const health = JSON.parse(await getBody(entry.port, entry.token)) as Record<string, unknown>;

    expect(health['logDirectory']).toBe(harness.logDirectory);
    // Et il n'est PAS dans l'entree de registre : son contenu est un contrat entre versions
    // qu'on n'elargit pas pour un besoin de diagnostic (ADR-003, decision 8).
    expect(Object.keys(entry)).not.toContain('logDirectory');
  });
});
