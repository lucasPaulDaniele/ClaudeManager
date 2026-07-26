import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INHERITED_ENVIRONMENT,
  neutralizeInheritedEnvironment,
} from '../../integration/src/environment.js';

/**
 * LA GARDE QUI N'ETAIT PAS GARDEE (§5 de l'increment B5).
 *
 * Le lanceur d'integration supprime les variables heritees d'une session Claude avant de
 * demarrer le VSCode de test. Sans cela, `npm run test:integration` ECHOUE — constate et
 * corrige a la main sur le poste de reference, sans qu'aucun test ne le rejoue. Une garde
 * qu'aucun test ne rejoue est une garde qu'un refactor supprimera un jour en silence, et le
 * symptome — `Cannot find module <dossier de travail>` — n'indique rien de sa cause.
 *
 * DEUX PROPRIETES DISTINCTES, et la seconde est celle qui compte :
 *   1. les variables fatales sont RECONNUES par le filtre ;
 *   2. elles sont SUPPRIMEES, pas vidées. Electron teste leur PRESENCE — `env.X = ''` laisse
 *      la variable definie, donc l'assainissement sans effet tout en ayant l'air d'avoir eu
 *      lieu. C'est exactement le mode de defaillance qu'un correctif « propre » introduirait.
 *
 * Le jeu d'entree est une CAPTURE REELLE (`tests/fixtures/environment/`), prise dans une
 * session Claude Code du terminal integre de VSCode : aucun nom n'est invente ici.
 */

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'environment',
  'claude-session-env-names.json'
);

interface EnvironmentCapture {
  readonly provenance: { readonly nameCount: number };
  readonly inheritedNames: readonly string[];
  readonly knownFatalToElectron: Readonly<Record<string, string>>;
}

const CAPTURE = JSON.parse(readFileSync(FIXTURE, 'utf8')) as EnvironmentCapture;

/** Ce qu'un shell porte de legitime et que l'assainissement ne doit JAMAIS toucher. */
const BYSTANDERS = ['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'NODE_ENV', 'CI'];

/** Reconstruit un environnement a partir de la capture. Valeur inerte : seul le nom compte. */
function environmentFromCapture(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of CAPTURE.inheritedNames) env[name] = 'valeur-inerte';
  for (const name of BYSTANDERS) env[name] = `valeur-de-${name}`;
  return env;
}

