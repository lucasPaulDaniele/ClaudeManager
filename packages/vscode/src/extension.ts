/**
 * Extension compagnon ClaudeManager — elle rend CETTE fenetre joignable, et rien d'autre.
 *
 * ACTIVATION TOTALEMENT INVISIBLE (principe fondateur n.1) : aucune notification, aucun
 * `outputChannel.show()`, aucune commande contribuee, aucune vue revelee. L'outil s'execute
 * pendant que l'humain travaille ailleurs — se manifester a l'ecran serait deja un vol
 * d'attention, et rendrait le pilotage non deterministe.
 */

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  isClaudeManagerError,
  purgeStaleEntries,
  readProcessTable,
  writeWindowEntry,
  WINDOW_ENTRY_SCHEMA_VERSION,
} from './core.js';
import {
  buildWindowEntry,
  readWindowIdentity,
  removeWindowEntry,
  type WindowIdentity,
} from './registry.js';
import { startServer, type HealthPayload, type ServerHandle } from './server.js';

const OUTPUT_CHANNEL = 'ClaudeManager';

/** Version de repli si le manifeste devenait illisible : jamais vide, l'entree serait refusee. */
const UNKNOWN_VERSION = '0.0.0-unknown';

interface WindowState {
  readonly identity: WindowIdentity;
  readonly extensionVersion: string;
  readonly startedAt: string;
  readonly token: string;
  readonly server: ServerHandle;
}

let output: vscode.OutputChannel | undefined;
let state: WindowState | undefined;

