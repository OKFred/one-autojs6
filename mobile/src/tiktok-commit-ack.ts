import type { TikTokConfig } from "./config.js";
import type { PreparedTikTokTask } from "./tiktok-policy.js";
import { waitForTikTokCommitReview } from "./tiktok-commit-review.js";

/**
 * Limit the local same-draft gate to explicitly hash-bound commercial publish jobs.
 * @param config Authoritative local configuration, never task input.
 * @param prepared Original device-ledger selection.
 * @returns Private wrapper/guard timeout, or zero for unchanged legacy behavior.
 */
export function tikTokCommitReviewTimeoutMs(config: TikTokConfig, prepared?: PreparedTikTokTask): number {
  const record = prepared?.publication;
  if (config.commitReview?.required !== true || prepared?.request.action !== "publish" ||
      !record?.media.expectedSha256 || !/^[a-f0-9]{64}$/.test(record.media.expectedSha256) ||
      record.media.fingerprint !== record.media.expectedSha256 ||
      record.postSettings?.audience !== "PUBLIC" || record.postSettings.commercialDisclosure !== "YOUR_BRAND") return 0;
  const seconds = config.commitReview.timeoutSeconds;
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 180) throw new Error("COMMIT_REVIEW_INVALID_CONTEXT");
  return seconds * 1000;
}

/** One task/draft can have exactly one private review wait and immutable binding. */
export class TikTokCommitAckGate {
  private binding?: string;
  private pending?: ReturnType<typeof waitForTikTokCommitReview>;

  /**
   * Reuse one pending one-use review, rejecting changed draft bindings or a cleaned-up task.
   * @param context Exact persisted COMMITTING checkpoint, selected hashes and frozen proof.
   * @param options Local private review options, including cancellation/current-task checks.
   * @param wait Injectable review boundary for isolated ACK regression tests.
   * @returns The consumed approval; callers must recheck the checkpoint before writing ACK.
   */
  async wait(
    context: Parameters<typeof waitForTikTokCommitReview>[0],
    options: Parameters<typeof waitForTikTokCommitReview>[1],
    wait: typeof waitForTikTokCommitReview = waitForTikTokCommitReview,
  ): Promise<Awaited<ReturnType<typeof waitForTikTokCommitReview>>> {
    const binding = JSON.stringify(context);
    if (this.binding !== undefined && this.binding !== binding) throw new Error("COMMIT_REVIEW_STALE");
    if (!this.pending) {
      this.binding = binding;
      this.pending = wait(context, options);
    }
    const approved = await this.pending;
    if (options.signal?.aborted || options.isCurrent?.() === false) throw new Error("COMMIT_REVIEW_CANCELLED");
    return approved;
  }
}
