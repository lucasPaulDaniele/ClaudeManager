/**
 * L'entree d'un schema ETRANGER que le scenario nominal depose dans le registre REEL du poste,
 * et qu'il retire lui-meme.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * POURQUOI CE MODULE EXISTE SEPAREMENT DU SCENARIO : il n'importe pas `vscode`, donc il se
 * verifie en Node pur (`tests/unit/integration/foreignEntry.test.ts`). Ce qu'il fait — ecrire
 * dans le registre de l'utilisateur, hors de tout repertoire temporaire — est la chose la
 * moins anodine de tout le harnais, et c'etait la seule qu'aucun test n'atteignait.
 *
 * TROIS REGLES, ET AUCUNE N'EST DECORATIVE (finding S8) :
 *
 *   1. ON N'ECRASE JAMAIS UNE ENTREE QU'ON N'A PAS ECRITE. Le nom est verifie libre avant, le
 *      contenu est verifie inchange avant le retrait.
 *   2. UNE ECRITURE PARTIELLE NE SURVIT PAS A SON ECHEC. Un fichier tronque dans le registre
 *      reel est classe `unparsable` — donc IMPURGEABLE PAR CONCEPTION, la purge conservatrice
 *      ne supprimant que ce dont elle a pu lire le pid. Il serait *immortel*, sur le poste de
 *      l'utilisateur. On l'efface donc au seul instant ou l'on sait encore qu'il est le notre.
 *   3. LES DROITS SONT CEUX DU COEUR — `0700` sur le repertoire, `0600` sur le fichier. Sans
 *      `mode`, Node applique l'umask (0755/0644) : sous POSIX, le harnais RELACHERAIT ce que
 *      `writeWindowEntry` resserre, dans un repertoire qui porte des jetons. Sans effet sous
 *      Windows, ou l'ACL heritee protege deja — les poser n'y coute rien.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import fs from 'node:fs';
import { windowEntryPath } from '../../../packages/core/src/index.js';

/** Les memes droits que `core/registry/store.node.ts`, et pour la meme raison. */
const REGISTRY_DIR_MODE = 0o700;
const ENTRY_FILE_MODE = 0o600;

export interface PlantedEntry {
  readonly pid: number;
  readonly file: string;
  readonly content: string;
}

/** Le seul point d'injection : une ecriture qui echoue ne se provoque pas a volonte. */
export type WriteEntry = (file: string, content: string) => void;

function writeEntry(file: string, content: string): void {
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: ENTRY_FILE_MODE });
}

/**
 * Depose une entree d'un schema etranger, nommee d'apres un pid VIVANT.
 *
 * Le contenu est la fixture 0.1.0 REELLE, seul l'`extHostPid` y etant repointe : le nom du
 * fichier doit correspondre a l'identite revendiquee, sans quoi le coeur classerait l'entree
 * `identity-mismatch` et le point eprouverait autre chose que ce qu'il annonce.
 *
 * Rend `undefined` si un fichier porte deja ce nom — auquel cas le scenario ECHOUE,
 * DELIBEREMENT : mieux vaut un echec explicite qu'un point silencieusement saute (principe
 * fondateur n.3). Le commentaire disait « quitte a perdre le point » quand le code, lui,
 * assertait trois lignes plus loin ; c'est le commentaire qui etait faux (finding C9).
 */
export function plantForeignEntry(
  fixture: Record<string, unknown>,
  pid: number,
  registryDir: string,
  write: WriteEntry = writeEntry
): PlantedEntry | undefined {
  const file = windowEntryPath(pid, registryDir);
  if (fs.existsSync(file)) return undefined;

  const content = `${JSON.stringify({ ...fixture, extHostPid: pid }, null, 2)}\n`;
  fs.mkdirSync(registryDir, { recursive: true, mode: REGISTRY_DIR_MODE });
  try {
    write(file, content);
  } catch (error) {
    // REGLE 2 : ici, et seulement ici, on SAIT que ce fichier est le notre — le nom etait
    // libre a la ligne precedente. Une milliseconde plus tard, plus rien ne l'etablirait.
    fs.rmSync(file, { force: true });
    throw error;
  }
  return { pid, file, content };
}

/**
 * Retire l'entree fabriquee — et ELLE SEULE.
 *
 * Garde de contenu : si le fichier a change depuis qu'on l'a ecrit, il n'est plus le notre et
 * on n'y touche pas.
 */
export function unplantForeignEntry(planted: PlantedEntry | undefined): string {
  if (planted === undefined) return 'aucune entree fabriquee';
  let onDisk: string;
  try {
    onDisk = fs.readFileSync(planted.file, 'utf8');
  } catch {
    return 'deja disparue';
  }
  if (onDisk !== planted.content) {
    return 'LAISSEE EN PLACE : le contenu a change, elle n est plus la notre';
  }
  fs.rmSync(planted.file, { force: true });
  return 'retiree';
}
