/**
 * PLOMBERIE de registre — et rien de plus.
 *
 * Tout le jugement (validation, schema, vivacite, purge, atomicite) vit dans
 * `@claudemanager/core` et n'est PAS redit ici. Ce module se borne a ce que seule
 * l'extension peut faire : relever sa propre identite de processus, et mettre en forme
 * l'entree qui la decrit.
 *
 * AUCUN IMPORT DE `vscode`, ET C'EST DELIBERE. L'etat du workspace — dossiers, confiance —
 * est RECU en parametre plutot que lu ici : c'est `extension.ts`, seul point de contact avec
 * l'editeur, qui le releve et le passe. Le prix est une ligne de plus a l'appel ; le gain
 * est que toute cette plomberie se verifie en Node pur, contre un vrai repertoire temporaire
 * et sans le moindre faux `vscode` (principe fondateur n.5 : pas de mocks du systeme reel).
 *
 * C'est le contre-exemple de la version 0.1.0, qui avait reimplemente le registre et
 * publiait des entrees sans `schemaVersion` ni `mainPid` — un format que la version
 * courante doit aujourd'hui traiter comme etranger.
 */

import { rmSync } from 'node:fs';
import path from 'node:path';
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
  /**
   * Etat du workspace AU MOMENT DE LA PUBLICATION, releve par l'appelant.
   *
   * Il change pendant la vie de la fenetre — la confiance s'accorde en cours de route, les
   * dossiers se reorganisent — donc republier revient a rappeler cette fonction avec un
   * releve frais. Ce qui suit n'en garde aucune trace.
   */
  readonly workspaceFolders: readonly string[];
  readonly isTrusted: boolean;
}

/**
 * Construit l'entree decrivant cette fenetre a l'instant present.
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
    workspaceFolders: draft.workspaceFolders,
    isTrusted: draft.isTrusted,
    extensionVersion: draft.extensionVersion,
    startedAt: draft.startedAt,
  };
}

/**
 * Chemin du fichier d'entree d'UNE fenetre.
 *
 * DETTE ASSUMEE : le nommage `<extHostPid>.json` est une convention du coeur, que ce module
 * doit ici redire faute d'un equivalent exporte. C'est la seule connaissance du registre
 * dupliquee dans l'extension — signalee comme telle, a remonter dans
 * `core/registry/store.node.ts`. Elle est isolee dans cette unique fonction : le jour ou le
 * coeur l'exportera, il n'y aura qu'un corps a remplacer.
 */
export function windowEntryPath(extHostPid: number, dir?: string): string {
  return path.join(resolveRegistryDir(dir), `${extHostPid}.json`);
}

/**
 * Retire l'entree de CETTE fenetre, et d'aucune autre.
 *
 * `force` : l'entree peut avoir deja ete balayee par une autre fenetre. Son absence est le
 * resultat recherche, pas une defaillance.
 */
export function removeWindowEntry(extHostPid: number, dir?: string): void {
  rmSync(windowEntryPath(extHostPid, dir), { force: true });
}
