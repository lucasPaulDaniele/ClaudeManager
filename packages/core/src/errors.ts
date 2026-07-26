/**
 * Erreurs nommees de ClaudeManager.
 *
 * Principe fondateur n.3 : l'outil s'appuie sur des API internes non contractuelles.
 * Quand un presuppose tombe, il echoue avec un code stable et une remediation lisible,
 * il ne degrade JAMAIS en silence.
 *
 * Chaque code portant sur une API interne de l'ecosysteme Claude correspond a une ligne de
 * `docs/compatibilite.md`. Les codes portant sur une dependance au systeme d'exploitation
 * — `PROCESS_TABLE_UNAVAILABLE` pour l'inventaire des processus, `REGISTRY_UNREADABLE`,
 * `REGISTRY_ENTRY_INVALID` et `PROMPT_FILE_UNWRITABLE` pour le systeme de fichiers,
 * `SEED_SHELL_NOT_FOUND` pour le shell — n'y figurent pas : ils ne dependent d'aucune API
 * interne. Pas davantage ceux qui portent sur le format du registre lui-meme
 * (`DUPLICATE_WINDOW_IDENTITY`, `OWNING_WINDOW_NOT_FOUND`) : ce format est le notre, il
 * n'est emprunte a personne. `WORKSPACE_FOLDER_MISSING` et `WORKSPACE_NOT_TRUSTED` portent
 * sur l'etat de la FENETRE, que l'API `vscode` publique decrit — ils n'y figurent pas non plus.
 *
 * `PROMPT_TOO_LARGE`, lui, Y FIGURE (D19) bien qu'il enonce une limite du systeme
 * d'exploitation : ce qui le rend atteignable est le CONTRAT DU CLI — le prompt n'est
 * soumissible qu'en argument positionnel (D3). Le jour ou le CLI accepterait un prompt par
 * fichier, cette limite cesserait de s'appliquer sans que Windows ait change.
 *
 * LES CODES DU CLIENT — `WINDOW_UNREACHABLE`, `WINDOW_TOKEN_REJECTED`,
 * `WINDOW_IDENTITY_MISMATCH`, `WINDOW_RESPONSE_UNREADABLE`, `WINDOW_REQUEST_REFUSED` — N'Y
 * FIGURENT PAS NON PLUS, et c'est exactement le motif du registre : le protocole qu'ils jugent
 * est LE NOTRE — le serveur local de l'extension compagnon, arbitre a l'ADR-003 —, il n'est
 * emprunte a personne et aucune mise a jour de l'extension Claude ne peut le changer. Idem
 * pour `PROMPT_EMPTY` et `PROMPT_FILE_UNREADABLE`, qui portent sur ce que l'APPELANT fournit.
 */

