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
 * Aucun cadre de test : `node:assert/strict`. Un echec leve, et `runTests` le rapporte.
 */

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  readProcessTable,
  readRegistry,
  redactWindowEntry,
  resolveOwningWindow,
  resolveRegistryDir,
  WINDOW_ENTRY_SCHEMA_VERSION,
  type WindowEntry,
} from '../../../packages/core/src/index.js';

const EXTENSION_ID = 'claudemanager.claudemanager-vscode';
const EXPECTED_VERSION = '0.2.0';

/** Entrees heritees du poste : attendues en `foreign-schema`, JAMAIS supprimees. */
const LEGACY_ENTRIES = ['11172.json', '17544.json'];

interface HttpProbe {
  readonly label: string;
  readonly status: number | string;
  readonly body: string;
  readonly carriesToken: boolean;
}

function probe(port: number, route: string, headers: Record<string, string>): Promise<{ status: number | string; body: string }> {
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

export async function run(): Promise<void> {
  const reportPath = process.env['CMGR_B3_REPORT'];
  const userDataDir = process.env['CMGR_B3_USER_DATA'];
  assert.ok(reportPath, 'CMGR_B3_REPORT must be provided by the launcher');
  assert.ok(userDataDir, 'CMGR_B3_USER_DATA must be provided by the launcher');

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

  // Point 9 : aucune reponse ne porte le jeton.
  const leakingProbe = probes.find((p) => p.carriesToken);
  assert.equal(leakingProbe, undefined, `a response carried the token: ${leakingProbe?.label}`);

  // ---- Point 5 : ecoute strictement locale ---------------------------------------------
  const lanAddress = firstNonLoopbackIPv4();
  const lanResult = lanAddress === undefined ? 'AUCUNE ADRESSE NON-LOOPBACK' : await probeAddress(lanAddress, port);
  if (lanAddress !== undefined) {
    assert.ok(lanResult.startsWith('ERR('), `the server must not answer on ${lanAddress}, got ${lanResult}`);
  }

  // ---- Point 6 : isolation ------------------------------------------------------------
  const snapshot = await readProcessTable();
  const registry = readRegistry({ snapshot });
  const owner = resolveOwningWindow(extHostPid, snapshot.table, registry.windows);
  assert.ok(owner, 'this window must claim its own extension host');
  assert.equal(owner.extHostPid, extHostPid, 'resolveOwningWindow must return THIS window');

  // Les entrees heritees du poste, si presentes, sont ecartees — jamais pilotees.
  const legacySkips = registry.skipped.filter((s) => LEGACY_ENTRIES.includes(s.file));
  for (const skip of legacySkips) {
    assert.equal(skip.reason, 'foreign-schema', `${skip.file} must be classified foreign-schema`);
  }
  assert.ok(
    !registry.windows.some((w) => LEGACY_ENTRIES.includes(`${w.extHostPid}.json`)),
    'a legacy entry must never appear among steerable windows'
  );

  // ---- Points 1, 7 et 9 : le journal persiste -----------------------------------------
  const logFile = await waitFor('the persisted log channel', () => findLogFile(userDataDir), 15_000);
  // Le balayage est differe : on attend sa ligne, ce qui prouve du meme coup qu'il a lieu
  // APRES l'activation et non pendant.
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
  const sweepIndex = Math.max(logText.indexOf('sweep completed'), logText.indexOf('sweep failed'));
  assert.ok(publishedIndex >= 0, 'the log must record the publication');
  assert.ok(sweepIndex > publishedIndex, 'the sweep must be reported AFTER the publication');

  const tokenInLog = logText.includes(token);
  assert.equal(tokenInLog, false, 'the token must never reach the persisted log');

  const report = {
    vscodeVersion: vscode.version,
    extensionId: EXTENSION_ID,
    activeBeforeWeAsked,
    extHostPid,
    mainPid,
    port,
    entry: redactWindowEntry(rawEntry),
    probes: probes.map((p) => ({ label: p.label, status: p.status, body: p.body })),
    loopbackOnly: { address: lanAddress ?? null, result: lanResult },
    isolation: {
      resolvedExtHostPid: owner.extHostPid,
      steerableWindows: registry.windows.map((w) => w.extHostPid),
      skipped: registry.skipped,
      legacyClassification: legacySkips,
    },
    log: {
      file: path.basename(logFile),
      activationMs: activationMs ?? null,
      sweepMs: sweepMs ?? null,
      sweepReportedAfterPublication: sweepIndex > publishedIndex,
      tokenInLog,
    },
    tokenInAnyResponse: false,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
}
