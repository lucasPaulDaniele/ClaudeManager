/**
 * LE MECANISME V1 — ouvrir une conversation Claude interactive dans CETTE fenetre.
 *
 * Arbitre a l'ADR-002 le 2026-07-25, complete par l'ADR-004 pour le transport du prompt.
 * Dans l'ordre, et L'ORDRE FAIT PARTIE DU MECANISME :
 *
 *   1. refus precoce — fenetre non approuvee, ou sans dossier de travail ;
 *   2. disponibilite de la commande d'attachement — c'est ICI, et nulle part ailleurs, que
 *      le repli V5 se decide ;
 *   3. `uuid` ;
 *   4. terminal MASQUE (`hideFromUser: true`, `show()` JAMAIS appele), `cwd` = un dossier de
 *      travail de CETTE fenetre, environnement herite NEUTRALISE ;
 *   5. une seule ligne, envoyee par `sendText` — forme L2 (ADR-004) ;
 *   6. LE TOUR 1 A REELLEMENT EU LIEU — le transcript de la session existe sur le disque ;
 *   7. attachement par `claude-vscode.editor.open(<uuid>)` ;
 *   8. `terminal.dispose()` — le `claude` du panneau survit, l'onglet reste intact ;
 *   9. repli V5, uniquement depuis les etapes qui precedent la creation du terminal.
 *
 * L'ETAPE 6 EST UNE CORRECTION, PAS UN AJOUT DE CONFORT (defaut de recette du 2026-07-26) :
 * `dispose()` TUE le `claude` du tour 1, et il intervenait 2,1 s apres l'envoi — avant que le
 * CLI n'ait rien produit. Le panneau s'attachait sur une session vide et la route rendait un
 * succes complet. Aucun des deux faits qu'elle observait auparavant ne pouvait s'y substituer,
 * c'est mesure : « un enfant du shell existe » est vrai des 2 s, et « un onglet est apparu »
 * est vrai MEME pour une session jamais amorcee (D19).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * AUCUN IMPORT DE `vscode`, et c'est ce qui rend l'ORDRE ci-dessus verifiable sans editeur.
 * L'editeur est atteint par un PORT (`EditorPort`) que `extension.ts` — seul point de contact
 * du paquet avec l'API — implemente en quelques lignes sans decision.
 *
 * CE QUE CE PORT EST, ET CE QU'IL N'EST PAS (principe fondateur n.5, « pas de mocks du
 * systeme reel »). Il est une couture d'ORDRE : ce que les tests unitaires eprouvent a
 * travers lui, c'est la SEQUENCE et les REFUS — « le repli ne part jamais une fois le terminal
 * cree », « l'erreur nommee precede le repli », « le terminal est supprime sur tous les
 * chemins ». Aucune de ces proprietes ne s'observe dans une fenetre reelle sans provoquer des
 * pannes qu'on ne sait pas provoquer. Il n'est PAS une simulation du comportement de VSCode :
 * que `editor.open` attache reellement une session, que `hideFromUser` cache reellement le
 * terminal, que `dispose` laisse reellement survivre le panneau — cela n'est prouve QUE par
 * `npm run test:integration`, dans une vraie fenetre, avec la vraie extension Claude.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  assertCommandLineFits,
  ClaudeManagerError,
  ERROR_CODES,
  isClaudeManagerError,
  readProcessTable,
  systemErrorCode,
  type ProcessSnapshot,
  type SerializedError,
} from './core.js';
import { describe } from './diagnostics.js';
import type { WorkspaceState } from './publication.js';
import {
  bundledClaudeCandidates,
  buildSeedCommandLine,
  claudeBinaryNames,
  CLAUDE_EXTENSION_ID,
  CLAUDE_OPEN_COMMAND,
  neutralizedTerminalEnvironment,
  resolveExecutable,
  SEED_SHELL_ARGUMENTS,
  seedLeadingArguments,
  selectNewPanel,
  SESSION_ID_SHAPE,
  shellNames,
  splitPathVariable,
  type PanelTabLike,
} from './seed.js';
import { probeSessionTranscript, transcriptProjectRoots } from './transcript.js';

/** L'extension Claude Code, vue par le mecanisme. */
export interface ClaudeExtensionHandle {
  readonly isActive: boolean;
  /** Repertoire d'installation — il porte la VERSION, il n'est jamais reconstruit (D16). */
  readonly extensionPath: string;
  activate(): Promise<void>;
}

/** Ce qu'on demande a l'editeur pour creer le terminal transitoire. */
export interface HiddenTerminalSpec {
  readonly name: string;
  readonly cwd: string;
  readonly shellPath: string;
  readonly shellArgs: readonly string[];
  /**
   * Noms herites, chacun mappe a `null` — JAMAIS `undefined`, JAMAIS `''`, JAMAIS
   * `strictEnv`. Le type dit `null` et rien d'autre : c'est la garde de typage du piege
   * mesure a l'ADR-004.
   */
  readonly env: Readonly<Record<string, null>>;
}

export interface HiddenTerminal {
  sendText(line: string): void;
  dispose(): void;
  /**
   * Pid du SHELL du terminal, quand l'editeur l'a resolu.
   *
   * C'est l'ancre de l'observation du tour 1 : le `claude` amorce est un ENFANT de ce shell.
   * Ecueil connu (ADR-002) : il ne se resout JAMAIS pour un pty deja mort — l'attendre sans
   * borne bloquerait indefiniment.
   */
  processId(): Promise<number | undefined>;
}

/**
 * LE SEUL CONTACT AVEC L'EDITEUR, et il est declare ici plutot qu'importe.
 *
 * `show()` n'y figure pas, et c'est deliberе : le mecanisme ne doit pas POUVOIR reveler un
 * terminal. Un principe qu'aucun type ne porte est un principe qu'on finit par enfreindre.
 */
export interface EditorPort {
  readWorkspace(): WorkspaceState;
  getClaudeExtension(): ClaudeExtensionHandle | undefined;
  listCommands(): Promise<readonly string[]>;
  executeCommand(command: string, ...args: readonly unknown[]): Promise<unknown>;
  createHiddenTerminal(spec: HiddenTerminalSpec): HiddenTerminal;
  listPanelTabs(): readonly PanelTabLike[];
}

/**
 * ECHELLE D'ATTENTE DE L'ATTACHEMENT — bornee, croissante, en millisecondes.
 *
 * L'attachement N'EST PAS INSTANTANE : la session doit d'abord exister cote CLI, ce qui
 * suppose le demarrage d'un processus Node complet. `editor.open` est donc RE-EMISE a chaque
 * echelon, et les onglets sont sondes pendant tout l'echelon.
 *
 * Total : 62 s. Borne, et c'est le point — les DEUX PORTES du CLI (onboarding, « Quick safety
 * check » du dossier) bloquent INDEFINIMENT quand elles se presentent. Sans borne, la route
 * pendrait pour toujours ; avec elle, l'appelant recoit une erreur nommee. Le mecanisme ne
 * tente JAMAIS de franchir ces portes : leur libelle n'est pas contractuel, et c'est
 * `cmgr doctor` (lot D) qui doit les verifier et les nommer.
 */
const ATTACH_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 32_000];

/** Granularite du sondage des onglets pendant un echelon. */
const TAB_POLL_INTERVAL_MS = 250;

