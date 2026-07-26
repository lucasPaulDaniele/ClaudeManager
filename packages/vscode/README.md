# ClaudeManager — extension compagnon

Cette extension rend **la fenêtre VSCode dans laquelle elle tourne** joignable par un agent,
sans jamais lui voler le focus.

Elle ne s'utilise pas à la main : elle n'ajoute aucune commande à la palette et n'affiche
aucune interface. Elle publie l'identité de sa fenêtre dans `~/.claudemanager/windows/` et
ouvre un serveur HTTP **strictement sur la boucle locale**, protégé par un jeton régénéré à
chaque session. C'est la CLI `cmgr` qui la consomme.

## Ce qu'elle expose

| Route | Rôle |
|---|---|
| `GET /health` | diagnostic : identité de la fenêtre, version, dossiers du workspace |
| `POST /conversations` | ouvre une conversation Claude dans **cette** fenêtre |

Les deux exigent le jeton de l'entrée de registre. Aucune réponse ne le renvoie.

## Limites de cette version

- Elle n'**ouvre** que. La fermeture d'une conversation et l'inventaire des conversations
  ouvertes ne sont pas encore livrés.
- La réponse du premier tour n'est pas restituée à l'appelant.
- Le CLI `claude` doit être **autorisé sur la machine** au préalable, sinon le panneau
  s'ouvre sans conversation.

## Documentation

Installation, procédure complète, limites et risques : **[dépôt
ClaudeManager](https://github.com/lucasPaulDaniele/ClaudeManager)**.

Licence MIT.
