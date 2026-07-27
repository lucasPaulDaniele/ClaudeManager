/**
 * Point d'entree unique du harnais d'integration — il s'execute DANS l'extension host d'un
 * vrai VSCode, et n'y fait qu'une chose : aiguiller vers le scenario demande.
 *
 * POURQUOI PLUSIEURS SCENARIOS PLUTOT QU'UNE SUITE. Ce qui reste a prouver au lot B se joue
 * a l'ETAT DE LA FENETRE, et l'etat d'une fenetre se fixe a son LANCEMENT : un workspace
 * multi-racine pour eprouver l'ajout d'un dossier sans redemarrer l'extension host, un
 * fichier de workspace SANS dossier pour eprouver le refus de publication. Aucune commande
 * ne fait passer une fenetre d'un etat a l'autre — il faut donc plusieurs lancements, et
 * `extensionTestsPath` n'en designe qu'un seul module. Ce module-ci est ce point d'entree ;
 * le scenario est choisi par l'environnement que le lanceur transmet.
 *
 * Le prefixe `CMGR_B3_` est conserve : il nomme le HARNAIS, pas l'increment qui l'a cree.
 * Le renommer orphelinerait les residus laisses sur le poste par les executions passees, que
 * `cleanup.ts` sait encore ramasser.
 */

import assert from 'node:assert/strict';
import { runCloseConversation } from './scenarios/closeConversation.js';
import { runEmptyWorkspace } from './scenarios/emptyWorkspace.js';
import { runNominal } from './scenarios/nominal.js';
import { runOpenConversation } from './scenarios/openConversation.js';
import type { ScenarioContext } from './support.js';

type Scenario = (context: ScenarioContext) => Promise<void>;

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  nominal: runNominal,
  'empty-workspace': runEmptyWorkspace,
  // Increment C1 : le seul scenario a EFFET DE BORD, et le seul lance avec l'extension
  // Claude chargee (`--disable-extensions` retire pour lui SEUL).
  'open-conversation': runOpenConversation,
  // Increment C4 : la fermeture. Il a un effet de bord sur des ONGLETS, mais il n'ouvre aucune
  // conversation et ne facture aucun tour — il cree ses propres onglets de webview, dont le
  // `viewType` CONTIENT le motif de reconnaissance. L'extension Claude n'y est donc pas requise.
  'close-conversation': runCloseConversation,
};

export async function run(): Promise<void> {
  const reportPath = process.env['CMGR_B3_REPORT'];
  const userDataDir = process.env['CMGR_B3_USER_DATA'];
  const repoRoot = process.env['CMGR_B3_REPO_ROOT'];
  const scratchDir = process.env['CMGR_B3_SCRATCH'];
  const name = process.env['CMGR_B3_SCENARIO'];
  assert.ok(reportPath, 'CMGR_B3_REPORT must be provided by the launcher');
  assert.ok(userDataDir, 'CMGR_B3_USER_DATA must be provided by the launcher');
  assert.ok(repoRoot, 'CMGR_B3_REPO_ROOT must be provided by the launcher');
  assert.ok(scratchDir, 'CMGR_B3_SCRATCH must be provided by the launcher');
  assert.ok(name, 'CMGR_B3_SCENARIO must be provided by the launcher');

  const scenario = SCENARIOS[name];
  // ECHOUER EXPLICITEMENT, jamais degrader en silence (principe fondateur n.3) : un scenario
  // inconnu qui se contenterait de ne rien faire produirait un run vert sans une assertion.
  assert.ok(scenario, `Unknown scenario "${name}"; known: ${Object.keys(SCENARIOS).join(', ')}`);

  await scenario({ reportPath, userDataDir, repoRoot, scratchDir });
}
