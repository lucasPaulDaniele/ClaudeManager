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
  it('la CLI n ouvre AUCUNE socket elle-meme : le reseau passe par le coeur', () => {
    // L'increment C2 fait entrer le reseau dans `cmgr`, mais par UN SEUL chemin : le client du
    // coeur (`core/client`), branche dans `run.ts` par `createLoopbackTransport()`. Ce que cette
    // regle preserve n'est pas « aucun reseau » — `open` en fait — mais le fait qu'il n'y ait
    // qu'un endroit ou l'hote, le port et les en-tetes se decident. Une socket ouverte
    // directement ici echapperait a la garde de boucle locale et a l'absence d'`Origin`.
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

  it('les commandes SANS RESEAU ne touchent pas au transport', () => {
    /**
     * `cmgr windows` et `cmgr whoami` restent hors reseau : faire dependre l'inventaire des
     * fenetres de leur joignabilite melangerait deux questions distinctes. « Laquelle repond ? »
     * appartient a `cmgr doctor` (lot D).
     *
     * LE DECOUPAGE A CHANGE DE NOM A L'INCREMENT C4, PAS DE NATURE : `cmgr conversations` est une
     * LECTURE qui fait du reseau — les onglets d'une fenetre ne se lisent que dans cette fenetre.
     * La ligne de partage n'est donc plus « lecture / ecriture » mais « avant `open` / apres », et
     * les trois commandes qui parlent au reseau sont declarees APRES elle. C'est ce que ce test
     * verifie, et c'est aussi pourquoi l'ordre de ce module n'est pas cosmetique.
     */
    const commands = readFileSync(path.join(CLI_SRC, 'commands.ts'), 'utf8');
    const [beforeOpen] = commands.split('export async function openCommand');
    expect(beforeOpen, 'la partie du module anterieure a `open`').not.toMatch(
      /context\s*\.\s*transport|(?:open|list|close)Conversations?InWindow\s*\(/
    );
    // L'assertion serait vide si le decoupage avait rate : les trois existent bien apres.
    for (const declaration of [
      'export async function openCommand',
      'export async function conversationsCommand',
      'export async function closeCommand',
    ]) {
      expect(commands).toContain(declaration);
    }
    expect(commands).toContain('context.transport');
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
