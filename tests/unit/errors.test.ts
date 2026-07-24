import { describe, expect, it } from 'vitest';
import {
  ClaudeManagerError,
  ERROR_CODES,
  isClaudeManagerError,
  type ErrorCode,
} from '../../packages/core/src/index.js';

describe('ClaudeManagerError', () => {
  it('porte le code, le message et une remediation non vide', () => {
    const err = new ClaudeManagerError(ERROR_CODES.CLAUDE_COMMAND_MISSING, 'commande absente');

    expect(err.code).toBe('CLAUDE_COMMAND_MISSING');
    expect(err.message).toBe('commande absente');
    expect(err.remediation.length).toBeGreaterThan(0);
    expect(err.name).toBe('ClaudeManagerError');
    expect(err).toBeInstanceOf(Error);
  });

  it('expose une remediation pour CHAQUE code declare', () => {
    // Garde-fou : ajouter un code sans sa remediation doit casser le build de tests.
    for (const code of Object.values(ERROR_CODES)) {
      const err = new ClaudeManagerError(code, 'peu importe');
      expect(err.remediation, `remediation manquante pour ${code}`).toBeTruthy();
    }
  });

  it('serialise sans champ details quand il n y en a pas', () => {
    const err = new ClaudeManagerError(ERROR_CODES.TRANSCRIPT_UNREADABLE, 'illisible');

    expect(err.toJSON()).toEqual({
      code: 'TRANSCRIPT_UNREADABLE',
      message: 'illisible',
      remediation: err.remediation,
    });
    expect(err.details).toBeUndefined();
  });

  it('serialise les details quand ils sont fournis', () => {
    const err = new ClaudeManagerError(ERROR_CODES.OWNING_WINDOW_NOT_FOUND, 'introuvable', {
      claudePid: 17816,
    });

    expect(err.details).toEqual({ claudePid: 17816 });
    expect(err.toJSON()).toEqual({
      code: 'OWNING_WINDOW_NOT_FOUND',
      message: 'introuvable',
      remediation: err.remediation,
      details: { claudePid: 17816 },
    });
  });

  it('reste serialisable par JSON.stringify', () => {
    const err = new ClaudeManagerError(ERROR_CODES.WORKSPACE_NOT_TRUSTED, 'restricted mode');

    expect(JSON.parse(JSON.stringify(err))).toMatchObject({ code: 'WORKSPACE_NOT_TRUSTED' });
  });
});

describe('isClaudeManagerError', () => {
  it('reconnait une erreur du domaine', () => {
    expect(isClaudeManagerError(new ClaudeManagerError(ERROR_CODES.SEED_SESSION_ID_MISMATCH, 'x'))).toBe(true);
  });

  it('rejette tout le reste', () => {
    expect(isClaudeManagerError(new Error('nue'))).toBe(false);
    expect(isClaudeManagerError(null)).toBe(false);
    expect(isClaudeManagerError({ code: 'CLAUDE_COMMAND_MISSING' as ErrorCode })).toBe(false);
  });
});