export const ERROR_CODES = {
  /** L'extension Claude Code n'est pas installee dans cette fenetre. */
  CLAUDE_EXTENSION_MISSING: 'CLAUDE_EXTENSION_MISSING',
  /** L'extension Claude Code est installee mais son activation n'a pas abouti. */
  CLAUDE_EXTENSION_INACTIVE: 'CLAUDE_EXTENSION_INACTIVE',
  /** La commande `claude-vscode.editor.open` est absente de l'inventaire VSCode. */
  CLAUDE_COMMAND_MISSING: 'CLAUDE_COMMAND_MISSING',
  /** Aucun onglet ne porte le viewType attendu alors qu'une conversation etait attendue. */
  CLAUDE_PANEL_VIEWTYPE_UNKNOWN: 'CLAUDE_PANEL_VIEWTYPE_UNKNOWN',
  /** Le binaire `claude` n'a ete trouve ni dans le bundle de l'extension, ni sur le PATH. */
  CLAUDE_BINARY_NOT_FOUND: 'CLAUDE_BINARY_NOT_FOUND',
  /** Le shell qui doit porter le tour 1 (`pwsh`) est introuvable. */
  SEED_SHELL_NOT_FOUND: 'SEED_SHELL_NOT_FOUND',
  /** La ligne de commande portant le prompt depasserait le plafond du systeme. */
  PROMPT_TOO_LARGE: 'PROMPT_TOO_LARGE',
  /** Le fichier transitoire portant le prompt n'a pas pu etre ecrit. */
  PROMPT_FILE_UNWRITABLE: 'PROMPT_FILE_UNWRITABLE',
  /** Le shell du terminal masque n'a jamais engendre le processus `claude` du tour 1. */
  SEED_PROCESS_NOT_STARTED: 'SEED_PROCESS_NOT_STARTED',
  /** Le processus a demarre, mais aucun transcript n'a ete ecrit : le tour 1 n'a pas eu lieu. */
  SEED_TRANSCRIPT_NOT_FOUND: 'SEED_TRANSCRIPT_NOT_FOUND',
  /** La fenetre cible n'a aucun dossier de travail : rien ne peut y servir de `cwd`. */
  WORKSPACE_FOLDER_MISSING: 'WORKSPACE_FOLDER_MISSING',
  /** Le CLI n'a pas rendu la session demandee lors de l'amorcage headless. */
  SEED_SESSION_ID_MISMATCH: 'SEED_SESSION_ID_MISMATCH',
  /** Le transcript d'une session est introuvable ou illisible. */
  TRANSCRIPT_UNREADABLE: 'TRANSCRIPT_UNREADABLE',
  /** Aucune fenetre enregistree ne revendique le processus appelant. */
  OWNING_WINDOW_NOT_FOUND: 'OWNING_WINDOW_NOT_FOUND',
  /** Deux fenetres enregistrees revendiquent le meme extension host. */
  DUPLICATE_WINDOW_IDENTITY: 'DUPLICATE_WINDOW_IDENTITY',
  /** La table des processus du systeme est illisible, ou vide — ce qui est impossible. */
  PROCESS_TABLE_UNAVAILABLE: 'PROCESS_TABLE_UNAVAILABLE',
  /** Le repertoire du registre des fenetres existe mais ne peut pas etre liste. */
  REGISTRY_UNREADABLE: 'REGISTRY_UNREADABLE',
  /** L'entree d'une fenetre n'a pas pu etre ecrite dans le registre. */
  REGISTRY_UNWRITABLE: 'REGISTRY_UNWRITABLE',
  /** Tentative de publication d'une entree de registre qui ne passe pas la validation. */
  REGISTRY_ENTRY_INVALID: 'REGISTRY_ENTRY_INVALID',
  /** La fenetre cible est en Restricted Mode : les extensions y sont desactivees. */
  WORKSPACE_NOT_TRUSTED: 'WORKSPACE_NOT_TRUSTED',
  /** Le serveur local de la fenetre hote n'a pas repondu : connexion refusee, ou silence. */
  WINDOW_UNREACHABLE: 'WINDOW_UNREACHABLE',
  /** La fenetre hote a refuse le jeton porteur que son entree de registre annonce. */
  WINDOW_TOKEN_REJECTED: 'WINDOW_TOKEN_REJECTED',
  /** La fenetre qui a repondu n'est pas celle que l'entree de registre decrivait. */
  WINDOW_IDENTITY_MISMATCH: 'WINDOW_IDENTITY_MISMATCH',
  /** La reponse de la fenetre hote n'est pas du JSON, ou pas de la forme attendue. */
  WINDOW_RESPONSE_UNREADABLE: 'WINDOW_RESPONSE_UNREADABLE',
  /** La fenetre hote a NOMME son refus, et ce nom n'est pas une erreur du coeur. */
  WINDOW_REQUEST_REFUSED: 'WINDOW_REQUEST_REFUSED',
  /** Le prompt est vide : la conversation s'ouvrirait sans que rien ne soit soumis. */
  PROMPT_EMPTY: 'PROMPT_EMPTY',
  /** Le fichier de prompt designe par l'appelant n'a pas pu etre lu. */
  PROMPT_FILE_UNREADABLE: 'PROMPT_FILE_UNREADABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Cette chaine est-elle un code que NOUS connaissons ?
 *
 * Elle existe pour UN usage, et il est etroit : le serveur local d'une fenetre rend le CODE
 * STABLE de ses erreurs nommees dans le champ `error` de ses reponses de refus. Le client doit
 * pouvoir relever une erreur du coeur telle que la fenetre l'a formulee, plutot que de la
 * reduire a « la fenetre a refuse » — ce qui reviendrait a perdre en chemin la remediation que
 * le coeur avait deja ecrite.
 *
 * Le predicat est ce qui empeche d'en faire un blanc-seing : une chaine venue du reseau ne
 * devient une erreur nommee QUE si elle designe un code existant. Tout le reste ressort en
 * `WINDOW_REQUEST_REFUSED`, sans jamais etre recopie tel quel dans un message.
 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, value);
}

