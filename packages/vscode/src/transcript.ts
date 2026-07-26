/**
 * LE SEUL FAIT QUI ETABLISSE QU'UN TOUR A EU LIEU : le transcript de la session existe.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * POURQUOI CE MODULE EXISTE, ET IL CORRIGE UN DEFAUT MESURE EN RECETTE LE 2026-07-26.
 *
 * Le mecanisme V1 tenait deux faits pour des preuves qu'ils ne sont pas :
 *   - « un enfant du shell existe » (table des processus, D20) — vrai 2 s apres l'envoi,
 *     quand le CLI n'a encore rien produit ;
 *   - « un onglet est apparu » (diff d'onglets) — vrai MEME pour une session jamais amorcee,
 *     c'est mesure et ecrit (D19).
 * Le terminal etait donc supprime 2,1 s apres l'envoi, et sa suppression TUE le `claude` du
 * tour 1 (ADR-002) : le panneau s'attachait sur une session VIDE, sans prompt ni reponse, et
 * la route rendait un succes complet. Exactement la degradation silencieuse que le principe
 * fondateur n.3 interdit.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * CE QUE CE MODULE FAIT, ET C'EST TOUT : il cherche un FICHIER PAR SON NOM et releve sa
 * TAILLE. Il ne lit pas une ligne, n'interprete aucun enregistrement, ne derive aucun slug —
 * lire le contenu d'un transcript est le lot D, et cette frontiere ne bouge pas.
 *
 * PAR NOM DE FICHIER, JAMAIS PAR CALCUL DE SLUG, et le motif n'est pas la commodite : la
 * derivation du repertoire de projet depuis le `cwd` (D7) est une convention non contractuelle,
 * et la racine qui la porte (D17) est la plus grosse inconnue du lot suivant — elle porte un
 * `— non verifie` assume dans `docs/compatibilite.md`. Le NOM du fichier, lui, est
 * l'identifiant que NOUS avons impose par `--session-id` : c'est la seule partie de ce chemin
 * dont nous soyons l'auteur.
 *
 * AUCUN CHEMIN N'EST RENDU A L'APPELANT, et c'est structurel : ces chemins portent le nom du
 * compte (`<HOME>/.claude/projects/c--Users-<compte>-…`), et le releve de ce module part dans
 * une erreur nommee, donc dans un journal, donc dans des PR d'un depot PUBLIC. On rend des
 * CHIFFRES — trouve ou non, taille, nombre de repertoires parcourus. Un chemin qu'on ne rend
 * pas est un chemin qu'on ne peut pas divulguer par inadvertance.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Racine de configuration du CLI, quand elle est relocalisee — `docs/compatibilite.md`, D17. */
export const CLAUDE_CONFIG_DIR_VARIABLE = 'CLAUDE_CONFIG_DIR';

/** Racine de configuration par defaut du CLI : `<HOME>/.claude`. */
const DEFAULT_CONFIG_DIRECTORY = '.claude';

/** Le repertoire qui porte les transcripts, sous une racine de configuration — D6. */
const PROJECTS_DIRECTORY = 'projects';

const TRANSCRIPT_EXTENSION = '.jsonl';

/**
 * OU CHERCHER, ET POURQUOI LES DEUX RACINES PLUTOT QU'UNE.
 *
 * La racine par defaut vient EN PREMIER, et ce n'est pas arbitraire : la session amorcee ne
 * peut PAS ecrire ailleurs. `CLAUDE_CONFIG_DIR` commence par `CLAUDE_`, donc la neutralisation
 * d'environnement du mecanisme la SUPPRIME de l'environnement du terminal des lors qu'elle
 * figure dans celui de l'extension host (`neutralizedTerminalEnvironment`, mesure ADR-004 :
 * `env: { X: null }` supprime reellement). Le `claude` amorce demarre donc sans elle.
 *
 * ELLE EST NEANMOINS BALAYEE, ET C'EST DELIBERE : la phrase ci-dessus est un RAISONNEMENT sur
 * notre propre code, pas une mesure — et D17 dit explicitement de ne jamais SUPPOSER ou vivent
 * `sessions/` et `projects/` quand la variable est posee, mais de les resoudre separement et de
 * verifier leur existence. Chercher dans les deux coute un `readdir` de plus et ne peut pas se
 * tromper : le nom du fichier est unique, il ne designe qu'une session — la notre.
 */
export function transcriptProjectRoots(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string
): readonly string[] {
  const roots = [path.join(homeDirectory, DEFAULT_CONFIG_DIRECTORY, PROJECTS_DIRECTORY)];

  const configured = environment[CLAUDE_CONFIG_DIR_VARIABLE]?.trim();
  if (configured !== undefined && configured.length > 0) {
    const relocated = path.join(configured, PROJECTS_DIRECTORY);
    // Une variable qui designe deja la racine par defaut ne fait pas une seconde racine.
    if (relocated !== roots[0]) roots.push(relocated);
  }
  return roots;
}

/** Ce qu'un passage a vu du transcript — des CHIFFRES, jamais un chemin. */
export interface TranscriptSighting {
  readonly found: boolean;
  /**
   * Taille en octets, `0` quand le fichier n'est pas la.
   *
   * Elle sert a un usage precis et a un seul : constater que le transcript a CESSE de croitre.
   * C'est une metadonnee, pas un contenu — aucune ligne n'est lue, aucun enregistrement n'est
   * interprete.
   */
  readonly bytes: number;
  /** Repertoires de projet parcourus — le CHIFFRE, jamais leurs noms (ils portent le compte). */
  readonly directoriesScanned: number;
}

/**
 * Cherche `<sessionId>.jsonl` sous les racines donnees, et releve sa taille.
 *
 * DEUX NIVEAUX, PAS UN BALAYAGE RECURSIF : le fichier vit sous `<racine>/<slug>/`, et la
 * racine elle-meme est sondee au cas ou la disposition s'aplatirait. Un parcours recursif sans
 * borne d'un `projects/` reel — 11 repertoires et 300 transcripts sur le poste de reference —
 * serait relance a chaque sondage, deux fois par seconde, pour trouver ce qu'un `join` trouve
 * directement.
 *
 * NE LEVE JAMAIS : une racine absente est l'etat nominal d'une machine dont le CLI n'a jamais
 * tourne, et un `readdir` qui echoue ne doit pas transformer une attente en incident. L'absence
 * de fichier est le resultat, et c'est l'appelant qui decide quand elle devient une erreur.
 */
export function probeSessionTranscript(
  roots: readonly string[],
  sessionId: string
): TranscriptSighting {
  const name = `${sessionId}${TRANSCRIPT_EXTENSION}`;
  let directoriesScanned = 0;

  for (const root of roots) {
    const atRoot = sizeOfFile(path.join(root, name));
    if (atRoot !== undefined) return { found: true, bytes: atRoot, directoriesScanned };

    for (const child of subdirectoriesOf(root)) {
      directoriesScanned += 1;
      const bytes = sizeOfFile(path.join(root, child, name));
      if (bytes !== undefined) return { found: true, bytes, directoriesScanned };
    }
  }
  return { found: false, bytes: 0, directoriesScanned };
}

/** Taille du candidat s'il existe ET s'il est un fichier, `undefined` sinon. */
function sizeOfFile(candidate: string): number | undefined {
  try {
    const stats = statSync(candidate);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

/** Les sous-repertoires d'une racine, ou rien du tout si elle n'est pas lisible. */
function subdirectoriesOf(root: string): readonly string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
