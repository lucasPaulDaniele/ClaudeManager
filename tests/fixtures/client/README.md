# Réponses réelles du serveur local d'une fenêtre

`companion-responses.json` porte ce qu'une **vraie fenêtre VSCode** a réellement répondu aux
**quatre** routes du serveur local. Deux campagnes de capture y coexistent, et chaque entrée porte
sa date et la version de l'extension compagnon qui l'a produite :

| Campagne | Routes | Relevé le | Scénarios |
|---|---|---|---|
| lot B / C1–C3 | `GET /health`, `POST /conversations`, les quatre refus de transport | **2026-07-26** | `nominal`, `open-conversation` |
| **C4** | `GET /conversations`, `POST /conversations/close`, et les deux refus de la fermeture | **2026-07-27** | `close-conversation` |

VSCode 1.122.1, extension Claude 2.1.220.

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
| `listConversations.body`, `listConversationsEmpty.body`, `closeConversation.body` | **corps verbatim** |
| `closeRefusals.*.body` | corps réel, **moins son champ `remediation`** — voir ci-dessous |

**Deux précisions sur les captures de C4, parce qu'elles ne sont pas verbatim au même titre :**

- **`closeRefusals` ne porte pas `remediation`.** Le vrai corps la porte ; elle en a été retirée
  parce que le client **ne la lit jamais** — il relit la remédiation dans sa propre table
  (`ClaudeManagerError`), c'est même le point de `refusalOf`. Ce qui fait contrat ici est `error`
  et `details`, et les recopier avec un paragraphe de texte français en prime n'aurait rien
  éprouvé de plus.
- **Les libellés sont ceux du HARNAIS, pas d'une vraie conversation.** `Conversation A`,
  `Conversation B` : ce sont les titres des panneaux que le scénario `close-conversation` crée
  lui-même. Un libellé de vraie conversation est **dérivé de son contenu** (D24 — mesuré le
  2026-07-27 : `Confirm session response`), donc c'est du contenu de conversation, et **rien de tel
  n'est versionné dans un dépôt public**. Le `viewType`, lui, est celui que VSCode a **réellement**
  rendu — préfixé `mainThreadWebview-`, exactement comme sur un vrai panneau Claude.

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