describe('la capture est bien celle qu on croit', () => {
  it('porte des noms, jamais de valeurs, et le compte annonce', () => {
    expect(CAPTURE.inheritedNames).toHaveLength(CAPTURE.provenance.nameCount);
    expect(CAPTURE.inheritedNames.length).toBeGreaterThan(0);
    expect([...CAPTURE.inheritedNames].sort()).toEqual(CAPTURE.inheritedNames);
    // Un nom de variable ne contient ni `=` ni separateur de chemin : si l'un apparait, c'est
    // qu'une VALEUR s'est glissee dans la capture d'un depot public.
    for (const name of CAPTURE.inheritedNames) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('porte les trois variables que le lot C devra neutraliser lui aussi', () => {
    // Le terminal masque du lot C herite du meme environnement : la liste n'est pas propre au
    // harnais, c'est le meme probleme qui l'attend.
    for (const name of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK', 'VSCODE_ESM_ENTRYPOINT']) {
      expect(CAPTURE.inheritedNames).toContain(name);
      expect(Object.keys(CAPTURE.knownFatalToElectron)).toContain(name);
    }
  });
});

describe('neutralizeInheritedEnvironment — ce qu elle retire', () => {
  it('retire TOUS les noms de la capture reelle, sans en oublier un seul', () => {
    // Le filtre est par FAMILLE : cette assertion est ce qui l'oblige a couvrir une capture
    // qu'il n'a pas choisie. Une famille retiree du motif la fait echouer sur-le-champ.
    const env = environmentFromCapture();

    const removed = neutralizeInheritedEnvironment(env);

    expect([...removed].sort()).toEqual([...CAPTURE.inheritedNames].sort());
    expect(Object.keys(env).sort()).toEqual([...BYSTANDERS].sort());
  });

  it('SUPPRIME les variables fatales au lieu de les vider — Electron teste la PRESENCE', () => {
    // LE POINT DE §5. `env.X = ''` passerait toutes les assertions ecrites sur la valeur
    // (`toBeUndefined` inclus, une chaine vide etant falsy) et laisserait pourtant Electron
    // demarrer en Node. Seul `in` distingue les deux.
    const env = environmentFromCapture();

    neutralizeInheritedEnvironment(env);

    for (const name of Object.keys(CAPTURE.knownFatalToElectron)) {
      expect(name in env).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(env, name)).toBe(false);
    }
    // Et sur l'ENSEMBLE de la capture, pas seulement sur les trois nommees.
    for (const name of CAPTURE.inheritedNames) expect(name in env).toBe(false);
  });

  it('ne touche AUCUNE variable etrangere aux cinq familles', () => {
    const env = environmentFromCapture();

    neutralizeInheritedEnvironment(env);

    for (const name of BYSTANDERS) expect(env[name]).toBe(`valeur-de-${name}`);
  });

  it('rend la liste TRIEE de ce qu elle a retire, et rien de plus', () => {
    // Le lanceur imprime cette liste : elle est la seule trace de ce qui a ete assaini.
    const env: NodeJS.ProcessEnv = {
      VSCODE_PID: '1',
      CLAUDECODE: '1',
      ELECTRON_RUN_AS_NODE: '1',
      PATH: 'x',
    };

    expect(neutralizeInheritedEnvironment(env)).toEqual([
      'CLAUDECODE',
      'ELECTRON_RUN_AS_NODE',
      'VSCODE_PID',
    ]);
  });

  it('rend une liste vide sur un environnement deja propre, sans rien inventer', () => {
    const env: NodeJS.ProcessEnv = { PATH: 'x' };

    expect(neutralizeInheritedEnvironment(env)).toEqual([]);
    expect(env['PATH']).toBe('x');
  });

  it('ne se laisse pas prendre par un nom qui CONTIENT une famille sans commencer par elle', () => {
    // Le motif est ancre : `MY_VSCODE_PID` n'est pas une variable de VSCode, et la supprimer
    // serait aussi grave que d'oublier la vraie.
    const env: NodeJS.ProcessEnv = { MY_VSCODE_PID: '1', XCLAUDE_CODE_ENTRYPOINT: '1' };

    expect(neutralizeInheritedEnvironment(env)).toEqual([]);
    expect(Object.keys(env).sort()).toEqual(['MY_VSCODE_PID', 'XCLAUDE_CODE_ENTRYPOINT']);
  });

  it('reconnait chaque famille annoncee, une par une', () => {
    for (const name of [
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'VSCODE_IPC_HOOK',
      'ELECTRON_RUN_AS_NODE',
      'CHROME_CRASHPAD_PIPE_NAME',
    ]) {
      expect(INHERITED_ENVIRONMENT.test(name)).toBe(true);
    }
  });
});

/**
 * LE VRAI `process.env`, et pas un objet ordinaire.
 *
 * `process.env` n'est pas un objet JavaScript comme un autre : Node y coerce toute valeur en
 * chaine, et `delete` y traverse jusqu'a l'environnement du processus. Prouver la semantique
 * de suppression sur un objet nu la prouverait pour un objet nu — pas pour ce que le lanceur
 * mute reellement. C'est le principe fondateur n.5 applique a l'echelle d'une seule fonction.
 */
describe('neutralizeInheritedEnvironment — sur le VRAI process.env', () => {
  const planted = ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK', 'VSCODE_ESM_ENTRYPOINT'];
  const saved = new Map<string, string | undefined>();

  /**
   * Sauvegarde TOUT ce que l'appel va retirer, pas seulement ce qu'on a depose.
   *
   * Ce test s'execute peut-etre lui-meme dans une session Claude : l'appel sans argument
   * videra alors les vraies variables du processus de test. Les restaurer une a une est ce
   * qui rend ce test sans effet sur ceux qui le suivent.
   */
  function remember(name: string): void {
    if (!saved.has(name)) saved.set(name, process.env[name]);
  }

  afterEach(() => {
    // Restauration EXACTE : une variable absente avant l'est encore apres.
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
  });

  it('les supprime reellement du processus, et `in` le confirme', () => {
    for (const name of Object.keys(process.env)) {
      if (INHERITED_ENVIRONMENT.test(name)) remember(name);
    }
    for (const name of planted) {
      remember(name);
      process.env[name] = '1';
      expect(name in process.env).toBe(true);
    }
    // `PATH` est notre temoin : il traverse l'assainissement sans une egratignure.
    const pathBefore = process.env['PATH'];

    const removed = neutralizeInheritedEnvironment();

    for (const name of planted) {
      expect(removed).toContain(name);
      expect(name in process.env).toBe(false);
    }
    expect(process.env['PATH']).toBe(pathBefore);
  });
});
