/**
 * Ce qu'une entree devient AVANT d'etre affichee — et rien d'autre.
 *
 * Ces fonctions vivent dans le COEUR deliberement : la CLI, le serveur MCP et le client du
 * lot C ne doivent ni avoir a y penser, ni pouvoir les oublier. Le masque du repertoire
 * personnel existait deja, mais dans le harnais de test (`tests/integration/src/redaction.ts`)
 * — c'est-a-dire la ou seul un producteur de sortie sur trois pouvait s'en servir.
 *
 * MODULE A PART, suffixe `.node` comme tout ce qui touche a la plateforme : masquer le
 * repertoire personnel suppose de le connaitre, quand `entry.ts` — la validation, qui est un
 * contrat entre versions — doit rester pur et eprouvable sans plateforme.
 *
 * AFFICHAGE, JAMAIS PERSISTANCE. Ce qui est ecrit dans le registre et ce que `GET /health`
 * rend a qui detient le jeton portent le chemin REEL : le lot C doit y comparer le `cwd`
 * d'une session au workspace de la fenetre, faute de quoi `claude-vscode.editor.open`
 * reussit en ouvrant un panneau vide (piege n.3). Un chemin masque ne se compare pas.
 */

import os from 'node:os';
import path from 'node:path';
import type { WindowEntry } from './entry.js';

/** Entree rendue affichable : jeton masque, repertoire personnel masque. */
export interface RedactedWindowEntry extends Omit<WindowEntry, 'token'> {
  readonly token: string;
}

/**
 * Constante opaque : ni prefixe, ni suffixe, ni longueur du jeton reel. Un masque qui
 * laisserait filtrer la longueur ou quelques caracteres reduirait l'espace de recherche.
 */
const REDACTED_TOKEN = '***';

/** La marque des shells : un humain la lit sans explication. */
const HOME_MARK = '~';

/**
 * Remplace le PREFIXE du repertoire personnel par `~`.
 *
 * Masquer plutot que supprimer, et c'est un arbitrage : `workspaceFolders` est le seul champ
 * qui permette a un humain de reconnaitre une fenetre parmi plusieurs. Le retirer
 * appauvrirait `cmgr windows` ; en retirer le prefixe personnel conserve entierement ce
 * pouvoir de reconnaissance et fait disparaitre le nom du compte.
 *
 * Un PREFIXE, jamais une occurrence quelconque : remplacer partout mutilerait un chemin qui
 * porterait la meme sous-chaine ailleurs. La coupure doit tomber sur un separateur, sans
 * quoi le repertoire personnel de `ana` masquerait le debut de celui d'`anatole`.
 *
 * COMPARAISON INSENSIBLE A LA CASSE, sur toutes les plateformes. Sous Windows elle est
 * obligatoire : le meme chemin s'ecrit `c:\Users\...` ou `C:\Users\...` selon qui le rend —
 * l'editeur et `os.homedir()` ne s'accordent meme pas sur la casse du disque. Ailleurs, la
 * seule divergence possible serait un AUTRE compte dont le chemin ne differerait que par la
 * casse : le masquer aussi retire une information de plus, jamais une de moins.
 */
export function maskHomeDirectory(folder: string): string {
  const home = os.homedir();
  if (folder.slice(0, home.length).toLowerCase() !== home.toLowerCase()) return folder;

  const rest = folder.slice(home.length);
  // Le workspace EST le repertoire personnel, ou la coupure tombe sur un separateur. Sinon
  // le prefixe commun n'est qu'une coincidence de nommage, et on ne touche a rien.
  if (rest !== '' && !rest.startsWith(path.sep)) return folder;
  return `${HOME_MARK}${rest}`;
}

/**
 * Masque ce qu'une entree ne doit pas porter vers un agent, un journal ou une PR publique.
 *
 * C'est le SEUL chemin par lequel une entree devient affichable — d'ou le regroupement ici
 * du jeton et du chemin personnel : deux regles contradictoires sur le meme flux de sortie
 * etaient exactement le defaut a corriger.
 */
export function redactWindowEntry(entry: WindowEntry): RedactedWindowEntry {
  return {
    ...entry,
    token: REDACTED_TOKEN,
    workspaceFolders: entry.workspaceFolders.map(maskHomeDirectory),
  };
}
