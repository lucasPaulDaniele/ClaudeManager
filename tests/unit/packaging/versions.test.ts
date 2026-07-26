import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLI_VERSION } from '../../../packages/cli/src/usage.js';

/**
 * LES NUMEROS DE VERSION, ET CE QUI LES TIENT ENSEMBLE.
 *
 * Sur le modele de `tests/unit/vscode/manifest.test.ts` : un numero qui vit en deux endroits
 * se desolidarise en silence, et c'est toujours l'utilisateur qui l'apprend. Ici l'enjeu est
 * plus direct qu'une coquille — la version de l'extension est OBSERVABLE DE L'EXTERIEUR :
 * elle est publiee dans l'entree de registre en `extensionVersion`, et `packages/core/src/
 * errors.ts` dit a l'utilisateur de la COMPARER pour diagnostiquer un desaccord de protocole.
 * Un numero qui ne bouge pas quand le protocole bouge rend ce conseil inapplicable.
 *
 * Ce fichier garde aussi les DEUX DECISIONS D'EMPAQUETAGE dont la regression serait invisible :
 * `--no-dependencies` (sans quoi `vsce` fuit hors du paquet) et l'absence de dependances a
 * l'execution (qui est ce qui rend ce drapeau LEGITIME).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function read(...segments: string[]): string {
  return readFileSync(path.join(ROOT, ...segments), 'utf8');
}

function readJson(...segments: string[]): Record<string, unknown> {
  return JSON.parse(read(...segments)) as Record<string, unknown>;
}

const rootManifest = readJson('package.json');
const extension = readJson('packages', 'vscode', 'package.json');
const cli = readJson('packages', 'cli', 'package.json');
const scripts = rootManifest['scripts'] as Record<string, string>;

/** La version de l'extension, qui est aussi celle du nom de fichier du VSIX. */
const EXTENSION_VERSION = extension['version'] as string;

const SEMVER = /^\d+\.\d+\.\d+$/;

describe('versions des deux artefacts', () => {
  it('sont du semver strict — le nom de fichier du VSIX en depend', () => {
    // `vsce` compose `<name>-<version>.vsix` : un suffixe de pre-release y passerait, mais la
    // procedure d'installation du README cite un nom de fichier exact.
    expect(EXTENSION_VERSION).toMatch(SEMVER);
    expect(cli['version']).toMatch(SEMVER);
  });

  it('la version annoncee par `cmgr --version` est celle de son manifeste', () => {
    // Redit ici alors que `tests/unit/cli/contract.test.ts` le garde deja : ce fichier est
    // l'endroit ou l'on vient LIRE l'etat des versions, et un renvoi n'y remplace pas un fait.
    expect(cli['version']).toBe(CLI_VERSION);
  });

  it("l'extension n'est PAS a 0.1.0 — cette version est brulee sur le poste de reference", () => {
    /**
     * Un repertoire `~/.vscode/extensions/claudemanager.claudemanager-vscode-0.1.0/` subsiste
     * sur le poste de reference, vestige d'un travail hors-process. Il est absent
     * d'`extensions.json` — donc desinstalle et non charge — mais il porte LE MEME
     * IDENTIFIANT D'EXTENSION que ce qu'on empaquette.
     *
     * Livrer un VSIX en 0.1.0 rendrait le vestige et l'installe indistinguables par leur
     * repertoire, et donc la recette non concluante. La garde vaut au-dela du poste : la
     * version est le seul discriminant dans le nom de ce repertoire.
     */
    expect(EXTENSION_VERSION).not.toBe('0.1.0');
  });

  it("l'extension a depasse 0.2.0, parce que son PROTOCOLE a change sous ce numero", () => {
    /**
     * MOTIF DE LA MONTEE A 0.3.0, et il est factuel, pas cosmetique.
     *
     * `0.2.0` a ete pose au lot B, quand le serveur local n'avait qu'UNE route (`GET /health`).
     * L'increment C1 lui a ajoute `POST /conversations` — la premiere route A EFFET DE BORD,
     * +1 372 lignes — SANS toucher au manifeste (verifie : `git show --stat ef25879 --
     * packages/vscode/package.json` ne rend rien). Deux extensions incompatibles ont donc
     * porte `0.2.0`.
     *
     * Or `packages/core/src/errors.ts` dit a l'utilisateur, mot pour mot, de « comparer son
     * extensionVersion avec `cmgr windows` » pour diagnostiquer un desaccord de protocole.
     * Ce conseil ne peut pas fonctionner si le numero ne bouge pas quand le protocole bouge.
     * Le VSIX etant le premier artefact reellement distribuable, c'est ici que la dette se
     * solde — pas plus tard, quand un utilisateur l'aura payee.
     */
    const [major, minor] = EXTENSION_VERSION.split('.').map((n) => Number.parseInt(n, 10));
    expect(major === 0 ? (minor as number) : major).toBeGreaterThanOrEqual(3);
  });
});

