/**
 * Outillage commun aux scenarios d'integration — ce qui SONDE, jamais ce qui ASSERTE.
 *
 * Ce module ne porte aucune assertion : il rend des mesures, et chaque scenario en tire ses
 * propres conclusions. Il vit hors de `suite.ts` parce qu'il y a desormais plusieurs
 * scenarios, lances chacun dans sa propre fenetre VSCode, et que deux implementations de la
 * meme sonde auraient diverge le jour ou l'une aurait ete corrigee.
 *
 * Aucun import de `vscode` ici : ce sont des sondes de processus et de reseau.
 */

import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/** Ce que le lanceur transmet a chaque scenario par l'environnement. */
export interface ScenarioContext {
  readonly reportPath: string;
  readonly userDataDir: string;
  readonly repoRoot: string;
  /** Repertoire de travail propre au scenario, ou il depose ce dont il a besoin. */
  readonly scratchDir: string;
}

export interface HttpProbe {
  readonly label: string;
  /** Statut HTTP, ou `ERR(<code systeme>)` quand la socket n'a rien voulu savoir. */
  readonly status: number | string;
  readonly body: string;
  readonly carriesToken: boolean;
}

export interface ProbeResult {
  readonly status: number | string;
  readonly body: string;
}

/**
 * Interroge une route du serveur local d'une fenetre.
 *
 * Ne LEVE jamais : un refus de connexion est une mesure, pas un incident. C'est ce qui permet
 * d'ecrire « ce port doit etre REFUSE » comme une assertion ordinaire.
 */
export function probe(
  port: number,
  route: string,
  headers: Record<string, string>
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: route, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', (error: NodeJS.ErrnoException) =>
      resolve({ status: `ERR(${error.code})`, body: '' })
    );
    req.end();
  });
}

/**
 * Poste un corps JSON sur une route du serveur local.
 *
 * `headers` est applique EN DERNIER et peut donc ecraser `host` : c'est ce qui permet
 * d'eprouver la garde de re-liaison DNS sur la vraie socket, sans client fabrique.
 */
export function postJson(
  port: number,
  route: string,
  payload: unknown,
  headers: Record<string, string>
): Promise<ProbeResult> {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.byteLength,
          ...headers,
        },
      },
      (res) => {
        let received = '';
        res.on('data', (chunk) => (received += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: received }));
      }
    );
    req.on('error', (error: NodeJS.ErrnoException) =>
      resolve({ status: `ERR(${error.code})`, body: '' })
    );
    req.end(body);
  });
}

/** Tente la MEME socket depuis une adresse non-loopback de la machine. */
export function probeAddress(address: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const req = request(
      { host: address, port, path: '/health', method: 'GET', timeout: 4000 },
      (res) => resolve(`REPONDU(${res.statusCode})`)
    );
    req.on('error', (error: NodeJS.ErrnoException) => resolve(`ERR(${error.code})`));
    req.on('timeout', () => {
      req.destroy();
      resolve('ERR(TIMEOUT)');
    });
    req.end();
  });
}

export function firstNonLoopbackIPv4(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return undefined;
}

/** Localise le journal persiste du canal `{ log: true }` sous le user-data-dir du run. */
export function findLogFile(userDataDir: string): string | undefined {
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

/**
 * Attend qu'une observation devienne concluante, sans jamais PROVOQUER ce qu'elle observe.
 *
 * C'est la forme que §1 impose : on regarde apparaitre l'effet, on ne le declenche pas. Un
 * depassement de delai LEVE — c'est ce qui rend l'attente falsifiable, la ou un sondage
 * silencieux se contenterait d'un `undefined`.
 */
export async function waitFor<T>(
  what: string,
  attempt: () => T | undefined,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = attempt();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((done) => setTimeout(done, 200));
  }
}

/** La meme attente, sur une observation asynchrone. */
export async function waitForAsync<T>(
  what: string,
  attempt: () => Promise<T | undefined>,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await attempt();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((done) => setTimeout(done, 200));
  }
}

/**
 * Le journal persiste, relu a chaque appel.
 *
 * VSCode ecrit ce fichier au fil de l'eau : le relire est la seule facon d'y voir arriver une
 * ligne emise apres le dernier appel.
 */
export function readLog(logFile: string): string {
  return fs.readFileSync(logFile, 'utf8');
}

/**
 * Releve les ports que l'extension a annonces avoir ouverts, DANS L'ORDRE.
 *
 * Le journal est la seule source de l'exterieur : l'entree de registre ne porte que le port
 * COURANT, et un port referme n'y laisse aucune trace. C'est ce qui rend verifiables les deux
 * points sensibles de B5 — « aucun serveur laisse en ecoute » (§3) et « le port change, ou
 * ne change pas, a la republication » (§2).
 */
export function listeningPortsIn(logText: string): readonly number[] {
  const ports: number[] = [];
  const pattern = /local server listening \([^)]*\): port=(\d+)/g;
  for (;;) {
    const match = pattern.exec(logText);
    if (match === null) break;
    ports.push(Number.parseInt(match[1] as string, 10));
  }
  return ports;
}
