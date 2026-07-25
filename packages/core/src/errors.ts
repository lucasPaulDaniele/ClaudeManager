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
 * dependent d'aucune API interne.
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
  /** La table des processus du systeme est illisible, ou vide — ce qui est impossible. */
  PROCESS_TABLE_UNAVAILABLE: 'PROCESS_TABLE_UNAVAILABLE',
  /** Le repertoire du registre des fenetres existe mais ne peut pas etre liste. */
  REGISTRY_UNREADABLE: 'REGISTRY_UNREADABLE',
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
  [ERROR_CODES.PROCESS_TABLE_UNAVAILABLE]:
    "L'inventaire des processus du systeme n'a pas pu etre lu. Sous Windows, verifier que `powershell.exe` est accessible et que la strategie d'execution ne bloque pas `-Command` ; ailleurs, que `ps` est installe (paquet procps). Sans cet inventaire, aucune fenetre ne peut etre identifiee.",
  [ERROR_CODES.REGISTRY_UNREADABLE]:
    "Le repertoire du registre des fenetres (~/.claudemanager/windows) existe mais n'a pas pu etre liste. Verifier qu'il s'agit bien d'un repertoire et que les droits de lecture sont accordes ; sans lui, aucune fenetre ne peut etre joignable.",
  [ERROR_CODES.REGISTRY_ENTRY_INVALID]:
    "L'entree de fenetre proposee ne respecte pas le schema du registre et n'a pas ete publiee. Une entree qu'on refuserait de relire ne doit jamais etre ecrite : consulter le motif dans les details.",
  [ERROR_CODES.WORKSPACE_NOT_TRUSTED]:
    "La fenetre cible est en Restricted Mode. Accorder la confiance au dossier dans VSCode ('Do you trust the authors of the files in this folder?').",
};

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
