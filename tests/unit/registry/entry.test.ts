import { describe, expect, it } from 'vitest';
import {
  parseWindowEntry,
  WINDOW_ENTRY_SCHEMA_VERSION,
  type ParseResult,
} from '../../../packages/core/src/index.js';
import { currentSchemaEntry, readLegacyEntry } from './fixtures.js';
import { WINDOWS_ROLES } from '../identity/fixtures.js';

const HOST = WINDOWS_ROLES.owningExtHostPid;

/** Entree de reference : la capture reelle portee au schema courant (voir `fixtures.ts`). */
const VALID = currentSchemaEntry(HOST);

/** Rejoue la validation sur l'entree de reference dont un seul champ a ete altere. */
function parseWith(field: string, value: unknown): ParseResult {
  return parseWindowEntry({ ...VALID, [field]: value });
}

function reasonOf(result: ParseResult): string {
  return result.ok ? 'ok' : result.reason;
}

describe('parseWindowEntry — ce qui est retenu', () => {
  it("accepte l'entree de reference et la rend champ a champ", () => {
    const result = parseWindowEntry(VALID);

    expect(result.ok).toBe(true);
    expect(result.ok && result.entry).toEqual(VALID);
  });

  it('tolere un champ inconnu sans jamais le propager', () => {
    // Compatibilite ascendante : une version ulterieure peut enrichir le schema sans
    // casser celle-ci. Mais ce qu'on ne comprend pas ne ressort pas.
    const result = parseWindowEntry({ ...VALID, futureField: 'quelque chose' });

    expect(result.ok).toBe(true);
    expect(result.ok && result.entry).toEqual(VALID);
    expect(result.ok && Object.keys(result.entry)).not.toContain('futureField');
  });

  it("expose l'identite lisible d'une entree retenue", () => {
    const result = parseWindowEntry(VALID);

    expect(result.identity).toEqual({ extHostPid: VALID.extHostPid, mainPid: VALID.mainPid });
  });
});

describe('parseWindowEntry — schema etranger, jamais confondu avec une corruption', () => {
  it("classe foreign-schema une entree SANS schemaVersion — la forme heritee 0.1.0", () => {
    const legacy = readLegacyEntry(HOST);

    const result = parseWindowEntry(legacy);

    expect(reasonOf(result)).toBe('foreign-schema');
  });

  it('classe foreign-schema une entree de version ulterieure', () => {
    expect(reasonOf(parseWith('schemaVersion', WINDOW_ENTRY_SCHEMA_VERSION + 1))).toBe(
      'foreign-schema'
    );
    expect(reasonOf(parseWith('schemaVersion', 0))).toBe('foreign-schema');
  });

  it('rend malgre tout les pid lisibles, de quoi juger la vivacite plus tard', () => {
    const result = parseWindowEntry(readLegacyEntry(HOST));

    // L'entree heritee n'a pas de mainPid : c'est precisement ce qui la distingue.
    expect(result.identity).toEqual({ extHostPid: HOST, mainPid: undefined });
  });

  it('classe invalid un schemaVersion present mais non entier', () => {
    expect(reasonOf(parseWith('schemaVersion', '1'))).toBe('invalid');
    expect(reasonOf(parseWith('schemaVersion', 1.5))).toBe('invalid');
  });
});

describe('parseWindowEntry — ce qui n est pas une entree du tout', () => {
  it('rejette les valeurs qui ne sont pas un objet', () => {
    for (const value of [null, undefined, 42, 'entree', true]) {
      expect(reasonOf(parseWindowEntry(value)), String(value)).toBe('invalid');
    }
  });

  it('rejette un tableau : un fichier corrompu, pas un schema etranger', () => {
    const result = parseWindowEntry([VALID]);

    expect(reasonOf(result)).toBe('invalid');
    expect(result.identity).toEqual({ extHostPid: undefined, mainPid: undefined });
  });
});

describe('parseWindowEntry — alerte n.14 : l identite doit etre un entier > 0', () => {
  it('refuse tout extHostPid qui ne designe aucun processus reel', () => {
    // Un extHostPid absurde face a un pid appelant tout aussi absurde produirait une fausse
    // correspondance dans resolveOwningWindow — donc une violation de l isolation.
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '11172', null]) {
      expect(reasonOf(parseWith('extHostPid', value)), String(value)).toBe('invalid');
    }
  });

  it('refuse un mainPid qui ne designe aucun processus reel', () => {
    for (const value of [0, -1, 1.5, Number.NaN, '16196', undefined]) {
      expect(reasonOf(parseWith('mainPid', value)), String(value)).toBe('invalid');
    }
  });

  it("n expose aucun pid absurde dans l identite d une entree rejetee", () => {
    expect(parseWith('extHostPid', 0).identity.extHostPid).toBeUndefined();
    expect(parseWith('mainPid', Number.NaN).identity.mainPid).toBeUndefined();
  });
});

describe('parseWindowEntry — les autres regles de validation', () => {
  it('refuse un port hors de 1..65535', () => {
    for (const value of [0, -1, 65_536, 1.5, '50933']) {
      expect(reasonOf(parseWith('port', value)), String(value)).toBe('invalid');
    }
    expect(reasonOf(parseWith('port', 1))).toBe('ok');
    expect(reasonOf(parseWith('port', 65_535))).toBe('ok');
  });

  it('refuse un jeton vide ou absent', () => {
    for (const value of ['', undefined, 42]) {
      expect(reasonOf(parseWith('token', value)), String(value)).toBe('invalid');
    }
  });

  it('refuse une fenetre sans dossier de travail', () => {
    // Regle de validation, pas controle tardif : sans workspace, l attachement du panneau
    // REUSSIT en ouvrant un panneau vide (docs/compatibilite.md, D10).
    for (const value of [[], undefined, 'un dossier', [''], ['ok', 42]]) {
      expect(reasonOf(parseWith('workspaceFolders', value)), JSON.stringify(value)).toBe('invalid');
    }
  });

  it('refuse un isTrusted qui n est pas booleen', () => {
    for (const value of ['true', 1, undefined]) {
      expect(reasonOf(parseWith('isTrusted', value)), String(value)).toBe('invalid');
    }
  });

  it('refuse une version d extension vide ou absente', () => {
    for (const value of ['', undefined, 1]) {
      expect(reasonOf(parseWith('extensionVersion', value)), String(value)).toBe('invalid');
    }
  });

  it('refuse un horodatage qu on ne sait pas relire', () => {
    for (const value of ['hier', '', undefined, 1_700_000_000_000]) {
      expect(reasonOf(parseWith('startedAt', value)), String(value)).toBe('invalid');
    }
    expect(reasonOf(parseWith('startedAt', '2026-07-24T22:01:24.603Z'))).toBe('ok');
  });
});