/** Remediation affichee a l'utilisateur pour chaque code. */
const REMEDIATIONS: Readonly<Record<ErrorCode, string>> = {
  [ERROR_CODES.CLAUDE_EXTENSION_MISSING]:
    "L'extension Claude Code (anthropic.claude-code) n'est pas installee dans cette fenetre. L'installer, puis rouvrir la fenetre. Sans elle, aucune conversation ne peut etre ouverte, pas meme en mode degrade.",
  [ERROR_CODES.CLAUDE_EXTENSION_INACTIVE]:
    "L'extension Claude Code est installee mais n'a pas pu etre activee dans cette fenetre. Verifier que le dossier est approuve (Workspace Trust) et consulter le journal de l'extension ; ses commandes sont enregistrees a l'activation, elles n'existent pas avant.",
  [ERROR_CODES.CLAUDE_COMMAND_MISSING]:
    "L'extension Claude Code est active mais n'expose plus la commande claude-vscode.editor.open. Cette commande n'est pas contractuelle : consulter docs/compatibilite.md (D1). Aucun repli n'est possible, le repli lui-meme passe par cette commande.",
  [ERROR_CODES.CLAUDE_PANEL_VIEWTYPE_UNKNOWN]:
    "Aucun onglet de conversation Claude n'a ete reconnu. Trois causes possibles, dans cet ordre de vraisemblance : le CLI attend derriere une de ses deux portes (onboarding, ou 'Quick safety check' du dossier — les verifier avec cmgr doctor), la session n'a pas demarre, ou la version installee de l'extension a change son viewType (docs/compatibilite.md, D2).",
  [ERROR_CODES.CLAUDE_BINARY_NOT_FOUND]:
    "Le binaire claude est introuvable : ni sous resources/native-binary du repertoire de l'extension Claude Code, ni sur le PATH de cette fenetre. Verifier l'installation de l'extension ; ne jamais coder son chemin en dur, il porte le numero de version (docs/compatibilite.md, D16).",
  [ERROR_CODES.SEED_SHELL_NOT_FOUND]:
    "PowerShell 7 (pwsh) est introuvable sur le PATH de cette fenetre. Le tour 1 est joue dans un shell, jamais en lancant claude.exe directement : c'est le shell qui garde un canal ouvert vers le processus. Installer PowerShell 7, ou signaler le besoin d'un autre shell — sa forme de citation devra etre mesuree avant d'etre employee.",
  [ERROR_CODES.PROMPT_TOO_LARGE]:
    "Le prompt depasse ce que la ligne de commande du systeme peut porter (~32 767 unites UTF-16 sous Windows, prompt cite et executable compris). Raccourcir le prompt, ou le decouper en plusieurs tours. Le detail porte la taille mesuree et le plafond.",
  [ERROR_CODES.PROMPT_FILE_UNWRITABLE]:
    "Le fichier transitoire portant le prompt n'a pas pu etre ecrit dans le repertoire de stockage de l'extension. Verifier les droits d'ecriture de ce repertoire et qu'aucun antivirus ne le verrouille.",
  [ERROR_CODES.SEED_PROCESS_NOT_STARTED]:
    "Le shell du terminal masque n'a engendre aucun processus : le tour 1 n'a pas demarre. Causes connues, dans cet ordre : une des deux portes du CLI attend une reponse (onboarding, ou 'Quick safety check' du dossier — les verifier avec cmgr doctor), le binaire claude a refuse de demarrer, ou le shell n'a pas execute la ligne.",
  [ERROR_CODES.SEED_TRANSCRIPT_NOT_FOUND]:
    "Le processus du tour 1 a demarre, mais aucun transcript <sessionId>.jsonl n'est apparu sous les racines de projets du CLI : le tour n'a PAS eu lieu, et le terminal a ete supprime. Trois causes, dans cet ordre de vraisemblance, toutes SILENCIEUSES cote CLI : (1) une porte du CLI attend une reponse dans ce repertoire — la confiance du dossier ('Quick safety check') se pose PAR REPERTOIRE et n'a jamais ete accordee pour celui-ci, cas MESURE le 2026-07-26 sur un dossier neuf ; (2) le CLI s'est cru agent enfant non interactif et a coupe la sauvegarde du transcript (contamination de l'environnement, voir docs/compatibilite.md) ; (3) la racine de configuration du CLI a change (CLAUDE_CONFIG_DIR, D17). Verifier avec cmgr doctor, qui doit NOMMER ces portes — jamais les franchir.",
  [ERROR_CODES.WORKSPACE_FOLDER_MISSING]:
    "La fenetre cible n'a aucun dossier de travail. Le tour 1 est joue dans le workspace de la fenetre — c'est ce qui garantit que le panneau attache bien la session ouverte. Ouvrir un dossier dans cette fenetre.",
  [ERROR_CODES.SEED_SESSION_ID_MISMATCH]:
    "Le CLI claude n'a pas honore l'identifiant de session demande. Verifier la version du binaire avec `cmgr doctor`.",
  [ERROR_CODES.TRANSCRIPT_UNREADABLE]:
    'Le transcript de la session est introuvable ou illisible. La conversation existe peut-etre sans avoir encore produit de tour.',
  [ERROR_CODES.OWNING_WINDOW_NOT_FOUND]:
    "Aucune fenetre VSCode enregistree ne revendique ce processus. Verifier que l'extension compagnon ClaudeManager est installee et active dans la fenetre appelante.",
  [ERROR_CODES.DUPLICATE_WINDOW_IDENTITY]:
    "Deux fenetres enregistrees revendiquent le meme extension host. Le registre nomme ses fichiers d'apres le pid, ce cas ne peut donc venir que d'une entree dupliquee ou forgee : inspecter ~/.claudemanager/windows et retirer celle qui n'a pas ete ecrite par une fenetre VSCode.",
  [ERROR_CODES.PROCESS_TABLE_UNAVAILABLE]:
    "L'inventaire des processus du systeme n'a pas pu etre lu. Sous Windows, verifier que `powershell.exe` est accessible et que la strategie d'execution ne bloque pas `-Command` ; ailleurs, que `ps` est installe (paquet procps). Sans cet inventaire, aucune fenetre ne peut etre identifiee.",
  [ERROR_CODES.REGISTRY_UNREADABLE]:
    "Le repertoire du registre des fenetres (~/.claudemanager/windows) existe mais n'a pas pu etre liste. Verifier qu'il s'agit bien d'un repertoire et que les droits de lecture sont accordes ; sans lui, aucune fenetre ne peut etre joignable.",
  [ERROR_CODES.REGISTRY_UNWRITABLE]:
    "L'entree de cette fenetre n'a pas pu etre ecrite dans le registre (~/.claudemanager/windows). Verifier que le chemin est bien un repertoire et non un fichier, que les droits d'ecriture sont accordes, et qu'aucun antivirus ni indexeur ne verrouille le repertoire ; sans cette entree, la fenetre n'est joignable par personne.",
  [ERROR_CODES.REGISTRY_ENTRY_INVALID]:
    "L'entree de fenetre proposee ne respecte pas le schema du registre et n'a pas ete publiee. Une entree qu'on refuserait de relire ne doit jamais etre ecrite : consulter le motif dans les details.",
  [ERROR_CODES.WORKSPACE_NOT_TRUSTED]:
    "La fenetre cible est en Restricted Mode. Accorder la confiance au dossier dans VSCode ('Do you trust the authors of the files in this folder?').",
  [ERROR_CODES.WINDOW_UNREACHABLE]:
    "La fenetre hote est enregistree mais son serveur local n'a pas repondu sur le port de son entree. Trois causes connues, dans cet ordre : son ecoute est morte et l'entree n'a pas encore ete republiee, la fenetre a ete rechargee, ou le port ephemere a ete repris par un autre processus local. Relancer la commande : le port et le jeton sont relus dans le registre a chaque appel, jamais mis en cache.",
  [ERROR_CODES.WINDOW_TOKEN_REJECTED]:
    "La fenetre hote a refuse le jeton porteur que son entree de registre annonce. L'entree est donc perimee ou substituee — le port ephemere a probablement ete repris par un autre processus local. NE PAS REESSAYER EN BOUCLE : chaque tentative presente le jeton a ce qui occupe le port. Inspecter ~/.claudemanager/windows, et recharger la fenetre pour qu'elle republie.",
  [ERROR_CODES.WINDOW_IDENTITY_MISMATCH]:
    "La fenetre qui a repondu n'est pas celle que le registre decrivait : son extension host n'est pas celui de l'entree lue. L'entree a ete substituee entre sa lecture et cet appel, ou le port a ete repris par une autre fenetre. AUCUNE DEMANDE N'A ETE EMISE — c'est ce que la confirmation de canal existe pour empecher. Relancer la commande, puis inspecter le registre si le desaccord persiste.",
  [ERROR_CODES.WINDOW_RESPONSE_UNREADABLE]:
    "La fenetre hote a repondu, mais sa reponse n'est pas de la forme attendue. La version de l'extension compagnon installee dans cette fenetre ne parle probablement pas le meme protocole que cette CLI : comparer son extensionVersion avec `cmgr windows`, puis recharger la fenetre apres mise a jour. Les details portent la route et ce qui manquait.",
  [ERROR_CODES.WINDOW_REQUEST_REFUSED]:
    "La fenetre hote a refuse la demande et a NOMME son refus ; le code exact figure dans les details. FORBIDDEN_HOST ou FORBIDDEN_ORIGIN signale qu'un intermediaire s'est interpose sur la boucle locale — aucun client de ClaudeManager ne produit ces refus. NOT_FOUND signale une extension compagnon trop ancienne pour cette route.",
  [ERROR_CODES.PROMPT_EMPTY]:
    "Le prompt est vide, ou ne porte que des blancs. Ouvrir une conversation sans prompt reviendrait a ouvrir un panneau pour rien : la demande est refusee AVANT toute ouverture. Verifier le fichier passe a --prompt-file, ou ce qui a ete ecrit sur stdin.",
  [ERROR_CODES.PROMPT_FILE_UNREADABLE]:
    "Le fichier de prompt n'a pas pu etre lu. Verifier que le chemin existe, qu'il designe un fichier et non un repertoire, et que les droits de lecture sont accordes. Le detail porte le seul code systeme : le message porterait le chemin, donc le nom du compte.",
};