function log(message: string): void {
  output?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Rend une defaillance lisible SANS trace de pile : les journaux d'un depot public ne
 * doivent porter ni chemin de fichier ni detail interne. Une erreur nommee est rendue avec
 * son code stable et sa remediation (principe fondateur n.3).
 */
function describe(error: unknown): string {
  if (isClaudeManagerError(error)) {
    return `${error.code}: ${error.message} — ${error.remediation}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** `packageJSON` est type `any` par l'API VSCode : on ne s'y fie qu'apres controle. */
function readExtensionVersion(context: vscode.ExtensionContext): string {
  const packageJson: unknown = context.extension.packageJSON;
  if (typeof packageJson !== 'object' || packageJson === null) return UNKNOWN_VERSION;
  const version = (packageJson as Record<string, unknown>)['version'];
  return typeof version === 'string' && version.length > 0 ? version : UNKNOWN_VERSION;
}

function healthOf(identity: WindowIdentity, extensionVersion: string): HealthPayload {
  return {
    ok: true,
    schemaVersion: WINDOW_ENTRY_SCHEMA_VERSION,
    extensionVersion,
    extHostPid: identity.extHostPid,
    mainPid: identity.mainPid,
    // Relus a chaque requete : ils changent pendant la vie de la fenetre.
    isTrusted: vscode.workspace.isTrusted,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  };
}

/**
 * Publie l'entree de cette fenetre. Rend `false` si le coeur l'a refusee.
 *
 * Le refus n'est PAS anticipe par un controle local : c'est `writeWindowEntry` qui juge, et
 * son erreur nommee qu'on journalise. Redire ici sa regle de validation la ferait diverger
 * un jour — et le cas le plus frequent, la fenetre sans dossier de travail, est
 * precisement une regle du coeur (`REGISTRY_ENTRY_INVALID`).
 */
function publish(current: WindowState, reason: string): boolean {
  const entry = buildWindowEntry({
    identity: current.identity,
    port: current.server.port,
    token: current.token,
    extensionVersion: current.extensionVersion,
    startedAt: current.startedAt,
  });

  try {
    writeWindowEntry(entry);
  } catch (error) {
    log(`refusing to publish this window (${reason}) — ${describe(error)}`);
    return false;
  }

  // Le jeton n'est JAMAIS journalise. Les chemins du workspace non plus : seul leur nombre
  // est utile ici, et `GET /health` les rend a qui detient le jeton.
  log(
    `published (${reason}): extHostPid=${entry.extHostPid} mainPid=${entry.mainPid} ` +
      `port=${entry.port} trusted=${entry.isTrusted} workspaceFolders=${entry.workspaceFolders.length}`
  );
  return true;
}

/**
 * Retire cette fenetre du registre et ferme son serveur.
 *
 * Les deux vont ENSEMBLE : un serveur ouvert sans entree pour le joindre n'est joignable
 * par personne, et une entree sans serveur derriere designe une fenetre morte.
 */
async function shutdown(reason: string): Promise<void> {
  const current = state;
  state = undefined;
  if (current === undefined) return;

  try {
    removeWindowEntry(current.identity.extHostPid);
  } catch (error) {
    log(`could not remove this window's registry entry (${reason}) — ${describe(error)}`);
  }

  try {
    await current.server.close();
  } catch (error) {
    log(`could not close the local server (${reason}) — ${describe(error)}`);
  }

  log(`window withdrawn (${reason}): extHostPid=${current.identity.extHostPid}`);
}

/**
 * Balaie les entrees dont la fenetre n'existe plus.
 *
 * DIFFERE HORS DE L'ACTIVATION, ET C'EST ESSENTIEL : `readProcessTable` coute de 700 ms a
 * 1,25 s (PowerShell + `Get-CimInstance`) et s'execute de facon SYNCHRONE — pendant tout ce
 * temps l'extension host est bloque, donc toutes les autres extensions de la fenetre avec
 * lui. Le programmer apres le retour d'`activate()` garde l'activation instantanee.
 *
 * Son echec n'empeche jamais la publication : publier est la fonction vitale, balayer n'est
 * que de l'hygiene. L'erreur est nommee et journalisee, puis l'extension continue.
 */
function sweepStaleEntries(): void {
  const start = performance.now();
  try {
    const removed = purgeStaleEntries({ table: readProcessTable() });
    const elapsed = Math.round(performance.now() - start);
    const detail = removed.length > 0 ? ` (${removed.join(', ')})` : '';
    log(`sweep completed in ${elapsed} ms: ${removed.length} stale entries removed${detail}`);
  } catch (error) {
    const elapsed = Math.round(performance.now() - start);
    log(`sweep failed after ${elapsed} ms, this window stays published — ${describe(error)}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const activationStart = performance.now();

  const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL);
  // `show()` n'est JAMAIS appele : reveler le panneau de sortie volerait le focus.
  context.subscriptions.push(channel);
  output = channel;

  const identity = readWindowIdentity();
  const extensionVersion = readExtensionVersion(context);
  const startedAt = new Date().toISOString();
  // Propre a cette fenetre ET a cette session : il ne survit pas a un redemarrage.
  const token = randomUUID();

  let server: ServerHandle;
  try {
    server = await startServer({
      token,
      health: () => healthOf(identity, extensionVersion),
      onError: (error) => log(`local server error — ${describe(error)}`),
    });
  } catch (error) {
    log(`this window is NOT reachable, the local server failed to listen — ${describe(error)}`);
    return;
  }

  const current: WindowState = { identity, extensionVersion, startedAt, token, server };
  state = current;

  // ORDRE IMPOSE : publier d'abord, balayer ensuite. Un balayage qui echoue ou qui traine
  // ne doit jamais retarder la joignabilite de la fenetre.
  if (!publish(current, 'activation')) {
    // La fenetre reste parfaitement utilisable : elle n'est simplement pas pilotable.
    await shutdown('entry rejected at activation');
    return;
  }

  context.subscriptions.push(
    // La confiance accordee en cours de route change `isTrusted` : republier remplace
    // l'entree, `writeWindowEntry` etant idempotente.
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      if (state !== undefined && !publish(state, 'workspace trust granted')) {
        void shutdown('entry rejected after trust was granted');
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (state !== undefined && !publish(state, 'workspace folders changed')) {
        void shutdown('entry rejected after workspace folders changed');
      }
    })
  );

  const sweep = setTimeout(sweepStaleEntries, 0);
  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(sweep)));

  log(`activation completed in ${(performance.now() - activationStart).toFixed(1)} ms`);
}

/**
 * `deactivate` n'est PAS toujours appele — une fenetre tuee ne le joue jamais. C'est
 * exactement pourquoi le balayage existe : l'entree laissee derriere sera reconnue morte
 * par la prochaine fenetre qui demarre.
 */
export async function deactivate(): Promise<void> {
  await shutdown('deactivate');
}
