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
| Commande | `Get-CimInstance Win32_Process \| ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$(if ($_.CreationDate) { [long]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() })" }` |
| Où | Poste de développement Windows 11 Pro 10.0.22000, VSCode 1.122.1 |
| Quand | 2026-07-25 (**recapture** — voir ci-dessous) |
| Contenu | 283 entrées `pid,ppid,creation`, fins de ligne CRLF à la capture |

C'est **exactement** la commande émise par `readProcessTable()` sur `win32`.

**Pourquoi une recapture.** La capture initiale ne portait que `pid,ppid`. Le gate du lot B a
établi que la garde anti-réemploi de PID fondée sur le seul parent **se franchit** : sous
Windows le parent enregistré est le `Code.exe` principal, qui engendre des enfants en
permanence, si bien qu'un PID recyclé par n'importe lequel d'entre eux la satisfait. La
troisième colonne est la date de création du processus, **en millisecondes depuis l'époque** —
un nombre, donc ni fuseau, ni format local, ni culture, et une fixture qui reste purement
numérique. Le `if` rend la commande totale : un `CreationDate` absent produit une colonne vide,
jamais une erreur.

La topologie est **identique** à celle de la capture précédente : mêmes extension hosts,
même processus principal, même orphelin réel en bout de chaîne. Seuls les deux PID les plus
proches de l'appelant changent — c'est une autre session de développement qui a pris la capture.

Les rôles — qui est le `claude.exe` appelant, quel est son extension host, quel est le
processus principal, quels autres extension hosts sont présents — sont relevés dans
**`windows-process-table.roles.json`**, avec la façon dont ils ont été identifiés.

Chaîne d'ancêtres réelle relevée dans cette capture :

```
claude.exe 18408 → pwsh.exe 16016 → claude.exe 22352 → extHost 11172 → Code.exe 16196 → explorer.exe 9284 → 5760 (mort)
```

Deux extension hosts y coexistent — `11172` (fenêtre hôte) et `17544` (autre fenêtre) —
**tous deux enfants du même `Code.exe` principal `16196`**. C'est la démonstration directe du
piège n°4 : le PID du processus principal ne discrimine aucune fenêtre.

La capture porte en outre un **témoin de réemploi de PID** : `16872`, enfant du **même** `16196`
que l'extension host, mais né bien **après** l'écriture des entrées de registre de
`tests/fixtures/registry/`. Son parent est celui qu'une entrée réelle déclare, et pourtant il
n'a jamais été cette fenêtre — seule sa date de création l'en distingue. Il n'a pas été
fabriqué : il a été *trouvé* dans la capture, et `windows-process-table.roles.json` dit comment.

## `posix-process-table.txt`

| | |
|---|---|
| Commande | `ps -Ao pid=,ppid=` |
| Où | Conteneur `ubuntu:24.04` (`procps-ng 4.0.4`) lancé avec `--pid=host` sous Docker Desktop 29.5.3 — la table est donc celle de la VM LinuxKit hôte, pas celle d'un conteneur vide |
| Quand | 2026-07-25 |
| Contenu | 162 entrées `<espaces>pid<espaces>ppid`, fins de ligne LF |

C'est **exactement** la commande émise par `readProcessTable()` hors `win32`, et le `ps` utilisé
est celui de `procps-ng` — la même implémentation que sur `ubuntu-latest` en CI.

> **Pas de date de création ici — et c'est déclaré, pas oublié.** `ps` l'expose (`-o lstart=`,
> `-o etimes=`), mais l'ajouter impose de **recapturer** cette table sur une vraie machine POSIX :
> le dépôt n'accepte aucune fixture fabriquée (principe fondateur n°5), et l'environnement de
> capture documenté ci-dessus — Docker Desktop — n'a pas pu être démarré au moment de la
> correction. La seconde garde anti-réemploi de PID ne s'applique donc **pas** hors Windows ;
> celle du `ppid`, elle, s'applique partout. `parsePosixProcessTable` le dit en toutes lettres.
>
> Deux points à trancher **avec une mesure** le jour où cette capture sera reprise : `etimes`
> ne rend que des **secondes entières** — il faudra alors décider si la comparaison de dates
> doit absorber cette granularité —, et sa prise en charge par le `ps` de **BusyBox** n'est pas
> vérifiée, alors que celle de `pid=,ppid=` l'est.

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
