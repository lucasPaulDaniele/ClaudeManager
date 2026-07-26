/**
 * CE QUI DOIT ETRE DANS UN ARTEFACT LIVRE, ET CE QUI N'A RIEN A Y FAIRE.
 *
 * Un empaquetage se casse EN SILENCE : tout compile, tous les tests passent, la CI est verte,
 * et l'archive livree est inutilisable. Aucun `typecheck` ne rattrape un module absent de
 * l'archive — cela ne se voit qu'a l'execution, sur le poste de quelqu'un d'autre.
 *
 * Ce module ne lit aucun fichier et ne connait aucun format d'archive : il ne juge qu'une
 * LISTE DE NOMS D'ENTREES. C'est ce qui lui permet d'etre a la fois :
 *   - eprouve en test unitaire (`tests/unit/packaging/rules.test.ts`) sur des relevés
 *     d'archives REELS, y compris des relevés qu'il doit REFUSER ;
 *   - applique a l'artefact reel (`tests/packaging/src/verify.test.ts`), sur l'archive que
 *     `npm run package:all` vient de produire.
 *
 * Une seule regle, deux appelants : ils ne peuvent pas diverger.
 */

/** Ce qu'une archive doit contenir, et ce qu'elle ne doit pas contenir. */
export interface ArchiveSpec {
  /** Nom lisible de l'artefact, pour les messages de violation. */
  readonly label: string;
  /**
   * Prefixe unique sous lequel TOUT le contenu utile doit vivre.
   *
   * C'est la garde la plus importante du fichier. Mesure du 2026-07-26 : `vsce` sans
   * `--no-dependencies`, dans ce monorepo, remonte HORS du repertoire du paquet et embarque
   * `../../.git/**` et `../../orchestration-claudemanager/**` — soit les internes de git et
   * l'etat de travail de la skill, que `.gitignore` ecarte precisement parce qu'il porte un
   * prefixe de jeton REEL, des uuid de sessions, une adresse IP interne et un nom de compte.
   * 1 574 fichiers au lieu de 22. Une entree hors de ce prefixe est donc une FUITE, pas une
   * maladresse de rangement.
   */
  readonly root: string;
  /** Entrees tolerees hors du prefixe — les metadonnees que le format impose. */
  readonly metadata: readonly string[];
  /** Chemins exacts sans lesquels l'artefact ne fonctionne pas. */
  readonly required: readonly string[];
  /** Repertoires devant porter au moins `min` entrees. */
  readonly populated: readonly { readonly prefix: string; readonly min: number }[];
}

/**
 * CE QUI NE DOIT JAMAIS PARTIR, quel que soit l'artefact.
 *
 * Chaque motif designe une defaillance CONSTATEE ou un risque nomme, jamais un rangement de
 * principe. L'ordre n'a pas d'importance : toutes les violations sont rendues, pas la
 * premiere — un rapport qui s'arrete au premier defaut fait croire qu'il n'y en avait qu'un.
 */
const FORBIDDEN: readonly { readonly why: string; readonly hit: (entry: string) => boolean }[] = [
  {
    why: "internes de git — historique, configuration, message de commit en cours",
    hit: (e) => e.split('/').includes('.git'),
  },
  {
    why: "etat de travail de la skill /orchestrer — il porte un prefixe de jeton REEL, des uuid de sessions, une adresse IP interne et un nom de compte (cf. .gitignore)",
    hit: (e) => e.split('/').some((s) => s.startsWith('orchestration-')),
  },
  {
    why: 'dependances : aucun artefact de ce depot n en a a l execution, le coeur etant compile avec son consommateur',
    hit: (e) => e.split('/').includes('node_modules'),
  },
  {
    why: 'rapport de couverture — un etat de mesure local, jamais un livrable',
    hit: (e) => e.split('/').includes('coverage'),
  },
  {
    why: "instance VSCode telechargee par le harnais d'integration",
    hit: (e) => e.split('/').includes('.vscode-test'),
  },
  {
    why: 'sources TypeScript : ce qui s execute est le JavaScript emis, et `main`/`bin` n y renvoient jamais',
    hit: (e) => e.endsWith('.ts'),
  },
  {
    why: 'cartes de source : les sources ne partant pas, elles pointeraient sur des fichiers absents de l archive',
    hit: (e) => e.endsWith('.map'),
  },
  {
    why: "configuration d'emission : elle sert a PRODUIRE l artefact, jamais a l executer",
    hit: (e) => /(^|\/)tsconfig[^/]*\.json$/.test(e),
  },
  {
    why: 'artefact d empaquetage embarque dans un artefact d empaquetage',
    hit: (e) => e.endsWith('.vsix') || e.endsWith('.tgz'),
  },
  {
    why: 'chemin remontant hors de l archive, ou chemin absolu',
    hit: (e) => e.split('/').includes('..') || /^([a-zA-Z]:|\/)/.test(e),
  },
];

