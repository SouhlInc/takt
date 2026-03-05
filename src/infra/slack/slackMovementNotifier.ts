const SLACK_BOT_TOKEN_ENV_KEY = 'TAKT_SLACK_BOT_TOKEN';

function getSlackBotToken(): string | undefined {
  return process.env[SLACK_BOT_TOKEN_ENV_KEY];
}

export interface SlackMovementNotifierOptions {
  botToken: string;
  channelId: string;
  threadTs: string;
  movementNames: string[];
  maxMovements: number;
}

export class SlackMovementNotifier {
  private readonly botToken: string;
  private readonly channelId: string;
  private readonly threadTs: string;
  private readonly movementNames: string[];
  private readonly maxMovements: number;
  private successCount = 0;
  private errorCount = 0;
  private readonly startTime: number = Date.now();
  private readonly movementStartTimes: Map<string, number> = new Map();

  constructor(options: SlackMovementNotifierOptions) {
    this.botToken = options.botToken;
    this.channelId = options.channelId;
    this.threadTs = options.threadTs;
    this.movementNames = options.movementNames;
    this.maxMovements = options.maxMovements;
  }

  notifyMovementStart(
    movementName: string,
    personaDisplayName: string,
    iteration: number,
    provider: string,
    model: string,
  ): void {
    this.movementStartTimes.set(movementName, Date.now());
    const stepIndex = this.getStepIndex(movementName);
    const totalSteps = this.movementNames.length;
    const text = `[${iteration}/${this.maxMovements}] (${stepIndex}/${totalSteps}) ${movementName} (${personaDisplayName}) 開始\nProvider: ${provider} | Model: ${model}`;
    this.post(text);
  }

  notifyMovementComplete(
    movementName: string,
    status: string,
    responseSummary?: string,
  ): void {
    const stepIndex = this.getStepIndex(movementName);
    const totalSteps = this.movementNames.length;
    const duration = this.getMovementDuration(movementName);
    const durationStr = duration !== undefined ? `\n実行時間: ${String(duration)}s` : '';

    if (status === 'error') {
      this.errorCount++;
      const summary = responseSummary ? `\n${responseSummary.slice(0, 200)}` : '';
      const text = `[${stepIndex}/${totalSteps}] ${movementName} エラー${summary}`;
      this.post(text);
      return;
    }

    this.successCount++;
    const summary = responseSummary ? `\n出力サマリー: ${responseSummary.slice(0, 200)}` : '';
    const text = `[${stepIndex}/${totalSteps}] ${movementName} 完了${durationStr}${summary}`;
    this.post(text);
  }

  notifyPieceComplete(totalIterations: number): void {
    const totalDuration = this.getTotalDuration();
    const text = `Piece 完了\n実行 movements: ${String(totalIterations)}\n成功: ${String(this.successCount)} / エラー: ${String(this.errorCount)}\n合計実行時間: ${String(totalDuration)}s`;
    this.post(text);
  }

  notifyPieceAbort(totalIterations: number, reason: string): void {
    const totalDuration = this.getTotalDuration();
    const truncatedReason = reason.slice(0, 200);
    const text = `Piece 中断: ${truncatedReason}\n実行 movements: ${String(totalIterations)}\n成功: ${String(this.successCount)} / エラー: ${String(this.errorCount)}\n合計実行時間: ${String(totalDuration)}s`;
    this.post(text);
  }

  private getStepIndex(movementName: string): number {
    const index = this.movementNames.indexOf(movementName);
    return index >= 0 ? index + 1 : 0;
  }

  private getMovementDuration(movementName: string): number | undefined {
    const startTime = this.movementStartTimes.get(movementName);
    if (startTime === undefined) return undefined;
    return Math.round((Date.now() - startTime) / 1000);
  }

  private getTotalDuration(): number {
    return Math.round((Date.now() - this.startTime) / 1000);
  }

  private post(text: string): void {
    fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: this.channelId,
        thread_ts: this.threadTs,
        text,
      }),
      signal: AbortSignal.timeout(5000),
    })
      .then(async (res) => {
        if (!res.ok) {
          process.stderr.write(`Slack movement notification failed: HTTP ${String(res.status)}\n`);
          return;
        }
        const body = await res.json() as { ok: boolean; error?: string };
        if (!body.ok) {
          process.stderr.write(`Slack movement notification failed: ${body.error}\n`);
        }
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Slack movement notification failed: ${detail}\n`);
      });
  }
}

export function createSlackMovementNotifier(
  channelId: string | undefined,
  threadTs: string | undefined,
  movementNames: string[],
  maxMovements: number,
): SlackMovementNotifier | null {
  if (!channelId && !threadTs) return null;

  if (!channelId || !threadTs) {
    process.stderr.write('Warning: --channel-id and --thread-ts must be specified together. Slack movement notifications disabled.\n');
    return null;
  }

  const botToken = getSlackBotToken();
  if (!botToken) {
    process.stderr.write('Warning: TAKT_SLACK_BOT_TOKEN not set. Slack movement notifications disabled.\n');
    return null;
  }

  return new SlackMovementNotifier({
    botToken,
    channelId,
    threadTs,
    movementNames,
    maxMovements,
  });
}
