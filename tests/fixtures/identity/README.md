# Fixtures d'identité — captures réelles

Principe fondateur n°5 : *pas de mocks du système réel*. Les tables de processus de ce dossier
sont de **vraies captures**, prises sur des systèmes réels. Aucune n'a été écrite à la main,
aucune n'a été triée, tronquée ou retouchée.

Elles ne contiennent que des **nombres** : ni chemin, ni nom d'utilisateur, ni ligne de commande.
Le dépôt est public — cette forme est une contrainte, pas un choix esthétique.

---

## `windows-process-table.csv`

| | |
|---|---|
| Commande | `Get-CimInstance Win32_Process \| ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }` |
| Où | Poste de développement Windows 11 Pro 10.0.22000, VSCode 1.122.1 |
| Quand | 2026-07-25 |
| Contenu | 319 entrées `pid,ppid`, fins de ligne CRLF à la capture |

C'est **exactement** la commande émise par `readProcessTable()` sur `win32`.

Les rôles — qui est le `claude.exe` appelant, quel est son extension host, quel est le
processus principal, quels autres extension hosts sont présents — sont relevés dans
**`windows-process-table.roles.json`**, avec la façon dont ils ont été identifiés.

Chaîne d'ancêtres réelle relevée dans cette capture :

```
claude.exe 2160 → pwsh.exe 8964 → claude.exe 22352 → extHost 11172 → Code.exe 16196 → explorer.exe 9284 → 5760 (mort)
```

Deux extension hosts y coexistent — `11172` (fenêtre hôte) et `17544` (autre fenêtre) —
**tous deux enfants du même `Code.exe` principal `16196`**. C'est la démonstration directe du
piège n°4 : le PID du processus principal ne discrimine aucune fenêtre.

## `posix-process-table.txt`

| | |
|---|---|
| Commande | `ps -Ao pid=,ppid=` |
| Où | Conteneur `ubuntu:24.04` (`procps-ng 4.0.4`) lancé avec `--pid=host` sous Docker Desktop 29.5.3 — la table est donc celle de la VM LinuxKit hôte, pas celle d'un conteneur vide |
| Quand | 2026-07-25 |
| Contenu | 162 entrées `<espaces>pid<espaces>ppid`, fins de ligne LF |

C'est **exactement** la commande émise par `readProcessTable()` hors `win32`, et le `ps` utilisé
est celui de `procps-ng` — la même implémentation que sur `ubuntu-latest` en CI.

La syntaxe a également été vérifiée contre le `ps` de **BusyBox v1.37.0** (image Alpine) : il
l'accepte et rend le même format. Aucun repli n'est donc nécessaire à ce jour.

`--pid=host` a été retenu pour disposer d'un arbre réellement profond ; la plus longue chaîne
de la capture compte 8 ancêtres et remonte jusqu'à `pid 1` :

```
75935 → 75934 → 75854 → 75821 → 75820 → 75741 → 75698 → 75673 → 1
```

## Note sur les fins de ligne

Le dépôt applique `* text=auto eol=lf` : git normalise en LF les CRLF de la capture Windows.
Le **contenu** est intact, et l'analyseur accepte les deux formes — c'est d'ailleurs l'une des
tolérances qu'il doit garantir.
