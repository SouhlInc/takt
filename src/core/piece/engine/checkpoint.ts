/**
 * Checkpoint persistence for piece execution.
 *
 * Saves and loads execution state so that interrupted runs
 * can be resumed from the last completed movement.
 */

import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PieceState } from '../../models/types.js';
import type { RunPaths } from '../run/run-paths.js';
import { createLogger } from '../../../shared/utils/index.js';

const log = createLogger('checkpoint');

const CHECKPOINT_FILE = 'checkpoint.json';
const MAX_LAST_OUTPUT_LENGTH = 5000;

/** Persisted checkpoint data */
export interface Checkpoint {
  /** Piece name */
  pieceName: string;
  /** Movement that was last completed */
  completedMovement: string;
  /** Next movement to execute on resume */
  nextMovement: string;
  /** Total iteration count at checkpoint */
  iteration: number;
  /** Per-movement iteration counts */
  movementIterations: Record<string, number>;
  /** Accumulated user inputs */
  userInputs: string[];
  /** Persona session IDs */
  personaSessions: Record<string, string>;
  /** Truncated last output content (for passPreviousResponse) */
  lastOutputContent?: string;
  /** Task content */
  task: string;
  /** Run directory name (slug) */
  reportDirName: string;
  /** Timestamp of checkpoint creation */
  timestamp: string;
  /** Status: 'in_progress' while running, 'completed' when piece finishes */
  status: 'in_progress' | 'completed';
}

/**
 * Save a checkpoint after a movement completes.
 */
export function saveCheckpoint(
  runPaths: RunPaths,
  state: PieceState,
  completedMovement: string,
  nextMovement: string,
  task: string,
): void {
  const checkpoint: Checkpoint = {
    pieceName: state.pieceName,
    completedMovement,
    nextMovement,
    iteration: state.iteration,
    movementIterations: Object.fromEntries(state.movementIterations),
    userInputs: [...state.userInputs],
    personaSessions: Object.fromEntries(state.personaSessions),
    lastOutputContent: state.lastOutput?.content?.slice(0, MAX_LAST_OUTPUT_LENGTH),
    task,
    reportDirName: runPaths.slug,
    timestamp: new Date().toISOString(),
    status: 'in_progress',
  };

  const path = join(runPaths.runRootAbs, CHECKPOINT_FILE);
  try {
    writeFileSync(path, JSON.stringify(checkpoint, null, 2), 'utf-8');
    log.debug('Checkpoint saved', { completedMovement, nextMovement, iteration: state.iteration });
  } catch (err) {
    log.error('Failed to save checkpoint', { error: err });
  }
}

/**
 * Mark a checkpoint as completed (piece finished successfully).
 */
export function markCheckpointCompleted(runPaths: RunPaths): void {
  const path = join(runPaths.runRootAbs, CHECKPOINT_FILE);
  if (!existsSync(path)) return;

  try {
    const checkpoint: Checkpoint = JSON.parse(readFileSync(path, 'utf-8'));
    checkpoint.status = 'completed';
    checkpoint.timestamp = new Date().toISOString();
    writeFileSync(path, JSON.stringify(checkpoint, null, 2), 'utf-8');
    log.debug('Checkpoint marked as completed');
  } catch (err) {
    log.error('Failed to mark checkpoint completed', { error: err });
  }
}

/**
 * Load a checkpoint from a specific run directory.
 */
export function loadCheckpoint(runPaths: RunPaths): Checkpoint | null {
  const path = join(runPaths.runRootAbs, CHECKPOINT_FILE);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    log.error('Failed to load checkpoint', { error: err });
    return null;
  }
}

/**
 * Find the latest resumable checkpoint in .takt/runs/.
 * Only returns checkpoints with status 'in_progress'.
 */
export function findLatestCheckpoint(
  cwd: string,
  pieceName?: string,
): { runDir: string; checkpoint: Checkpoint } | null {
  const runsDir = join(cwd, '.takt', 'runs');
  if (!existsSync(runsDir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(runsDir);
  } catch {
    return null;
  }

  // Collect candidates with their modification times
  const candidates: Array<{ dir: string; checkpoint: Checkpoint; mtime: number }> = [];

  for (const dir of entries) {
    const checkpointPath = join(runsDir, dir, CHECKPOINT_FILE);
    if (!existsSync(checkpointPath)) continue;

    try {
      const checkpoint: Checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf-8'));
      if (checkpoint.status !== 'in_progress') continue;
      if (pieceName && checkpoint.pieceName !== pieceName) continue;

      const mtime = statSync(checkpointPath).mtimeMs;
      candidates.push({ dir, checkpoint, mtime });
    } catch {
      continue;
    }
  }

  if (candidates.length === 0) return null;

  // Return the most recently modified
  candidates.sort((a, b) => b.mtime - a.mtime);
  const latest = candidates[0]!;
  return { runDir: latest.dir, checkpoint: latest.checkpoint };
}
