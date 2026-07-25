/**
 * Suite d'integration B3 — elle s'execute DANS l'extension host d'un vrai VSCode.
 *
 * Elle rejoue les points du §7 de l'increment : activation, entree publiee, identite,
 * `/health`, ecoute locale, isolation, balayage differe, absence de fuite du jeton.
 *
 * PORTEE VOLONTAIREMENT ETROITE : c'est le strict harnais qui prouve B3. La republication
 * sur octroi de confiance ou changement de dossiers, l'enumeration d'onglets et les
 * scenarios multi-fenetres relevent de B5 et ne sont pas couverts ici.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * CETTE SUITE TRAVAILLE SUR LE REGISTRE REEL DU POSTE — c'est VOULU, et ce n'etait dit nulle
 * part (finding C8 du gate, que le lecteur du code pouvait raisonnablement croire faux).
 *
 * Pourquoi : la fenetre sous test publie son entree par le chemin de PRODUCTION, sans
 * surcharge de repertoire — c'est precisement ce qui donne son sens au point 6. Prouver
 * l'isolation dans un registre vide et dedie ne prouverait rien : l'invariant du produit,
 * c'est qu'une fenetre ne revendique pas les autres AU MILIEU des autres, entrees heritees
 * du poste comprises. Un registre de laboratoire supprimerait le seul voisinage qui compte.
 *
 * Ce que la suite s'autorise a ecrire dans ce registre reel :
 *   - l'entree de la fenetre de test elle-meme, retiree par `deactivate` (point 8) ;
 *   - UNE entree d'un schema etranger qu'elle fabrique et supprime elle-meme, nommee d'apres
 *     un pid choisi a l'execution, dont elle verifie qu'aucun fichier ne portait deja le nom.
 *
 * Ce qu'elle ne fait JAMAIS : supprimer une entree qu'elle n'a pas ecrite. Le seul retrait
 * qu'elle opere est celui de son propre fichier fabrique, et il est garde par une
 * comparaison de contenu — si le fichier n'est plus le sien, elle n'y touche pas.
 *
 * Le BALAYAGE, lui, supprime bel et bien des entrees mortes du poste : c'est le comportement
 * de production de l'extension, pas un acte de la suite, et c'est exactement ce qu'on veut
 * eprouver. Une entree vivante n'en est jamais la cible.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Aucun cadre de test : `node:assert/strict`. Un echec leve, et `runTests` le rapporte.
 */

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { mask } from './redaction.js';
import {
  readProcessTable,
  readRegistry,
  redactWindowEntry,
  resolveOwningWindow,
  resolveRegistryDir,
  WINDOW_ENTRY_SCHEMA_VERSION,
  type ProcessSnapshot,
  type WindowEntry,
} from '../../../packages/core/src/index.js';

const EXTENSION_ID = 'claudemanager.claudemanager-vscode';
const EXPECTED_VERSION = '0.2.0';

/**
 * Entrees heritees REELLES du poste de reference.
 *
 * Elles ne portent plus AUCUNE assertion, et c'est la correction du finding C6 : elles sont
 * nommees par des pid releves le 2026-07-24, et le jour ou ces processus meurent le balayage
 * les classe `dead` puis les supprime — apres quoi les deux assertions qui les visaient
 * passaient a vide. La preuve se detruisait elle-meme en s'executant.
 *
 * Elles restent OBSERVEES, et rapportees telles quelles : leur presence et leur
 * classification sont un renseignement sur l'etat du poste, pas une preuve. La preuve, elle,
 * est fabriquee a l'execution — voir `plantForeignEntry`.
 *
 * Aucun chemin de cette suite ne les supprime.
 */
const LEGACY_ENTRIES = ['11172.json', '17544.json'];

/** Le 0.1.0 reel, capture et anonymise : `tests/fixtures/registry/legacy-0.1.0/`. */
const LEGACY_FIXTURE = ['tests', 'fixtures', 'registry', 'legacy-0.1.0', '11172.json'];

