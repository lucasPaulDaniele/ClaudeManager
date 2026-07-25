import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      /**
       * TOUS les paquets, et non le seul coeur.
       *
       * L'`include` etait restreint a `packages/core/src` : les 497 lignes de l'extension
       * compagnon etaient hors mesure ET sans un seul test unitaire, si bien qu'un « 100 %,
       * CI verte » ne disait rien de la moitie du lot — deux findings du gate (C5, C2)
       * vivaient precisement dans cette zone (finding R10/C7).
       *
       * Les paquets encore vides (`cli`, `mcp`) n'ont pas de sources : ils entreront dans la
       * mesure le jour ou ils en auront, sans qu'on ait a y penser.
       */
      include: ['packages/**/src/**/*.ts'],
      /**
       * EXCLUSIONS NOMMEES ET DATEES — jamais un silence (2026-07-25).
       *
       * Ce qui est ecarte ici l'est parce que l'API de l'editeur en est la substance meme,
       * pas parce que c'est difficile a couvrir. Les eprouver suppose une vraie fenetre :
       * c'est `npm run test:integration` qui s'en charge, et son log est joint en preuve.
       *
       * - `extension.ts` : cycle d'activation, abonnements aux evenements du workspace,
       *   canal de journal, observateur de fichiers. Tout ce qui pouvait en etre extrait l'a
       *   ete au meme increment — `diagnostics.ts` (mise en forme des defaillances, lecture
       *   du manifeste) et `registry.ts` (identite, construction et retrait d'entree) sont
       *   desormais sans `vscode`, donc mesures et couverts.
       * - `core.ts` : reexport pur, sans une ligne de logique.
       *
       * Toute nouvelle exclusion se justifie ici, avec sa date. Le reste de
       * `packages/vscode/src` — `server.ts` au premier chef, qui n'importe pas `vscode` —
       * est mesure comme le coeur.
       */
      exclude: ['packages/vscode/src/extension.ts', 'packages/vscode/src/core.ts'],
      thresholds: {
        /**
         * Le coeur porte toute la logique et n'a aucune dependance a VSCode : il n'existe
         * aucune raison legitime de laisser une ligne non couverte.
         */
        'packages/core/src/**': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        /**
         * SEUIL GLOBAL FIXE A CE QUI EST REELLEMENT ATTEINT (mesure du 2026-07-25 :
         * 98,43 lignes / 97,88 branches / 96,82 fonctions), jamais a un chiffre d'intention :
         * un seuil qu'on n'atteint pas est un seuil qu'on desactivera — c'est exactement ce
         * qui est arrive au « 90 % global » que le CLAUDE.md annoncait et que rien ne
         * configurait.
         *
         * TOUT L'ECART TIENT A QUATRE CHEMINS DE DEFAILLANCE QU'UNE VRAIE SOCKET NE PRODUIT
         * PAS, et qu'on refuse de forcer avec un faux `http` (principe fondateur n.5) :
         *   - `server.ts` : « la socket ecoute sans port TCP resoluble » — `listen(0, host)`
         *     rend toujours une adresse TCP — et le rejet au demarrage — un port ephemere
         *     n'entre jamais en conflit ;
         *   - `publication.ts` : les deux memes vus de l'appelant, plus l'echec de fermeture
         *     du serveur, que `ServerHandle.close` ne peut pas produire aujourd'hui.
         * Ces chemins sont conserves — un port devine ne serait jamais joignable — et
         * laisses NON COUVERTS plutot que masques par une exclusion.
         *
         * Le seuil se releve quand la couverture monte, jamais l'inverse sans justification.
         */
        lines: 98,
        functions: 96,
        branches: 97,
        statements: 98,
      },
    },
  },
});
