import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Garde-fou d'architecture de la CLI.
 *
 * Ce que ce fichier verifie ne se relit pas : il s'agit de proprietes qu'une relecture
 * attentive laisserait passer une fois sur dix, et qui deviendraient fausses au premier
 * increment distrait.
 */

const CLI_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'cli',
  'src'
);

function sourcesUnder(directory: string): readonly string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe('garde-fou d architecture de la CLI', () => {
  it('la CLI ne fait AUCUN reseau', () => {
    // Le lot B ne parle a aucun serveur : `cmgr` lit le registre et la table des processus,
    // rien d'autre. Le client HTTP est `core/client`, inscrit au lot C — une commande de
    // lecture qui interrogerait `/health` ferait dependre l'inventaire des fenetres de leur
    // joignabilite, deux questions distinctes.
    const files = sourcesUnder(CLI_SRC);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, path.basename(file)).not.toMatch(
        /from\s+['"]node:(http|https|net|tls|dgram)['"]|require\(\s*['"]node:(http|https|net|tls|dgram)['"]\s*\)/
      );
      expect(source, path.basename(file)).not.toMatch(/\bfetch\s*\(|\bnew\s+WebSocket\b/);
    }
  });

  it("la CLI n'importe jamais le module vscode", () => {
    // Principe fondateur n.4. La configuration d'emission le garantit deja — elle ne
    // declare pas les types `vscode` —, ce test le dit dans le langage du produit.
    for (const file of sourcesUnder(CLI_SRC)) {
      expect(readFileSync(file, 'utf8'), path.basename(file)).not.toMatch(
        /from\s+['"]vscode['"]|require\(\s*['"]vscode['"]\s*\)/
      );
    }
  });

  it("la CLI n'ecrit jamais dans le registre, et ne le purge jamais", () => {
    // `cmgr` est strictement en LECTURE au lot B. La purge appartient a l'extension
    // compagnon, qui seule sait quand sa fenetre s'active ; ouvrir et fermer relevent du
    // lot C. Importer `writeWindowEntry` ou `purgeStaleEntries` serait donc un elargissement
    // de perimetre, pas un detail.
    for (const file of sourcesUnder(CLI_SRC)) {
      const source = readFileSync(file, 'utf8');
      expect(source, path.basename(file)).not.toMatch(/\b(purgeStaleEntries|writeWindowEntry)\b/);
      // Aucune ecriture directe non plus, qui contournerait le coeur.
      expect(source, path.basename(file)).not.toMatch(/\b(writeFileSync|rmSync|renameSync)\b/);
    }
  });

  it("aucune source de la CLI ne lit l'environnement", () => {
    // Meme motif que pour l'identite du coeur : c'est ce qui interdit structurellement de
    // retomber sur `VSCODE_PID`, partage entre toutes les fenetres d'un meme processus
    // principal, ou sur une surcharge officieuse du registre.
    for (const file of sourcesUnder(CLI_SRC)) {
      expect(readFileSync(file, 'utf8'), path.basename(file)).not.toMatch(/process\s*\.\s*env/);
    }
  });
});
