import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeManagerError, ERROR_CODES } from '../../../packages/core/src/index.js';
import {
  describe as describeError,
  readExtensionVersion,
  UNKNOWN_VERSION,
} from '../../../packages/vscode/src/diagnostics.js';

/**
 * Ce que l'extension laisse sortir vers un journal PERSISTE, que `cmgr doctor` remettra a un
 * agent et qu'une PR d'un depot public porte en preuve.
 *
 * Les erreurs systeme y sont VRAIES : on provoque un vrai `ENOENT`, un vrai `ENOTDIR`, sur
 * un vrai systeme de fichiers. Un objet `{ code: 'EPERM' }' fabrique a la main prouverait
 * seulement qu'on sait ecrire l'assertion qui va avec (principe fondateur n.5).
 */

const HOME = os.homedir();
const temporaries: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cmgr-diagnostics-'));
  temporaries.push(dir);
  return dir;
}

/** Provoque une VRAIE defaillance du systeme de fichiers et rend l'erreur telle quelle. */
function realFsFailure(operation: () => void): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("l'operation devait echouer");
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('describe', () => {
  it('rend le code, le message et la remediation d une erreur nommee', () => {
    const error = new ClaudeManagerError(
      ERROR_CODES.REGISTRY_ENTRY_INVALID,
      'Refusing to publish a window entry rejected as invalid'
    );

    const rendered = describeError(error);

    expect(rendered).toContain('REGISTRY_ENTRY_INVALID');
    expect(rendered).toContain('Refusing to publish a window entry rejected as invalid');
    expect(rendered).toContain(error.remediation);
  });

  it('ne laisse PAS passer le chemin porte par une erreur fs nue', () => {
    // Le cas exact du finding S3 : `removeWindowEntry` et la purge du coeur levent des
    // erreurs `fs` nues, qui embarquent toutes le chemin — donc le nom de compte.
    const dir = makeDir();
    const error = realFsFailure(() => readFileSync(path.join(dir, '11172.json'), 'utf8'));

    // Le message BRUT porte bel et bien le chemin : c'est ce qui partait dans le journal.
    expect((error as NodeJS.ErrnoException).message).toContain(dir);
    const rendered = describeError(error);

    expect(rendered).toBe('Error(ENOENT)');
    expect(rendered).not.toContain(dir);
    expect(rendered).not.toContain(HOME);
    expect(rendered).not.toContain(os.userInfo().username);
  });

  it('ne laisse PAS passer le chemin d une suppression refusee', () => {
    // La forme la plus proche du cas reel de S3 : `removeWindowEntry` appelle `rmSync`.
    const dir = makeDir();
    writeFileSync(path.join(dir, '11172.json'), '{}', 'utf8');
    const error = realFsFailure(() => rmSync(dir));

    expect((error as NodeJS.ErrnoException).message).toContain(dir);
    expect(describeError(error)).not.toContain(dir);
    expect(describeError(error)).not.toContain(HOME);
  });

  it('conserve le NOM de la classe, qui ne revele rien du poste', () => {
    expect(describeError(new TypeError('un detail interne quelconque'))).toBe(
      'TypeError(UNKNOWN)'
    );
  });

  it('ne rend jamais le texte d une valeur levee qui n est pas une erreur', () => {
    expect(describeError('C:\\Users\\quelqu-un\\secret')).toBe('Unknown(UNKNOWN)');
    expect(describeError(undefined)).toBe('Unknown(UNKNOWN)');
  });
});

describe('readExtensionVersion', () => {
  it('rend la version du manifeste', () => {
    expect(readExtensionVersion({ version: '0.2.0' })).toBe('0.2.0');
  });

  it('rend la version de repli plutot qu une chaine vide, qui ferait refuser l entree', () => {
    expect(readExtensionVersion({ version: '' })).toBe(UNKNOWN_VERSION);
    expect(readExtensionVersion({ version: 2 })).toBe(UNKNOWN_VERSION);
    expect(readExtensionVersion({})).toBe(UNKNOWN_VERSION);
    expect(readExtensionVersion(null)).toBe(UNKNOWN_VERSION);
    expect(readExtensionVersion(undefined)).toBe(UNKNOWN_VERSION);
    expect(readExtensionVersion('0.2.0')).toBe(UNKNOWN_VERSION);
  });

  it('rend une version de repli non vide, sans quoi le coeur refuserait de publier', () => {
    expect(UNKNOWN_VERSION.length).toBeGreaterThan(0);
  });
});
