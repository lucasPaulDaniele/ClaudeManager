/**
 * VERIFICATION DE L'ARTEFACT REEL — commande LOCALE, jamais la CI publique.
 *
 * `npm run verify:packaging` empaquette, puis passe ici. Tout ce qui est juge dans ce fichier
 * l'est sur l'ARCHIVE QUI VIENT D'ETRE PRODUITE : ni sur `.vscodeignore`, ni sur `files`, ni
 * sur ce que `vsce ls` PREDIT. C'est la seule facon de prendre en defaut un empaquetage, qui
 * se casse en silence — tout compile, la CI est verte, et l'archive livree est inutilisable.
 *
 * POURQUOI PAS DANS `tests/unit/` : ces assertions exigent des artefacts BATIS. La CI publique
 * n'execute que `lint`, `typecheck` et `test:coverage` ; un test unitaire qui aurait besoin
 * d'un `.vsix` y echouerait, ou — bien pire — s'y ignorerait tout seul et ne prouverait plus
 * rien. C'est exactement le montage de `npm run test:integration` : commande locale, log joint
 * en preuve a la PR.
 *
 * La REGLE, elle, est ailleurs — dans `rules.ts`, sans acces au disque —, et
 * `tests/unit/packaging/rules.test.ts` l'eprouve a chaque CI, sur des relevés reels et sur des
 * relevés qu'elle doit REFUSER. Une seule regle, deux appelants : ils ne peuvent pas diverger.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { namesOf, readTarGzEntries, readZipEntries, type ArchiveEntry } from './archives.js';
import { CLI_TARBALL_SPEC, VSIX_SPEC, inspectArchive } from './rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');

function readManifest(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(ROOT, ...segments), 'utf8')) as Record<string, unknown>;
}

const extensionManifest = readManifest('packages', 'vscode', 'package.json');
const cliManifest = readManifest('packages', 'cli', 'package.json');

/** L'unique artefact portant cette extension, ou un echec qui dit ce qui manque. */
function soleArtifact(extension: string): string {
  if (!existsSync(ARTIFACTS)) {
    throw new Error(`${ARTIFACTS} est absent : lancer \`npm run package:all\` d'abord.`);
  }
  const found = readdirSync(ARTIFACTS).filter((f) => f.endsWith(extension));
  if (found.length !== 1) {
    throw new Error(
      `${found.length} fichier(s) « *${extension} » dans artifacts/ au lieu d'un seul : ${found.join(', ') || '(aucun)'}. ` +
        'Un residu d une version anterieure rendrait cette verification ambigue — vider artifacts/ et reempaqueter.'
    );
  }
  return path.join(ARTIFACTS, found[0] as string);
}

/**
 * `vsce` RENOMME deux fichiers en les empaquetant, et il faut le savoir pour comparer ce qu'il
 * ANNONCE (`vsce ls`, qui donne les noms des SOURCES) a ce qu'il EMET (l'archive).
 *
 * MESURE DU 2026-07-26, decouverte par ce test meme, qui a echoue en le montrant :
 *   `LICENSE`   -> `LICENSE.txt`   (extension ajoutee)
 *   `README.md` -> `readme.md`     (MIS EN MINUSCULES)
 *
 * Ce n'est pas documente par l'outil. C'est donc encode ici plutot que suppose ailleurs : si
 * une version future de `vsce` change ce comportement, ce test le dira au lieu de laisser une
 * comparaison passer sur une normalisation trop permissive — raison pour laquelle la
 * correspondance est EXPLICITE et non un `toLowerCase()` applique aux deux cotes.
 */
function asPackagedName(source: string): string {
  if (source === 'LICENSE') return 'LICENSE.txt';
  if (source === 'README.md') return 'readme.md';
  return source;
}

let vsix: readonly ArchiveEntry[];
let tarball: readonly ArchiveEntry[];
let vsixPath: string;
let tarballPath: string;

beforeAll(() => {
  vsixPath = soleArtifact('.vsix');
  tarballPath = soleArtifact('.tgz');
  vsix = readZipEntries(readFileSync(vsixPath));
  tarball = readTarGzEntries(readFileSync(tarballPath));
});

