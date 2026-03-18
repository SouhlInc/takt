/**
 * Upload text content as a file to a Slack thread.
 *
 * Uses the newer files.getUploadURLExternal + files.completeUploadExternal flow.
 * Never throws: errors are written to stderr and the function returns false.
 */

const UPLOAD_TIMEOUT_MS = 30_000;

export interface SlackFileUploadOptions {
  botToken: string;
  channelId: string;
  threadTs: string;
  content: string;
  filename: string;
  title?: string;
  initialComment?: string;
}

export async function uploadFileToSlack(options: SlackFileUploadOptions): Promise<boolean> {
  try {
    const contentBytes = Buffer.from(options.content, 'utf-8');

    // Step 1: Get a presigned upload URL
    const urlResponse = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        filename: options.filename,
        length: String(contentBytes.length),
      }),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    if (!urlResponse.ok) {
      process.stderr.write(`Slack file upload: getUploadURL HTTP ${String(urlResponse.status)}\n`);
      return false;
    }

    const urlBody = (await urlResponse.json()) as {
      ok: boolean;
      upload_url?: string;
      file_id?: string;
      error?: string;
    };
    if (!urlBody.ok || !urlBody.upload_url || !urlBody.file_id) {
      process.stderr.write(
        `Slack file upload: getUploadURL failed: ${urlBody.error ?? 'unknown'}\n`,
      );
      return false;
    }

    // Step 2: Upload file content to the presigned URL
    const uploadResponse = await fetch(urlBody.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: contentBytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    if (!uploadResponse.ok) {
      process.stderr.write(`Slack file upload: upload HTTP ${String(uploadResponse.status)}\n`);
      return false;
    }

    // Step 3: Finalize the upload and share to the thread
    const completePayload: Record<string, unknown> = {
      files: [{ id: urlBody.file_id, title: options.title ?? options.filename }],
      channel_id: options.channelId,
      thread_ts: options.threadTs,
    };
    if (options.initialComment) {
      completePayload.initial_comment = options.initialComment;
    }

    const completeResponse = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(completePayload),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    if (!completeResponse.ok) {
      process.stderr.write(
        `Slack file upload: completeUpload HTTP ${String(completeResponse.status)}\n`,
      );
      return false;
    }

    const completeBody = (await completeResponse.json()) as { ok: boolean; error?: string };
    if (!completeBody.ok) {
      process.stderr.write(
        `Slack file upload: completeUpload failed: ${completeBody.error ?? 'unknown'}\n`,
      );
      return false;
    }

    return true;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Slack file upload error: ${detail}\n`);
    return false;
  }
}
