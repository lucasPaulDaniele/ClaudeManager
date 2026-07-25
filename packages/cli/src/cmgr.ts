#!/usr/bin/env node
/**
 * Point d'entree du binaire `cmgr`.
 *
 * TROIS LIGNES, et c'est delibere : tout ce qui pouvait etre extrait l'a ete dans `run.ts`,
 * qui est mesure et couvert. Ce fichier ne porte plus une seule decision — il passe le vrai
 * `process` et laisse `runProcess` faire, y compris poser le code de sortie.
 *
 * `runProcess` ne leve jamais : `runCli` est totale, et cette garantie est ce qui evite une
 * trace de pile la ou l'appelant attend du JSON.
 */
import { runProcess } from './run.js';

await runProcess(process);