describe('decisions d empaquetage que rien d autre ne tiendrait', () => {
  it("l'extension ne declare AUCUNE dependance d'execution", () => {
    /**
     * C'EST LA GARDE LA PLUS IMPORTANTE DU FICHIER.
     *
     * `package:vscode` passe `--no-dependencies`, sans quoi `vsce` remonte hors du repertoire
     * du paquet et embarque `.git/**` et l'etat de travail de la skill (mesure : 1 527 entrees
     * hors paquet sur 1 582 — `tests/fixtures/packaging/vsce-escape-excerpt.json`).
     *
     * Ce drapeau n'est LEGITIME que parce que l'extension n'a rien a embarquer : le coeur est
     * compile a cote d'elle, pas require depuis `node_modules`. Le jour ou quelqu'un ajoute
     * une vraie dependance d'execution, `--no-dependencies` la retrancherait EN SILENCE et
     * l'extension echouerait au chargement chez l'utilisateur. Ce test est ce qui transforme
     * cette hypothese en contrainte verifiee.
     */
    expect(extension['dependencies']).toBeUndefined();
    expect(extension['bundledDependencies']).toBeUndefined();
  });

  it('la CLI ne declare AUCUNE dependance d execution — meme raison, meme garde', () => {
    // Le tarball n'embarque pas `node_modules` : depuis C2 la CLI passe par le client HTTP du
    // coeur, qui est dans `dist/core`. Une dependance declaree ici serait absente a
    // l'installation.
    expect(cli['dependencies']).toBeUndefined();
  });

  it('`package:vscode` porte bien `--no-dependencies`', () => {
    // Retirer ce drapeau reintroduirait la fuite sans qu'aucun test de contenu ne tourne dans
    // la CI publique — elle n'empaquette pas. La garde est donc sur le SCRIPT.
    expect(scripts['package:vscode']).toContain('--no-dependencies');
  });

  it('`package:all` vide `artifacts/` avant d empaqueter', () => {
    // Sans ce nettoyage, une montee de version laisse l'archive precedente sur place et la
    // verification devient ambigue — deux `.vsix` pour un artefact.
    expect(scripts['package:all']).toContain('artifacts:clean');
  });

  it('`@vscode/vsce` est une devDependency declaree, jamais un outil global', () => {
    // Un outil d'empaquetage non verrouille produit un artefact different d'une machine a
    // l'autre. La version exacte est dans `package-lock.json`.
    const dev = rootManifest['devDependencies'] as Record<string, string>;
    expect(dev['@vscode/vsce']).toBeDefined();
  });

  it('les artefacts d empaquetage ne sont jamais versionnes', () => {
    const gitignore = read('.gitignore');
    expect(gitignore).toContain('*.vsix');
    expect(gitignore).toContain('artifacts/');
  });
});

describe('ce que les manifestes doivent porter pour etre publiables', () => {
  it("l'extension porte tout ce que `vsce` exige, sans drapeau qui le fasse taire", () => {
    // Mesure du 2026-07-26 : `vsce package` ne rend plus AUCUN avertissement une fois la
    // licence en place. Ces champs sont donc traites, pas contournes.
    for (const field of ['name', 'displayName', 'description', 'publisher', 'license', 'engines']) {
      expect(extension[field], field).toBeTruthy();
    }
    expect((extension['categories'] as string[]).length).toBeGreaterThan(0);
    expect((extension['repository'] as Record<string, string>)['url']).toMatch(
      /^https:\/\/github\.com\//
    );
  });

  it('la CLI expose `cmgr` et embarque de quoi l executer', () => {
    expect((cli['bin'] as Record<string, string>)['cmgr']).toBe('./dist/cli/src/cmgr.js');
    // `dist` EN ENTIER : `build:cli` y emet `dist/cli` ET `dist/core`. Restreindre a
    // `dist/cli` livrerait un binaire qui echoue a l'execution sur un module absent.
    expect(cli['files']).toContain('dist');
  });

  it('`main` de l extension designe la racine compilee, jamais une source', () => {
    const main = extension['main'] as string;
    expect(main).toBe('./dist/vscode/src/extension.js');
    expect(main.endsWith('.js')).toBe(true);
  });

  it('les trois manifestes s accordent sur la licence', () => {
    expect(extension['license']).toBe(rootManifest['license']);
    expect(cli['license']).toBe(rootManifest['license']);
  });

  it('la licence embarquee dans le VSIX est CELLE du depot, a l octet', () => {
    // `vsce` exige un fichier de licence DANS le repertoire du paquet — d'ou une copie. Une
    // copie derive : ce test est ce qui l'en empeche.
    expect(read('packages', 'vscode', 'LICENSE')).toBe(read('LICENSE'));
  });

  it("aucun manifeste ne porte de chemin du poste ni d'adresse personnelle", () => {
    // Le depot est PUBLIC, et un manifeste est exactement le genre de fichier ou une URL ou un
    // chemin absolu se glisse.
    for (const [label, manifest] of [
      ['extension', extension],
      ['cli', cli],
    ] as const) {
      const serialized = JSON.stringify(manifest);
      expect(serialized, label).not.toMatch(/[A-Za-z]:\\\\/);
      expect(serialized, label).not.toMatch(/\/Users\//);
      expect(serialized.toLowerCase(), label).not.toContain('onedrive');
    }
  });
});

describe('`.vscodeignore` retranche ce qu il doit retrancher', () => {
  /**
   * Complementaire, jamais substitut : ce que ce bloc juge est une INTENTION declaree, et
   * l'increment se prouve sur l'ARCHIVE (`npm run verify:packaging`, plus les relevés reels de
   * `rules.test.ts`). Les deux ensemble disent pourquoi une entree manque : parce qu'on l'a
   * ecartee, et pas par accident.
   */
  const lines = read('packages', 'vscode', '.vscodeignore')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  it('ecarte les sources, les cartes et les dependances', () => {
    expect(lines).toContain('src/**');
    expect(lines).toContain('**/*.map');
    expect(lines).toContain('node_modules/**');
  });

  it("n'ecarte NI `dist/vscode`, NI `dist/core` — l'erreur qui viderait le VSIX", () => {
    for (const line of lines) {
      expect(line.startsWith('dist'), `« ${line} » retrancherait une racine compilee`).toBe(false);
    }
  });
});
