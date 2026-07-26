import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WindowEntry } from '../../../packages/core/src/index.js';
import {
  WindowPublisher,
  type PublisherOptions,
  type WorkspaceState,
} from '../../../packages/vscode/src/publication.js';

/**
 * Le cycle de vie de la publication — VRAIES sockets, VRAI repertoire de registre.
 *
 * C'est ici que vivent les deux garde-fous de non-regression du gate : C5 (un refus de
 * publication retirait la fenetre DEFINITIVEMENT) et S6 (un serveur survivait a la
 * disparition de son entree). Aucun des deux n'etait eprouvable avant que ce cycle ne soit
 * separe de `vscode` — c'est precisement pourquoi ils avaient echappe a une CI verte.
 *
 * Le seul element injecte est l'etat du workspace, que seul un editeur connait : ce n'est
 * pas un faux `vscode`, c'est le parametre que la fonction attend.
 */

const IDENTITY = { extHostPid: process.pid, mainPid: process.ppid };
const FOLDERS = ['c:\\Users\\user\\Documents\\Github\\ClaudeManager'];

const temporaries: string[] = [];
const publishers: WindowPublisher[] = [];

function makeRegistryDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cmgr-publication-'));
  temporaries.push(dir);
  return dir;
}

interface Harness {
  readonly publisher: WindowPublisher;
  readonly dir: string;
  readonly lines: string[];
  workspace: WorkspaceState;
  /** Surcharge du releve : par defaut, il rend `workspace`. */
  readWorkspace: () => WorkspaceState;
}

function makePublisher(initial?: Partial<WorkspaceState>): Harness {
  const dir = makeRegistryDir();
  const lines: string[] = [];
  const harness = {
    dir,
    lines,
    workspace: {
      workspaceFolders: initial?.workspaceFolders ?? FOLDERS,
      isTrusted: initial?.isTrusted ?? true,
    },
    readWorkspace: (): WorkspaceState => harness.workspace,
  } as Harness & { publisher: WindowPublisher };

  const options: PublisherOptions = {
    identity: IDENTITY,
    extensionVersion: '0.2.0',
    token: '00000000-0000-0000-0000-000000000000',
    logDirectory: path.join(dir, 'logs'),
    readWorkspace: () => harness.readWorkspace(),
    log: (message) => lines.push(message),
    registryDir: dir,
  };

  harness.publisher = new WindowPublisher(options);
  publishers.push(harness.publisher);
  return harness;
}

function readEntry(harness: Harness): WindowEntry {
  return JSON.parse(readFileSync(harness.publisher.entryFile, 'utf8')) as WindowEntry;
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

    await harness.publisher.republishIfEntryVanished('after the sweep');

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

    await harness.publisher.republishIfEntryVanished('after the sweep');

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

    await harness.publisher.republishIfEntryVanished('watcher');

    expect(existsSync(harness.publisher.entryFile)).toBe(false);
    expect(harness.publisher.isPublished).toBe(false);
  });

  it('ne republie plus rien apres la fermeture du cycle de vie', async () => {
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');
    await harness.publisher.close('deactivate');

    await harness.publisher.republishIfEntryVanished('watcher');
    expect(await harness.publisher.ensurePublished('trop tard')).toBe(false);

    expect(existsSync(harness.publisher.entryFile)).toBe(false);
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
    const harness = makePublisher();
    await harness.publisher.ensurePublished('activation');

    expect(harness.publisher.entryFile.startsWith(harness.dir)).toBe(true);
  });
});
