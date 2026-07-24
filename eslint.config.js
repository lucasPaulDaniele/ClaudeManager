import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.vsix'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Le coeur ne journalise pas : il retourne des resultats (principe fondateur n.4).
      // Seuls la CLI et l'extension ecrivent des sorties, et le font explicitement.
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
  {
    // La CLI et l'extension sont les seuls points de sortie autorises.
    files: ['packages/cli/**/*.ts', 'packages/vscode/**/*.ts', 'packages/mcp/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  }
);
