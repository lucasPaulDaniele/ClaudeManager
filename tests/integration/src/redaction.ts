/**
 * Ce que la sortie du harnais ne doit PAS porter.
 *
 * Le log d'integration est joint en preuve a des PR d'un depot PUBLIC — le CLAUDE.md en fait
 * un critere de merge. Il imprimait des chemins absolus sous `os.tmpdir()`, donc le nom de
 * compte et l'arborescence de travail, que l'auteur retirait A LA MAIN : une neutralisation
 * manuelle, donc non reproductible, sur une sortie publiee par construction (finding S7).
 *
 * Module a part parce que DEUX producteurs doivent appliquer exactement le meme masque — la
 * suite, qui ecrit le rapport dans l'extension host, et le lanceur, qui imprime tout le
 * reste. Deux implementations auraient divergé.
 */

import os from 'node:os';

/**
 * L'ordre COMPTE : sous Windows le repertoire temporaire est SOUS le repertoire personnel,
 * et masquer le second d'abord laisserait le premier a moitie masque (`~\AppData\Local\Temp`
 * au lieu de `<tmp>`).
 */
const MASKS: ReadonlyArray<readonly [string, string]> = [
  [os.tmpdir(), '<tmp>'],
  [os.homedir(), '~'],
];

function replaceInsensitive(text: string, needle: string, replacement: string): string {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), replacement);
}

/**
 * Remplace, dans une chaine destinee a etre publiee, ce qui identifie le POSTE.
 *
 * DEUX FORMES SONT CHERCHEES, et l'omission de la seconde a ete mesuree : le rapport porte
 * les corps de reponse de `GET /health`, qui sont du JSON — un chemin y est ECHAPPE
 * (`c:\\Users\\...`), et un masque qui ne connait que la forme brute (`c:\Users\...`) passe
 * a cote de la sortie la plus volumineuse du harnais. C'est exactement ce qui s'est produit
 * au premier rejeu de cette correction.
 *
 * La comparaison est insensible a la casse : sous Windows le meme chemin s'ecrit
 * `c:\Users\...` ou `C:\Users\...` selon qui le rend.
 */
export function mask(text: string): string {
  let masked = text;
  for (const [needle, replacement] of MASKS) {
    // Forme echappee d'abord : elle contient la forme brute comme sous-chaine sur les
    // systemes ou le separateur n'est pas echappe, et l'inverse la mutilerait.
    masked = replaceInsensitive(masked, JSON.stringify(needle).slice(1, -1), replacement);
    masked = replaceInsensitive(masked, needle, replacement);
  }
  return masked;
}