interface HttpProbe {
  readonly label: string;
  readonly status: number | string;
  readonly body: string;
  readonly carriesToken: boolean;
}

function probe(
  port: number,
  route: string,
  headers: Record<string, string>
): Promise<{ status: number | string; body: string }> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: route, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', (error: NodeJS.ErrnoException) => resolve({ status: `ERR(${error.code})`, body: '' }));
    req.end();
  });
}

/** Tente la MEME socket depuis une adresse non-loopback de la machine. */
function probeAddress(address: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const req = request({ host: address, port, path: '/health', method: 'GET', timeout: 4000 }, (res) =>
      resolve(`REPONDU(${res.statusCode})`)
    );
    req.on('error', (error: NodeJS.ErrnoException) => resolve(`ERR(${error.code})`));
    req.on('timeout', () => {
      req.destroy();
      resolve('ERR(TIMEOUT)');
    });
    req.end();
  });
}

function firstNonLoopbackIPv4(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return undefined;
}

/** Localise le journal persiste du canal `{ log: true }` sous le user-data-dir du run. */
function findLogFile(userDataDir: string): string | undefined {
  const logs = path.join(userDataDir, 'logs');
  if (!fs.existsSync(logs)) return undefined;

  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.name.toLowerCase().includes('claudemanager') && item.name.endsWith('.log')) {
        found.push(full);
      }
    }
  };
  walk(logs);
  return found[0];
}

