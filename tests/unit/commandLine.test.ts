import { describe, expect, it } from 'vitest';
import { ERROR_CODES, isClaudeManagerError } from '../../packages/core/src/index.js';
// PRIS A LEUR MODULE, ET PLUS AU CONTRAT (V2-12) : ces quatre-la n'avaient aucun consommateur
// hors d'ici. Les exporter depuis `index.ts` en faisait la surface publique du coeur — et,
// par le `export *` de `packages/vscode/src/core.ts`, celle de l'extension.
import {
  assertCommandLineFits,
  COMMAND_LINE_SAFETY_MARGIN,
  measureCommandLineBudget,
  quotedArgumentCost,
  WINDOWS_COMMAND_LINE_LIMIT,
  type CommandLineDraft,
} from '../../packages/core/src/commandLine.js';

/**
 * LA GARDE DE PLAFOND, DES DEUX COTES DE LA LIMITE.
 *
 * Ce qu'elle empeche est un echec SILENCIEUX : mesure le 2026-07-26, un prompt de 32 600
 * caracteres ne produit ni sortie, ni erreur, ni processus. Sans cette garde, le mecanisme
 * creerait un terminal, enverrait sa ligne, attendrait 62 s un panneau qui ne viendra pas, et
 * rendrait une erreur d'attachement — c'est-a-dire un diagnostic FAUX pour une cause connue
 * et mesurable d'avance.
 */

/** L'executable reel du poste de reference, anonymise — sa longueur est ce qui compte. */
const EXECUTABLE =
  'C:\\Users\\user\\.vscode\\extensions\\anthropic.claude-code-2.1.220-win32-x64\\resources\\native-binary\\claude.exe';
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

function draft(prompt: string): CommandLineDraft {
  return { executable: EXECUTABLE, leadingArguments: ['--session-id', SESSION_ID], prompt };
}

/** Le plus grand prompt qui passe, calcule depuis la mesure elle-meme. */
function largestPromptThatFits(): number {
  const empty = measureCommandLineBudget(draft(''));
  // `available` est ce qu'un prompt peut encore COUTER ; un prompt sans `"` ni `\` coute sa
  // longueur plus les deux guillemets encadrants, deja comptes dans le cout du prompt vide.
  return empty.available;
}

describe('cout d un argument cite', () => {
  it('compte les guillemets encadrants', () => {
    expect(quotedArgumentCost('')).toBe(2);
    expect(quotedArgumentCost('abc')).toBe(5);
  });

  it('MAJORE chaque guillemet et chaque contre-oblique — jamais l inverse', () => {
    // `CommandLineToArgvW` protege `"` par `\"`, et double les contre-obliques qui precedent
    // un guillemet. Majorer est le sens SUR : une borne trop basse laisserait tenter un envoi
    // qui echouerait sans bruit.
    expect(quotedArgumentCost('a"b')).toBe(2 + 3 + 1);
    expect(quotedArgumentCost('a\\b')).toBe(2 + 3 + 1);
    expect(quotedArgumentCost('"""')).toBe(2 + 3 + 3);
  });

  it('compte en unites UTF-16, jamais en octets', () => {
    // Un prompt non-ASCII pese bien plus en octets UTF-8 qu'en unites UTF-16 : compter des
    // octets refuserait a tort. `lpCommandLine` compte des WCHAR, comme `String.length`.
    const accented = 'éèàùç';
    expect(accented.length).toBe(5);
    expect(Buffer.from(accented, 'utf8').length).toBe(10);
    expect(quotedArgumentCost(accented)).toBe(7);
  });
});

