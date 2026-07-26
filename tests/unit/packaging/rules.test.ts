import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLI_TARBALL_SPEC,
  VSIX_SPEC,
  inspectArchive,
  type ArchiveSpec,
} from '../../packaging/src/rules.js';

/**
 * LA REGLE D'EMPAQUETAGE, EPROUVEE A CHAQUE CI — sur des relevés d'archives REELS.
 *
 * Ce fichier ne lit aucune archive : il juge des LISTES D'ENTREES capturees depuis les vrais
 * artefacts (`tests/fixtures/packaging/`). C'est ce qui lui permet de tourner dans la CI
 * publique, qui n'empaquette rien, alors que la verification de l'artefact lui-meme
 * (`npm run verify:packaging`) est locale.
 *
 * CE QUE CE FICHIER PROUVE, ET C'EST TOUT SON OBJET : la regle PEUT ECHOUER.
 *
 * « Une assertion qui n'a rien observe passe toujours » — la lecon transversale du lot. Une
 * regle d'empaquetage est particulierement exposee a ce travers : ecrite pour accepter
 * l'archive du jour, elle accepterait aussi bien n'importe quoi. Chaque cas negatif ci-dessous
 * part donc du releve REEL et lui applique UNE mutation, puis exige une violation nommee. Les
 * mutations ne fabriquent pas une fixture : elles derivent d'une capture reelle la defaillance
 * exacte qu'on veut voir refusee.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(ROOT, 'tests', 'fixtures', 'packaging', name), 'utf8')
  ) as Record<string, unknown>;
}

const VSIX_REAL = fixture('vsix-entries.json')['entries'] as string[];
const CLI_REAL = fixture('cli-tarball-entries.json')['entries'] as string[];
const ESCAPE = fixture('vsce-escape-excerpt.json');

/** Les motifs de violation, sans leurs entrees : ce qu'on veut affirmer, c'est le POURQUOI. */
function reasons(entries: readonly string[], spec: ArchiveSpec): readonly string[] {
  return inspectArchive(entries, spec).map((v) => v.why);
}

describe('les relevés REELS des deux artefacts sont conformes', () => {
  it('le VSIX capture le 2026-07-26 ne porte aucune violation', () => {
    expect(inspectArchive(VSIX_REAL, VSIX_SPEC)).toEqual([]);
  });

  it('le tarball de la CLI capture le 2026-07-26 ne porte aucune violation', () => {
    expect(inspectArchive(CLI_REAL, CLI_TARBALL_SPEC)).toEqual([]);
  });

  it('les deux relevés portent bien les DEUX racines compilees', () => {
    // Le fait meme que l'increment C3 existe pour garantir. Affirme sur le releve, pas sur
    // `.vscodeignore` ni sur `files`.
    expect(VSIX_REAL.filter((e) => e.startsWith('extension/dist/vscode/src/')).length).toBe(8);
    expect(VSIX_REAL.filter((e) => e.startsWith('extension/dist/core/src/')).length).toBe(13);
    expect(CLI_REAL.filter((e) => e.startsWith('package/dist/cli/src/')).length).toBe(8);
    expect(CLI_REAL.filter((e) => e.startsWith('package/dist/core/src/')).length).toBe(13);
  });
});

