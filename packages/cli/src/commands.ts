/**
 * Les deux commandes de lecture de `cmgr`, et rien d'autre.
 *
 * PERIMETRE, ET C'EST UNE DECISION : ce module lit le registre et la table des processus.
 * Il n'ecrit rien, ne purge rien — la purge appartient a l'extension compagnon, qui seule
 * sait quand sa fenetre s'active —, n'ouvre ni ne ferme aucune conversation (lot C), et NE
 * FAIT AUCUN RESEAU. Le client HTTP du coeur (`core/client`) est inscrit au lot C : une
 * commande de lecture qui interrogerait un serveur local ferait dependre l'inventaire des
 * fenetres de leur joignabilite, deux questions distinctes.
 *
 * AUCUNE FENETRE N'EST FABRIQUEE ICI. Toute la garantie d'identite vit dans
 * `parseWindowEntry` : validation de schema, confrontation du contenu au NOM du fichier,
 * garde anti-reemploi de pid. Une fenetre decrite depuis un argument de ligne de commande
 * n'aurait traverse aucun de ces controles, et `resolveOwningWindow` la retiendrait aussi
 * volontiers qu'une vraie. C'est pourquoi la liste passee au coeur provient TOUJOURS de
 * `readRegistry`, et pourquoi aucune option n'existe pour la completer.
 */

import {
  ancestorsOf,
  readRegistry,
  redactWindowEntry,
  requireOwningWindow,
  resolveOwningWindow,
  resolveRegistryDir,
  type ProcessSnapshot,
  type RegistryReadResult,
  type SkippedEntry,
} from './core.js';

/**
 * Tout ce dont une commande a besoin du monde exterieur.
 *
 * `readSnapshot` est fourni plutot qu'appele : c'est la couture qui permet aux tests
 * unitaires de rejouer une capture reelle sans relancer l'inventaire du poste. Ce n'est PAS
 * un point d'extension public — la CLI reelle y branche `readProcessTable`, et rien d'autre
 * n'est offert a l'utilisateur pour en changer.
 *
 * `registryDir` est explicitement `string | undefined` et non optionnel : un appelant doit
 * DIRE qu'il vise le registre par defaut, plutot que de l'obtenir par omission.
 */
export interface CliContext {
  /** Le processus dont on cherche la fenetre : `process.pid` en production. */
  readonly pid: number;
  readonly registryDir: string | undefined;
  readonly readSnapshot: () => Promise<ProcessSnapshot>;
}

/**
 * Contexte d'enveloppe, rendu en succes COMME en echec.
 *
 * Il est MUTABLE et rempli au plus tot, deliberement : `skipped` est connu des la lecture du
 * registre, mais `whoami` peut echouer juste apres. Or c'est precisement dans ce cas que
 * l'utilisateur en a le plus besoin — « aucune fenetre ne te revendique, et voici les deux
 * entrees qu'on a ecartees, avec leur motif » repond a la question, la ou l'erreur seule la
 * laisse entiere (principe fondateur n.3 : ce qui a ete ecarte doit APPARAITRE).
 *
 * Il n'entre jamais dans l'erreur elle-meme, qui est rendue telle que le coeur l'a formulee.
 */
export interface Diagnostics {
  skipped?: readonly SkippedEntry[];
}

export type CommandBody = Readonly<Record<string, unknown>>;

/**
 * Le repertoire est resolu UNE fois, par le resolveur du coeur, et jamais par une branche.
 *
 * `readRegistry({ snapshot })` et `readRegistry({ snapshot, dir })` aboutissent au meme
 * `resolveRegistryDir` : choisir entre les deux selon que `registryDir` est defini n'aurait
 * fait qu'ajouter un chemin dont l'un des deux cotes n'est jamais emprunte par les tests —
 * le defaut visant, lui, le registre REEL du poste, qu'aucun test unitaire ne doit toucher.
 */
function readWindowRegistry(context: CliContext, snapshot: ProcessSnapshot): RegistryReadResult {
  return readRegistry({ snapshot, dir: resolveRegistryDir(context.registryDir) });
}