/**
 * ATTENTE DU PROCESSUS AMORCE — combien de fois on interroge la table des processus.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * POURQUOI CETTE ETAPE EXISTE, ET ELLE N'EST PAS UNE PRECAUTION : elle corrige un defaut
 * MESURE le 2026-07-26, dans une vraie fenetre.
 *
 * L'attachement ne peut PAS servir d'horloge. Falsification jouee : `editor.open` appelee
 * avec un identifiant de session JAMAIS AMORCE ouvre un panneau tout de meme
 * (`ghostSessionOpensAPanel: true`). Le diff d'onglets aboutissait donc en moins de 200 ms —
 * avant meme que `claude` n'ait fini de demarrer —, et `terminal.dispose()` suivait aussitot.
 * Or la suppression du terminal TUE le `claude` du tour 1 (ADR-002) : le tour etait interrompu
 * a la naissance, et la route rendait un succes. Une degradation silencieuse, exactement ce
 * que le principe fondateur n.3 interdit.
 *
 * L'attente porte donc sur un FAIT OBSERVE — le shell a engendre un processus — et non sur
 * une duree devinee. C'est aussi ce qui donne enfin un signal aux DEUX PORTES du CLI :
 * quand l'une d'elles attend, aucun processus n'est engendre, et l'appelant recoit
 * `SEED_PROCESS_NOT_STARTED` plutot qu'un faux succes.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Chaque interrogation coute de 700 ms a 1,3 s (`Get-CimInstance`) : huit tentatives bornent
 * l'attente autour d'une dizaine de secondes, sans qu'aucun nombre ne soit invente.
 */
const SEED_PROCESS_ATTEMPTS = 8;

/**
 * ATTENTE DU PID DU SHELL — bornee, et LA BORNE EST LE CORRECTIF (gate C, volet 2).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * CE QUI ETAIT CASSE : `await terminal.processId()` n'etait borne par RIEN. Un commentaire
 * annoncait « la course contre l'echelle ci-dessous le borne » — cette course n'etait pas
 * ecrite : la boucle des tentatives ne demarrait qu'APRES la resolution de cet `await`. Or
 * l'ecueil est mesure dans ce depot (ADR-002, ecueil n.5) : « `terminal.processId` ne se
 * resout JAMAIS pour un pty deja mort. Une boucle qui l'attend se bloque indefiniment. » Et
 * l'adaptateur reel propage le thenable sans le borner — `Promise.resolve(terminal.processId)`
 * ADOPTE un thenable qui ne se regle jamais.
 *
 * CE QUE CA PRODUISAIT, ET AUCUN NIVEAU N'EN RATTRAPAIT RIEN : la route pend sans borne, donc
 * le `finally` n'est jamais atteint — terminal masque NON SUPPRIME et fichier de prompt laisse
 * EN CLAIR sur le disque —, et `serializeOpenings` etant une file d'un seul rang, plus aucune
 * ouverture n'est possible dans cette fenetre jusqu'a rechargement — que le README interdit
 * precisement sur une fenetre qui heberge une conversation. Cote client, l'abandon a 300 s
 * sort en `WINDOW_UNREACHABLE`, qui designe la mauvaise cause.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * HUIT ECHELONS DE 250 ms, SOIT 2 s. C'est une borne de VIVACITE, pas de performance : le pid
 * est resolu par l'editeur des que le pty est engendre, et un pty qui n'existe pas apres 2 s
 * n'existera pas. Elle ne s'ajoute pas au pire cas de la route — quand elle s'epuise, on leve,
 * et rien de ce qui suit n'a lieu.
 */
const SHELL_PID_ATTEMPTS = 8;

/**
 * ATTENTE DE L'ACTIVATION DE L'EXTENSION CLAUDE — bornee pour la meme raison, et sans mesure.
 *
 * `extension.activate()` est une promesse de l'editeur : rien ne garantit qu'elle se regle.
 * Non bornee, elle bloque la meme file d'un rang que ci-dessus, avec la meme consequence pour
 * l'appelant — sauf qu'ici aucun terminal n'existe encore et aucun prompt n'est ecrit, donc
 * rien ne fuit : seule la fenetre devient inutilisable.
 *
 * 10 s, ET CE CHIFFRE N'EST PAS MESURE — il est assume comme tel. Aucun spike n'a chronometre
 * l'activation de l'extension Claude ; ce qu'on sait est qu'elle enregistre ses commandes a ce
 * moment-la, et qu'une activation qui n'a pas rendu la main au bout de 10 s ne servira aucune
 * commande dans ce cycle. Une erreur nommee vaut alors mieux qu'une route qui ne revient pas.
 */
const EXTENSION_ACTIVATION_BUDGET_MS = 10_000;

/**
 * « Rien ne s'est encore regle » — A NE PAS CONFONDRE AVEC `undefined`, qui est une REPONSE.
 *
 * Les deux ne decrivent pas le meme defaut : `undefined` est ce que l'editeur repond quand il
 * n'a pas de pid a donner ; l'absence de reponse, elle, est l'ecueil n.5. Un `await` non borne
 * ne distingue que le premier — c'est meme la raison pour laquelle le double de test, qui
 * rendait `undefined` sous un nom annoncant l'ecueil, ne couvrait pas le cas reel.
 */
const NOTHING_SETTLED = Symbol('nothing-settled');

/** Granularite du sondage du transcript — deux passages par seconde. */
const TRANSCRIPT_POLL_INTERVAL_MS = 500;

/**
 * ATTENTE DE L'APPARITION DU TRANSCRIPT — bornee, et le chiffre est MESURE.
 *
 * MESURE DU 2026-07-26, sur le poste de reference, dossier dont la confiance du CLI etait deja
 * accordee : la ligne est envoyee a t0, `<sessionId>.jsonl` apparait a **+2 533 ms**. Le repere
 * annonce au cahier des charges — « moins de 10 s » — est donc large.
 *
 * 45 s, soit dix-huit fois la mesure, et la dissymetrie des couts commande cette marge : trop
 * court, on emet une erreur nommee ET on supprime le terminal, donc on TUE un tour parfaitement
 * sain — un demarrage a froid du CLI (265 Mo de binaire, antivirus en embuscade) coute
 * facilement quelques secondes de plus. Trop long, on retarde une erreur de diagnostic.
 */
const TRANSCRIPT_APPEARANCE_BUDGET_MS = 45_000;

/**
 * GRACE ACCORDEE A LA SORTIE DU TOUR — et voici pourquoi elle N'EST PAS FACULTATIVE.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * L'APPARITION DU FICHIER NE PROUVE PAS QUE LE TOUR SOIT ALLE A SON TERME, et c'est mesure le
 * 2026-07-26 sur ce poste, a la milliseconde :
 *
 *   +2 533 ms  le transcript apparait — 8 enregistrements : `mode`, `permission-mode`,
 *              `file-history-snapshot`, `user`, `attachment`. LE PROMPT EST ENREGISTRE,
 *              LA REPONSE N'EXISTE PAS ENCORE.
 *   +6 417 ms  la reponse est ecrite — 11 enregistrements, `assistant` parmi eux.
 *              Journal du CLI a l'appui : `[engine] turn 1 end (… api=5566ms stop=end_turn)`.
 *
 * Supprimer le terminal a l'apparition tuerait donc la reponse en vol : le panneau porterait le
 * prompt et rien d'autre. Ce serait le defaut de recette du 2026-07-26 reproduit un etage plus
 * haut — un fait qui prouve un DEBUT pris pour un fait qui prouve le TOUR.
 *
 * ET LA TAILLE SEULE NE SUFFIT PAS DAVANTAGE : entre +2 533 ms et +6 417 ms, le fichier N'A PAS
 * CROIT. Une simple attente de stabilite aurait conclu « c'est fini » au bout de 4 s d'immobilite
 * qui etaient, en realite, l'attente de la premiere reponse du service. On exige donc une
 * CROISSANCE depuis l'apparition, PUIS un silence — dans cet ordre, et l'ordre est le fond du
 * raisonnement.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * CETTE PHASE N'EST JAMAIS UNE ERREUR, et c'est deliberе : le tour est deja ENREGISTRE quand
 * elle commence. Son epuisement se journalise — « la sortie n'etait pas retombee » — et
 * l'ouverture reste un succes. Nommer un echec ici reviendrait a refuser une conversation
 * ouverte parce que le service a ete lent.
 *
 * PLAFOND : 30 s apres l'apparition. Au-dela, on assume la troncature plutot que de tenir la
 * route indefiniment ; la voie qui rend la REPONSE du tour 1 a l'appelant est
 * `cmgr open --wait`, et elle appartient au lot D, qui LIT le transcript.
 */
