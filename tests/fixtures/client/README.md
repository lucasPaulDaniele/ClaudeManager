# Réponses réelles du serveur local d'une fenêtre

`companion-responses.json` porte ce qu'une **vraie fenêtre VSCode** a réellement répondu à
`GET /health` et à `POST /conversations`, relevé le **2026-07-26** par
`npm run test:integration` — scénarios `nominal` et `open-conversation`, VSCode 1.122.1,
extension compagnon 0.2.0, extension Claude 2.1.220.

Ces réponses alimentent les tests unitaires de `packages/core/src/client/**`. Le principe
fondateur n°5 l'exige : le client est éprouvé contre ce que la fenêtre **envoie**, jamais
contre ce qu'on suppose qu'elle enverrait.

## Anonymisation

Les corps sont recopiés **tels quels** de la sortie du harnais, laquelle applique déjà son
masque (`tests/integration/src/redaction.ts`) : le répertoire temporaire est réduit à `<tmp>`
et le jeton porteur n'a jamais figuré dans aucune de ces réponses — c'est d'ailleurs une
assertion du scénario `nominal` (`tokenInAnyResponse: false`).

Les suffixes aléatoires des répertoires temporaires (`cmgr-b3-ws-hNxwPo`) sont conservés :
ils sont tirés au sort à chaque exécution et ne désignent personne.

## Ce qui est verbatim, et ce qui ne l'est pas — le dire vaut mieux que le laisser croire

| Entrée | Forme |
|---|---|
| `health.body` | **corps verbatim**, tel que la socket l'a rendu |
| `refusals.*.body` | **corps verbatim** (les quatre refus : 401, 403 × 2, 404) |
| `openSeeded.result`, `openFallback.result` | **champ à champ**, tels que le scénario les a relevés après `JSON.parse` du corps réel |

La nuance est réelle et elle est assumée : le rapport d'intégration de C1 relève les champs de
`POST /conversations` un à un, il ne recopie pas le corps. Ce que la sérialisation seule
aurait apporté — ordre des clés, espacement — n'a aucun effet sur un consommateur qui appelle
`JSON.parse`, et les tests reconstruisent le corps en le faisant **servir par le vrai serveur**
(`packages/vscode/src/server.ts`), jamais en écrivant une chaîne à la main.

**Un blanc, et il est nommé** : `openFallback.result.degradedFrom` ne porte que `code` et
`details`. Le rapport de C1 ne relève pas `message` ni `remediation`, et il n'est pas question
de les inventer ici. Le client rend `degradedFrom` **verbatim** sans jamais le relire : les
tests éprouvent donc exactement cette propriété — ce qui entre ressort à l'identique, quel que
soit son contenu.
