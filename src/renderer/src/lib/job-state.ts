import type { JobSnapshot } from "../../../shared/backend";

export function isTerminalJobStatus(status: JobSnapshot["status"]): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

export function isActiveJob(job: JobSnapshot | null | undefined): boolean {
  return Boolean(job && !isTerminalJobStatus(job.status));
}