/**
 * UN SEUL instantane par commande.
 *
 * `readProcessTable()` coute de 700 ms a 1,3 s sur un poste reel : le relire une seconde
 * fois doublerait la duree de la commande pour rien, et — plus grave — ferait juger le
 * registre et la chaine d'ancetres sur deux etats du systeme differents.
 */
async function inventory(
  context: CliContext
): Promise<{ readonly snapshot: ProcessSnapshot; readonly registry: RegistryReadResult }> {
  const snapshot = await context.readSnapshot();
  return { snapshot, registry: readWindowRegistry(context, snapshot) };
}

/**
 * « Quelles fenetres sont pilotables ? »
 *
 * Une liste VIDE assortie de `skipped` NON VIDE n'est pas un echec : c'est le renseignement
 * capital que des fenetres existent, qu'aucune n'est pilotable, et pourquoi. C'est
 * exactement l'etat d'un poste ou seule une version anterieure de l'extension a tourne.
 *
 * L'absence de fenetre hote n'est PAS une erreur ici : lister n'est pas se situer.
 * L'AMBIGUITE, elle, en est une — `resolveOwningWindow` leve `DUPLICATE_WINDOW_IDENTITY`
 * quand deux entrees revendiquent le meme extension host, et on la laisse remonter plutot
 * que de rendre `owner: null`. Un `null` dirait « aucune fenetre ne te revendique » la ou la
 * verite est « deux te revendiquent » : ce serait la degradation silencieuse que le principe
 * fondateur n.3 interdit.
 */
export async function windowsCommand(
  context: CliContext,
  diagnostics: Diagnostics
): Promise<CommandBody> {
  const { snapshot, registry } = await inventory(context);
  diagnostics.skipped = registry.skipped;

  const owner = resolveOwningWindow(context.pid, snapshot.table, registry.windows);

  return {
    // `redactWindowEntry` vit dans le coeur pour que la CLI ne puisse pas l'oublier : c'est
    // le seul chemin par lequel une entree devient affichable.
    windows: registry.windows.map(redactWindowEntry),
    owner: owner === undefined ? null : { extHostPid: owner.extHostPid },
  };
}

/**
 * « Dans quelle fenetre s'execute le processus qui m'appelle ? »
 *
 * La chaine remonte naturellement du binaire au shell, du shell au `claude.exe`, puis a
 * l'extension host : c'est le seul rattachement qui fasse identite. Ni `VSCODE_PID` — un
 * processus principal heberge plusieurs fenetres et le partage entre toutes —, ni le titre,
 * ni le chemin du workspace n'y entrent : deux fenetres sur le meme dossier physique sont le
 * cas de reference du produit.
 *
 * N'avoir AUCUNE fenetre hote n'est pas un succes a champ vide : c'est
 * `OWNING_WINDOW_NOT_FOUND`, rendue telle quelle avec un code de sortie non nul. D'ou
 * `requireOwningWindow` plutot que `resolveOwningWindow`.
 */
export async function whoamiCommand(
  context: CliContext,
  diagnostics: Diagnostics
): Promise<CommandBody> {
  const { snapshot, registry } = await inventory(context);
  // Rempli AVANT la resolution : c'est en cas d'echec qu'il vaut le plus.
  diagnostics.skipped = registry.skipped;

  // La MEME chaine que celle sur laquelle le coeur decide — processus appelant inclus, car
  // l'extension compagnon est l'extension host de sa fenetre et doit se resoudre elle-meme.
  // Elle est rendue pour que l'utilisateur puisse VOIR le rattachement, jamais pour le
  // decider : la decision reste entierement celle de `requireOwningWindow`.
  const chain = [context.pid, ...ancestorsOf(context.pid, snapshot.table)];

  const owner = requireOwningWindow(context.pid, snapshot.table, registry.windows);

  return {
    window: redactWindowEntry(owner),
    ancestry: {
      callerPid: context.pid,
      chain,
      /** Profondeur a laquelle la fenetre hote a ete trouvee — 0 signifie « c'est moi ». */
      ownerDepth: chain.indexOf(owner.extHostPid),
    },
  };
}
