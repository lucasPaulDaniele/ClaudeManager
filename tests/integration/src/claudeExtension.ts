/**
 * Faire cohabiter l'extension COMPAGNON et l'extension CLAUDE dans la fenetre de preuve.
 *
 * Le harnais du lot B lance chaque fenetre avec `--disable-extensions` : la fenetre de test ne
 * contient que la notre, et c'est ce qu'il faut pour eprouver le registre et le serveur local.
 * L'increment C1, lui, appelle une commande de l'extension Claude et lance son binaire : sans
 * elle, il n'y a rien a mesurer.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * MONTAGE RETENU, ET IL EST CONTRAINT — un `--extensions-dir` DEDIE, peuple d'une JONCTION
 * vers l'installation de l'utilisateur, et `--disable-extensions` RETIRE pour ce seul
 * scenario. Les autres montages ont ete ecartes :
 *
 *   - pointer `--extensions-dir` sur `~/.vscode/extensions` chargerait TOUTES les extensions
 *     du poste dans la fenetre de test, y compris la version 0.1.0 de ClaudeManager qui y est
 *     installee — deux compagnons dans la meme fenetre, et le registre a l'avenant ;
 *   - RECOPIER l'extension Claude, c'est 144 Mo par execution, pour un resultat identique.
 *
 * LA JONCTION SE RETIRE AVANT TOUT MENAGE RECURSIF, ET C'EST UNE GARDE ECRITE, PAS UNE
 * INTENTION : supprimer recursivement un repertoire qui en contient une effacerait
 * l'INSTALLATION DE L'UTILISATEUR. `dismantle` retire les liens un a un et LEVE s'il en reste
 * un seul ; le lanceur ne balaie qu'apres.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Prefixe des repertoires d'installation de l'extension Claude — il porte la VERSION. */
const CLAUDE_EXTENSION_PREFIX = 'anthropic.claude-code-';

export interface ClaudeExtensionMount {
  /** A passer en `--extensions-dir`. */
  readonly extensionsDir: string;
  /** Nom du repertoire jonctionne, version comprise — il part dans le rapport. */
  readonly installed: string;
  /** Version deduite du nom : c'est elle que `docs/compatibilite.md` doit citer. */
  readonly version: string;
}

/**
 * Trouve l'installation la plus RECENTE de l'extension Claude sur le poste.
 *
 * Plusieurs versions cohabitent (le poste de reference en porte trois) : VSCode ne charge que
 * la derniere, et c'est celle sur laquelle la preuve doit porter. Le tri est celui des
 * numeros, jamais l'ordre de `readdir`.
 */
export function findClaudeExtension(): ClaudeExtensionMount['installed'] | undefined {
  const root = path.join(os.homedir(), '.vscode', 'extensions');
  let entries: readonly string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return undefined;
  }

  const installed = entries
    .filter((name) => name.startsWith(CLAUDE_EXTENSION_PREFIX))
    .sort((a, b) => compareVersions(versionOf(a), versionOf(b)));
  return installed[installed.length - 1];
}

function versionOf(directory: string): string {
  return directory.slice(CLAUDE_EXTENSION_PREFIX.length).split('-')[0] ?? '0.0.0';
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10));
  const right = b.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Monte un `--extensions-dir` dedie portant UNE jonction vers l'extension Claude.
 *
 * ECHOUE EN LE DISANT si la jonction ne peut pas etre posee : sous Windows, `symlink` de type
 * `junction` ne demande pas de privilege administrateur, mais un poste peut la refuser
 * autrement (systeme de fichiers, strategie). Recopier 144 Mo en silence serait le pire des
 * comportements — la preuve deviendrait lente sans que personne ne sache pourquoi.
 */
export function mountClaudeExtension(root: string, installed: string): ClaudeExtensionMount {
  const extensionsDir = path.join(root, 'extensions');
  fs.mkdirSync(extensionsDir, { recursive: true });

  const target = path.join(os.homedir(), '.vscode', 'extensions', installed);
  // `junction` : le seul type de lien de repertoire que Windows accorde sans privilege. Sous
  // POSIX, Node le traite comme un lien symbolique de repertoire.
  fs.symlinkSync(target, path.join(extensionsDir, installed), 'junction');

  return { extensionsDir, installed, version: versionOf(installed) };
}

export interface DismantleResult {
  readonly removedLinks: readonly string[];
  readonly directory: string;
}

/**
 * Retire les liens AVANT tout menage recursif — la garde, ecrite plutot que supposee.
 *
 * `lstat`, jamais `stat` : `stat` SUIT le lien et rendrait « repertoire », ce qui ferait
 * exactement conclure qu'il faut descendre dedans. `rmSync` sans `recursive` sur un lien de
 * repertoire retire le LIEN, pas sa cible.
 *
 * @throws si un lien subsiste : le lanceur ne doit alors RIEN balayer recursivement.
 */
export function dismantleClaudeExtension(mount: ClaudeExtensionMount): DismantleResult {
  const removedLinks: string[] = [];
  let entries: readonly string[] = [];
  try {
    entries = fs.readdirSync(mount.extensionsDir);
  } catch {
    return { removedLinks, directory: mount.extensionsDir };
  }

  for (const name of entries) {
    const absolute = path.join(mount.extensionsDir, name);
    if (!fs.lstatSync(absolute).isSymbolicLink()) continue;
    // `rmdirSync` ET NON `rmSync`, ET C'EST MESURE : sur une jonction Windows, `rmSync` sans
    // `recursive` leve `ERR_FS_EISDIR` — il voit un repertoire —, et avec `recursive` il
    // DESCENDRAIT DEDANS. `rmdirSync` retire le point de reanalyse lui-meme, sans jamais
    // suivre la cible. C'est la seule forme qui fasse ce qu'on veut ici.
    fs.rmdirSync(absolute);
    removedLinks.push(name);
  }

  const remaining = fs
    .readdirSync(mount.extensionsDir)
    .filter((name) => fs.lstatSync(path.join(mount.extensionsDir, name)).isSymbolicLink());
  if (remaining.length > 0) {
    throw new Error(
      `Refusing to let the harness sweep ${mount.extensionsDir}: ${remaining.length} link(s) remain, ` +
        "a recursive removal would erase the user's own Claude extension"
    );
  }

  return { removedLinks, directory: mount.extensionsDir };
}