describe('VSIX de l extension compagnon', () => {
  it('ne porte QUE ce qui doit y etre — les deux racines compilees comprises', () => {
    // LE test de l'increment. `dist/core/**` est exige au meme titre que `dist/vscode/**` :
    // le coeur est compile A COTE de l'extension, jamais recopie dans ses sources. Un VSIX
    // sans lui s'installe sans un mot et echoue au CHARGEMENT.
    expect(inspectArchive(namesOf(vsix), VSIX_SPEC)).toEqual([]);
  });

  it('porte les DEUX racines, et on les compte', () => {
    // Redit explicitement plutot que laisse a la seule lecture de `VSIX_SPEC` : c'est le fait
    // que le compte-rendu de l'increment doit pouvoir citer.
    const js = namesOf(vsix).filter((n) => n.endsWith('.js'));
    const vscodeRoot = js.filter((n) => n.startsWith('extension/dist/vscode/src/'));
    const coreRoot = js.filter((n) => n.startsWith('extension/dist/core/src/'));

    expect(vscodeRoot.length).toBeGreaterThan(0);
    expect(coreRoot.length).toBeGreaterThan(0);
    // Aucun `.js` ne vit ailleurs que sous l'une des deux racines.
    expect(js.length).toBe(vscodeRoot.length + coreRoot.length);
  });

  it('embarque le manifeste que ce depot versionne, a la version qu il annonce', () => {
    const packaged = JSON.parse(
      (vsix.find((e) => e.name === 'extension/package.json')?.content ?? Buffer.alloc(0)).toString(
        'utf8'
      )
    ) as Record<string, unknown>;

    // C'est CE manifeste que VSCode expose en `context.extension.packageJSON`, donc CE numero
    // que l'entree de registre publie en `extensionVersion`.
    expect(packaged['version']).toBe(extensionManifest['version']);
    expect(packaged['main']).toBe(extensionManifest['main']);
    expect(packaged['name']).toBe(extensionManifest['name']);
  });

  it('designe par `main` un fichier REELLEMENT present dans l archive', () => {
    // `main` est une chaine du manifeste : rien, jusqu'ici, ne garantissait qu'elle designe
    // quelque chose. Un `main` juste et une archive incomplete donnent la meme erreur qu'un
    // `main` faux, et elle ne survient qu'a l'installation.
    const main = (extensionManifest['main'] as string).replace(/^\.\//, '');
    expect(namesOf(vsix)).toContain(`extension/${main}`);
  });

  it('porte le nom de fichier attendu, version comprise', () => {
    const { name, version } = extensionManifest as { name: string; version: string };
    expect(path.basename(vsixPath)).toBe(`${name}-${version}.vsix`);
  });

  it('contient exactement ce que `vsce ls` annonce — deux lectures independantes', () => {
    // CORROBORATION MUTUELLE. Le lecteur de ZIP de ce depot est fait maison (aucune
    // dependance ajoutee) : le confronter a l'outil qui a produit l'archive evite qu'un
    // defaut de lecture se fasse passer pour une archive conforme.
    const announced = execFileSync(
      process.execPath,
      [path.join(ROOT, 'node_modules', '@vscode', 'vsce', 'vsce'), 'ls', '--no-dependencies'],
      { cwd: path.join(ROOT, 'packages', 'vscode'), encoding: 'utf8' }
    )
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map(asPackagedName)
      .sort();

    // `vsce ls` enumere les fichiers du PAQUET ; l'archive les prefixe et y ajoute ses deux
    // metadonnees. On compare donc ce qui est comparable.
    const packaged = namesOf(vsix)
      .filter((n) => !VSIX_SPEC.metadata.includes(n))
      .map((n) => n.slice(VSIX_SPEC.root.length))
      .sort();

    expect(packaged).toEqual(announced);
  });
});

describe('tarball npm de la CLI', () => {
  it('ne porte QUE ce qui doit y etre — `dist/core` compris', () => {
    // Depuis C2, `cmgr open` passe par le client HTTP du COEUR. Le paquet ne declarant
    // aucune dependance, un tarball sans `dist/core` echouerait a l'EXECUTION, apres
    // installation, sur la machine de quelqu'un d'autre.
    expect(inspectArchive(namesOf(tarball), CLI_TARBALL_SPEC)).toEqual([]);
  });

  it('designe par `bin.cmgr` un fichier REELLEMENT present dans l archive', () => {
    const bin = (cliManifest['bin'] as Record<string, string>)['cmgr'] as string;
    expect(namesOf(tarball)).toContain(`package/${bin.replace(/^\.\//, '')}`);
  });

  it('rend `cmgr --version` EXECUTE depuis le contenu empaquete', () => {
    // Le coeur du «installable» : on n'en deduit rien du manifeste, on LANCE le binaire tel
    // qu'il serait installe. Le tarball est extrait dans un repertoire neuf, hors de l'arbre
    // de travail — sans quoi la resolution de modules pourrait retomber sur les sources et le
    // test passerait pour de mauvaises raisons.
    const sandbox = path.join(os.tmpdir(), `cmgr-packaging-${process.pid}`);
    rmSync(sandbox, { recursive: true, force: true });

    for (const entry of tarball) {
      const target = path.join(sandbox, entry.name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, entry.content);
    }

    const bin = (cliManifest['bin'] as Record<string, string>)['cmgr'] as string;
    const stdout = execFileSync(
      process.execPath,
      [path.join(sandbox, 'package', bin.replace(/^\.\//, '')), '--version'],
      { encoding: 'utf8' }
    );

    // Contrat de sortie du depot : du JSON sur stdout, sans condition.
    expect(JSON.parse(stdout)).toEqual({
      command: 'version',
      ok: true,
      name: 'cmgr',
      version: cliManifest['version'],
    });

    rmSync(sandbox, { recursive: true, force: true });
  });

  it('porte le nom de fichier npm attendu, version comprise', () => {
    // `@claudemanager/cli` -> `claudemanager-cli-<version>.tgz`
    const { name, version } = cliManifest as { name: string; version: string };
    const flattened = name.replace(/^@/, '').replace(/\//g, '-');
    expect(path.basename(tarballPath)).toBe(`${flattened}-${version}.tgz`);
  });
});

describe('reproductibilite', () => {
  it('reempaqueter rend le MEME contenu — a l octet, entree par entree', () => {
    // MESURE DU 2026-07-26, ET ELLE CORRIGE UNE ATTENTE : le VSIX n'est PAS reproductible A
    // L'OCTET. Deux empaquetages successifs, sans rien changer entre les deux, rendent deux
    // sha256 differents — releve : 464b4e27... puis 4a9675a9...
    //
    // CAUSE, mesuree et non supposee : `vsce` HORODATE A L'HEURE COURANTE les deux entrees
    // qu'il genere lui-meme (`extension.vsixmanifest`, `[Content_Types].xml`) — 16:22 puis
    // 16:23 sur le releve —, la ou les fichiers reels gardent leur mtime disque. Un ZIP porte
    // ces dates dans ses en-tetes : l'archive ne peut donc pas etre identique d'une minute a
    // l'autre, et aucun drapeau de `vsce` ne l'en empeche.
    //
    // CE QUI EST DONC GARDE ICI est ce qui est vrai ET ce qui compte : le CONTENU. Meme jeu
    // d'entrees, memes octets pour chacune. Promettre l'octet-a-octet serait promettre ce
    // qu'aucune mesure ne soutient.
    const before = readZipEntries(readFileSync(vsixPath));
    execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'node_modules', '@vscode', 'vsce', 'vsce'),
        'package',
        '--no-dependencies',
        '--out',
        path.join(ARTIFACTS, 'reproducibility.vsix'),
      ],
      { cwd: path.join(ROOT, 'packages', 'vscode'), encoding: 'utf8' }
    );
    const after = readZipEntries(readFileSync(path.join(ARTIFACTS, 'reproducibility.vsix')));

    const digest = (entries: readonly ArchiveEntry[]): Record<string, string> =>
      Object.fromEntries(
        [...entries]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => [e.name, createHash('sha256').update(e.content).digest('hex')])
      );

    expect(digest(after)).toEqual(digest(before));
    rmSync(path.join(ARTIFACTS, 'reproducibility.vsix'), { force: true });
  });
});
