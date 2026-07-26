import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.vsix',
      /**
       * ETAT DE TRAVAIL DE LA SKILL `/orchestrer` — ignore par git (`.gitignore`), et
       * desormais par ESLint.
       *
       * IL NE L'ETAIT PAS, ET CELA CASSAIT `npm run ci` — un critere de merge. Le repertoire
       * porte les BANCS DE MESURE du chantier : du JavaScript jetable, en CommonJS, ecrit
       * pour etre charge par un extension host, donc `require`, `exports` et `console`
       * partout. ESLint l'analysait sous la configuration du PRODUIT et rendait 146 erreurs
       * qui ne designent aucun defaut : mesure sur le socle vierge, `eslint .` sortait deja
       * en erreur avant le moindre changement de l'increment C1.
       *
       * C'est exactement l'ecueil deja rencontre avec `.vscode-test/` — ignore par git, pas
       * par ESLint, qui partait alors analyser tout le code source de VSCode
       * (`tests/integration/src/runTests.ts`). La conclusion y avait ete de deplacer le
       * repertoire ; ici c'est impossible, il est le repertoire de travail de la skill.
       *
       * Le motif est le meme dans les deux cas, et il est etroit : ce qui n'est pas versionne
       * n'est pas du code du projet. Aucune regle n'est desactivee, aucune source du produit
       * n'est ecartee — `packages/**` et `tests/**` restent analyses en entier.
       */
      'orchestration-*/**',
    ],
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
