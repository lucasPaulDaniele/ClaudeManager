import type { ProcessTable } from './processTable.js';

/**
 * Ancetres d'un processus, du parent immediat vers la racine, `pid` exclu.
 *
 * C'est une **requete** : un pid absurde ou introuvable rend une chaine vide, il ne leve
 * pas. La decision de traiter l'absence comme une erreur appartient a l'appelant, qui seul
 * sait s'il posait une question ou s'il conduisait une operation.
 *
 * La table peut etre corrompue — instantane mouvant, pid reutilise apres bouclage du
 * compteur : la remontee memorise les pid deja vus, ce qui garantit l'arret et interdit
 * qu'un pid apparaisse deux fois dans la chaine.
 */
export function ancestorsOf(pid: number, table: ProcessTable): readonly number[] {
  const chain: number[] = [];
  if (!Number.isInteger(pid) || pid <= 0) return chain;

  const visited = new Set<number>([pid]);
  let current = table.get(pid)?.ppid;
  while (current !== undefined && current > 0 && !visited.has(current)) {
    chain.push(current);
    visited.add(current);
    current = table.get(current)?.ppid;
  }

  return chain;
}