async function waitFor<T>(what: string, attempt: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = attempt();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

interface PlantedEntry {
  readonly pid: number;
  readonly file: string;
  readonly content: string;
}

/**
 * Depose dans le registre REEL une entree d'un schema etranger, nommee d'apres un pid
 * VIVANT choisi a l'execution.
 *
 * C'est la preuve que les deux assertions supprimees ne fournissaient pas : elle ne depend
 * d'aucun pid historique, donc elle ne peut pas s'evaporer avec le temps. Le pid retenu est
 * `process.ppid` — le `Code.exe` principal de l'instance de test —, vivant par construction
 * puisqu'il nous heberge, et qui n'est jamais un extension host, donc jamais le nom d'une
 * entree legitime.
 *
 * Le CONTENU est la fixture 0.1.0 reelle, capturee sur ce poste et anonymisee : seul le
 * `extHostPid` y est repointe, parce que le nom du fichier doit correspondre a l'identite
 * revendiquee (le coeur classe `identity-mismatch` sinon). Rien n'est fabrique a la main.
 *
 * Rend `undefined` si un fichier porte deja ce nom : on n'ecrase jamais une entree qui n'est
 * pas la notre, quitte a perdre le point.
 */
function plantForeignEntry(repoRoot: string, registryDir: string): PlantedEntry | undefined {
  const pid = process.ppid;
  const file = path.join(registryDir, `${pid}.json`);
  if (fs.existsSync(file)) return undefined;

  const fixture = JSON.parse(
    fs.readFileSync(path.join(repoRoot, ...LEGACY_FIXTURE), 'utf8')
  ) as Record<string, unknown>;
  const content = `${JSON.stringify({ ...fixture, extHostPid: pid }, null, 2)}\n`;

  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return { pid, file, content };
}

/**
 * Retire l'entree fabriquee — et ELLE SEULE.
 *
 * Garde de contenu : si le fichier a change depuis qu'on l'a ecrit, il n'est plus le notre
 * et on n'y touche pas. Le harnais ecrit dans le registre de production ; il n'a le droit de
 * detruire que ce qu'il a lui-meme depose.
 */
function unplantForeignEntry(planted: PlantedEntry | undefined): string {
  if (planted === undefined) return 'aucune entree fabriquee';
  let onDisk: string;
  try {
    onDisk = fs.readFileSync(planted.file, 'utf8');
  } catch {
    return 'deja disparue';
  }
  if (onDisk !== planted.content) return 'LAISSEE EN PLACE : le contenu a change, elle n est plus la notre';
  fs.rmSync(planted.file, { force: true });
  return 'retiree';
}

export async function run(): Promise<void> {
  const reportPath = process.env['CMGR_B3_REPORT'];
  const userDataDir = process.env['CMGR_B3_USER_DATA'];
  const repoRoot = process.env['CMGR_B3_REPO_ROOT'];
  assert.ok(reportPath, 'CMGR_B3_REPORT must be provided by the launcher');
  assert.ok(userDataDir, 'CMGR_B3_USER_DATA must be provided by the launcher');
  assert.ok(repoRoot, 'CMGR_B3_REPO_ROOT must be provided by the launcher');

  // ---- Point 1 : l'extension est active -----------------------------------------------
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not installed in this window`);

  // Releve AVANT toute intervention : `onStartupFinished` doit l'avoir activee seule.
  const activeBeforeWeAsked = extension.isActive;
  await extension.activate();
  assert.equal(extension.isActive, true, 'Extension failed to activate');

  const extHostPid = process.pid;
  const mainPid = process.ppid;

  // ---- Point 2 et 3 : l'entree publiee decrit CETTE fenetre ----------------------------
  const registryDir = resolveRegistryDir();
  const entryFile = path.join(registryDir, `${extHostPid}.json`);
  const rawEntry = await waitFor(
    `the registry entry ${extHostPid}.json`,
    () => (fs.existsSync(entryFile) ? (JSON.parse(fs.readFileSync(entryFile, 'utf8')) as WindowEntry) : undefined),
    15_000
  );

  assert.equal(rawEntry.schemaVersion, WINDOW_ENTRY_SCHEMA_VERSION, 'schemaVersion must come from the core');
  assert.equal(rawEntry.extensionVersion, EXPECTED_VERSION, 'extensionVersion must be 0.2.0');
  assert.equal(rawEntry.extHostPid, extHostPid, 'extHostPid must be this extension host');
  assert.equal(rawEntry.mainPid, mainPid, 'mainPid must be the real ppid of this extension host');
  assert.ok(rawEntry.workspaceFolders.length > 0, 'a publishable window always has a workspace');

  const token = rawEntry.token;
  const port = rawEntry.port;

  // ---- Point 4 : /health, et les deux branches de la comparaison a temps constant ------
  const sameLengthWrongToken = token.replace(/./, (c) => (c === '0' ? '1' : '0'));
  assert.equal(sameLengthWrongToken.length, token.length, 'the wrong token must be the same length');

  const probes: HttpProbe[] = [];
  const cases: ReadonlyArray<readonly [string, string, Record<string, string>]> = [
    ['GET /health + jeton valide -> 200', '/health', { authorization: `Bearer ${token}` }],
    ['GET /health sans jeton -> 401', '/health', {}],
    ['GET /health + faux jeton de MEME longueur -> 401', '/health', { authorization: `Bearer ${sameLengthWrongToken}` }],
    ['GET /inconnue + jeton valide -> 404', '/inconnue', { authorization: `Bearer ${token}` }],
  ];
  for (const [label, route, headers] of cases) {
    const result = await probe(port, route, headers);
    probes.push({ label, status: result.status, body: result.body, carriesToken: result.body.includes(token) });
  }

  assert.equal(probes[0]?.status, 200, '/health with a valid token must answer 200');
  assert.equal(probes[1]?.status, 401, '/health without a token must answer 401');
  assert.equal(probes[2]?.status, 401, '/health with a same-length wrong token must answer 401');
  assert.equal(probes[3]?.status, 404, 'an unknown route with a valid token must answer 404');

  const health = JSON.parse(probes[0]?.body ?? '{}') as Record<string, unknown>;
  assert.equal(health['ok'], true);
  assert.equal(health['extHostPid'], extHostPid);
  assert.equal(health['mainPid'], mainPid);
  assert.equal(health['schemaVersion'], WINDOW_ENTRY_SCHEMA_VERSION);
  assert.equal(health['extensionVersion'], EXPECTED_VERSION);

  // Point 9 : aucune reponse ne porte le jeton. MESURE, sur les quatre reponses — le rapport
  // affichait jusqu'ici la constante litterale `false`, c'est-a-dire rien (finding C6).
  const tokenInAnyResponse = probes.some((p) => p.carriesToken);
  assert.equal(tokenInAnyResponse, false, `a response carried the token: ${probes.find((p) => p.carriesToken)?.label}`);

  // ---- Point 5 : ecoute strictement locale ---------------------------------------------
  // PREUVE DIRECTE, cote serveur : l'adresse est relevee sur la socket elle-meme
  // (`server.address()`), pas recopiee d'une constante. Sans elle, le point reposait sur la
  // seule absence de reponse ailleurs — ce qu'un pare-feu produit tout aussi bien.
  assert.equal(health['listenAddress'], '127.0.0.1', 'the server must be bound to the loopback');

  const lanAddress = firstNonLoopbackIPv4();
  const lanResult = lanAddress === undefined ? 'AUCUNE ADRESSE NON-LOOPBACK' : await probeAddress(lanAddress, port);
  if (lanAddress !== undefined) {
    // SEUL UN REFUS PROUVE QUELQUE CHOSE. `ERR(TIMEOUT)` est INDETERMINE — c'est le verdict
    // qu'un pare-feu Windows rend devant un serveur lie a `0.0.0.0`, donc exactement le cas
    // qu'on veut exclure — et un resultat indetermine echoue le point (finding C6).
    assert.equal(
      lanResult,
      'ERR(ECONNREFUSED)',
      `the LAN probe must be REFUSED, not merely unanswered; got ${lanResult}`
    );
  }

  // ---- Point 6 : isolation ------------------------------------------------------------
  const snapshot: ProcessSnapshot = await readProcessTable();

  // Une entree d'un schema etranger, deposee MAINTENANT sur un pid vivant : la preuve ne
  // depend plus de pids releves il y a un an. Elle est retiree quoi qu'il arrive.
  const planted = plantForeignEntry(repoRoot, registryDir);
  let isolation: Record<string, unknown> = {};
  let unplanted = 'jamais tentee';
  try {
    assert.ok(planted, 'the foreign entry must have been planted (a file already claimed that pid?)');
    // ASSERER SA PRESENCE AVANT DE LA CLASSER : sans cela, un fichier absent produirait
    // exactement le silence que cette suite est censee rendre impossible.
    assert.ok(fs.existsSync(planted.file), 'the planted foreign entry must be on disk');
    assert.ok(snapshot.table.has(planted.pid), 'the planted entry must name a LIVE pid');

    const registry = readRegistry({ snapshot, dir: registryDir });
    const owner = resolveOwningWindow(extHostPid, snapshot.table, registry.windows);
    assert.ok(owner, 'this window must claim its own extension host');
    assert.equal(owner.extHostPid, extHostPid, 'resolveOwningWindow must return THIS window');

    const skip = registry.skipped.find((s) => s.file === `${planted.pid}.json`);
    assert.ok(skip, 'the planted foreign entry must be reported among the skipped ones');
    assert.equal(skip.reason, 'foreign-schema', 'a live entry of another schema is foreign, never invalid');
    assert.ok(
      !registry.windows.some((w) => w.extHostPid === planted.pid),
      'a foreign entry must never appear among steerable windows, even with a live pid'
    );

    // Observation, PAS une preuve : ce que le poste porte reellement au moment du rejeu.
    const legacyObserved = registry.skipped.filter((s) => LEGACY_ENTRIES.includes(s.file));

    isolation = {
      resolvedExtHostPid: owner.extHostPid,
      steerableWindows: registry.windows.map((w) => w.extHostPid),
      skipped: registry.skipped,
      plantedForeignEntry: { pid: planted.pid, classification: skip.reason },
      legacyEntriesObserved: legacyObserved,
    };
  } finally {
    unplanted = unplantForeignEntry(planted);
  }
  assert.equal(unplanted, 'retiree', 'the planted entry must have been removed by the suite itself');

  // ---- Points 1, 7 et 9 : le journal persiste -----------------------------------------
  const logFile = await waitFor('the persisted log channel', () => findLogFile(userDataDir), 15_000);
  const logText = await waitFor(
    'the deferred sweep to report in the log',
    () => {
      const text = fs.readFileSync(logFile, 'utf8');
      return text.includes('sweep completed') || text.includes('sweep failed') ? text : undefined;
    },
    60_000
  );

  const activationMs = /activation completed in ([\d.]+) ms/.exec(logText)?.[1];
  const sweepMs = /sweep completed in (\d+) ms/.exec(logText)?.[1];
  const publishedIndex = logText.indexOf('published (activation)');
  const activationIndex = logText.indexOf('activation completed');
  const sweepIndex = Math.max(logText.indexOf('sweep completed'), logText.indexOf('sweep failed'));
  assert.ok(publishedIndex >= 0, 'the log must record the publication');
  assert.ok(activationIndex >= 0, 'the log must record the end of activation');
  assert.ok(sweepIndex > publishedIndex, 'the sweep must be reported AFTER the publication');
  // CE QU'ON PROUVE ICI, ET RIEN D'AUTRE : le balayage est rapporte apres la FIN de
  // l'activation, donc `activate` a bel et bien rendu la main sans l'attendre. La comparaison
  // precedente portait sur la publication — vraie aussi d'un appel synchrone en fin
  // d'`activate`, donc sans valeur probante (finding C6).
  assert.ok(
    sweepIndex > activationIndex,
    'the sweep must be reported AFTER activation completed, which is what proves it is deferred'
  );

  const tokenInLog = logText.includes(token);
  assert.equal(tokenInLog, false, 'the token must never reach the persisted log');

  // R5 : le journal designe comme source de diagnostic de `cmgr doctor` doit etre
  // LOCALISABLE par un consommateur. La fenetre publie son repertoire de journal sur
  // `/health` ; on verifie que le fichier reellement trouve en depend, plutot que de
  // supposer que le chemin publie sert a quelque chose.
  const logDirectory = health['logDirectory'];
  assert.equal(typeof logDirectory, 'string', '/health must publish the log directory');
  // MESURE, et non suppose : le fichier du canal se trouve DANS le repertoire publie. C'est
  // ce qui rend `cmgr doctor` (lot D) realisable — sans cette valeur, le chemin comportait
  // deux segments indevinables (l'horodatage de session et `window<N>`) et le journal etait
  // introuvable de l'exterieur.
  assert.ok(
    logFile.toLowerCase().startsWith((logDirectory as string).toLowerCase()),
    'the persisted channel must be found INSIDE the log directory published on /health'
  );

  const report = {
    vscodeVersion: vscode.version,
    extensionId: EXTENSION_ID,
    activeBeforeWeAsked,
    extHostPid,
    mainPid,
    port,
    entry: redactWindowEntry({ ...rawEntry, workspaceFolders: rawEntry.workspaceFolders.map(mask) }),
    // Les corps de reponse portent les dossiers du workspace et le repertoire de journal,
    // tous absolus : masques, jamais retires — leur forme reste diagnostique.
    probes: probes.map((p) => ({ label: p.label, status: p.status, body: mask(p.body) })),
    // L'ADRESSE LAN N'EST PAS IMPRIMEE : le plan d'adressage interne du poste n'a rien a
    // faire dans une PR publique, et seul le verdict a une valeur de preuve (finding S7).
    loopbackOnly: {
      listenAddress: health['listenAddress'],
      lanProbeAttempted: lanAddress !== undefined,
      result: lanResult,
    },
    isolation,
    plantedEntryCleanup: unplanted,
    log: {
      file: path.basename(logFile),
      // Relatif au repertoire de journal publie : c'est ce qui rend le chemin verifiable
      // sans rien reveler du poste.
      pathBelowPublishedLogDirectory: mask(path.relative(logDirectory as string, logFile)),
      activationMs: activationMs ?? null,
      sweepMs: sweepMs ?? null,
      sweepReportedAfterActivationCompleted: sweepIndex > activationIndex,
      tokenInLog,
    },
    tokenInAnyResponse,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
}
