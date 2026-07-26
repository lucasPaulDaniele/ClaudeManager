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
       * Les paquets encore vides (`mcp`) n'ont pas de sources : ils entreront dans la
       * mesure le jour ou ils en auront, sans qu'on ait a y penser. C'est exactement ce qui
       * s'est passe pour `cli` a l'increment B4, sans une ligne a changer ici.
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
       * EXCLUSION AJOUTEE A L'INCREMENT B4 (2026-07-25), et de la meme nature que `core.ts` :
       *
       * - `packages/cli/src/cmgr.ts` : point d'entree du binaire — un shebang, un import, et
       *   `await runProcess(process)`. Il ne porte AUCUNE decision : tout ce qui pouvait en
       *   etre extrait l'a ete au meme increment dans `run.ts` (decoupage d'`argv`, choix du
       *   flux, code de sortie), qui est mesure a 100 % contre un `process` simule. L'eprouver
       *   ici supposerait de lancer un processus, donc de compiler d'abord — `npm run
       *   build:cli` — puis de lire le registre REEL du poste et son inventaire de processus,
       *   ce qu'aucun test unitaire de ce depot ne fait. C'est le lancement reel du binaire,
       *   dont la sortie est jointe en preuve a la PR, qui en repond.
       *
       * Toute nouvelle exclusion se justifie ici, avec sa date. Le reste de
       * `packages/vscode/src` — `server.ts` au premier chef, qui n'importe pas `vscode` — et
       * TOUT `packages/cli/src` sont mesures comme le coeur.
       */
      exclude: [
        'packages/vscode/src/extension.ts',
        'packages/vscode/src/core.ts',
        'packages/cli/src/cmgr.ts',
      ],
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
         * SEUIL GLOBAL FIXE AU PLANCHER ENTIER DE CE QUI EST REELLEMENT ATTEINT, jamais a un
         * chiffre d'intention : un seuil qu'on n'atteint pas est un seuil qu'on desactivera —
         * c'est exactement ce qui est arrive au « 90 % global » que le CLAUDE.md annoncait et
         * que rien ne configurait.
         *
         * MESURE DU 2026-07-26 (gate final du lot B), les QUATRE metriques :
         *   98,96 instructions · 98,25 branches · 97,72 fonctions · 98,96 lignes
         * Plancher retenu : 98 / 98 / 97 / 98. Marges : 0,96 · 0,25 · 0,72 · 0,96 point.
         *
         * La mesure precedente (2026-07-25 : 98,43 lignes / 97,88 branches / 96,82 fonctions)
         * omettait les INSTRUCTIONS, alors que le seuil, lui, en portait un. Les quatre sont
         * desormais citees — un chiffre configure sans mesure en regard est la divergence
         * meme que ce commentaire existe pour empecher.
         *
         * RELEVE LE 2026-07-26 : branches 97 -> 98, fonctions 96 -> 97. Lignes et
         * instructions restent a 98, qui est deja leur plancher.
         *
         * Mesure prise sous Windows, ou 3 tests POSIX sont ignores ; la couverture de la CI
         * Linux a ete relevee et elle est IDENTIQUE — le plancher ne depend donc pas de la
         * plateforme.
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
        functions: 97,
        branches: 98,
        statements: 98,
      },
    },
  },
});
