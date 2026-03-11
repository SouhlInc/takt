import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createIsolatedEnv, updateIsolatedConfig, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('E2E: Checkpoint resume (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    // Override provider to 'mock' so Phase 3 judgment also uses mock
    updateIsolatedConfig(isolatedEnv.taktDir, { provider: 'mock' });
    repo = createLocalRepo();
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should create checkpoint on abort and resume from it', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-checkpoint-test.yaml');
    const abortScenarioPath = resolve(__dirname, '../fixtures/scenarios/checkpoint-abort.json');
    const resumeScenarioPath = resolve(__dirname, '../fixtures/scenarios/checkpoint-resume.json');

    // ── Phase 1: Run with abort scenario (step-3 triggers ABORT) ──
    const abortResult = runTakt({
      args: [
        '--pipeline',
        '--task', 'Checkpoint resume test',
        '--piece', piecePath,
        '--provider', 'mock',
        '--skip-checkout',
        '--skip-git',
        '-q',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: abortScenarioPath,
      },
      timeout: 60_000,
    });

    // Piece should have aborted (non-zero exit)
    expect(abortResult.exitCode).not.toBe(0);

    // ── Phase 2: Verify checkpoint.json exists ──
    const runsDir = join(repo.path, '.takt', 'runs');
    expect(existsSync(runsDir)).toBe(true);

    const runDirs = readdirSync(runsDir);
    expect(runDirs.length).toBeGreaterThanOrEqual(1);

    // Find the checkpoint
    let checkpointDir: string | undefined;
    let checkpoint: Record<string, unknown> | undefined;
    for (const dir of runDirs) {
      const cpPath = join(runsDir, dir, 'checkpoint.json');
      if (existsSync(cpPath)) {
        checkpointDir = dir;
        checkpoint = JSON.parse(readFileSync(cpPath, 'utf-8'));
        break;
      }
    }

    expect(checkpointDir).toBeDefined();
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.status).toBe('in_progress');
    // step-3 triggered ABORT, so checkpoint records step-3 as both completed and next
    // (the movement that executed and resulted in ABORT)
    expect(checkpoint!.completedMovement).toBe('step-3');
    expect(checkpoint!.nextMovement).toBe('step-3');
    expect(checkpoint!.iteration).toBeGreaterThanOrEqual(3);

    console.log('=== Checkpoint after abort ===');
    console.log(JSON.stringify(checkpoint, null, 2));

    // ── Phase 3: Resume from checkpoint ──
    const resumeResult = runTakt({
      args: [
        '--pipeline',
        '--task', 'Checkpoint resume test',
        '--piece', piecePath,
        '--provider', 'mock',
        '--skip-checkout',
        '--skip-git',
        '-q',
        '--resume',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: resumeScenarioPath,
      },
      timeout: 60_000,
    });

    console.log('=== Resume stdout ===');
    console.log(resumeResult.stdout.slice(-2000));
    if (resumeResult.stderr) {
      console.log('=== Resume stderr ===');
      console.log(resumeResult.stderr.slice(-1000));
    }

    // Resume should complete successfully
    expect(resumeResult.exitCode).toBe(0);

    // Verify checkpoint is now marked as completed
    const cpPath = join(runsDir, checkpointDir!, 'checkpoint.json');
    const finalCheckpoint = JSON.parse(readFileSync(cpPath, 'utf-8'));
    expect(finalCheckpoint.status).toBe('completed');

    console.log('=== Final checkpoint ===');
    console.log(JSON.stringify(finalCheckpoint, null, 2));
  }, 120_000);
});
