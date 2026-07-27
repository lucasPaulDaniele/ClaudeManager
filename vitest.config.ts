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
         * MESURE DU 2026-07-27 (correction du gate C final, volet 1), les QUATRE metriques,
         * SUR LES DEUX PLATEFORMES :
         *
         *   Windows, poste de reference : 99,63 instructions · 99,21 branches · 99,00 fonctions · 99,63 lignes
         *   Linux, CI GitHub : a consigner des la premiere execution de cette branche
         *
         * Plancher retenu : 99 / 98 / 98 / 99 — INCHANGE. Marges : 0,63 · 1,21 · 1,00 · 0,63 point.
         *
         * ─────────────────────────────────────────────────────────────────────────────────
         * POURQUOI LES BRANCHES NE PASSENT TOUJOURS PAS A 99, ALORS QUE LA REGLE LE DEMANDERAIT.
         *
         * La regle dit « au plancher entier de ce qui est reellement atteint », et 99,21
         * appellerait donc 99. LE COMPTE ABSOLU DIT AUTRE CHOSE, et c'est le meme raisonnement
         * qu'a l'increment C4, refait sur les nouveaux chiffres : **1 006 branches couvertes sur
         * 1 014**, quand `ceil(0,99 x 1014) = 1004`. LA MARGE SERAIT DE DEUX BRANCHES — elle etait
         * d'UNE a la mesure precedente (972/980 pour 971 exigees), et de ZERO a celle d'avant.
         * Elle progresse, mais une branche pese encore 0,099 point : trois branches non couvertes
         * ajoutees n'importe ou dans le depot feraient tomber la CI.
         *
         * C'est exactement le « seuil qu'on n'atteint pas est un seuil qu'on desactivera »
         * que cette regle existe pour empecher, atteint par l'autre bout : un plancher exact
         * mais intenable se contourne au premier incident, et c'est alors la regle entiere
         * qui perd son autorite. Un plancher tenable vaut mieux qu'un plancher exact.
         *
         * LES FONCTIONS SONT DANS LE MEME CAS, ET LE LEUR EST PLUS NET ENCORE : 200 sur 202, soit
         * 99,00 % — le pourcentage atteint tout juste 99, et `ceil(0,99 x 202) = 200` : la marge
         * y serait de ZERO. Un seuil qu'UNE SEULE fonction non couverte ferait tomber n'est pas
         * un plancher, c'est un piege. Au seuil de 98, il en faut 198 : la marge est de DEUX.
         *
         * CE QU'IL FAUDRAIT POUR RELEVER L'UN OU L'AUTRE : couvrir les branches et les fonctions
         * restantes, qui sont toutes des chemins de defaillance QU'UNE VRAIE SOCKET NE PRODUIT
         * PAS (voir la localisation ci-dessous). Les deux autres metriques sont deja a leur
         * plancher entier, avec 17 lignes de marge.
         * ─────────────────────────────────────────────────────────────────────────────────
         *
         * LES DEUX MESURES SONT CITEES, ET C'EST LE POINT : un plancher releve sur la seule
         * plateforme de developpement est un plancher qu'on n'a pas verifie la ou la porte se
         * ferme. Les deux plateformes n'executent PAS les memes tests — 5 tests POSIX sont
         * ignores sous Windows (3 du registre, 2 sur les droits du repertoire de transit du
         * prompt), 1 test Windows est ignore sous Linux (le decoupage d'un `PATH` a lettres de
         * lecteur). La couverture ressort pourtant identique au centieme : les lignes
         * concernees sont EXECUTEES des deux cotes, seules les assertions different.
         *
         * CES QUATRE CHIFFRES SONT AUSSI DANS `CLAUDE.md`, ET C'EST LE PIEGE A EVITER : le
         * gate du lot B a passe une journee sur le symetrique de ce residu — un document qui
         * annoncait un seuil que rien ne configurait. Les deux se relevent ENSEMBLE, ou ni
         * l'un ni l'autre — et la MESURE aussi s'y met a jour ensemble, y compris quand elle
         * ne fait pas bouger le seuil, comme le 2026-07-27.
         *
         * Mesure precedente (2026-07-27, increment C4) :
         *   99,61 instructions · 99,18 branches · 98,98 fonctions · 99,61 lignes
         *   (Linux, CI GitHub, execution 30264426122 : identiques). Plancher : 99 / 98 / 98 / 99.
         *   Comptes absolus d'alors : 972 branches sur 980, marge d'UNE au seuil de 99.
         *
         * Mesure encore precedente (2026-07-27, correction du gate C volet 2) :
         *   99,53 instructions · 99,04 branches · 98,75 fonctions · 99,53 lignes
         *   (Linux, CI GitHub, execution 30244910972 : identiques). Plancher : 99 / 98 / 98 / 99.
         *   Comptes absolus d'alors : 832 branches sur 840, marge de ZERO au seuil de 99.
         *
         * Mesure encore precedente (2026-07-26, increment C1) :
         *   99,31 instructions · 98,61 branches · 98,30 fonctions · 99,31 lignes
         *   (Linux, execution 30202106398 : identiques). Plancher alors retenu : 99 / 98 / 98 / 99,
         *   releve depuis 98 / 98 / 97 / 98 par ce meme increment.
         *
         * Mesure encore precedente (2026-07-26, gate final du lot B) :
         *   98,96 instructions · 98,25 branches · 97,72 fonctions · 98,96 lignes
         * Plancher alors retenu : 98 / 98 / 97 / 98.
         *
         * La mesure precedente (2026-07-25 : 98,43 lignes / 97,88 branches / 96,82 fonctions)
         * omettait les INSTRUCTIONS, alors que le seuil, lui, en portait un. Les quatre sont
         * desormais citees — un chiffre configure sans mesure en regard est la divergence
         * meme que ce commentaire existe pour empecher.
         *
         * OU SONT LES 8 BRANCHES ET LES 2 FONCTIONS QUI MANQUENT — RELEVE AU 2026-07-27 (C4),
         * INCHANGE A LA CORRECTION DU GATE FINAL : les lignes ajoutees depuis sont couvertes,
         * et les huit branches sont exactement les memes :
         *   - `server.ts` (4 branches, 1 fonction) : « la socket ecoute sans port TCP
         *     resoluble » — `listen(0, host)` rend toujours une adresse TCP — et le rejet au
         *     demarrage — un port ephemere n'entre jamais en conflit ;
         *   - `publication.ts` (3 branches, 1 fonction) : les deux memes vus de l'appelant,
         *     plus l'echec de fermeture du serveur, que `ServerHandle.close` ne peut pas
         *     produire aujourd'hui ;
         *   - `conversations.ts` (1 branche) : une branche du bloc `finally` de la route
         *     d'ouverture, que `v8` rattache a la ligne du `finally` lui-meme. Le fichier est a
         *     100 % de lignes, d'instructions et de fonctions.
         * Les sept premieres sont des chemins de defaillance QU'UNE VRAIE SOCKET NE PRODUIT
         * PAS, et qu'on refuse de forcer avec un faux `http` (principe fondateur n.5). Elles
         * sont conservees — un port devine ne serait jamais joignable — et laissees NON
         * COUVERTES plutot que masquees par une exclusion.
         *
         * `tabs.ts`, ARRIVE A L'INCREMENT C4, EST A 100 % DES QUATRE METRIQUES — et deux de ses
         * branches ont ete SUPPRIMEES plutot que couvertes : une seconde recherche de poignee et
         * un `iterator.done` qu'aucun chemin ne pouvait atteindre. Un repli inatteignable laisse
         * croire qu'un cas a ete prevu et ne se verifie jamais ; le retirer valait mieux que de
         * fabriquer un test pour l'atteindre. LA CORRECTION DU GATE FINAL L'Y A MAINTENU, par le
         * meme moyen : les deux transitions d'etat d'une poignee sont rendues AVEC la resolution
         * plutot qu'offertes en methodes du registre, ce qui evite une seconde recherche — donc
         * un `handle === undefined` qu'aucun chemin ne peut produire.
         *
         * Le seuil se releve quand la couverture monte, jamais l'inverse sans justification.
         */
        lines: 99,
        functions: 98,
        branches: 98,
        statements: 99,
      },
    },
  },
});
