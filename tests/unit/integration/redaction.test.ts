import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mask } from '../../integration/src/redaction.js';

/**
 * Ce que le harnais publie dans une PR d'un depot public.
 *
 * Les chaines eprouvees ici sont construites a partir des VRAIS `os.tmpdir()` et
 * `os.homedir()` de la machine qui execute le test : un chemin invente ne prouverait que
 * l'existence du remplacement, pas qu'il vise les bons repertoires.
 */

const TMP = os.tmpdir();
const HOME = os.homedir();

describe('mask', () => {
  it('remplace le repertoire temporaire', () => {
    expect(mask(path.join(TMP, 'cmgr-b3-ws-4kJTyb'))).toBe(`<tmp>${path.sep}cmgr-b3-ws-4kJTyb`);
  });

  it('remplace le repertoire personnel', () => {
    expect(mask(path.join(HOME, '.claudemanager', 'windows'))).toBe(
      `~${path.sep}.claudemanager${path.sep}windows`
    );
  });

  it('masque le temporaire AVANT le personnel, qui le contient sous Windows', () => {
    const masked = mask(path.join(TMP, 'cmgr-b3-uds-7oTWCb'));

    expect(masked).not.toContain('~');
    expect(masked.startsWith('<tmp>')).toBe(true);
  });

  it('masque la forme ECHAPPEE que porte un corps de reponse JSON', () => {
    // LE CAS MESURE : le rapport porte les corps de `GET /health`, ou un chemin Windows est
    // echappe (`c:\\Users\\...`). Un masque qui ne connaissait que la forme brute laissait
    // passer la sortie la plus volumineuse du harnais — constate au premier rejeu.
    const body = JSON.stringify({ workspaceFolders: [path.join(TMP, 'cmgr-b3-ws-4kJTyb')] });

    const masked = mask(body);

    expect(masked).not.toContain(os.userInfo().username);
    expect(masked).toContain('<tmp>');
  });

  it('masque un chemin quelle que soit sa casse', () => {
    // `c:\Users\...` ou `C:\Users\...` selon qui rend le chemin.
    expect(mask(TMP.toUpperCase())).toBe('<tmp>');
    expect(mask(TMP.toLowerCase())).toBe('<tmp>');
  });

  it('laisse intact ce qui n identifie pas le poste', () => {
    expect(mask('sweep completed in 566 ms: 0 stale entries removed')).toBe(
      'sweep completed in 566 ms: 0 stale entries removed'
    );
  });

  it('ne laisse RIEN passer du rapport complet d un rejeu reel', () => {
    // La forme exacte des lignes qui fuyaient, brutes et echappees dans la meme chaine.
    const report = [
      `[runTests] workspace de test    : ${path.join(TMP, 'cmgr-b3-ws-4kJTyb')}`,
      JSON.stringify({ logDirectory: path.join(TMP, 'cmgr-b3-uds-7oTWCb', 'logs') }),
      `l entree ${path.join(HOME, '.claudemanager', 'windows', '16228.json')}`,
    ].join('\n');

    const masked = mask(report);

    expect(masked).not.toContain(TMP);
    expect(masked).not.toContain(HOME);
    expect(masked).not.toContain(JSON.stringify(TMP).slice(1, -1));
    expect(masked).not.toContain(os.userInfo().username);
  });
});
