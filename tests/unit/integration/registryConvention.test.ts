import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveRegistryDir,
  windowEntryFileName,
  windowEntryPath,
  writeWindowEntry,
} from '../../../packages/core/src/index.js';
import { currentSchemaEntry } from '../registry/fixtures.js';

/**
 * LA CONVENTION DE NOMMAGE DU REGISTRE NE SE REECRIT PAS A LA MAIN — garde-fou de l'alerte
 * n.33, et il vaut pour le HARNAIS autant que pour l'extension.
 *
 * La duplication cotе extension etait GARDEE : `tests/unit/vscode/registry.test.ts` confronte
 * le chemin construit a ce que le coeur relit, et tomberait si les deux divergeaient. Celle du
 * harnais ne l'etait PAS — `runTests.ts` reencodait a la fois le repertoire et le nom, hors de
 * toute garde, pour un simple `existsSync`.
 *
 * LE COUT EXACT, et c'est pour lui que ce fichier existe. Le jour ou le lot C change la
 * convention : `registry.test.ts` tombe, on corrige l'extension ; `runTests.ts` ne tombe pas,
 * puisqu'un `existsSync` sur un chemin qui n'a jamais rien porte rend simplement `false`. Le
 * « point 8 » imprime alors, a chaque execution, « l entree <pid>.json a DISPARU : deactivate a
 * bien retire cette fenetre du registre ». C'est UNE PREUVE FAUSSE dans un journal joint a une
 * PR — donc dans un critere de merge — et elle est INDETECTABLE, la seule assertion possible
 * etant une absence.
 *
 * Ce fichier ne relit pas le code : il l'interdit.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Les surfaces qui LOCALISENT une entree de registre — et qui, toutes, doivent passer par le
 * coeur. `tests/unit/**` en est exclu a dessein : un test a le droit de nommer un fichier
 * attendu en clair, c'est meme ainsi qu'il constate une divergence.
 */
const WATCHED = [
  path.join(ROOT, 'packages', 'vscode', 'src'),
  path.join(ROOT, 'tests', 'integration', 'src'),
];

/**
 * Un gabarit qui n'est QU'UNE interpolation suivie de `.json` : c'est la convention du
 * registre, et rien d'autre n'a cette forme.
 *
 * L'ancrage sur le backtick ouvrant est ce qui evite le faux positif : le harnais nomme aussi
 * ses rapports `cmgr-b3-report-${pid}-${scenario}.json`, et ceux-la sont des artefacts de test
 * qui ne designent aucune fenetre.
 */
const HAND_ROLLED_ENTRY_NAME = /`\$\{[^`}]*\}\.json`/;

/**
 * L'autre moitie du reencodage que `runTests.ts` portait : le REPERTOIRE.
 *
 * `resolveRegistryDir` est la seule source de cette racine. La reecrire a la main la ferait
 * survivre a un deplacement du registre — et un `existsSync` sur un chemin obsolete rend
 * `false`, ce qui, au « point 8 », s'imprime en « a DISPARU ».
 */
const HAND_ROLLED_REGISTRY_ROOT = /'\.claudemanager'|"\.claudemanager"/;

function sourcesUnder(directory: string): readonly string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

const temporaries: string[] = [];

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('la convention de nommage du registre vit dans le coeur, et nulle part ailleurs', () => {
  it('aucune source de l extension ni du harnais ne reencode <pid>.json', () => {
    const files = WATCHED.flatMap(sourcesUnder);
    // Sans cette borne, un chemin devenu faux rendrait le test vert en ne scannant rien.
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect(readFileSync(file, 'utf8'), path.relative(ROOT, file)).not.toMatch(
        HAND_ROLLED_ENTRY_NAME
      );
    }
  });

  it('aucune source de l extension ni du harnais ne reencode la racine du registre', () => {
    const files = WATCHED.flatMap(sourcesUnder);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect(readFileSync(file, 'utf8'), path.relative(ROOT, file)).not.toMatch(
        HAND_ROLLED_REGISTRY_ROOT
      );
    }
  });

  it('le nom exporte est CELUI que l ecriture pose reellement sur disque', () => {
    // LA BOUCLE EST FERMEE ICI : une convention exportee qui divergerait de l'ecriture ne
    // vaudrait rien — elle ne ferait qu'ajouter un quatrieme encodage aux trois qu'elle
    // remplace. Ce test constate le nom REEL, il ne le redit pas.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cmgr-convention-'));
    temporaries.push(dir);
    const entry = currentSchemaEntry(11172);

    const written = writeWindowEntry(entry, { dir });

    expect(readdirSync(dir)).toEqual([windowEntryFileName(entry.extHostPid)]);
    expect(written).toBe(windowEntryPath(entry.extHostPid, dir));
  });

  it('retombe sur le registre par defaut du poste quand aucun repertoire n est impose', () => {
    expect(windowEntryPath(11172)).toBe(path.join(resolveRegistryDir(), '11172.json'));
  });
});
