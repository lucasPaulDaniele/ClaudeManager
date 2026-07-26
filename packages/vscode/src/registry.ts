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
import { windowEntryPath, WINDOW_ENTRY_SCHEMA_VERSION, type WindowEntry } from './core.js';

/**
 * LA CONVENTION DE NOMMAGE VIENT DU COEUR, elle n'est plus redite ici.
 *
 * Elle y etait DUPLIQUEE, faute d'un equivalent exporte — dette signalee en commentaire et
 * gardee par un test (`tests/unit/vscode/registry.test.ts`). Le coeur l'exporte depuis le gate
 * final du lot B : `windowEntryPath` et `windowEntryFileName` vivent a cote de
 * `resolveRegistryDir`, et l'ecriture comme la lecture du registre les emploient. La
 * reexportation garde la porte unique de ce module — le reste de l'extension continue
 * d'importer sa plomberie de registre ici, sans savoir d'ou vient la convention.
 */
export { windowEntryPath };

/** Identite de la fenetre : les deux pid, releves ensemble. */
export interface WindowIdentity {
  readonly extHostPid: number;
  readonly mainPid: number;
}

/**
 * Releve l'identite de la fenetre — les deux pid AU MEME INSTANT (alerte n.18).
 *
 * `mainPid` porte la MOITIE PAR LE PARENT de la garde anti-reemploi de pid du registre : un
 * pid reattribue n'a le plus souvent pas le meme parent que l'extension host qu'il remplace.
 * Elle SE FRANCHIT pourtant — sous Windows le parent enregistre est le `Code.exe` principal,
 * qui engendre des enfants en permanence —, d'ou la seconde moitie, par la date de creation
 * (`judgeCurrentSchemaLiveness` dans le coeur, et l'ADR-003, decision 6). Celle-ci n'a de
 * valeur que si les deux valeurs decrivent le meme instant, d'ou leur lecture conjointe ici
 * plutot qu'a deux endroits du code d'activation.
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
 * Retire l'entree de CETTE fenetre, et d'aucune autre.
 *
 * `force` : l'entree peut avoir deja ete balayee par une autre fenetre. Son absence est le
 * resultat recherche, pas une defaillance.
 */
export function removeWindowEntry(extHostPid: number, dir?: string): void {
  rmSync(windowEntryPath(extHostPid, dir), { force: true });
}
