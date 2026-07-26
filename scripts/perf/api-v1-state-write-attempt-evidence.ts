import { Reservator } from '@shared/queuebox/DequeueController.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from
  '@shared/queuebox/ResourceInboxAttemptTelemetry.ts';

type AppInboxEvidence = Readonly<{
  commandId: string;
  operationId: string;
  resourceId: string;
  topicId: string;
}>;

type RawCommand = Readonly<{
  commandId: string;
  status: 'accepted' | 'exhausted';
}>;

export type AppInboxAttemptObservation = Readonly<{
  commandId: string;
  operationId: string;
  attempt: number;
  outcome: 'accepted' | 'conflicted' | 'exhausted';
  terminal: boolean;
  source: 'resource_inbox.release.telemetry';
  retryDelayMs: number;
  dueAgeMs: number;
  selectedLane: 'fast' | 'fairness' | 'timeout';
}>;

export function deriveAppInboxAttemptObservations(
  releases: readonly ResourceInboxAttemptReleaseTelemetry[],
  evidence: readonly AppInboxEvidence[],
  commands: readonly RawCommand[],
): AppInboxAttemptObservation[] {
  const accepted = new Set(commands.filter((entry) => entry.status === 'accepted')
    .map((entry) => entry.commandId));
  const evidenceByKey = new Map(evidence.map((entry) => [
    `${entry.topicId}\u0000${entry.resourceId}`,
    entry,
  ]));
  return releases.flatMap((release) => {
    const entry = evidenceByKey.get(`${release.key.topicId}\u0000${release.key.resourceId}`);
    if (!entry) return [];
    const terminal = release.status !== 'RETRY';
    return [{
      commandId: entry.commandId,
      operationId: entry.operationId,
      attempt: release.attempt,
      outcome: terminal
        ? accepted.has(entry.commandId) ? 'accepted' as const : 'exhausted' as const
        : 'conflicted' as const,
      terminal,
      source: 'resource_inbox.release.telemetry' as const,
      retryDelayMs: release.retryDelayMs,
      dueAgeMs: release.dueAgeMs,
      selectedLane: release.selectedLane === Reservator.FAIRNESS
        ? 'fairness' as const
        : release.selectedLane === Reservator.TIMEOUT ? 'timeout' as const : 'fast' as const,
    }];
  }).toSorted((left, right) =>
    left.commandId.localeCompare(right.commandId) ||
    left.operationId.localeCompare(right.operationId) || left.attempt - right.attempt
  );
}

export function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export function readAppInboxCommandType(resource: string): string {
  const payload = parseJsonRecord(resource)?.payload;
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) &&
      typeof (payload as Record<string, unknown>).typeId === 'string'
    ? (payload as Record<string, unknown>).typeId as string
    : 'UNKNOWN';
}

export function parsePersistedResult(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
