import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'core',
  'src'
);

function sourcesUnder(directory: string): readonly string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe('garde-fou d architecture', () => {
  it("l'identite ne lit AUCUNE variable d'environnement", () => {
    // C'est ce qui interdit structurellement de retomber sur VSCODE_PID (partage entre
    // fenetres, piege n.4) ou sur CLAUDE_CODE_SSE_PORT (piste non arbitree, alerte n.7).
    // Seul l'extHostPid, retrouve par la chaine d'ancetres, fait identite.
    const files = sourcesUnder(path.join(CORE_SRC, 'identity'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect(readFileSync(file, 'utf8'), path.basename(file)).not.toMatch(/process\s*\.\s*env/);
    }
  });

  it("le coeur n'importe jamais le module vscode", () => {
    // Principe fondateur n.4 : sans cette regle, tester devient impossible sans lancer un
    // editeur complet.
    const files = sourcesUnder(CORE_SRC);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect(readFileSync(file, 'utf8'), path.basename(file)).not.toMatch(
        /from\s+['"]vscode['"]|require\(\s*['"]vscode['"]\s*\)/
      );
    }
  });

  it('le coeur ne journalise pas', () => {
    // La regle ESLint no-console le garantit deja ; ce test le dit dans le langage du
    // produit plutot que dans celui de l'outillage.
    for (const file of sourcesUnder(CORE_SRC)) {
      expect(readFileSync(file, 'utf8'), path.basename(file)).not.toMatch(/console\s*\./);
    }
  });
});
