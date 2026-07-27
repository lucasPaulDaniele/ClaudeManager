import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { INHERITED_ENVIRONMENT } from '../../integration/src/environment.js';
import {
  bundledClaudeCandidates,
  buildSeedCommandLine,
  claudeBinaryNames,
  CLAUDE_EXTENSION_ID,
  CLAUDE_OPEN_COMMAND,
  CLAUDE_PANEL_VIEW_TYPE,
  INHERITED_CLAUDE_ENVIRONMENT,
  isClaudePanel,
  neutralizedTerminalEnvironment,
  quotePowerShellLiteral,
  resolveExecutable,
  SEED_SHELL_ARGUMENTS,
  seedLeadingArguments,
  selectNewPanel,
  SESSION_ID_SHAPE,
  shellNames,
  splitPathVariable,
  type PanelTabLike,
} from '../../../packages/vscode/src/seed.js';

/** La capture REELLE de ce qu'une session Claude propage — jamais une liste fabriquee. */
const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'environment', 'claude-session-env-names.json'),
    'utf8'
  )
) as { readonly inheritedNames: readonly string[] };

const temporaries: string[] = [];

function makeTemporaryFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmgr-seed-'));
  temporaries.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, '', 'utf8');
  return file;
}

afterAll(() => {
  for (const dir of temporaries) fs.rmSync(dir, { recursive: true, force: true });
});

describe('carte d environnement du terminal masque', () => {
  it('couvre TOUTE la capture reelle d une session Claude', () => {
    // 21 noms captures le 2026-07-26 — dont deux qui n'existaient pas la veille. C'est
    // exactement pourquoi la regle est une FAMILLE et non une liste : une liste nommee les
    // aurait laisses passer sans que rien ne le signale.
    const neutralized = neutralizedTerminalEnvironment(
      Object.fromEntries(FIXTURE.inheritedNames.map((name) => [name, 'valeur']))
    );

    expect(Object.keys(neutralized).sort()).toEqual([...FIXTURE.inheritedNames].sort());
  });

  it('mappe chaque nom a `null` — JAMAIS `undefined` (mesure : `undefined` NE FAIT RIEN)', () => {
    // LE PIEGE. `TerminalOptions.env` est type `string | null | undefined` : ecrire
    // `undefined` COMPILE, passe le typecheck, se relit tres bien — et laisse la variable
    // INTACTE dans le terminal (mesure du 2026-07-26 : `CLAUDECODE` ressort `PRESENT=1`).
    // Une intention en commentaire n'aurait rien empeche ; ce test, si.
    const map = neutralizedTerminalEnvironment({ CLAUDECODE: '1', CLAUDE_PID: '42' });

    for (const [name, value] of Object.entries(map)) {
      expect(value, `${name} doit valoir null, pas undefined`).toBeNull();
      expect(value).not.toBeUndefined();
    }
    // Et la cle est bien PRESENTE : un objet sans la cle vaudrait `undefined` a la lecture.
    expect(Object.prototype.hasOwnProperty.call(map, 'CLAUDECODE')).toBe(true);
  });

  it('ne mappe JAMAIS a la chaine vide — mesure : `\'\'` laisse la variable PRESENTE', () => {
    // Seconde forme fautive : `env: { X: '' }` rend `PRESENT-ET-VIDE`. Or le CLI teste la
    // PRESENCE — l'assainissement serait sans effet tout en ayant l'air d'avoir eu lieu.
    const map = neutralizedTerminalEnvironment({ CLAUDECODE: '1', VSCODE_PID: '7' });

    expect(Object.values(map)).not.toContain('');
    expect(Object.values(map).every((value) => value === null)).toBe(true);
  });

  it('ne touche a RIEN d autre : le reste de l environnement passe intact', () => {
    const map = neutralizedTerminalEnvironment({
      CLAUDECODE: '1',
      PATH: 'c:\\windows',
      TERM_PROGRAM: 'vscode',
      HOME: 'c:\\users\\user',
    });

    expect(Object.keys(map)).toEqual(['CLAUDECODE']);
  });

  it('NE PEUT PAS atteindre `CLAUDE_CODE_SSE_PORT`, et c est dit plutot que tu', () => {
    // Elle est injectee par l'extension Claude via `EnvironmentVariableCollection`, donc
    // absente du `process.env` de l'extension host : aucune enumeration batie dessus ne peut
    // la voir. GARDEE DELIBEREMENT — elle designe CETTE fenetre, c'est le canal
    // d'integration IDE normal, et la supprimer couperait le terminal de sa propre fenetre.
    const map = neutralizedTerminalEnvironment({ CLAUDECODE: '1' });

    expect(Object.keys(map)).not.toContain('CLAUDE_CODE_SSE_PORT');
  });

  it('porte la MEME famille que le harnais d integration, sur la MEME fixture', () => {
    // Les deux assainissent a deux etages differents — le processus qui lance VSCode d'un
    // cote, le terminal masque de l'autre — pour la meme raison. Les laisser diverger ferait
    // qu'un jour l'un couvrirait ce que l'autre laisse passer.
    expect(INHERITED_CLAUDE_ENVIRONMENT.source).toBe(INHERITED_ENVIRONMENT.source);
    for (const name of FIXTURE.inheritedNames) {
      expect(INHERITED_CLAUDE_ENVIRONMENT.test(name)).toBe(INHERITED_ENVIRONMENT.test(name));
    }
  });
});

