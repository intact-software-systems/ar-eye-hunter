import type { RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import type {
  RtcBaselineExclusiveFileLock,
  RtcBaselineFilePort,
} from './rtc-baseline-file-port.ts';

const schema = 'rallar.rtc-baseline.writer-lock.v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const RTC_BASELINE_WRITER_LOCK_STALE_AFTER_MS = 300_000;

interface OwnedMetadata {
  readonly schema: typeof schema;
  readonly state: 'owned';
  readonly ownerToken: string;
  readonly hostname: string;
  readonly processId: number;
  readonly createdAtUtc: string;
}

interface ReleasedMetadata {
  readonly schema: typeof schema;
  readonly state: 'released';
  readonly ownerToken: string;
  readonly hostname: string;
  readonly processId: number;
  readonly createdAtUtc: string;
  readonly releasedAtUtc: string;
}

type Metadata = OwnedMetadata | ReleasedMetadata;

interface OwnerFields {
  readonly ownerToken: string;
  readonly hostname: string;
  readonly processId: number;
  readonly createdAtUtc: string;
}

interface RecoveryFailureInput {
  readonly metadata: OwnedMetadata;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function hasOwnerFields(
  value: Record<string, unknown>,
): value is Record<string, unknown> & OwnerFields {
  return (
    typeof value.ownerToken === 'string' &&
    value.ownerToken.length > 0 &&
    typeof value.hostname === 'string' &&
    value.hostname.length > 0 &&
    Number.isSafeInteger(value.processId) &&
    Number(value.processId) > 0 &&
    isUtcTimestamp(value.createdAtUtc)
  );
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decodeMetadata(bytes: Uint8Array): Metadata | null {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(value) || value.schema !== schema || !hasOwnerFields(value)) return null;
  if (value.state === 'owned') {
    const keys = ['createdAtUtc', 'hostname', 'ownerToken', 'processId', 'schema', 'state'];
    return hasOnlyKeys(value, keys)
      ? {
          schema,
          state: 'owned',
          ownerToken: value.ownerToken,
          hostname: value.hostname,
          processId: value.processId,
          createdAtUtc: value.createdAtUtc,
        }
      : null;
  }
  if (value.state === 'released') {
    const keys = [
      'createdAtUtc',
      'hostname',
      'ownerToken',
      'processId',
      'releasedAtUtc',
      'schema',
      'state',
    ];
    if (!hasOnlyKeys(value, keys) || !isUtcTimestamp(value.releasedAtUtc)) return null;
    return {
      schema,
      state: 'released',
      ownerToken: value.ownerToken,
      hostname: value.hostname,
      processId: value.processId,
      createdAtUtc: value.createdAtUtc,
      releasedAtUtc: value.releasedAtUtc,
    };
  }
  return null;
}

function encodeMetadata(metadata: Metadata) {
  return encoder.encode(`${JSON.stringify(metadata)}\n`);
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
    return lockFailure('lock-release-failed', String(error).replace(/^Error: /, ''));
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
      return lockFailure('lock-acquire-failed', String(error).replace(/^Error: /, ''));
    }
    if (advisoryLock === null) {
      return lockFailure('lock-conflict', 'Another RTC baseline writer currently holds the lock.');
    }

    try {
      const now = runtime.now();
      const identity = runtime.readOwnerIdentity();
      if (!advisoryLock.created) {
        const existing = decodeMetadata(await advisoryLock.readBytes());
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

      const ownedMetadata: OwnedMetadata = {
        schema,
        state: 'owned',
        ownerToken: runtime.createOwnerToken(),
        hostname: identity.hostname,
        processId: identity.processId,
        createdAtUtc: now.toISOString(),
      };
      await advisoryLock.writeBytes(encodeMetadata(ownedMetadata));

      return {
        ok: true,
        value: {
          async release() {
            let result: RtcBaselineResult<void> = { ok: true, value: undefined };
            try {
              const current = decodeMetadata(await advisoryLock.readBytes());
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
                  encodeMetadata({
                    ...current,
                    state: 'released',
                    releasedAtUtc: runtime.now().toISOString(),
                  }),
                );
              }
            } catch (error) {
              result = lockFailure('lock-release-failed', String(error).replace(/^Error: /, ''));
            }
            const advisoryRelease = await releaseAdvisoryLock(advisoryLock);
            return advisoryRelease ?? result;
          },
        },
      };
    } catch (error) {
      return stopAcquisition(
        advisoryLock,
        lockFailure('lock-acquire-failed', String(error).replace(/^Error: /, '')),
      );
    }
  }

  return { acquire };
}
