/**
 * Erreurs nommees de ClaudeManager.
 *
 * Principe fondateur n.3 : l'outil s'appuie sur des API internes non contractuelles.
 * Quand un presuppose tombe, il echoue avec un code stable et une remediation lisible,
 * il ne degrade JAMAIS en silence.
 *
 * Chaque code portant sur une API interne de l'ecosysteme Claude correspond a une ligne de
 * `docs/compatibilite.md`. Les codes portant sur une dependance au systeme d'exploitation
 * — `PROCESS_TABLE_UNAVAILABLE` pour l'inventaire des processus, `REGISTRY_UNREADABLE` et
 * `REGISTRY_ENTRY_INVALID` pour le systeme de fichiers — n'y figurent pas : ils ne
 * dependent d'aucune API interne. Pas davantage ceux qui portent sur le format du registre
 * lui-meme (`DUPLICATE_WINDOW_IDENTITY`, `OWNING_WINDOW_NOT_FOUND`) : ce format est le
 * notre, il n'est emprunte a personne.
 */

export const ERROR_CODES = {
  /** La commande `claude-vscode.editor.open` est absente de l'inventaire VSCode. */
  CLAUDE_COMMAND_MISSING: 'CLAUDE_COMMAND_MISSING',
  /** Aucun onglet ne porte le viewType attendu alors qu'une conversation etait attendue. */
  CLAUDE_PANEL_VIEWTYPE_UNKNOWN: 'CLAUDE_PANEL_VIEWTYPE_UNKNOWN',
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
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Remediation affichee a l'utilisateur pour chaque code. */
const REMEDIATIONS: Readonly<Record<ErrorCode, string>> = {
  [ERROR_CODES.CLAUDE_COMMAND_MISSING]:
    "L'extension Claude Code n'est pas active dans cette fenetre. Verifier qu'elle est installee, puis que le dossier est approuve (Workspace Trust) : en Restricted Mode ses commandes n'existent pas.",
  [ERROR_CODES.CLAUDE_PANEL_VIEWTYPE_UNKNOWN]:
    "Aucun onglet de conversation Claude n'a ete reconnu. La version installee de l'extension a peut-etre change son viewType : consulter docs/compatibilite.md.",
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
