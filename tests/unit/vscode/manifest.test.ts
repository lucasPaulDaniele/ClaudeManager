import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VSCODE_VERSION } from '../../integration/src/environment.js';

/**
 * Le plancher `engines.vscode` est une PROMESSE PUBLIQUE : elle doit etre tenue par quelque
 * chose.
 *
 * Trois nombres coexistaient sans qu'aucune garde ne les relie (finding R6) — le manifeste
 * promettait `^1.90.0`, la verification de types s'appuyait sur `@types/vscode` **1.125.0**,
 * et la seule preuve d'execution etait epinglee a **1.122.1**. `npm run typecheck` ne
 * pouvait donc pas detecter l'usage d'une API introduite apres 1.90 : mesure, un appel a
 * `vscode.lm.registerMcpServerDefinitionProvider` (API MCP, 1.101) compilait sans un mot.
 *
 * Les types sont desormais alignes sur le plancher, ce qui fait de la promesse une
 * contrainte VERIFIEE a chaque `npm run typecheck`. Ce test empeche les deux de se
 * desolidariser a nouveau — c'est exactement ainsi que le defaut etait ne.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readJson(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(ROOT, ...segments), 'utf8')) as Record<string, unknown>;
}

/** `^1.90.0`, `~1.90.0`, `1.90.0` -> `[1, 90, 0]`. Aucune dependance ajoutee pour cela. */
function versionOf(range: string): readonly number[] {
  const parts = range.replace(/^[\^~>=<\s]+/, '').split('.');
  return parts.map((part) => Number.parseInt(part, 10));
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const manifest = readJson('packages', 'vscode', 'package.json');
const engines = manifest['engines'] as Record<string, string>;
const devDependencies = manifest['devDependencies'] as Record<string, string>;
const floor = versionOf(engines['vscode'] as string);

describe('plancher VSCode annonce par l extension', () => {
  it('est le plancher que ce depot connait — le changer est une decision, pas un effet de bord', () => {
    expect(engines['vscode']).toBe('^1.90.0');
  });

  it('est celui contre lequel les types verifient, sans quoi il ne garde rien', () => {
    // La ligne qui manquait : `@types/vscode` etait a `^1.125.0` a la racine, donc rien
    // n'empechait d'employer une API posterieure a 1.90 sans s'en apercevoir.
    const installed = versionOf(
      readJson('node_modules', '@types', 'vscode', 'package.json')['version'] as string
    );

    expect(installed[0]).toBe(floor[0]);
    expect(installed[1]).toBe(floor[1]);
  });

  it('est declare a l identique par le paquet et par la racine du depot', () => {
    const root = readJson('package.json')['devDependencies'] as Record<string, string>;

    // Deux plages differentes se dedupliqueraient sur la plus haute, et la verification
    // repartirait sur des types que le manifeste ne promet pas.
    expect(devDependencies['@types/vscode']).toBe(root['@types/vscode']);
    expect(versionOf(devDependencies['@types/vscode'] as string)).toEqual(floor);
  });

  it('n est jamais au-dessus de la version reellement eprouvee par le harnais', () => {
    // Promettre un plancher qu'aucune execution n'a jamais atteint serait une declaration,
    // pas une mesure.
    expect(compare(floor, versionOf(VSCODE_VERSION))).toBeLessThanOrEqual(0);
  });
});
