import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  maskHomeDirectory,
  redactWindowEntry,
  writeWindowEntry,
  type WindowEntry,
} from '../../../packages/core/src/index.js';
import { WINDOWS_ROLES } from '../identity/fixtures.js';
import { currentSchemaEntry, makeRegistryDir } from './fixtures.js';

/**
 * CE QUI SORT DU COEUR VERS UN AGENT, et ce qui n'en sort jamais.
 *
 * Les chemins eprouves ici sont construits a partir du VRAI `os.homedir()` de la machine qui
 * execute le test : un chemin invente ne prouverait que l'existence d'un remplacement, pas
 * qu'il vise le bon repertoire.
 */

const HOST = WINDOWS_ROLES.owningExtHostPid;
const HOME = os.homedir();

/** Entree de reference : la capture reelle portee au schema courant (voir `fixtures.ts`). */
const VALID = currentSchemaEntry(HOST);

/** La meme, dont le workspace est sous le repertoire personnel REEL de cette machine. */
function entryAtHome(...segments: readonly string[]): WindowEntry {
  return { ...VALID, workspaceFolders: [path.join(HOME, ...segments)] };
}

describe('maskHomeDirectory', () => {
  it('remplace le prefixe personnel, et lui seul', () => {
    expect(maskHomeDirectory(path.join(HOME, 'Documents', 'Github', 'ClaudeManager'))).toBe(
      `~${path.sep}Documents${path.sep}Github${path.sep}ClaudeManager`
    );
  });

  it('rend `~` seul quand le workspace EST le repertoire personnel', () => {
    expect(maskHomeDirectory(HOME)).toBe('~');
  });

  it('masque quelle que soit la casse — les deux formes existent sous Windows', () => {
    // `c:\Users\...` ou `C:\Users\...` selon qui rend le chemin : l'editeur et
    // `os.homedir()` ne s'accordent meme pas sur la casse du disque.
    expect(maskHomeDirectory(HOME.toUpperCase())).toBe('~');
    expect(maskHomeDirectory(HOME.toLowerCase())).toBe('~');
  });

  it('ne touche PAS a un chemin qui partage seulement le debut du prefixe', () => {
    // La coupure doit tomber sur un separateur : sans cela, le repertoire personnel de
    // `ana` masquerait le debut de celui d'`anatole`.
    const neighbour = `${HOME}son`;

    expect(maskHomeDirectory(neighbour)).toBe(neighbour);
  });

  it('laisse intact ce qui n identifie pas le poste', () => {
    // Le chemin des fixtures, anonymise : il ne designe le repertoire personnel de personne.
    const anonymous = VALID.workspaceFolders[0] as string;

    expect(maskHomeDirectory(anonymous)).toBe(anonymous);
    expect(maskHomeDirectory('/ailleurs/sur/la/machine')).toBe('/ailleurs/sur/la/machine');
  });
});

describe('redactWindowEntry — le jeton', () => {
  it('ne laisse subsister AUCUN fragment du jeton reel', () => {
    const redacted = redactWindowEntry(VALID);

    expect(redacted.token).not.toBe(VALID.token);
    expect(redacted.token.length).not.toBe(VALID.token.length);

    // Ni prefixe, ni suffixe, ni fragment : on balaie toutes les sous-chaines de 4
    // caracteres du jeton reel dans la serialisation complete de l entree masquee.
    const serialized = JSON.stringify(redacted);
    for (let i = 0; i + 4 <= VALID.token.length; i += 1) {
      expect(serialized, VALID.token.slice(i, i + 4)).not.toContain(VALID.token.slice(i, i + 4));
    }
  });

  it('rend la MEME constante pour deux jetons differents', () => {
    // La preuve de fond : la sortie ne porte aucune information sur l entree. Les deux
    // fenetres capturees portaient bien deux jetons distincts (voir le README des fixtures).
    const other = currentSchemaEntry(WINDOWS_ROLES.otherExtHostPids[0] as number);
    expect(other.token).not.toBe(VALID.token);

    expect(redactWindowEntry(other).token).toBe(redactWindowEntry(VALID).token);
  });
});

describe('redactWindowEntry — le repertoire personnel', () => {
  it('masque le prefixe personnel de CHAQUE dossier de travail', () => {
    const folders = [path.join(HOME, 'ws-a'), path.join(HOME, 'ws-b'), '/ailleurs'];

    const redacted = redactWindowEntry({ ...VALID, workspaceFolders: folders });

    expect(redacted.workspaceFolders).toEqual([
      `~${path.sep}ws-a`,
      `~${path.sep}ws-b`,
      '/ailleurs',
    ]);
  });

  it('conserve le pouvoir de reconnaissance : seul le nom du compte disparait', () => {
    // L arbitrage : ce champ est le SEUL qui permette a un humain de reconnaitre une
    // fenetre parmi plusieurs. Le supprimer aurait appauvri `cmgr windows`.
    const redacted = redactWindowEntry(entryAtHome('Documents', 'Github', 'ClaudeManager'));

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(JSON.stringify(HOME).slice(1, -1));
    expect(redacted.workspaceFolders[0]).toContain('ClaudeManager');
  });

  it('conserve tout le reste a l identique', () => {
    const redacted = redactWindowEntry(VALID);

    expect({ ...redacted, token: VALID.token }).toEqual(VALID);
  });
});

/**
 * LA CONTRE-EPREUVE, et elle compte autant que le masque lui-meme.
 *
 * `redactWindowEntry` est une fonction d'AFFICHAGE. Le masquage ne doit jamais atteindre ce
 * qui est ecrit sur disque : le registre est un contrat entre versions, et le lot C a besoin
 * du chemin REEL pour verifier que le `cwd` d'une session correspond au workspace de la
 * fenetre — faute de quoi `claude-vscode.editor.open` reussit en ouvrant un panneau vide.
 */
describe('ce que le masque ne doit JAMAIS atteindre', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeRegistryDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("l'entree ECRITE porte le chemin reel, masque ou non a l'affichage", () => {
    const entry = entryAtHome('Documents', 'Github', 'ClaudeManager');

    const file = writeWindowEntry(entry, { dir });

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(entry);
    expect(readFileSync(file, 'utf8')).toContain(JSON.stringify(HOME).slice(1, -1));
    // Et l'affichage de cette meme entree, lui, ne le porte pas.
    expect(JSON.stringify(redactWindowEntry(entry))).not.toContain(
      JSON.stringify(HOME).slice(1, -1)
    );
  });

  it("ne modifie pas l'entree qu'on lui donne", () => {
    const entry = entryAtHome('ws-a');

    redactWindowEntry(entry);

    expect(entry.workspaceFolders).toEqual([path.join(HOME, 'ws-a')]);
  });
});