describe('LA FUITE MESUREE — `vsce` sans `--no-dependencies` remonte hors du paquet', () => {
  /**
   * Le releve reel de la fuite : 1 582 entrees annoncees, 1 527 EN DEHORS du repertoire du
   * paquet, dont `.git/**` et `orchestration-claudemanager/**` — l'etat de travail de la
   * skill, que `.gitignore` ecarte precisement parce qu'il porte un prefixe de jeton REEL,
   * des uuid de sessions, une adresse IP interne et un nom de compte.
   *
   * Si cette regle laissait passer CE releve, elle ne protegerait de rien.
   */
  const excerpt = ESCAPE['excerpt'] as string[];

  it('le releve de la fuite est refuse — chaque entree hors prefixe est signalee', () => {
    const violations = inspectArchive(excerpt, VSIX_SPEC);
    const leaks = violations.filter((v) => v.why.includes('FUITE'));

    // TOUTES les entrees de l'extrait sont hors du paquet : aucune ne doit passer.
    expect(leaks.length).toBe(excerpt.length);
  });

  it('les zones les plus graves de la fuite sont nommement refusees', () => {
    const refused = (entry: string): readonly string[] => reasons([entry], VSIX_SPEC);

    for (const entry of ['../../.git/ORIG_HEAD', '../../orchestration-claudemanager/.gitkeep']) {
      expect(excerpt, `${entry} doit etre dans l extrait capture`).toContain(entry);
      expect(refused(entry).length, entry).toBeGreaterThan(0);
    }
  });

  it('les memes zones sont refusees AUSSI quand elles sont sous le bon prefixe', () => {
    // La garde de prefixe seule ne suffirait pas : un jour, un chemin interne pourrait porter
    // l'un de ces repertoires. Les motifs interdits valent donc independamment du prefixe.
    expect(reasons([...VSIX_REAL, 'extension/.git/config'], VSIX_SPEC)).toContain(
      'internes de git — historique, configuration, message de commit en cours'
    );
    expect(reasons([...VSIX_REAL, 'extension/orchestration-claudemanager/x.json'], VSIX_SPEC))
      .toContain(
        "etat de travail de la skill /orchestrer — il porte un prefixe de jeton REEL, des uuid de sessions, une adresse IP interne et un nom de compte (cf. .gitignore)"
      );
    expect(reasons([...VSIX_REAL, 'extension/node_modules/x/index.js'], VSIX_SPEC).length)
      .toBeGreaterThan(0);
  });
});

describe('CHAQUE regle peut echouer — une mutation du releve reel, une violation', () => {
  /**
   * Le tableau ci-dessous est la preuve demandee par la lecon transversale du lot : pour
   * chaque interdiction et chaque exigence, un releve REEL mute d'un cran, et l'assurance que
   * la regle le refuse. Sans ces cas, rien ne distinguerait une regle qui garde de deux
   * fonctions qui rendent toujours une liste vide.
   */
  const mutations: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['une source TypeScript', [...VSIX_REAL, 'extension/src/extension.ts']],
    ['une carte de source', [...VSIX_REAL, 'extension/dist/vscode/src/extension.js.map']],
    ['le marqueur de format des sources', [...VSIX_REAL, 'extension/src/package.json']],
    ['une configuration d emission', [...VSIX_REAL, 'extension/tsconfig.build.json']],
    ['un rapport de couverture', [...VSIX_REAL, 'extension/coverage/lcov.info']],
    ['l instance VSCode du harnais', [...VSIX_REAL, 'extension/.vscode-test/extensions.json']],
    ['un artefact dans l artefact', [...VSIX_REAL, 'extension/claudemanager-vscode-0.3.0.vsix']],
    ['un chemin remontant', [...VSIX_REAL, 'extension/dist/../../../etc/passwd']],
    ['un chemin absolu POSIX', [...VSIX_REAL, '/etc/passwd']],
    ['un chemin absolu Windows', [...VSIX_REAL, 'C:/Windows/System32/drivers/etc/hosts']],
  ];

  for (const [label, entries] of mutations) {
    it(`refuse ${label}`, () => {
      expect(inspectArchive(entries, VSIX_SPEC).length).toBeGreaterThan(0);
    });
  }

  it('refuse un VSIX AMPUTE DE `dist/core` — le piege central de cet empaquetage', () => {
    // LE cas. Le coeur est compile A COTE de l'extension, jamais recopie : un VSIX sans lui
    // s'installe sans un mot et echoue au CHARGEMENT, ce qu'aucun typecheck ne rattrape.
    const amputated = VSIX_REAL.filter((e) => !e.startsWith('extension/dist/core/'));
    const why = reasons(amputated, VSIX_SPEC);

    expect(why).toContain('ABSENT, et l artefact ne fonctionne pas sans lui');
    expect(why.some((w) => w.includes('racine compilee absente ou incomplete'))).toBe(true);
  });

  it('refuse un VSIX ampute de `dist/vscode`', () => {
    const amputated = VSIX_REAL.filter((e) => !e.startsWith('extension/dist/vscode/'));
    expect(reasons(amputated, VSIX_SPEC).length).toBeGreaterThan(0);
  });

  it('refuse un VSIX ampute du seul `extension.js` — le `main` du manifeste', () => {
    const amputated = VSIX_REAL.filter((e) => e !== 'extension/dist/vscode/src/extension.js');
    expect(reasons(amputated, VSIX_SPEC)).toContain(
      'ABSENT, et l artefact ne fonctionne pas sans lui'
    );
  });

  it('refuse un VSIX ampute de son manifeste', () => {
    const amputated = VSIX_REAL.filter((e) => e !== 'extension/package.json');
    expect(reasons(amputated, VSIX_SPEC)).toContain(
      'ABSENT, et l artefact ne fonctionne pas sans lui'
    );
  });

  it('refuse un tarball de CLI ampute de `dist/core` — ce que C2 a rendu fatal', () => {
    // Depuis C2, `cmgr open` passe par le client HTTP du coeur. Sans `dist/core`, le binaire
    // installe echoue a l'execution sur un module absent.
    const amputated = CLI_REAL.filter((e) => !e.startsWith('package/dist/core/'));
    const why = reasons(amputated, CLI_TARBALL_SPEC);

    expect(why).toContain('ABSENT, et l artefact ne fonctionne pas sans lui');
    expect(why.some((w) => w.includes('racine compilee absente ou incomplete'))).toBe(true);
  });

  it('refuse un tarball de CLI ampute de `cmgr.js` — le `bin` du manifeste', () => {
    const amputated = CLI_REAL.filter((e) => e !== 'package/dist/cli/src/cmgr.js');
    expect(reasons(amputated, CLI_TARBALL_SPEC)).toContain(
      'ABSENT, et l artefact ne fonctionne pas sans lui'
    );
  });
});