const TURN_OUTPUT_BUDGET_MS = 30_000;

/**
 * Silence exige apres la derniere croissance pour tenir la sortie du tour pour retombee.
 *
 * La reponse mesuree est arrivee entre deux sondages — 8 enregistrements, puis 11 d'un coup —,
 * mais rien ne garantit qu'un titre, un enregistrement `system` ou une sortie plus longue
 * n'arrivent en plusieurs ecritures. 3 s de silence, soit six sondages sans le moindre octet.
 */
const TURN_OUTPUT_QUIET_MS = 3_000;

/**
 * Age au-dela duquel un fichier de prompt abandonne est efface au passage.
 *
 * RATTRAPAGE DE L'EXISTANT (principe fondateur n.7) : la ligne envoyee au shell efface le
 * fichier elle-meme, et l'extension a un filet en `finally`. Reste le cas ou l'extension host
 * MEURT entre l'ecriture et l'envoi — aucun des deux ne joue alors, et un prompt reste sur
 * le disque indefiniment. Une heure : bien au-dela des 62 s d'un cycle d'ouverture, donc
 * jamais le fichier d'une ouverture en cours, y compris celle d'une autre fenetre.
 */
const ABANDONED_PROMPT_MAX_AGE_MS = 3_600_000;

/** Droits du repertoire de transit et du fichier de prompt — meme discipline que le registre. */
const PROMPT_DIR_MODE = 0o700;
const PROMPT_FILE_MODE = 0o600;

export interface OpenConversationRequest {
  readonly prompt: string;
}

/**
 * QUEL CHEMIN A ETE PRIS — et rien de plus.
 *
 * `'seeded'` A REMPLACE `'nominal'`, ET CE N'EST PAS COSMETIQUE. « Nominal » se lit
 * naturellement « tout s'est bien passe » ; le mode, lui, ne dit QUE la voie empruntee. Ce que
 * l'ouverture a etabli du tour 1 est porte par `firstTurn` et `firstTurnVerified`, jamais
 * deduit du mode.
 */
export type OpenMode = 'seeded' | 'fallback';

/**
 * CE QUE L'OUVERTURE A REELLEMENT ETABLI DU TOUR 1.
 *
 * `'transcript-observed'` — le transcript de la session EXISTE sur le disque, trouve par son
 * NOM DE FICHIER. C'est le seul fait disponible qui etablisse qu'un tour a eu lieu : le CLI ne
 * l'ecrit ni quand une de ses portes attend, ni quand il se croit agent enfant non interactif
 * (auquel cas il coupe la sauvegarde du transcript, silencieusement).
 *
 * `'not-attempted'` — repli V5 : aucune session n'a ete amorcee, il n'y a pas de tour.
 *
 * `'process-started'` A DISPARU DE CETTE ENUMERATION, et c'est le fond du correctif du
 * 2026-07-26 : « un enfant du shell existe » etait vrai 2 s apres l'envoi, alors que le CLI
 * pouvait tout aussi bien etre arrete a une porte — les deux cas sont le MEME processus,
 * `claude.exe`, avec la MEME ligne de commande. Un etat qui ne discrimine rien n'a pas a etre
 * rendu comme un resultat. Le CLIENT du coeur, lui, l'accepte encore en lecture : une fenetre
 * portant une version anterieure de l'extension le rend toujours, et refuser sa reponse
 * transformerait un ecart de version en reponse illisible.
 */
export type FirstTurnOutcome = 'transcript-observed' | 'not-attempted';

export interface OpenConversationResult {
  readonly ok: true;
  readonly mode: OpenMode;
  /** `null` en repli : aucune session n'a ete amorcee, l'humain valide un champ pre-rempli. */
  readonly sessionId: string | null;
  readonly extHostPid: number;
  /**
   * Vrai en repli SEULEMENT, et l'enonce est etroit a dessein : le prompt est pre-rempli dans
   * le champ de saisie et attend une validation humaine. Ce champ ne dit RIEN de l'etat du
   * tour 1 dans la voie amorcee — c'est `firstTurnVerified` qui le porte.
   */
  readonly humanActionRequired: boolean;
  /** Ce que l'ouverture a etabli du tour 1 — jamais plus que ce qui a ete observe. */
  readonly firstTurn: FirstTurnOutcome;
  /**
   * LE TOUR 1 A-T-IL EU LIEU ? **CE CHAMP PEUT DESORMAIS VALOIR `true`, ET C'EST LE CORRECTIF.**
   *
   * Il valait le litteral `false`, et c'etait le bon choix tant que rien ne pouvait le
   * verifier : le type litteral obligeait a rompre la compilation des consommateurs le jour ou
   * la promesse changerait. Ce jour est arrive — le mecanisme CONSTATE l'existence du
   * transcript de la session avant de rendre la main.
   *
   * CE QU'IL AFFIRME, EXACTEMENT : `<sessionId>.jsonl` existe sous une racine de projets du
   * CLI, trouve par son NOM. Donc le CLI a demarre, aucune de ses portes ne l'attend, la
   * sauvegarde du transcript n'a pas ete coupee, et l'identifiant de session que NOUS avons
   * impose est bien celui qu'il ecrit.
   *
   * CE QU'IL N'AFFIRME PAS : que la REPONSE du tour soit complete — le mecanisme laisse a la
   * sortie du tour une grace bornee (`TURN_OUTPUT_BUDGET_MS`) avant de supprimer le terminal,
   * mais il ne lit pas le contenu du transcript et ne peut donc pas le certifier. Restituer la
   * reponse est `cmgr open --wait`, lot D.
   *
   * `false` en repli V5 : aucune session n'est amorcee, il n'y a rien a verifier.
   */
  readonly firstTurnVerified: boolean;
  /**
   * Le `viewType` de l'onglet apparu, RELEVE TEL QUEL — il est prefixe par VSCode.
   *
   * CE QU'IL PROUVE A CHANGE DE PORTEE, ET IL FAUT LE DIRE ICI : un onglet apparu prouve que
   * `claude-vscode.editor.open` A REPONDU, jamais que la session soit attachee — la commande
   * ouvre un panneau MEME pour un identifiant jamais amorce (D19, mesure C1). Ce champ est
   * donc un RELEVE, pas une preuve ; la preuve du tour est `firstTurnVerified`. Absent en
   * repli, ou aucun diff n'est fait.
   */
  readonly panelViewType?: string | undefined;
  /**
   * L'ERREUR QUI A CAUSE LE REPLI — le repli s'AJOUTE a elle, il ne la remplace jamais
   * (dette D18). Sans ce champ, l'appelant croirait le mecanisme nominal intact.
   */
  readonly degradedFrom?: SerializedError;
}

