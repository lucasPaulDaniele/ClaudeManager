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

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * UN DESACCORD DE PROTOCOLE NE SE REPARE JAMAIS EN RECHARGEANT LA FENETRE.
 *
 * Les deux codes d'illisibilite sont les seuls a renvoyer l'utilisateur vers une MISE A JOUR,
 * et c'est ce qui les rend dangereux : la suite naturelle d'une mise a jour, pour qui ne l'a
 * pas lu, est `Developer: Reload Window`. Or un rechargement TUE les claude.exe qui descendent
 * de l'extension host — donc la conversation qui vient peut-etre de s'ouvrir — et il ne fait
 * meme pas prendre la version neuve (ADR-005). Le seul geste est une fenetre NEUVE.
 *
 * Le defaut reel qui motive cette garde, releve au gate final du lot C : la remediation de
 * `WINDOW_RESPONSE_UNREADABLE` s'arretait a « mettre les deux artefacts a jour ensemble » et
 * laissait le geste suivant a deviner, quand la doc, elle, attribuait ce cas a l'autre code.
 *
 * Second volet, et il porte sur la valeur du diagnostic lui-meme : ces remediations envoient
 * COMPARER DES NUMEROS. Pendant le lot C le protocole a bouge sans que le numero monte —
 * l'extension 0.2.0 et la CLI 0.3.0 designent chacune deux etats —, si bien que la comparaison
 * peut rendre un verdict faux sur ces versions-la. Le dire vaut mieux que laisser conclure.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
describe('les remediations de desaccord de protocole', () => {
  const CODES = [
    ERROR_CODES.WINDOW_RESPONSE_UNREADABLE,
    ERROR_CODES.WINDOW_OPEN_RESPONSE_UNREADABLE,
  ] as const;

  for (const code of CODES) {
    // Compare en majuscules : ces textes insistent par la casse, elle n'est pas un contrat.
    const remediation = new ClaudeManagerError(code, 'peu importe').remediation.toUpperCase();

    it(`${code} prescrit la fenetre NEUVE et interdit le rechargement`, () => {
      expect(remediation).toContain('FENETRE NEUVE');
      expect(remediation).toContain('NE PAS RECHARGER');
    });

    it(`${code} avertit qu un numero de version ne conclut pas toujours`, () => {
      expect(remediation).toContain('NE CONCLUT PAS TOUJOURS');
      // Les deux numeros qui ont porte deux protocoles sont NOMMES : sans eux l'avertissement
      // serait une precaution de style, et le lecteur ne saurait pas quand il s'applique.
      expect(remediation).toContain('0.2.0');
      expect(remediation).toContain('0.3.0');
    });
  }

  it('renvoie a `cmgr windows`, la seule source de la version REELLEMENT servie', () => {
    // Controle positif de l'ensemble : `code --list-extensions` dit ce qui est sur le disque,
    // l'entree de registre ce que la fenetre EXECUTE. La remediation doit viser la seconde.
    for (const code of CODES) {
      expect(new ClaudeManagerError(code, 'x').remediation, code).toContain('cmgr windows');
    }
  });
});

describe('isClaudeManagerError', () => {
  it('reconnait une erreur du domaine', () => {
    expect(isClaudeManagerError(new ClaudeManagerError(ERROR_CODES.SEED_TRANSCRIPT_NOT_FOUND, 'x'))).toBe(true);
  });

  it('rejette tout le reste', () => {
    expect(isClaudeManagerError(new Error('nue'))).toBe(false);
    expect(isClaudeManagerError(null)).toBe(false);
    expect(isClaudeManagerError({ code: 'CLAUDE_COMMAND_MISSING' as ErrorCode })).toBe(false);
  });
});
