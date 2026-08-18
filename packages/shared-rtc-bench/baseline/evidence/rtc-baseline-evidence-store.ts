import type { RtcBaselineJson, RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import {
  createRtcBaselineArtifactFiles,
  type RtcBaselineStoredFile,
} from './rtc-baseline-artifact-files.ts';
import {
  createRtcBaselineConfinedPath,
  rtcBaselineUnconfinedPathFailure,
} from './rtc-baseline-confined-path.ts';
import { createRtcBaselineInitialization } from './create-rtc-baseline-initialization.ts';
import { createRtcBaselineSummaryPublisher } from './create-rtc-baseline-summary-publisher.ts';
import type { RtcBaselineFilePort } from './rtc-baseline-file-port.ts';
import {
  createRtcBaselineWriterLock,
  type RtcBaselineWriterLockConfig,
  type RtcBaselineWriterLockLease,
  type RtcBaselineWriterLockRuntime,
} from './rtc-baseline-writer-lock.ts';

export interface RtcBaselineFileStore {
  initializeBaseline(
    baselineId: string,
    files: Readonly<Record<string, Uint8Array>>,
    directoryPaths?: readonly string[],
  ): StoreVoidResult;
  writeJsonCreateNew(
    baselineId: string,
    relativePath: string,
    value: RtcBaselineJson | object,
  ): StoreVoidResult;
  readBytes(baselineId: string, relativePath: string): Promise<RtcBaselineResult<Uint8Array>>;
  readJson(baselineId: string, relativePath: string): Promise<RtcBaselineResult<RtcBaselineJson>>;
  listArtifacts(baselineId: string, relativePath: string): StoreFilesResult;
  withFinalizationLock<T>(
    baselineId: string,
    operation: (writer: RtcBaselineLockedWriter) => Promise<RtcBaselineResult<T>>,
  ): Promise<RtcBaselineResult<T>>;
}

export interface RtcBaselineLockedWriter {
  writeJsonCreateNew(
    baselineId: string,
    relativePath: string,
    value: RtcBaselineJson | object,
  ): StoreVoidResult;
  publishSummary(
    baselineId: string,
    summaryBytes: Uint8Array,
    checksumBytes: Uint8Array,
  ): StoreVoidResult;
}

type StoreVoidResult = Promise<RtcBaselineResult<void>>;
type StoreFilesResult = Promise<RtcBaselineResult<readonly RtcBaselineStoredFile[]>>;

export function createRtcBaselineFileStore(input: {
  readonly rootPath: string;
  readonly filePort: RtcBaselineFilePort;
  readonly writerLockRuntime: RtcBaselineWriterLockRuntime;
  readonly writerLockConfig: RtcBaselineWriterLockConfig;
}): RtcBaselineFileStore {
  const { rootPath, filePort, writerLockRuntime, writerLockConfig } = input;
  const confinedPath = createRtcBaselineConfinedPath({ rootPath, filePort });
  const artifactFiles = createRtcBaselineArtifactFiles({ confinedPath, filePort });
  const publishSummary = createRtcBaselineSummaryPublisher({ confinedPath, filePort });
  const writerLock = createRtcBaselineWriterLock({
    filePort,
    runtime: writerLockRuntime,
    config: writerLockConfig,
  });

  async function acquireLock(
    baselineId: string,
  ): Promise<RtcBaselineResult<RtcBaselineWriterLockLease>> {
    const inspected = await confinedPath.inspect(baselineId, '.writer.lock');
    return inspected.ok ? writerLock.acquire(inspected.value) : inspected;
  }

  const lockedWriter: RtcBaselineLockedWriter = {
    writeJsonCreateNew: artifactFiles.writeJsonCreateNew,
    publishSummary,
  };

  async function withLock<T>(
    baselineId: string,
    operation: (writer: RtcBaselineLockedWriter) => Promise<RtcBaselineResult<T>>,
  ): Promise<RtcBaselineResult<T>> {
    const lock = await acquireLock(baselineId);
    if (!lock.ok) return lock;
    let result: RtcBaselineResult<T>;
    try {
      result = await operation(lockedWriter);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      result = {
        ok: false,
        issues: [
          {
            path: '$.operation',
            code: 'operation-threw',
            message: cause.message,
          },
        ],
      };
    }
    const release = await lock.value.release();
    if (!release.ok && !result.ok) {
      return { ok: false, issues: [...result.issues, ...release.issues] };
    }
    return release.ok ? result : release;
  }

  const initialization = createRtcBaselineInitialization({
    confinedPath,
    filePort,
    acquireLock,
  });

  return {
    initializeBaseline: initialization.initialize,
    writeJsonCreateNew: (baselineId, relativePath, value) => {
      if (!confinedPath.isConfined(baselineId, relativePath)) {
        return Promise.resolve(rtcBaselineUnconfinedPathFailure());
      }
      return withLock(baselineId, (writer) =>
        writer.writeJsonCreateNew(baselineId, relativePath, value),
      );
    },
    readBytes: artifactFiles.readBytes,
    readJson: artifactFiles.readJson,
    listArtifacts: artifactFiles.listArtifacts,
    withFinalizationLock: withLock,
  };
}
