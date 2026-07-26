import { defineConfig } from 'vitest/config';

/**
 * CONFIGURATION DE LA VERIFICATION D'EMPAQUETAGE — `npm run verify:packaging`.
 *
 * Fichier SEPARE de `vitest.config.ts`, et deliberement : la configuration unitaire porte les
 * SEUILS DE COUVERTURE, qui sont un critere de merge. Les melanger ferait mesurer la
 * couverture sur une execution qui ne charge pas le meme perimetre, donc ferait bouger un
 * seuil pour une raison etrangere a la couverture reelle du produit. `vitest.config.ts` n'est
 * pas touche.
 *
 * AUCUNE COUVERTURE ici, et ce n'est pas un oubli : ce qui est juge dans `tests/packaging` est
 * un ARTEFACT sur le disque, pas du code du produit. Le code du produit qui participe a
 * l'empaquetage — il n'y en a pas — n'existe pas ; les regles (`rules.ts`) sont, elles,
 * eprouvees par `tests/unit/packaging/`, qui passe par `vitest.config.ts` et compte donc dans
 * la mesure normale.
 *
 * POURQUOI CETTE COMMANDE EST LOCALE : elle exige des artefacts BATIS — un `.vsix` produit par
 * `vsce`, un `.tgz` produit par `npm pack` — et elle LANCE le binaire empaquete. Meme montage
 * que `npm run test:integration` : la CI publique ne l'execute pas, son log est joint en
 * preuve a la PR.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/packaging/src/**/*.test.ts'],
    // Empaqueter puis relire deux archives depasse le defaut de 5 s sur un disque froid.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