/**
 * Le marqueur de format des SOURCES (`packages/vscode/src/package.json`), qui declare
 * `type: module` — l'exact contraire de ce que le chargeur d'extensions de VSCode exige.
 * Il est deja couvert par l'interdiction des sources, mais il merite son propre message :
 * embarque, il produirait une extension qui ne se charge pas, avec une erreur qui ne
 * designerait pas la cause.
 */
const FORMAT_MARKER = 'src/package.json';

/** Une violation, telle qu'elle est rendue a l'appelant. */
export interface Violation {
  readonly entry: string;
  readonly why: string;
}

/**
 * Juge une liste d'entrees d'archive. Rend TOUTES les violations, l'archive etant conforme si
 * et seulement si la liste est vide.
 */
export function inspectArchive(
  entries: readonly string[],
  spec: ArchiveSpec
): readonly Violation[] {
  const violations: Violation[] = [];
  const normalized = entries.map((e) => e.replace(/\\/g, '/')).filter((e) => !e.endsWith('/'));

  for (const entry of normalized) {
    if (!entry.startsWith(spec.root) && !spec.metadata.includes(entry)) {
      violations.push({
        entry,
        why: `hors du prefixe « ${spec.root} » — FUITE hors du repertoire du paquet`,
      });
      // Une entree hors prefixe est deja disqualifiante ; la juger deux fois n'apprend rien.
      continue;
    }

    for (const rule of FORBIDDEN) {
      if (rule.hit(entry)) violations.push({ entry, why: rule.why });
    }

    if (entry.endsWith(`/${FORMAT_MARKER}`)) {
      violations.push({
        entry,
        why: 'marqueur de format des sources : il declare `type: module`, que le chargeur d extensions refuse',
      });
    }
  }

  const present = new Set(normalized);
  for (const needed of spec.required) {
    if (!present.has(needed)) {
      violations.push({ entry: needed, why: 'ABSENT, et l artefact ne fonctionne pas sans lui' });
    }
  }

  for (const { prefix, min } of spec.populated) {
    const count = normalized.filter((e) => e.startsWith(prefix)).length;
    if (count < min) {
      violations.push({
        entry: prefix,
        why: `${count} entree(s) pour un minimum de ${min} — racine compilee absente ou incomplete`,
      });
    }
  }

  return violations;
}

/**
 * LE VSIX DE L'EXTENSION COMPAGNON.
 *
 * `dist/core/**` est exige AU MEME TITRE que `dist/vscode/**`, et c'est tout l'enjeu : le
 * coeur est compile A COTE de l'extension (`rootDir: ".."`), jamais recopie dans ses sources.
 * Un VSIX qui ne porterait que `dist/vscode` s'installerait sans un mot et echouerait au
 * chargement, sur un `require` de module absent.
 *
 * Les minima sont deliberement BAS : ce test garde la PRESENCE des deux racines, pas le
 * decompte du jour. Un seuil egal au nombre exact de fichiers casserait a chaque module
 * ajoute, ce qui apprend a le relever sans le lire.
 */
export const VSIX_SPEC: ArchiveSpec = {
  label: 'VSIX de l extension compagnon',
  root: 'extension/',
  // Imposees par le format VSIX lui-meme, et generees par `vsce` : elles ne sont pas a nous.
  metadata: ['extension.vsixmanifest', '[Content_Types].xml'],
  required: [
    'extension/package.json',
    // `main` du manifeste. C'est le seul fichier dont l'absence est fatale AU CHARGEMENT.
    'extension/dist/vscode/src/extension.js',
    // Le point d'entree du coeur, par lequel tout le reste est requis.
    'extension/dist/core/src/index.js',
  ],
  populated: [
    { prefix: 'extension/dist/vscode/src/', min: 5 },
    { prefix: 'extension/dist/core/src/', min: 5 },
  ],
};

/**
 * LE TARBALL NPM DE LA CLI.
 *
 * Meme piege, meme garde : depuis l'increment C2, `cmgr open` passe par le client HTTP du
 * COEUR. Le paquet ne declarant aucune dependance, `dist/core` doit etre DANS le tarball —
 * sans quoi `cmgr open` echoue a l'execution, une fois installe, sur la machine de
 * quelqu'un d'autre.
 */
export const CLI_TARBALL_SPEC: ArchiveSpec = {
  label: 'tarball npm de la CLI',
  root: 'package/',
  metadata: [],
  required: [
    'package/package.json',
    // `bin.cmgr` du manifeste.
    'package/dist/cli/src/cmgr.js',
    'package/dist/core/src/index.js',
  ],
  populated: [
    { prefix: 'package/dist/cli/src/', min: 5 },
    { prefix: 'package/dist/core/src/', min: 5 },
  ],
};