/**
 * Reduit une defaillance systeme a son CODE, et jette le texte libre.
 *
 * Les `details` d'une erreur nommee partent vers un agent ET vers un journal persiste,
 * lui-meme joint en preuve a des PR d'un depot PUBLIC. Or les erreurs `fs` de Node
 * embarquent systematiquement le chemin — donc le nom de compte et l'arborescence
 * personnelle : `EPERM: operation not permitted, rename 'C:\\Users\\<compte>\\...'`. Et le
 * message d'un `execFile` en echec recopie le stderr du processus, que rien ne contraint.
 *
 * Le code seul — `EPERM`, `ENOENT`, un statut de sortie, un signal — suffit au diagnostic
 * et ne porte rien de personnel. C'est la meme discipline que `listEntryFiles`, qui sonde
 * l'existence plutot que d'interpreter un message systeme.
 */
export function systemErrorCode(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const { code, signal } = cause as { readonly code?: unknown; readonly signal?: unknown };
    // `fs` et un `execFile` introuvable rendent un code textuel ; un processus qui sort en
    // erreur rend son statut ; un processus tue rend son signal.
    if (typeof code === 'string' && code.length > 0) return code;
    if (typeof code === 'number') return `EXIT_${code}`;
    if (typeof signal === 'string' && signal.length > 0) return signal;
  }
  // Tout le reste — une chaine levee, un objet sans code — n'est pas dit, faute de pouvoir
  // garantir ce qu'il contient.
  return 'UNKNOWN';
}

/** Forme serialisable d'une erreur, rendue telle quelle par la CLI et le serveur MCP. */
export interface SerializedError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly remediation: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Erreur portant un code stable. Ne jamais lever d'erreur nue depuis le coeur :
 * l'appelant est un agent, il a besoin d'un code, pas d'une chaine libre.
 */
export class ClaudeManagerError extends Error {
  readonly code: ErrorCode;
  readonly remediation: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'ClaudeManagerError';
    this.code = code;
    this.remediation = REMEDIATIONS[code];
    this.details = details;
  }

  toJSON(): SerializedError {
    return this.details === undefined
      ? { code: this.code, message: this.message, remediation: this.remediation }
      : { code: this.code, message: this.message, remediation: this.remediation, details: this.details };
  }
}

/** Predicat de reconnaissance, sur du duck typing pour survivre aux frontieres de modules. */
export function isClaudeManagerError(value: unknown): value is ClaudeManagerError {
  return value instanceof ClaudeManagerError;
}