describe('citation PowerShell', () => {
  it('encadre d apostrophes — un litteral simple n interprete RIEN', () => {
    expect(quotePowerShellLiteral('c:\\tmp\\x.txt')).toBe("'c:\\tmp\\x.txt'");
    // `$`, backtick, `$(...)` : inertes dans un litteral simple.
    expect(quotePowerShellLiteral('$env:PATH $(Get-Date) `x`')).toBe("'$env:PATH $(Get-Date) `x`'");
  });

  it('DOUBLE l apostrophe — sans quoi le reste du chemin deviendrait du CODE', () => {
    // Un repertoire personnel peut porter une apostrophe : `C:\Users\O'Brien\...`.
    expect(quotePowerShellLiteral("c:\\Users\\O'Brien\\p.txt")).toBe("'c:\\Users\\O''Brien\\p.txt'");
  });
});

describe('la ligne envoyee au shell — forme L2', () => {
  const line = buildSeedCommandLine({
    claudeBinary: 'c:\\ext\\claude.exe',
    sessionId: 'abc-123',
    promptFile: 'c:\\tmp\\abc-123.prompt.txt',
  });

  it('lit le prompt en DONNEE : il ne traverse jamais l analyseur du shell', () => {
    expect(line).toContain("$p = [IO.File]::ReadAllText('c:\\tmp\\abc-123.prompt.txt')");
    // Le prompt lui-meme n'apparait NULLE PART dans la ligne — c'est tout l'objet de L2.
    expect(line).toContain("--session-id 'abc-123' $p");
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * LES TROIS INTERPOLATIONS SONT CITEES, ET LE `sessionId` NE L'ETAIT PAS (V2-5).
   *
   * Il n'y avait aucun chemin d'exploitation : la valeur vient de `randomUUID()`. Mais rien ne
   * l'imposait — ni type, ni assertion, ni test —, et la fabrique d'identifiants est injectee.
   * Une garde de forme est posee a la source ; la citation est la SECONDE, parce que deux
   * gardes independantes valent mieux qu'une quand l'autre tient a une regex.
   * ─────────────────────────────────────────────────────────────────────────────────────────
   */
  it('CITE le sessionId comme les deux autres interpolations — plus aucune exception', () => {
    const hostile = buildSeedCommandLine({
      claudeBinary: 'c:\\ext\\claude.exe',
      sessionId: "x'; & calc.exe; '",
      promptFile: 'c:\\tmp\\p.txt',
    });

    // La valeur reste une DONNEE : l'apostrophe est doublee, le litteral ne se referme pas.
    expect(hostile).toContain("--session-id 'x''; & calc.exe; ''' $p");
    // Et il n'existe aucune occurrence de `calc.exe` hors du litteral cite.
    expect(hostile).not.toContain('; & calc.exe; $p');
  });

  it('n accepte comme identifiant a amorcer que la forme d un uuid', () => {
    expect(SESSION_ID_SHAPE.test('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true);
    // La casse n'est pas un critere de surete : le CLI accepte les deux.
    expect(SESSION_ID_SHAPE.test('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(true);
    for (const refused of ["x'; & calc.exe; '", '../../evade', 'a/b', '', 'abc-123']) {
      expect(SESSION_ID_SHAPE.test(refused), refused).toBe(false);
    }
  });

  it('efface le fichier DANS LA MEME LIGNE, avant que claude ne demarre', () => {
    const removal = line.indexOf('Remove-Item');
    const start = line.indexOf('--session-id');
    expect(removal).toBeGreaterThan(-1);
    expect(removal).toBeLessThan(start);
    expect(line).toContain("-LiteralPath 'c:\\tmp\\abc-123.prompt.txt' -Force");
  });

  it('GARDE le lancement : un prompt vide ne demarre AUCUNE session', () => {
    // Une exception de `ReadAllText` termine la STATEMENT, pas la ligne. Sans cette garde,
    // `claude` demarrerait sans argument : session interactive SANS TOUR 1, panneau attache,
    // route en succes — une conversation vide rendue comme un succes.
    expect(line).toContain('if ($p) {');
  });

  it('appelle le binaire par `&` : un chemin cite serait sinon une simple donnee', () => {
    expect(line).toContain("& 'c:\\ext\\claude.exe'");
  });

  it('reste COURTE quelle que soit la taille du prompt — le plafond est ailleurs', () => {
    // Mesure : la ligne L2 pese 236 caracteres a 32 000 comme a 32 600, et les deux tailles
    // se comportent comme L1 (32 744 caracteres). Le plafond est `CreateProcess`, pas le pty.
    expect(line.length).toBeLessThan(400);
  });

  it('ne pese que les arguments du PROCESSUS FILS', () => {
    // C'est cette liste que la garde de plafond compte, pas la ligne ci-dessus.
    expect(seedLeadingArguments('abc-123')).toEqual(['--session-id', 'abc-123']);
  });
});

describe('resolution des executables', () => {
  it('prefere le bundle de l extension au PATH', () => {
    const bundled = makeTemporaryFile('claude.exe');
    const onPath = makeTemporaryFile('claude.exe');

    const found = resolveExecutable({
      preferred: [bundled],
      names: ['claude.exe'],
      pathEntries: [path.dirname(onPath)],
      exists: (candidate) => fs.existsSync(candidate),
    });

    expect(found).toBe(bundled);
  });

  it('retombe sur le PATH quand le bundle ne porte rien', () => {
    const onPath = makeTemporaryFile('pwsh.exe');

    expect(
      resolveExecutable({
        preferred: ['c:\\nulle-part\\pwsh.exe'],
        names: ['pwsh.exe'],
        pathEntries: ['c:\\vide', path.dirname(onPath)],
        exists: (candidate) => fs.existsSync(candidate),
      })
    ).toBe(onPath);
  });

  it('rend `undefined` plutot que de lever : l appelant sait quelle erreur nommee poser', () => {
    expect(
      resolveExecutable({
        preferred: [],
        names: ['introuvable.exe'],
        pathEntries: ['c:\\vide'],
        exists: () => false,
      })
    ).toBeUndefined();
  });

  it('ignore une entree VIDE de PATH — elle designerait le repertoire courant', () => {
    const probed: string[] = [];
    resolveExecutable({
      preferred: [],
      names: ['x.exe'],
      pathEntries: ['', 'c:\\a'],
      exists: (candidate) => {
        probed.push(candidate);
        return false;
      },
    });

    expect(probed).toEqual([path.join('c:\\a', 'x.exe')]);
  });

  it('decoupe le PATH selon la convention de la PLATEFORME, jamais un separateur code en dur', () => {
    /**
     * LES ENTREES NE PORTENT NI `:` NI `;`, ET C'EST LE FOND DE LA CORRECTION.
     *
     * La version precedente construisait l'entree avec `path.delimiter` — donc en suivant la
     * plateforme — mais codait des chemins de forme Windows dans l'ATTENDU. Sous Linux, ou le
     * delimiteur EST `:`, la chaine `c:\a:c:\b` se decoupe en QUATRE morceaux
     * (`c`, `\a`, `c`, `\b`) : le test se contredisait des qu'il changeait de plateforme, et
     * la CI publique — qui tourne sous Linux — le disait depuis la livraison initiale.
     *
     * Il eprouvait son CAS PARTICULIER, pas sa REGLE. La regle, elle, est la meme partout :
     * on decoupe selon la convention de la plateforme. Des entrees sans separateur d'aucune
     * des deux conventions la rendent verifiable des deux cotes.
     */
    expect(splitPathVariable(`dossier-a${path.delimiter}dossier-b`)).toEqual([
      'dossier-a',
      'dossier-b',
    ]);
    expect(splitPathVariable(undefined)).toEqual([]);
    expect(splitPathVariable('')).toEqual([]);
    // Les guillemets sont de la SYNTAXE de la variable, pas du chemin ; les espaces de bord
    // non plus.
    expect(splitPathVariable(`"avec espace"${path.delimiter}  autre  `)).toEqual([
      'avec espace',
      'autre',
    ]);
  });

  /**
   * Cas INTRINSEQUEMENT propre a Windows : une lettre de lecteur ne se decoupe correctement
   * que la ou le delimiteur est `;`. Il est GARDE parce que c'est la forme de PRODUCTION du
   * poste cible, et BORNE parce qu'il n'a aucun sens ailleurs — meme convention que les tests
   * POSIX deja ignores sous Windows.
   */
  const windowsOnly = process.platform === 'win32' ? it : it.skip;

  windowsOnly('decoupe un vrai PATH Windows, lettres de lecteur comprises', () => {
    expect(path.delimiter).toBe(';');
    expect(splitPathVariable('c:\\a;c:\\b')).toEqual(['c:\\a', 'c:\\b']);
    expect(splitPathVariable('"c:\\avec espace";c:\\b')).toEqual(['c:\\avec espace', 'c:\\b']);
  });

  it('cherche les noms de binaire propres a la plateforme', () => {
    expect(claudeBinaryNames('win32')).toEqual(['claude.exe', 'claude.cmd', 'claude']);
    expect(claudeBinaryNames('linux')).toEqual(['claude']);
    expect(shellNames('win32')).toEqual(['pwsh.exe']);
    expect(shellNames('darwin')).toEqual(['pwsh']);
  });

  it('lance ce shell SANS PROFIL — le profil defait la neutralisation de l environnement', () => {
    // V2-3, et c'est le piege majeur du chantier par une voie que rien ne surveillait : la
    // neutralisation a lieu A LA CREATION du terminal, le profil s'execute APRES. Un profil qui
    // pose `$env:CLAUDE_*` fait que le `claude` amorce se declare agent enfant non interactif
    // et coupe la sauvegarde de son transcript, silencieusement. Rien du profil n'est
    // necessaire : le binaire et le shell sont resolus en chemins ABSOLUS.
    expect(SEED_SHELL_ARGUMENTS).toContain('-NoProfile');
    expect(SEED_SHELL_ARGUMENTS).toContain('-NoLogo');
  });

  it('derive le chemin du bundle du repertoire RENDU par l editeur — jamais code en dur', () => {
    // Il porte le NUMERO DE VERSION et change a chaque mise a jour de l'extension (D16).
    const extensionPath = path.join('c:', 'ext', 'anthropic.claude-code-2.1.220-win32-x64');

    expect(bundledClaudeCandidates(extensionPath, 'win32')[0]).toBe(
      path.join(extensionPath, 'resources', 'native-binary', 'claude.exe')
    );
    expect(bundledClaudeCandidates(extensionPath, 'linux')).toEqual([
      path.join(extensionPath, 'resources', 'native-binary', 'claude'),
    ]);
  });
});

describe('reconnaissance et diff des onglets', () => {
  const claudeTab = (label: string): PanelTabLike => ({
    // MESURE au lot B : VSCode PREFIXE le viewType d'une webview.
    viewType: `mainThreadWebview-${CLAUDE_PANEL_VIEW_TYPE}`,
    label,
  });
  const otherTab = (label: string): PanelTabLike => ({ viewType: 'mainThreadWebview-autre', label });

  it('reconnait le panneau par « CONTIENT », jamais par egalite', () => {
    expect(isClaudePanel(claudeTab('x'))).toBe(true);
    // L'egalite ne reconnaitrait JAMAIS le panneau reel, qui est prefixe.
    expect(claudeTab('x').viewType).not.toBe(CLAUDE_PANEL_VIEW_TYPE);
    expect(isClaudePanel({ viewType: undefined, label: 'un fichier' })).toBe(false);
    expect(isClaudePanel(otherTab('x'))).toBe(false);
  });

  it('designe l onglet APPARU, meme au milieu d un panneau deja restaure', () => {
    // Une fenetre peut rouvrir automatiquement un panneau Claude a son lancement : le premier
    // trouve n'est donc pas forcement celui qu'on vient d'attacher.
    const before = [otherTab('code.ts'), claudeTab('conversation restauree')];
    const after = [...before, claudeTab('Reponds exactement OK')];

    expect(selectNewPanel(before, after)?.label).toBe('Reponds exactement OK');
  });

  it('ne declare RIEN de neuf quand rien n a bouge', () => {
    const before = [claudeTab('a'), otherTab('b')];

    expect(selectNewPanel(before, [...before])).toBeUndefined();
  });

  it('resiste a des libelles IDENTIQUES : c est un multi-ensemble, pas un ensemble', () => {
    const before = [claudeTab('meme titre')];

    expect(selectNewPanel(before, [claudeTab('meme titre')])).toBeUndefined();
    expect(selectNewPanel(before, [claudeTab('meme titre'), claudeTab('meme titre')])).toBeDefined();
  });

  it('ne depend PAS de l identite des objets — les releves sont reconstruits a chaque appel', () => {
    // L'adaptateur reconstruit ses enveloppes a chaque releve, et rien ne documente que
    // `tabGroups.all` rende les memes instances. Une comparaison d'identite declarerait
    // « nouveau » un onglet present depuis le debut.
    const before = [claudeTab('a')];
    const after = [claudeTab('a')];

    expect(before[0]).not.toBe(after[0]);
    expect(selectNewPanel(before, after)).toBeUndefined();
  });

  it('voit apparaitre un panneau alors qu un autre se ferme — le comptage seul le manquerait', () => {
    const before = [claudeTab('ancienne')];
    const after = [claudeTab('nouvelle')];

    expect(after.length).toBe(before.length);
    expect(selectNewPanel(before, after)?.label).toBe('nouvelle');
  });
});

describe('identifiants de l ecosysteme Claude', () => {
  it('nomme l extension et la commande tels que docs/compatibilite.md les recense', () => {
    expect(CLAUDE_EXTENSION_ID).toBe('anthropic.claude-code');
    expect(CLAUDE_OPEN_COMMAND).toBe('claude-vscode.editor.open');
    expect(CLAUDE_PANEL_VIEW_TYPE).toBe('claudeVSCodePanel');
  });
});
