import { resolveConfigValues } from '../../infra/config/index.js';
import { info, error, status, blankLine } from '../../shared/ui/index.js';
import { createLogger, getErrorMessage, getSlackWebhookUrl, sendSlackNotification, buildSlackRunSummary } from '../../shared/utils/index.js';
import type { SlackTaskDetail } from '../../shared/utils/index.js';
import { generateRunId } from '../tasks/execute/slackSummaryAdapter.js';
import type { PipelineExecutionOptions } from '../tasks/index.js';
import {
  EXIT_ISSUE_FETCH_FAILED,
  EXIT_PIECE_FAILED,
  EXIT_GIT_OPERATION_FAILED,
  EXIT_PR_CREATION_FAILED,
} from '../../shared/exitCodes.js';
import {
  resolveTaskContent,
  resolveExecutionContext,
  runPiece,
  commitAndPush,
  submitPullRequest,
  buildCommitMessage,
  type ExecutionContext,
} from './steps.js';
import { findLatestCheckpoint, loadCheckpoint, type Checkpoint } from '../../core/piece/engine/checkpoint.js';
import { buildRunPaths } from '../../core/piece/run/run-paths.js';

export type { PipelineExecutionOptions };

const log = createLogger('pipeline');

interface PipelineOutcome {
  exitCode: number;
  result: PipelineResult;
}

async function runPipeline(options: PipelineExecutionOptions): Promise<PipelineOutcome> {
  const { cwd, piece, autoPr, skipGit } = options;
  const pipelineConfig = resolveConfigValues(cwd, ['pipeline']).pipeline;

  const buildResult = (overrides: Partial<PipelineResult> = {}): PipelineResult => ({
    success: false, piece, issueNumber: options.issueNumber, ...overrides,
  });

  const taskContent = resolveTaskContent(options);
  if (!taskContent) return { exitCode: EXIT_ISSUE_FETCH_FAILED, result: buildResult() };

  let context: ExecutionContext;
  try {
    context = await resolveExecutionContext(
      cwd,
      taskContent.task,
      options,
      pipelineConfig,
      taskContent.prBranch,
      taskContent.prBaseBranch,
    );
  } catch (err) {
    error(`Failed to prepare execution environment: ${getErrorMessage(err)}`);
    return { exitCode: EXIT_GIT_OPERATION_FAILED, result: buildResult() };
  }

  // Resolve checkpoint for --resume
  let checkpoint: Checkpoint | undefined;
  if (options.resume) {
    if (typeof options.resume === 'string') {
      const runPaths = buildRunPaths(context.execCwd, options.resume);
      const loaded = loadCheckpoint(runPaths);
      if (loaded && loaded.status === 'in_progress') {
        checkpoint = loaded;
      } else {
        error(`No resumable checkpoint found in run directory: ${options.resume}`);
        return { exitCode: EXIT_PIECE_FAILED, result: buildResult({ branch: context.branch }) };
      }
    } else {
      // Don't filter by piece name: the CLI --piece value is a file path/identifier,
      // but checkpoint stores the YAML name field. They won't match.
      const found = findLatestCheckpoint(context.execCwd);
      if (found) {
        checkpoint = found.checkpoint;
      } else {
        error('No resumable checkpoint found. Running from the beginning.');
      }
    }
    if (checkpoint) {
      info(`Resuming from checkpoint: movement "${checkpoint.nextMovement}" (iteration ${checkpoint.iteration})`);
    }
  }

  log.info('Pipeline piece execution starting', { piece, branch: context.branch, skipGit, issueNumber: options.issueNumber, resume: !!checkpoint });
  const pieceOk = await runPiece(cwd, piece, taskContent.task, context.execCwd, {
    provider: options.provider,
    model: options.model,
    channelId: options.channelId,
    threadTs: options.threadTs,
    checkpoint,
  });
  if (!pieceOk) return { exitCode: EXIT_PIECE_FAILED, result: buildResult({ branch: context.branch }) };

  if (!skipGit && context.branch) {
    const commitMessage = buildCommitMessage(pipelineConfig, taskContent.issue, options.task);
    if (!commitAndPush(context.execCwd, cwd, context.branch, commitMessage, context.isWorktree)) {
      return { exitCode: EXIT_GIT_OPERATION_FAILED, result: buildResult({ branch: context.branch }) };
    }
  }

  let prUrl: string | undefined;
  if (autoPr && !skipGit && context.branch) {
    prUrl = submitPullRequest(cwd, context.branch, context.baseBranch, taskContent, piece, pipelineConfig, options);
    if (!prUrl) return { exitCode: EXIT_PR_CREATION_FAILED, result: buildResult({ branch: context.branch }) };
  } else if (autoPr && skipGit) {
    info('--auto-pr is ignored when --skip-git is specified (no push was performed)');
  }

  blankLine();
  status('Issue', taskContent.issue ? `#${taskContent.issue.number} "${taskContent.issue.title}"` : 'N/A');
  status('Branch', context.branch ?? '(current)');
  status('Piece', piece);
  status('Result', 'Success', 'green');

  return { exitCode: 0, result: buildResult({ success: true, branch: context.branch, prUrl }) };
}
export async function executePipeline(options: PipelineExecutionOptions): Promise<number> {
  const startTime = Date.now();
  const runId = generateRunId();
  let pipelineResult: PipelineResult = { success: false, piece: options.piece, issueNumber: options.issueNumber };

  try {
    const outcome = await runPipeline(options);
    pipelineResult = outcome.result;
    return outcome.exitCode;
  } finally {
    await notifySlack(runId, startTime, pipelineResult);
  }
}

interface PipelineResult {
  success: boolean;
  piece: string;
  issueNumber?: number;
  branch?: string;
  prUrl?: string;
}

async function notifySlack(runId: string, startTime: number, result: PipelineResult): Promise<void> {
  const webhookUrl = getSlackWebhookUrl();
  if (!webhookUrl) return;

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  const task: SlackTaskDetail = {
    name: 'pipeline',
    success: result.success,
    piece: result.piece,
    issueNumber: result.issueNumber,
    durationSec,
    branch: result.branch,
    prUrl: result.prUrl,
  };
  const message = buildSlackRunSummary({
    runId,
    total: 1,
    success: result.success ? 1 : 0,
    failed: result.success ? 0 : 1,
    durationSec,
    concurrency: 1,
    tasks: [task],
  });

  await sendSlackNotification(webhookUrl, message);
}