describe('ce que la regle ne doit PAS refuser — les faux positifs coutent aussi', () => {
  it('tolere les deux metadonnees que le format VSIX impose', () => {
    // Elles sont hors du prefixe `extension/` et ne sont pas de nous : les refuser rendrait la
    // regle inapplicable a tout VSIX reel.
    expect(inspectArchive(['extension.vsixmanifest', '[Content_Types].xml'], VSIX_SPEC).filter(
      (v) => v.why.includes('FUITE')
    )).toEqual([]);
  });

  it('tolere la licence et le readme renommes par `vsce`', () => {
    // `vsce` renomme `LICENSE` -> `LICENSE.txt` et met `README.md` en minuscules. Les deux
    // sont dans le releve reel, qui ne porte aucune violation — redit ici parce que c'est le
    // genre de detail qu'une regle trop stricte casserait sans qu'on comprenne pourquoi.
    expect(VSIX_REAL).toContain('extension/LICENSE.txt');
    expect(VSIX_REAL).toContain('extension/readme.md');
    expect(inspectArchive(VSIX_REAL, VSIX_SPEC)).toEqual([]);
  });

  it('tolere les entrees de repertoire, que certains formats emettent', () => {
    expect(inspectArchive([...VSIX_REAL, 'extension/dist/'], VSIX_SPEC)).toEqual([]);
  });

  it('juge un separateur Windows comme un separateur', () => {
    // Un lecteur d'archive pourrait rendre des `\` ; la regle normalise avant de juger, sans
    // quoi `extension\dist\...` serait vu comme hors prefixe.
    const windowsStyle = VSIX_REAL.map((e) => e.replace(/\//g, '\\'));
    expect(inspectArchive(windowsStyle, VSIX_SPEC)).toEqual([]);
  });
});