export interface OpenConversationDependencies {
  readonly editor: EditorPort;
  readonly extHostPid: number;
  /** Repertoire de transit du prompt — le stockage propre a l'extension, hors du workspace. */
  readonly promptDirectory: string;
  readonly log: (message: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Attente differee — SEUL POINT D'INJECTION avec le port, et pour la meme raison que
   * `schedule` dans `publication.ts` : ce qu'il faut prouver est que l'echelle est BORNEE et
   * que `editor.open` est re-emise, pas qu'on patiente 62 secondes.
   */
  readonly wait?: (ms: number) => Promise<void>;
  /** Identifiant de session — injectable pour que la preuve puisse l'imposer. */
  readonly newSessionId?: () => string;
  /**
   * Inventaire des processus du systeme. Defaut : celui du coeur.
   *
   * Injectable pour la meme raison que `wait` : ce qu'il faut prouver est que l'attente porte
   * sur un FAIT OBSERVE et qu'elle est bornee, pas que `Get-CimInstance` reponde en 1,1 s.
   */
  readonly readProcessTable?: () => Promise<ProcessSnapshot>;
  /**
   * Ou chercher `<sessionId>.jsonl`. Defaut : les racines de projets du CLI.
   *
   * Injectable POUR QUE LA PREUVE PUISSE EXISTER, et pas pour reconfigurer quoi que ce soit :
   * un test unitaire qui viserait le vrai `<HOME>/.claude/projects` du poste y chercherait un
   * transcript que personne n'ecrira jamais, et — bien pire — ne pourrait pas etablir que
   * `dispose()` n'intervient qu'apres. Le systeme de fichiers, lui, reste REEL : le fichier est
   * vraiment cherche, vraiment trouve, vraiment mesure.
   */
  readonly transcriptProjectRoots?: readonly string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Ecrit le prompt dans un fichier transitoire, a droits restreints.
 *
 * MEME DISCIPLINE QUE L'ENTREE DE REGISTRE, et pour un motif voisin : ce fichier porte le
 * prompt en clair — c'est-a-dire, en production, tout le contexte d'un lot d'orchestration.
 * Sans `mode`, Node applique `0o666 & ~umask` : sur un poste POSIX multi-utilisateurs,
 * n'importe quel autre compte le lirait. Sous Windows ces bits ne pilotent que l'attribut
 * « lecture seule » et c'est l'ACL heritee qui protege — les poser n'y coute rien.
 *
 * @throws {ClaudeManagerError} `PROMPT_FILE_UNWRITABLE`
 */
function writePromptFile(directory: string, sessionId: string, prompt: string): string {
  const file = path.join(directory, `${sessionId}.prompt.txt`);
  try {
    mkdirSync(directory, { recursive: true, mode: PROMPT_DIR_MODE });
    // Le `mode` de `mkdirSync` ne s'applique qu'a la CREATION : un repertoire deja la —
    // celui d'une version anterieure — resterait ouvert. Ce `chmod` est idempotent.
    chmodSync(directory, PROMPT_DIR_MODE);
    writeFileSync(file, prompt, { encoding: 'utf8', mode: PROMPT_FILE_MODE });
  } catch (cause) {
    // Sans detail hors du code systeme : le message porterait le chemin, donc le compte.
    throw new ClaudeManagerError(
      ERROR_CODES.PROMPT_FILE_UNWRITABLE,
      'The transient prompt file could not be written',
      { cause: systemErrorCode(cause) }
    );
  }
  return file;
}

/**
 * Efface les prompts qu'aucun cycle n'a pu effacer — jamais ceux d'un cycle en cours.
 *
 * Ne leve JAMAIS : c'est de l'hygiene, et une hygiene qui ferait echouer une ouverture serait
 * pire que le residu qu'elle vise. Ce qu'elle n'a pas pu faire est journalise.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * DEUX SITES D'APPEL, ET LE SECOND EST LE CORRECTIF (V2-4). Elle n'etait appelee que depuis
 * `openConversation` : si l'extension host MEURT entre l'ecriture du fichier et l'envoi de la
 * ligne, le prompt reste en clair INDEFINIMENT tant qu'aucune ouverture ne survient dans cette
 * fenetre — c'est-a-dire, pour une fenetre qui n'en fera plus jamais, pour toujours.
 * L'ACTIVATION est le moment qui manquait : un host qui demarre prouve que le precedent est
 * mort. `activate()` y balaie deja le registre (`sweepStaleEntries`) ; la symetrie est faite.
 *
 * L'AGE RESTE EXIGE A L'ACTIVATION, ET CE N'EST PAS UNE PRUDENCE DE STYLE : le repertoire de
 * transit est le `globalStorage` de l'EXTENSION, pas de la fenetre — TOUTES les fenetres du
 * poste y ecrivent. « Le host precedent est mort, donc ses prompts sont abandonnes par
 * construction » vaut pour LE NOTRE ; il ne dit rien de l'ouverture qu'une AUTRE fenetre est
 * peut-etre en train de jouer a la seconde ou l'on demarre. Effacer sans age tuerait son tour 1.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
export function sweepAbandonedPrompts(
  directory: string,
  now: number,
  log: (message: string) => void
): void {
  let files: readonly string[];
  try {
    files = readdirSync(directory);
  } catch {
    // Repertoire absent : c'est l'etat nominal d'une fenetre qui n'a encore rien ouvert.
    return;
  }

  let removed = 0;
  for (const file of files) {
    if (!file.endsWith('.prompt.txt')) continue;
    const absolute = path.join(directory, file);
    try {
      if (now - statSync(absolute).mtimeMs < ABANDONED_PROMPT_MAX_AGE_MS) continue;
      rmSync(absolute, { force: true });
      removed += 1;
    } catch (error) {
      log(`could not sweep an abandoned prompt file — ${describe(error)}`);
    }
  }
  if (removed > 0) log(`swept ${removed} abandoned prompt file(s)`);
}

/**
 * Verifie que la commande d'attachement EXISTE — et distingue trois causes, pas une.
 *
 * ALERTE MESUREE : les commandes `claude-vscode.*` sont enregistrees A L'ACTIVATION, elles ne
 * sont pas contribuees par le manifeste. Avant activation, `getCommands(true)` en rend ZERO ;
 * apres, il en rend dix-huit. Un `executeCommand` sur une extension non encore activee echoue
 * donc en *command not found* — EXACTEMENT le symptome qui, seul, ferait conclure a la
 * disparition de la commande. Les deux causes sont indiscernables au point d'appel : on
 * active DONC explicitement, on constate `isActive`, et alors seulement on interroge
 * l'inventaire.
 *
 * @throws {ClaudeManagerError} `CLAUDE_EXTENSION_MISSING`, `CLAUDE_EXTENSION_INACTIVE`,
 * `CLAUDE_COMMAND_MISSING`
 */
async function requireAttachCommand(
  editor: EditorPort,
  wait: (ms: number) => Promise<void>,
  log: (message: string) => void
): Promise<ClaudeExtensionHandle> {
  const extension = editor.getClaudeExtension();
  if (extension === undefined) {
    throw new ClaudeManagerError(
      ERROR_CODES.CLAUDE_EXTENSION_MISSING,
      `The ${CLAUDE_EXTENSION_ID} extension is not installed in this window`,
      { extensionId: CLAUDE_EXTENSION_ID }
    );
  }

  if (!extension.isActive) {
    try {
      // BORNEE : c'est une promesse de l'editeur, rien ne garantit qu'elle se regle. Non
      // bornee, elle bloquerait la file d'ouverture de cette fenetre pour toujours — le meme
      // defaut que celui du pid du shell, un etage plus haut.
      const settled = await Promise.race([
        extension.activate(),
        wait(EXTENSION_ACTIVATION_BUDGET_MS).then((): typeof NOTHING_SETTLED => NOTHING_SETTLED),
      ]);
      if (settled === NOTHING_SETTLED) {
        throw new ClaudeManagerError(
          ERROR_CODES.CLAUDE_EXTENSION_INACTIVE,
          `The ${CLAUDE_EXTENSION_ID} extension activation did not return within the allotted time`,
          { extensionId: CLAUDE_EXTENSION_ID, waitedMs: EXTENSION_ACTIVATION_BUDGET_MS }
        );
      }
    } catch (cause) {
      // Deja nommee — l'echeance ci-dessus : elle porte son propre detail, la reemballer le
      // perdrait et ferait passer une borne pour un rejet de l'extension.
      if (isClaudeManagerError(cause)) throw cause;
      throw new ClaudeManagerError(
        ERROR_CODES.CLAUDE_EXTENSION_INACTIVE,
        `The ${CLAUDE_EXTENSION_ID} extension failed to activate in this window`,
        { extensionId: CLAUDE_EXTENSION_ID, cause: systemErrorCode(cause) }
      );
    }
  }
  // CONSTATE, jamais suppose : `activate()` peut rendre la main sans que l'extension soit
  // active — un `activate` qui rejette silencieusement, une desactivation concurrente.
  if (!extension.isActive) {
    throw new ClaudeManagerError(
      ERROR_CODES.CLAUDE_EXTENSION_INACTIVE,
      `The ${CLAUDE_EXTENSION_ID} extension reports itself inactive after activation`,
      { extensionId: CLAUDE_EXTENSION_ID }
    );
  }

  const commands = await editor.listCommands();
  if (!commands.includes(CLAUDE_OPEN_COMMAND)) {
    throw new ClaudeManagerError(
      ERROR_CODES.CLAUDE_COMMAND_MISSING,
      `The ${CLAUDE_OPEN_COMMAND} command is not registered although the extension is active`,
      { command: CLAUDE_OPEN_COMMAND }
    );
  }
  log(`attach command available: ${CLAUDE_OPEN_COMMAND}`);
  // RENDUE plutot que relue plus loin : une seconde interrogation ouvrirait un cas
  // « l'extension a disparu entre-temps » qu'aucun test ne peut atteindre, et qu'il faudrait
  // pourtant ecrire. La poignee qu'on a validee est celle dont on se sert.
  return extension;
}

/**
 * LE PID DU SHELL, OU L'AVEU QU'IL N'EST JAMAIS VENU — et l'attente est BORNEE.
 *
 * LA COURSE EST ECRITE, CETTE FOIS. Elle etait promise par un commentaire et absente du code :
 * `await terminal.processId()` precedait la boucle des tentatives au lieu de courir contre
 * elle. Ici, chaque echelon confronte la promesse de l'editeur a une attente courte — la
 * promesse gagne des qu'elle se regle, l'echelle gagne quand elle ne se regle jamais.
 *
 * `NOTHING_SETTLED` DISTINGUE CE QUE `undefined` CONFONDAIT : l'editeur n'a rien repondu, par
 * opposition a « il a repondu qu'il n'avait pas de pid ». L'appelant en fait deux erreurs
 * distinctes.
 */
async function resolveShellPid(
  terminal: HiddenTerminal,
  wait: (ms: number) => Promise<void>
): Promise<number | undefined | typeof NOTHING_SETTLED> {
  // UNE SEULE FOIS, hors de la boucle : rappeler `processId()` a chaque echelon demanderait un
  // nouveau thenable a l'editeur a chaque tour, et l'on n'attendrait jamais le MEME.
  const resolving = terminal.processId();

  for (let attempt = 1; attempt <= SHELL_PID_ATTEMPTS; attempt += 1) {
    const settled = await Promise.race([
      resolving,
      wait(TAB_POLL_INTERVAL_MS).then((): typeof NOTHING_SETTLED => NOTHING_SETTLED),
    ]);
    if (settled !== NOTHING_SETTLED) return settled;
  }
  return NOTHING_SETTLED;
}

/**
 * Attend que le shell du terminal ait REELLEMENT engendre le processus du tour 1.
 *
 * L'observation est faite sur la TABLE DES PROCESSUS du systeme — la meme que celle qui
 * resout « ma fenetre » —, jamais sur un fichier d'etat du CLI : `<CONFIG>/sessions/<pid>.json`
 * porte un `— non verifie` assume dans `docs/compatibilite.md` (D17), et faire dependre le
 * mecanisme de la plus grosse inconnue du lot suivant serait le mettre a sa merci.
 *
 * CE QU'ELLE ETABLIT : un processus est ne du shell, donc la ligne s'est executee, donc le
 * binaire a demarre et aucune porte n'attend.
 * CE QU'ELLE N'ETABLIT PAS, et c'est dit : que le TOUR soit termine. Le savoir suppose de
 * lire le transcript — lot D.
 *
 * @throws {ClaudeManagerError} `SEED_PROCESS_NOT_STARTED`
 */
async function awaitSeedProcess(
  terminal: HiddenTerminal,
  readTable: () => Promise<ProcessSnapshot>,
  wait: (ms: number) => Promise<void>,
  log: (message: string) => void
): Promise<{ readonly shellPid: number; readonly seedPid: number }> {
  const shellPid = await resolveShellPid(terminal, wait);
  if (shellPid === NOTHING_SETTLED) {
    throw new ClaudeManagerError(
      ERROR_CODES.SEED_PROCESS_NOT_STARTED,
      'The hidden terminal never settled its shell process id within the allotted time',
      // LES DEUX CAS SE DISTINGUENT ICI, ET C'EST TOUT L'INTERET DU DETAIL : « jamais reglee »
      // designe un pty deja mort (ecueil ADR-002 n.5) ; « undefined » est une REPONSE de
      // l'editeur. Meme code de sortie, deux diagnostics.
      { shellPid: 'never-settled', waitedMs: SHELL_PID_ATTEMPTS * TAB_POLL_INTERVAL_MS }
    );
  }
  if (shellPid === undefined) {
    throw new ClaudeManagerError(
      ERROR_CODES.SEED_PROCESS_NOT_STARTED,
      'The hidden terminal never resolved a shell process id',
      { shellPid: 'undefined' }
    );
  }

  for (let attempt = 1; attempt <= SEED_PROCESS_ATTEMPTS; attempt += 1) {
    const snapshot = await readTable();
    for (const [pid, record] of snapshot.table) {
      if (record.ppid !== shellPid) continue;
      log(`the seed process started after ${attempt} process table read(s)`);
      return { shellPid, seedPid: pid };
    }
    // La table coute deja de 700 ms a 1,3 s : on n'y ajoute qu'une respiration courte.
    await wait(TAB_POLL_INTERVAL_MS);
  }

  throw new ClaudeManagerError(
    ERROR_CODES.SEED_PROCESS_NOT_STARTED,
    'The hidden terminal shell never spawned the first-turn process',
    { attempts: SEED_PROCESS_ATTEMPTS }
  );
}

/**
 * ATTEND QUE LE TOUR 1 AIT REELLEMENT EU LIEU, puis que sa sortie soit retombee.
 *
 * DEUX PHASES, DE NATURES DIFFERENTES, ET C'EST LE CŒUR DU CORRECTIF :
 *
 *   A. LE TRANSCRIPT APPARAIT — fait EXIGE. Son absence est une erreur NOMMEE : le tour n'a
 *      pas eu lieu, et rendre un succes serait la degradation silencieuse du 2026-07-26.
 *   B. LA SORTIE DU TOUR EST ECRITE PUIS SE TAIT — grace BORNEE, jamais une erreur. Mesure du
 *      2026-07-26 : le fichier apparait a +2 533 ms avec le prompt et SANS la reponse, qui
 *      n'arrive qu'a +6 417 ms. Supprimer le terminal a l'apparition tuerait la reponse en vol.
 *      On exige donc une CROISSANCE depuis l'apparition, PUIS un silence — le fichier ne
 *      grossit pas pendant que le service reflechit, une simple stabilite conclurait a tort.
 *
 * AUCUNE LIGNE N'EST LUE : existence et taille, rien d'autre. Interpreter le contenu d'un
 * transcript est la frontiere du lot D, et elle ne bouge pas.
 *
 * @throws {ClaudeManagerError} `SEED_TRANSCRIPT_NOT_FOUND`
 */
async function awaitFirstTurn(
  roots: readonly string[],
  sessionId: string,
  wait: (ms: number) => Promise<void>,
  log: (message: string) => void
): Promise<void> {
  // ---- Phase A : le transcript existe ---------------------------------------------------
  let sighting = probeSessionTranscript(roots, sessionId);
  let appearedAfterMs = 0;
  while (!sighting.found) {
    if (appearedAfterMs >= TRANSCRIPT_APPEARANCE_BUDGET_MS) {
      throw new ClaudeManagerError(
        ERROR_CODES.SEED_TRANSCRIPT_NOT_FOUND,
        'No transcript was written for the seeded session: the first turn never took place',
        // Des CHIFFRES, jamais un chemin : ces racines portent le nom du compte.
        //
        // LE `sessionId` EST L'EXCEPTION, ET IL FAUT LA : c'est un uuid que NOUS avons genere,
        // rendu tel quel au premier niveau en cas de succes. Sans lui, l'appelant apprend qu'un
        // `claude --session-id <uuid>` a ete lance sans savoir lequel — il ne peut ni constater
        // un transcript apparu en retard derriere une porte du CLI, ni s'abstenir de relancer.
        // La discipline visait les chemins qui portent le nom du compte, pas un identifiant.
        {
          sessionId,
          waitedMs: appearedAfterMs,
          rootsScanned: roots.length,
          directoriesScanned: sighting.directoriesScanned,
        }
      );
    }
    await wait(TRANSCRIPT_POLL_INTERVAL_MS);
    appearedAfterMs += TRANSCRIPT_POLL_INTERVAL_MS;
    sighting = probeSessionTranscript(roots, sessionId);
  }
  log(`the session transcript appeared after ~${appearedAfterMs} ms: the first turn is RECORDED`);

  // ---- Phase B : la sortie du tour est ecrite, puis se tait -----------------------------
  const bytesAtAppearance = sighting.bytes;
  let bytes = bytesAtAppearance;
  let quietMs = 0;
  for (let waitedMs = 0; waitedMs < TURN_OUTPUT_BUDGET_MS; waitedMs += TRANSCRIPT_POLL_INTERVAL_MS) {
    await wait(TRANSCRIPT_POLL_INTERVAL_MS);
    const seen = probeSessionTranscript(roots, sessionId).bytes;

    if (seen !== bytes) {
      // Le tour ecrit : le silence exige repart de zero.
      bytes = seen;
      quietMs = 0;
      continue;
    }
    // Rien n'a encore ete ecrit DEPUIS l'apparition : c'est l'attente de la reponse, pas un
    // silence de fin. La distinction est exactement ce que la mesure impose.
    if (bytes === bytesAtAppearance) continue;

    quietMs += TRANSCRIPT_POLL_INTERVAL_MS;
    if (quietMs >= TURN_OUTPUT_QUIET_MS) {
      log(
        `the turn output settled after ~${waitedMs + TRANSCRIPT_POLL_INTERVAL_MS} ms ` +
          `(+${bytes - bytesAtAppearance} bytes since the transcript appeared)`
      );
      return;
    }
  }

  // NI ERREUR NI SILENCE : le tour est enregistre, sa sortie n'a pas fini de s'ecrire dans le
  // temps accorde. On le DIT, et on supprime le terminal — la troncature est assumee, bornee,
  // et l'appelant en trouve la trace dans le journal de la fenetre.
  log(
    `the turn output had not settled ${TURN_OUTPUT_BUDGET_MS} ms after the transcript appeared ` +
      `(+${bytes - bytesAtAppearance} bytes): disposing the seed terminal may truncate it`
  );
}

/**
 * Attache le panneau, et RELEVE l'onglet apparu.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * CE QUE LE DIFF D'ONGLETS PROUVE, ET IL FAUT LIRE CE PARAGRAPHE AVANT D'Y TOUCHER : il prouve
 * que `claude-vscode.editor.open` A REPONDU EN OUVRANT UN PANNEAU. Il ne prouve PAS que la
 * session soit attachee — mesure par falsification a C1 (D19, `ghostSessionOpensAPanel: true`),
 * un appel avec un identifiant JAMAIS AMORCE ouvre un panneau tout de meme, en 86 ms. Il ne
 * peut donc servir ni d'horloge, ni de preuve de tour : croire le contraire est precisement ce
 * qui a produit le defaut de recette du 2026-07-26.
 *
 * CE QU'IL RESTE ET POURQUOI ON LE GARDE : sans lui, la seule chose qu'on saurait de
 * l'attachement serait « la commande n'a pas leve », et l'absence d'erreur ne vaut rien (D10 :
 * `editor.open` REUSSIT en ouvrant un panneau vide quand le `cwd` ne correspond pas au
 * workspace). Il releve aussi le `viewType`, qui est prefixe par VSCode et qu'on ne devine pas.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * @throws {ClaudeManagerError} `CLAUDE_PANEL_VIEWTYPE_UNKNOWN`
 */
async function attachPanel(
  editor: EditorPort,
  sessionId: string,
  before: readonly PanelTabLike[],
  wait: (ms: number) => Promise<void>,
  log: (message: string) => void
): Promise<PanelTabLike> {
  let attempts = 0;
  for (const budgetMs of ATTACH_RETRY_DELAYS_MS) {
    attempts += 1;
    await editor.executeCommand(CLAUDE_OPEN_COMMAND, sessionId);

    for (let waited = 0; waited < budgetMs; waited += TAB_POLL_INTERVAL_MS) {
      const panel = selectNewPanel(before, editor.listPanelTabs());
      if (panel !== undefined) {
        // `viewType` est defini par construction — `selectNewPanel` ne rend qu'un onglet
        // deja reconnu Claude. Aucun repli n'est ecrit pour un cas qui ne se produit pas.
        //
        // « a REPONDU », jamais « est attache » : un onglet apparait meme pour une session
        // jamais amorcee (D19). Le libelle de cette ligne de journal est ce qui empeche de
        // relire ce diff, dans six mois, comme une preuve d'attachement.
        log(`the attach command answered with a panel after ${attempts} attempt(s), viewType=${panel.viewType}`);
        return panel;
      }
      await wait(TAB_POLL_INTERVAL_MS);
    }
  }

  const totalMs = ATTACH_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
  throw new ClaudeManagerError(
    ERROR_CODES.CLAUDE_PANEL_VIEWTYPE_UNKNOWN,
    'No Claude conversation tab appeared after the attach command was issued',
    // LE `sessionId` EST DANS LES DETAILS, ET C'EST LE CAS LE PLUS COUTEUX DU PRODUIT : cette
    // erreur tombe APRES `awaitFirstTurn`, donc apres un tour 1 REELLEMENT joue — les jetons du
    // modele ont ete consommes, le transcript est sur le disque, et le `finally` va supprimer le
    // terminal. Sans cet identifiant, une session complete existerait sans qu'aucun appelant
    // puisse la designer, et la seule conduite possible serait d'en ouvrir une seconde.
    { sessionId, attempts, waitedMs: totalMs }
  );
}

/**
 * LE REPLI V5 — il s'AJOUTE a l'erreur nommee, il ne la remplace JAMAIS.
 *
 * `editor.open(null, <prompt>)` PRE-REMPLIT le champ de saisie sans jamais soumettre : prouve
 * deux fois (au source — il appelle `setInputText`, rien d'autre — et par mesure). La
 * conversation est ouverte, le prompt est la, l'humain valide. Perte d'autonomie ASSUMEE :
 * mieux vaut un geste humain qu'une conversation non ouverte.
 *
 * Si le repli echoue a son tour, c'est l'erreur NOMINALE qui remonte : c'est elle que
 * l'appelant doit diagnostiquer, l'echec du repli n'en est qu'une consequence.
 */
async function runFallback(
  editor: EditorPort,
  prompt: string,
  cause: ClaudeManagerError,
  extHostPid: number,
  log: (message: string) => void
): Promise<OpenConversationResult> {
  try {
    await editor.executeCommand(CLAUDE_OPEN_COMMAND, null, prompt);
  } catch (error) {
    log(`the V5 fallback failed too, the named failure above stands — ${describe(error)}`);
    throw cause;
  }

  log('V5 fallback ran: the conversation is open with the prompt PRE-FILLED, NOT submitted');
  return {
    ok: true,
    mode: 'fallback',
    sessionId: null,
    extHostPid,
    humanActionRequired: true,
    // Aucune session n'a ete amorcee : il n'y a pas de tour 1 a qualifier.
    firstTurn: 'not-attempted',
    firstTurnVerified: false,
    degradedFrom: cause.toJSON(),
  };
}

/**
 * Ouvre une conversation Claude interactive dans CETTE fenetre.
 *
 * @throws {ClaudeManagerError} toute defaillance prevue du mecanisme, avec son code stable.
 */
export async function openConversation(
  request: OpenConversationRequest,
  dependencies: OpenConversationDependencies
): Promise<OpenConversationResult> {
  const { editor, extHostPid, promptDirectory, log } = dependencies;
  const platform = dependencies.platform ?? process.platform;
  const environment = dependencies.environment ?? process.env;
  const wait = dependencies.wait ?? sleep;
  const readTable = dependencies.readProcessTable ?? readProcessTable;
  const transcriptRoots =
    dependencies.transcriptProjectRoots ?? transcriptProjectRoots(environment, homedir());

  // ---- Etape 0 : l'identifiant de session est CONFORME -----------------------------------
  // AVANT TOUT LE RESTE, parce que cette valeur va servir a deux choses qui ne pardonnent
  // pas : NOMMER UN FICHIER dans le repertoire de transit du prompt — un separateur de chemin
  // ecrirait le prompt en clair ailleurs — et S'ECRIRE DANS LA LIGNE POWERSHELL du terminal
  // d'amorcage. La fabrique est injectee : la garde n'est donc pas inatteignable, elle est
  // simplement satisfaite par `randomUUID()` en production (V2-5).
  const sessionId = (dependencies.newSessionId ?? randomUUID)();
  if (!SESSION_ID_SHAPE.test(sessionId)) {
    throw new ClaudeManagerError(
      ERROR_CODES.SEED_SESSION_ID_INVALID,
      'The session id to seed is not a uuid',
      // LA LONGUEUR, JAMAIS LA VALEUR : c'est precisement une valeur dont on ne sait pas d'ou
      // elle vient qui ne doit pas etre recopiee dans une sortie qui part vers un journal.
      { length: sessionId.length }
    );
  }

  // ---- Etape 1 : refus precoce ----------------------------------------------------------
  // AVANT TOUT LE RESTE, et sans repli : ce sont des etats de la FENETRE, pas des defaillances
  // de l'ecosysteme Claude. En Restricted Mode les commandes de l'extension Claude n'existent
  // meme pas — l'echec serait incomprehensible s'il se presentait plus loin (piege n.1).
  const workspace = editor.readWorkspace();
  if (!workspace.isTrusted) {
    throw new ClaudeManagerError(
      ERROR_CODES.WORKSPACE_NOT_TRUSTED,
      'This window is in Restricted Mode, no conversation can be opened here'
    );
  }
  const cwd = workspace.workspaceFolders[0];
  if (cwd === undefined) {
    throw new ClaudeManagerError(
      ERROR_CODES.WORKSPACE_FOLDER_MISSING,
      'This window has no workspace folder to run the first turn in'
    );
  }

  // ---- Etape 2 : disponibilite de la commande — LE POINT DE DECISION DU REPLI ------------
  //
  // Les trois defaillances ci-dessous SORTENT SANS REPLI, et ce n'est pas un oubli : le repli
  // V5 est `claude-vscode.editor.open` elle-meme. Extension absente, extension non activable,
  // commande disparue — dans les trois cas, il n'y a plus rien a appeler. C'est ce que dit la
  // derniere phrase de la decision : « Si `editor.open` est elle-meme absente, il n'y a plus
  // de repli : erreur nommee, et c'est tout. »
  //
  // Une fois cette etape franchie, le repli est DISPONIBLE — et il le restera jusqu'a la
  // creation du terminal, pas au-dela (voir `seeded` ci-dessous).
  const claudeExtension = await requireAttachCommand(editor, wait, log);

  let seeded = false;
  let terminal: HiddenTerminal | undefined;
  let promptFile: string | undefined;

  try {
    // ---- Etapes 3 a 5 : la ligne, et tout ce qu'il faut pour la construire ---------------
    //
    // `PATH` ou `Path` : Windows ne garantit pas la casse de ses variables d'environnement,
    // et `process.env` de Node la restitue telle que le processus l'a recue.
    const pathEntries = splitPathVariable(environment['PATH'] ?? environment['Path']);

    const claudeBinary = resolveExecutable({
      // Le bundle de l'extension D'ABORD : `claude` n'est pas sur le `PATH` de tous les
      // shells du poste de reference (constate), et le chemin du bundle porte la version —
      // il est derive de ce que l'editeur rend, jamais code en dur (D16).
      preferred: bundledClaudeCandidates(claudeExtension.extensionPath, platform),
      names: claudeBinaryNames(platform),
      pathEntries,
      exists: existsAsFile,
    });
    if (claudeBinary === undefined) {
      throw new ClaudeManagerError(
        ERROR_CODES.CLAUDE_BINARY_NOT_FOUND,
        'The claude binary was found neither in the extension bundle nor on PATH',
        // Le NOMBRE d'emplacements sondes, jamais leur chemin : ils portent le compte.
        { searchedPathEntries: pathEntries.length }
      );
    }

    // `pwsh`, et JAMAIS `shellPath` pointant directement sur `claude.exe` : c'est le shell qui
    // garde un canal ouvert vers le processus, donc qui rend franchissables les deux portes du
    // CLI. Aucun repli silencieux sur un autre shell : leurs regles de citation different, et
    // la forme L2 n'a ete mesuree que sous PowerShell.
    const shell = resolveExecutable({
      preferred: [],
      names: shellNames(platform),
      pathEntries,
      exists: existsAsFile,
    });
    if (shell === undefined) {
      throw new ClaudeManagerError(
        ERROR_CODES.SEED_SHELL_NOT_FOUND,
        'PowerShell 7 (pwsh) was not found on this window PATH',
        { searchedPathEntries: pathEntries.length }
      );
    }

    // GARDE DE PLAFOND — AVANT toute tentative, parce que le depassement est SILENCIEUX.
    // Elle pese la ligne du PROCESSUS FILS, pas celle envoyee au pty : c'est `CreateProcess`
    // qui plafonne (ADR-004).
    const budget = assertCommandLineFits({
      executable: claudeBinary,
      leadingArguments: seedLeadingArguments(sessionId),
      prompt: request.prompt,
    });
    log(
      `command line budget: prompt=${budget.promptLength} cost=${budget.promptCost} ` +
        `fixed=${budget.fixedCost} available=${budget.available} limit=${budget.limit}`
    );

    sweepAbandonedPrompts(promptDirectory, Date.now(), log);
    promptFile = writePromptFile(promptDirectory, sessionId, request.prompt);

    // ---- Etape 4 : le terminal masque ---------------------------------------------------
    // A PARTIR D'ICI, PLUS AUCUN REPLI. Un `claude` va exister : basculer en V5 ouvrirait une
    // SECONDE conversation pendant qu'une vraie session tourne. Le repli repare une
    // INDISPONIBILITE, jamais une latence.
    seeded = true;
    terminal = editor.createHiddenTerminal({
      name: `ClaudeManager seed ${sessionId}`,
      // LE `cwd` EST UN DOSSIER DE TRAVAIL DE CETTE FENETRE, et c'est ce qui rend le piege
      // n.3 impossible PAR CONSTRUCTION : `editor.open` n'attache la session que si son `cwd`
      // correspond au workspace de la fenetre — sinon il reussit en ouvrant un panneau VIDE.
      cwd,
      shellPath: shell,
      // `-NoProfile` FAIT PARTIE DU MECANISME : un profil PowerShell s'execute APRES la
      // neutralisation de l'environnement et peut la defaire. Voir `SEED_SHELL_ARGUMENTS`.
      shellArgs: SEED_SHELL_ARGUMENTS,
      env: neutralizedTerminalEnvironment(environment),
    });

    const before = editor.listPanelTabs();
    terminal.sendText(buildSeedCommandLine({ claudeBinary, sessionId, promptFile }));
    log(`seed line sent to a hidden terminal (session ${sessionId})`);

    // ---- Etape 5 bis : un processus a REELLEMENT ete engendre ----------------------------
    //
    // ELLE NE PORTE PLUS LA PREUVE DU TOUR — c'est l'etape 6 qui la porte — et elle est
    // CONSERVEE pour ce qu'elle discrimine, elle seule : « rien n'a demarre du tout » (le shell
    // n'a pas execute la ligne, le binaire a refuse) se distingue ici de « demarre, mais aucun
    // tour » (une porte du CLI attend, ou la sauvegarde du transcript a ete coupee). Deux causes,
    // deux remediations, deux erreurs nommees — et celle-ci tombe en ~12 s la ou l'attente du
    // transcript en accorde 45.
    await awaitSeedProcess(terminal, readTable, wait, log);

    // ---- Etape 6 : LE TOUR 1 A EU LIEU — le seul fait qui l'etablisse --------------------
    // AVANT l'attachement, et surtout avant le `dispose()` du `finally`, qui TUE le `claude`
    // du tour 1 (ADR-002). C'est tout le correctif du 2026-07-26.
    await awaitFirstTurn(transcriptRoots, sessionId, wait, log);

    // ---- Etape 7 : attachement, RELEVE par diff des onglets ------------------------------
    const panel = await attachPanel(editor, sessionId, before, wait, log);

    return {
      ok: true,
      mode: 'seeded',
      sessionId,
      extHostPid,
      humanActionRequired: false,
      firstTurn: 'transcript-observed',
      // VRAI, ET SUR UN FAIT CONSTATE : `<sessionId>.jsonl` existe. Voir le champ pour ce que
      // cette affirmation couvre exactement — et ce qu'elle ne couvre pas.
      firstTurnVerified: true,
      panelViewType: panel.viewType,
    };
  } catch (error) {
    if (!isClaudeManagerError(error)) throw error;

    // L'ERREUR NOMMEE EST EMISE D'ABORD, LE REPLI ENSUITE — l'ordre n'est pas negociable
    // (dette D18). Sans quoi l'appelant croirait le mecanisme nominal intact.
    log(`the nominal V1 path failed — ${describe(error)}`);

    // LE SEUL CRITERE DU REPLI, ET IL EST ICI : aucun `claude` n'a encore pu naitre. Une fois
    // le terminal cree, une vraie session tourne peut-etre — ouvrir un second panneau
    // pre-rempli serait pire que l'echec qu'on repare.
    if (seeded) {
      log('no V5 fallback: a claude session may already be running, a second panel would be worse');
      throw error;
    }
    return await runFallback(editor, request.prompt, error, extHostPid, log);
  } finally {
    // ---- Etape 7 : le terminal disparait SUR TOUS LES CHEMINS, succes comme echec --------
    //
    // ───────────────────────────────────────────────────────────────────────────────────────
    // AUCUNE DES DEUX OPERATIONS NE PEUT JETER, ET C'EST UN CORRECTIF (V2-2). Une exception
    // levee dans un `finally` REMPLACE la valeur de retour : une ouverture parfaitement
    // REUSSIE — tour 1 joue, panneau attache — ressortait alors en `500 UNEXPECTED_FAILURE`,
    // exactement le contraire de ce que C3-FIX venait de corriger. Et le cas n'est pas
    // theorique : `force: true` couvre `ENOENT`, le cas nominal, mais PAS `EPERM`/`EBUSY` —
    // un antivirus qui tient encore le handle, c'est-a-dire le scenario que la remediation de
    // `PROMPT_FILE_UNWRITABLE` cite deja.
    //
    // Les DEUX sont concernees, pas seulement la seconde : un jet de `dispose()` court-
    // circuiterait en plus le `rmSync`, laissant le prompt EN CLAIR sur le disque.
    //
    // C'est la discipline deja appliquee a `sweepAbandonedPrompts` — « ne leve JAMAIS » —, qui
    // n'avait pas ete reportee ici. Ce que le nettoyage n'a pas pu faire est JOURNALISE : une
    // hygiene silencieuse est une hygiene dont personne ne peut dire si elle a eu lieu.
    // ───────────────────────────────────────────────────────────────────────────────────────
    try {
      // Le `claude` du panneau survit, l'onglet reste intact (mesure, ADR-002).
      terminal?.dispose();
    } catch (error) {
      log(`could not dispose the seed terminal, it may linger hidden — ${describe(error)}`);
    }
    // FILET : la ligne efface le fichier elle-meme, avant meme que `claude` ne demarre. Ce
    // filet couvre le cas ou elle n'a jamais pu s'executer.
    if (promptFile !== undefined) {
      try {
        rmSync(promptFile, { force: true });
      } catch (error) {
        // Le prompt reste EN CLAIR sur le disque : le dire est le minimum, et le balayage des
        // prompts abandonnes — a l'ouverture suivante comme a la prochaine activation — le
        // reprendra passe son age.
        log(`could not remove the transient prompt file, it stays on disk — ${describe(error)}`);
      }
    }
  }
}

/**
 * SERIALISE LES OUVERTURES DE CETTE FENETRE — une a la fois, jamais deux de front.
 *
 * La preuve d'attachement est un DIFF D'ONGLETS. Deux ouvertures concurrentes releveraient
 * leur etat « avant » a des instants entrelaces : la seconde verrait apparaitre le panneau de
 * la premiere et le revendiquerait. Les deux routes rendraient un succes, l'une des deux avec
 * le panneau de l'autre — et l'appelant recevrait un `sessionId` qui ne designe pas ce qui
 * s'est ouvert.
 *
 * File d'un seul rang, exactement comme celle des transitions de publication. Une ouverture
 * qui echoue ne bloque pas les suivantes : le `catch` porte sur la CHAINE, pas sur la tache.
 */
export function serializeOpenings<T>(
  open: (request: T) => Promise<OpenConversationResult>
): (request: T) => Promise<OpenConversationResult> {
  let queue: Promise<unknown> = Promise.resolve();
  return (request: T): Promise<OpenConversationResult> => {
    const settled = queue.then(
      () => open(request),
      () => open(request)
    );
    queue = settled.catch(() => undefined);
    return settled;
  };
}

/**
 * Un candidat existe-t-il, ET est-ce un fichier ?
 *
 * `statSync` plutot qu'`existsSync` : un REPERTOIRE nomme `claude.exe` sur le `PATH` ferait
 * conclure a tort a la presence du binaire, et l'echec suivant n'aurait plus de nom.
 */
function existsAsFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
