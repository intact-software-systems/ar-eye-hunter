import type { RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import type {
  RtcBaselineExclusiveFileLock,
  RtcBaselineFilePort,
} from './rtc-baseline-file-port.ts';
import {
  createRtcBaselineOwnedWriterLockMetadata,
  decodeRtcBaselineWriterLockMetadata,
  encodeRtcBaselineWriterLockMetadata,
  type RtcBaselineOwnedWriterLockMetadata,
} from './rtc-baseline-writer-lock-metadata.ts';

export const RTC_BASELINE_WRITER_LOCK_STALE_AFTER_MS = 300_000;

interface RecoveryFailureInput {
  readonly metadata: RtcBaselineOwnedWriterLockMetadata;
  readonly runtime: RtcBaselineWriterLockRuntime;
  readonly config: RtcBaselineWriterLockConfig;
  readonly now: Date;
  readonly currentHostname: string;
}

export interface RtcBaselineWriterLockRuntime {
  createOwnerToken(): string;
  readOwnerIdentity(): { readonly hostname: string; readonly processId: number };
  now(): Date;
  readProcessLiveness(processId: number): Promise<'alive' | 'dead' | 'unknown'>;
}

export interface RtcBaselineWriterLockConfig {
  readonly staleAfterMs: number;
}

export interface RtcBaselineWriterLockLease {
  release(): Promise<RtcBaselineResult<void>>;
}

export interface RtcBaselineWriterLock {
  acquire(path: string): Promise<RtcBaselineResult<RtcBaselineWriterLockLease>>;
}

function lockFailure(code: string, message: string): RtcBaselineResult<never> {
  return { ok: false, issues: [{ path: '$.lock', code, message }] };
}

async function recoveryFailure(input: RecoveryFailureInput): Promise<RtcBaselineResult<void>> {
  const { metadata, runtime, config, now, currentHostname } = input;
  if (metadata.hostname !== currentHostname) {
    return lockFailure(
      'lock-owner-remote',
      `Writer lock belongs to host ${metadata.hostname}; remote process liveness cannot be proven.`,
    );
  }
  const ageMs = now.getTime() - new Date(metadata.createdAtUtc).getTime();
  if (ageMs < 0) {
    return lockFailure(
      'lock-clock-anomaly',
      'Writer lock creation time is later than the local clock; recovery was refused.',
    );
  }
  const liveness = await runtime.readProcessLiveness(metadata.processId);
  if (liveness === 'alive') {
    return lockFailure(
      'lock-owner-live',
      `Writer process ${metadata.processId} is still alive; recovery was refused.`,
    );
  }
  if (liveness === 'unknown') {
    return lockFailure(
      'lock-liveness-unknown',
      `Writer process ${metadata.processId} liveness could not be proven; recovery was refused.`,
    );
  }
  if (ageMs < config.staleAfterMs) {
    const message =
      `Writer process ${metadata.processId} is dead, but its lock has not reached the ` +
      `${config.staleAfterMs}ms stale threshold.`;
    return lockFailure('lock-owner-not-stale', message);
  }
  return { ok: true, value: undefined };
}

async function releaseAdvisoryLock(lock: RtcBaselineExclusiveFileLock) {
  try {
    await lock.release();
    return null;
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    return lockFailure('lock-release-failed', cause.message);
  }
}

async function stopAcquisition<T>(
  lock: RtcBaselineExclusiveFileLock,
  result: RtcBaselineResult<T>,
) {
  return (await releaseAdvisoryLock(lock)) ?? result;
}

export function createRtcBaselineWriterLock(input: {
  readonly filePort: RtcBaselineFilePort;
  readonly runtime: RtcBaselineWriterLockRuntime;
  readonly config: RtcBaselineWriterLockConfig;
}): RtcBaselineWriterLock {
  const { filePort, runtime, config } = input;

  async function acquire(path: string): Promise<RtcBaselineResult<RtcBaselineWriterLockLease>> {
    let advisoryLock: RtcBaselineExclusiveFileLock | null;
    try {
      advisoryLock = await filePort.tryAcquireExclusiveFileLock(path);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      return lockFailure('lock-acquire-failed', cause.message);
    }
    if (advisoryLock === null) {
      return lockFailure('lock-conflict', 'Another RTC baseline writer currently holds the lock.');
    }

    try {
      const now = runtime.now();
      const identity = runtime.readOwnerIdentity();
      if (!advisoryLock.created) {
        const existing = decodeRtcBaselineWriterLockMetadata(await advisoryLock.readBytes());
        if (existing === null) {
          return stopAcquisition(
            advisoryLock,
            lockFailure(
              'lock-metadata-invalid',
              'Writer lock metadata is malformed or uses an unsupported schema.',
            ),
          );
        }
        if (existing.state === 'owned') {
          const recoverable = await recoveryFailure({
            metadata: existing,
            runtime,
            config,
            now,
            currentHostname: identity.hostname,
          });
          if (!recoverable.ok) {
            return stopAcquisition(advisoryLock, recoverable);
          }
        }
      }

      const ownedMetadata = createRtcBaselineOwnedWriterLockMetadata({
        ownerToken: runtime.createOwnerToken(),
        hostname: identity.hostname,
        processId: identity.processId,
        createdAtUtc: now.toISOString(),
      });
      await advisoryLock.writeBytes(encodeRtcBaselineWriterLockMetadata(ownedMetadata));

      return {
        ok: true,
        value: {
          async release() {
            let result: RtcBaselineResult<void> = { ok: true, value: undefined };
            try {
              const current = decodeRtcBaselineWriterLockMetadata(await advisoryLock.readBytes());
              if (
                current === null ||
                current.state !== 'owned' ||
                current.ownerToken !== ownedMetadata.ownerToken
              ) {
                result = lockFailure(
                  'lock-ownership-lost',
                  'Writer lock ownership changed before release; the replacement was preserved.',
                );
              } else {
                await advisoryLock.writeBytes(
                  encodeRtcBaselineWriterLockMetadata({
                    ...current,
                    state: 'released',
                    releasedAtUtc: runtime.now().toISOString(),
                  }),
                );
              }
            } catch (error) {
              const cause = error instanceof Error ? error : new Error(String(error));
              result = lockFailure('lock-release-failed', cause.message);
            }
            const advisoryRelease = await releaseAdvisoryLock(advisoryLock);
            return advisoryRelease ?? result;
          },
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      return stopAcquisition(
        advisoryLock,
        lockFailure('lock-acquire-failed', cause.message),
      );
    }
  }

  return { acquire };
}
