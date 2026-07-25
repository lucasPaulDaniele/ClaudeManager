/**
 * PLOMBERIE de registre — et rien de plus.
 *
 * Tout le jugement (validation, schema, vivacite, purge, atomicite) vit dans
 * `@claudemanager/core` et n'est PAS redit ici. Ce module se borne a ce que seule
 * l'extension peut faire : lire l'etat de sa propre fenetre via l'API VSCode, et relever
 * sa propre identite de processus.
 *
 * C'est le contre-exemple de la version 0.1.0, qui avait reimplemente le registre et
 * publiait des entrees sans `schemaVersion` ni `mainPid` — un format que la version
 * courante doit aujourd'hui traiter comme etranger.
 */

import { rmSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { resolveRegistryDir, WINDOW_ENTRY_SCHEMA_VERSION, type WindowEntry } from './core.js';

/** Identite de la fenetre : les deux pid, releves ensemble. */
export interface WindowIdentity {
  readonly extHostPid: number;
  readonly mainPid: number;
}

/**
 * Releve l'identite de la fenetre — les deux pid AU MEME INSTANT (alerte n.18).
 *
 * `mainPid` est la garde anti-reemploi de pid du registre : si un pid libere est
 * reattribue, son nouveau parent trahit la substitution. Cette garde n'a de valeur que si
 * les deux valeurs decrivent le meme instant, d'ou leur lecture conjointe ici plutot qu'a
 * deux endroits du code d'activation.
 *
 * `process.pid` EST l'extension host de cette fenetre — c'est ce que l'extension execute.
 * Jamais `VSCODE_PID` : un processus principal heberge plusieurs fenetres et le partage
 * entre toutes, il ne discrimine donc rien (piege n.4).
 */
export function readWindowIdentity(): WindowIdentity {
  return { extHostPid: process.pid, mainPid: process.ppid };
}

export interface WindowEntryDraft {
  readonly identity: WindowIdentity;
  readonly port: number;
  readonly token: string;
  readonly extensionVersion: string;
  readonly startedAt: string;
}

/**
 * Construit l'entree decrivant cette fenetre a l'instant present.
 *
 * L'etat du workspace est relu a CHAQUE appel : la confiance peut etre accordee en cours
 * de route, et les dossiers changer. Republier revient donc a rappeler cette fonction.
 *
 * Aucune validation ici : `writeWindowEntry` est seule juge de ce qui est publiable.
 */
export function buildWindowEntry(draft: WindowEntryDraft): WindowEntry {
  return {
    // Version du schema prise au coeur, jamais une constante locale : c'est ce qui
    // permettra a une version ulterieure de reconnaitre nos entrees pour ce qu'elles sont.
    schemaVersion: WINDOW_ENTRY_SCHEMA_VERSION,
    extHostPid: draft.identity.extHostPid,
    mainPid: draft.identity.mainPid,
    port: draft.port,
    token: draft.token,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    isTrusted: vscode.workspace.isTrusted,
    extensionVersion: draft.extensionVersion,
    startedAt: draft.startedAt,
  };
}

/**
 * Retire l'entree de CETTE fenetre, et d'aucune autre.
 *
 * DETTE ASSUMEE : le nom de fichier d'une entree (`<extHostPid>.json`) est une convention
 * du coeur, que ce module doit ici redire faute d'un `removeWindowEntry` exporte. C'est la
 * seule connaissance du registre dupliquee dans l'extension — signalee comme telle, a
 * remonter dans `core/registry/store.node.ts`.
 *
 * `force` : l'entree peut avoir deja ete balayee par une autre fenetre. Son absence est le
 * resultat recherche, pas une defaillance.
 */
export function removeWindowEntry(extHostPid: number): void {
  rmSync(path.join(resolveRegistryDir(), `${extHostPid}.json`), { force: true });
}