describe('mesure de la ligne', () => {
  it('pese l executable, les drapeaux, les separateurs ET le prompt', () => {
    const budget = measureCommandLineBudget(draft('bonjour'));

    expect(budget.fixedCost).toBe(
      quotedArgumentCost(EXECUTABLE) +
        1 +
        quotedArgumentCost('--session-id') +
        1 +
        quotedArgumentCost(SESSION_ID) +
        1
    );
    expect(budget.promptCost).toBe(quotedArgumentCost('bonjour'));
    expect(budget.total).toBe(budget.fixedCost + budget.promptCost + COMMAND_LINE_SAFETY_MARGIN);
  });

  it('porte une marge de securite EXPLICITE, jamais implicite', () => {
    expect(measureCommandLineBudget(draft('')).safetyMargin).toBe(COMMAND_LINE_SAFETY_MARGIN);
    expect(COMMAND_LINE_SAFETY_MARGIN).toBeGreaterThan(0);
  });

  it('rend le plafond MESURE — 32 767 unites UTF-16', () => {
    expect(WINDOWS_COMMAND_LINE_LIMIT).toBe(32_767);
    expect(measureCommandLineBudget(draft('')).limit).toBe(32_767);
  });
});

describe('les deux cotes de la limite', () => {
  it('ACCEPTE le plus grand prompt qui tienne', () => {
    const size = largestPromptThatFits();
    const budget = assertCommandLineFits(draft('A'.repeat(size)));

    expect(budget.fits).toBe(true);
    expect(budget.total).toBeLessThanOrEqual(WINDOWS_COMMAND_LINE_LIMIT);
    expect(budget.available).toBe(0);
  });

  it('REFUSE le premier prompt qui deborde — un caractere de plus', () => {
    const size = largestPromptThatFits() + 1;

    expect(() => assertCommandLineFits(draft('A'.repeat(size)))).toThrowError();
  });

  it('reste coherente avec la mesure du 2026-07-26 : 32 000 passe, 32 600 echoue', () => {
    // Les deux tailles mesurees sur le vrai chemin, avec le vrai executable. La garde doit
    // les classer comme la mesure les a classees — sans quoi elle refuserait ce qui marche,
    // ou laisserait tenter ce qui echoue en silence.
    expect(measureCommandLineBudget(draft('A'.repeat(32_000))).fits).toBe(true);
    expect(measureCommandLineBudget(draft('A'.repeat(32_600))).fits).toBe(false);
  });

  it('leve une erreur NOMMEE portant la taille mesuree ET le plafond', () => {
    const prompt = 'A'.repeat(40_000);
    try {
      assertCommandLineFits(draft(prompt));
      expect.unreachable('the guard must refuse a 40 000 character prompt');
    } catch (error) {
      expect(isClaudeManagerError(error)).toBe(true);
      if (!isClaudeManagerError(error)) return;
      expect(error.code).toBe(ERROR_CODES.PROMPT_TOO_LARGE);
      expect(error.details).toMatchObject({
        promptLength: 40_000,
        limit: WINDOWS_COMMAND_LINE_LIMIT,
      });
      expect(error.details?.['overflowBy']).toBeGreaterThan(0);
      expect(error.remediation).toContain('32 767');
    }
  });

  it('ne TRONQUE jamais : elle refuse, ou elle laisse passer', () => {
    // Un prompt tronque produirait une conversation qui a l'air normale et qui demande autre
    // chose que ce qu'on lui a demande. La garde ne rend aucun prompt : elle ne peut donc pas
    // en modifier un.
    const budget = measureCommandLineBudget(draft('A'.repeat(40_000)));
    expect(budget.promptLength).toBe(40_000);
    expect(Object.values(budget).every((value) => typeof value !== 'string')).toBe(true);
  });

  it('ne laisse fuir AUCUN chemin dans les details — le depot est public', () => {
    try {
      assertCommandLineFits(draft('A'.repeat(40_000)));
    } catch (error) {
      if (!isClaudeManagerError(error)) throw error;
      expect(JSON.stringify(error.details)).not.toContain('claude.exe');
      expect(JSON.stringify(error.details)).not.toContain('Users');
    }
  });

  it('compte le cout du prompt CITE, pas sa seule longueur', () => {
    // Un prompt truffe de guillemets coute plus cher que sa longueur : c'est exactement le
    // cas qu'une garde naive laisserait passer, pour un echec silencieux au bout.
    const size = largestPromptThatFits();
    const hostile = `${'"'.repeat(10)}${'A'.repeat(size - 10)}`;

    expect(hostile.length).toBe(size);
    expect(measureCommandLineBudget(draft(hostile)).fits).toBe(false);
  });
});
