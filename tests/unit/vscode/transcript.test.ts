import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  probeSessionTranscript,
  transcriptProjectRoots,
} from '../../../packages/vscode/src/transcript.js';

/**
 * CHERCHER UN TRANSCRIPT PAR SON NOM — et rien d'autre.
 *
 * LE SYSTEME DE FICHIERS EST REEL ici : de vrais repertoires temporaires, de vrais fichiers, de
 * vraies tailles. Ce module n'a rien a simuler — il n'y a pas d'API d'editeur derriere lui, et
 * une sonde d'existence simulee ne prouverait que la simulation.
 *
 * CE QUE CES TESTS GARDENT, ET C'EST LEUR RAISON D'ETRE : que la recherche ne repose JAMAIS sur
 * une derivation de slug (D7, convention non contractuelle) ni sur une racine supposee (D17,
 * `— non verifie`), et qu'aucun chemin ne ressorte de ce module.
 */

const SESSION = '11111111-2222-4333-8444-555555555555';
const temporaries: string[] = [];

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmgr-transcript-'));
  temporaries.push(root);
  return root;
}

/** Ecrit `<racine>/<slug>/<sessionId>.jsonl` avec le contenu demande, et rend son chemin. */
function writeTranscript(root: string, slug: string, content: string, session = SESSION): string {
  const directory = path.join(root, slug);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${session}.jsonl`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ou chercher — les racines de projets', () => {
  it('part de `<HOME>/.claude/projects`, sans jamais coder un separateur', () => {
    const roots = transcriptProjectRoots({}, path.join('somewhere', 'home'));

    expect(roots).toEqual([path.join('somewhere', 'home', '.claude', 'projects')]);
    // `path.join` : le separateur est celui de la plateforme, jamais `\` ni `/` en dur.
    expect(roots[0]).toBe(path.join('somewhere', 'home', '.claude', 'projects'));
  });

  it('ajoute la racine de `CLAUDE_CONFIG_DIR` — sans jamais remplacer celle par defaut', () => {
    // D17 dit de NE JAMAIS SUPPOSER ou vivent `projects/` quand la variable est posee. On balaie
    // donc les deux : le nom du fichier ne designe qu'une session, il ne peut pas se tromper.
    const roots = transcriptProjectRoots(
      { CLAUDE_CONFIG_DIR: path.join('ailleurs', 'config') },
      path.join('home')
    );

    expect(roots).toEqual([
      path.join('home', '.claude', 'projects'),
      path.join('ailleurs', 'config', 'projects'),
    ]);
  });

  it('ignore une variable vide ou faite de blancs — elle ne designe aucune racine', () => {
    for (const value of ['', '   ']) {
      expect(transcriptProjectRoots({ CLAUDE_CONFIG_DIR: value }, 'home')).toEqual([
        path.join('home', '.claude', 'projects'),
      ]);
    }
  });

  it('ne compte pas deux fois la racine par defaut quand la variable la designe', () => {
    const home = path.join('home');
    const roots = transcriptProjectRoots(
      { CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
      home
    );

    expect(roots).toEqual([path.join(home, '.claude', 'projects')]);
  });
});

describe('trouver le fichier — par son NOM, jamais par un slug calcule', () => {
  it('le trouve sous un slug quelconque, et releve sa taille', () => {
    const root = scratch();
    writeTranscript(root, 'un-slug-que-personne-ne-calcule', 'abcde');

    const sighting = probeSessionTranscript([root], SESSION);

    expect(sighting.found).toBe(true);
    expect(sighting.bytes).toBe(5);
  });

  it('le trouve au milieu d autres repertoires de projet et d autres sessions', () => {
    const root = scratch();
    writeTranscript(root, 'projet-a', 'x', '99999999-9999-4999-8999-999999999999');
    writeTranscript(root, 'projet-b', 'x'.repeat(11));
    writeTranscript(root, 'projet-c', 'x', '88888888-8888-4888-8888-888888888888');

    expect(probeSessionTranscript([root], SESSION)).toMatchObject({ found: true, bytes: 11 });
  });

  it('le trouve aussi POSE A LA RACINE — la disposition n est pas un contrat', () => {
    const root = scratch();
    fs.writeFileSync(path.join(root, `${SESSION}.jsonl`), 'xy', 'utf8');

    expect(probeSessionTranscript([root], SESSION)).toMatchObject({ found: true, bytes: 2 });
  });

  it('cherche dans la SECONDE racine quand la premiere ne porte rien', () => {
    const first = scratch();
    const second = scratch();
    fs.mkdirSync(path.join(first, 'projet-vide'), { recursive: true });
    writeTranscript(second, 'projet', 'xyz');

    expect(probeSessionTranscript([first, second], SESSION)).toMatchObject({
      found: true,
      bytes: 3,
    });
  });

  it('ne rend PAS trouve quand seul un homonyme partiel existe', () => {
    const root = scratch();
    // Le prefixe, l'extension, un suffixe : aucun n'est le fichier de CETTE session.
    fs.mkdirSync(path.join(root, 'projet'), { recursive: true });
    for (const name of [`${SESSION}`, `${SESSION}.json`, `${SESSION}.jsonl.bak`, 'autre.jsonl']) {
      fs.writeFileSync(path.join(root, 'projet', name), 'x', 'utf8');
    }

    expect(probeSessionTranscript([root], SESSION).found).toBe(false);
  });

  it('ne prend PAS un REPERTOIRE portant ce nom pour un transcript', () => {
    const root = scratch();
    fs.mkdirSync(path.join(root, 'projet', `${SESSION}.jsonl`), { recursive: true });

    expect(probeSessionTranscript([root], SESSION).found).toBe(false);
  });

  it('ne leve JAMAIS sur une racine absente — c est l etat d une machine neuve', () => {
    const absent = path.join(scratch(), 'jamais-cree');

    expect(probeSessionTranscript([absent], SESSION)).toEqual({
      found: false,
      bytes: 0,
      directoriesScanned: 0,
    });
  });

  it('ne leve JAMAIS quand la racine est un FICHIER', () => {
    const root = scratch();
    const file = path.join(root, 'pas-un-repertoire');
    fs.writeFileSync(file, 'x', 'utf8');

    expect(probeSessionTranscript([file], SESSION).found).toBe(false);
  });

  it('COMPTE les repertoires parcourus — c est ce que l erreur nommee rapporte', () => {
    const root = scratch();
    for (const slug of ['a', 'b', 'c']) fs.mkdirSync(path.join(root, slug), { recursive: true });
    // Un fichier a la racine n'est pas un repertoire de projet : il ne se compte pas.
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x', 'utf8');

    expect(probeSessionTranscript([root], SESSION)).toEqual({
      found: false,
      bytes: 0,
      directoriesScanned: 3,
    });
  });

  it('ne descend pas plus bas que le premier niveau — le balayage est BORNE', () => {
    // Un parcours recursif serait relance deux fois par seconde sur un `projects/` reel. Ce que
    // le mecanisme cherche vit sous `<racine>/<slug>/`, jamais plus profond (D6).
    const root = scratch();
    writeTranscript(path.join(root, 'trop', 'profond'), 'encore', 'x');

    expect(probeSessionTranscript([root], SESSION).found).toBe(false);
  });
});
