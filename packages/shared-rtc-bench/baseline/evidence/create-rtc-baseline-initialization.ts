import {
  rtcBaselineIssue,
  type RtcBaselineIssueDto,
  type RtcBaselineResult,
} from '../contracts/rtc-baseline-contracts.ts';
import {
  rtcBaselineUnconfinedPathFailure,
  type RtcBaselineConfinedPath,
} from './rtc-baseline-confined-path.ts';
import type { RtcBaselineFilePort } from './rtc-baseline-file-port.ts';
import type { RtcBaselineWriterLockLease } from './rtc-baseline-writer-lock.ts';
import { reserveRtcBaselineDirectory } from './reserve-rtc-baseline-directory.ts';

interface RtcBaselineInitialization {
  initialize(
    baselineId: string,
    files: Readonly<Record<string, Uint8Array>>,
    directoryPaths?: readonly string[],
  ): Promise<RtcBaselineResult<void>>;
}

interface RtcBaselineInitialArtifactsWritten {
  readonly issue: RtcBaselineIssueDto | null;
  readonly written: readonly string[];
}

export function createRtcBaselineInitialization(input: {
  readonly confinedPath: RtcBaselineConfinedPath;
  readonly filePort: RtcBaselineFilePort;
  readonly acquireLock: (
    baselineId: string,
  ) => Promise<RtcBaselineResult<RtcBaselineWriterLockLease>>;
}): RtcBaselineInitialization {
  const { confinedPath, filePort, acquireLock } = input;

  async function writeInitialArtifacts(
    path: string,
    files: Readonly<Record<string, Uint8Array>>,
    directoryPaths: readonly string[],
  ): Promise<RtcBaselineInitialArtifactsWritten> {
    const written: string[] = [];
    for (const relativePath of directoryPaths) {
      try {
        await filePort.createDirectory(`${path}/${relativePath}`, { recursive: true });
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        return {
          issue: rtcBaselineIssue(`$.${relativePath}`, 'directory-create-failed', cause.message),
          written,
        };
      }
    }
    for (const [relativePath, bytes] of Object.entries(files)) {
      try {
        await filePort.writeFileCreateNew(`${path}/${relativePath}`, bytes);
        written.push(`${path}/${relativePath}`);
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        return {
          issue: rtcBaselineIssue(`$.${relativePath}`, 'write-failed', cause.message),
          written,
        };
      }
    }
    return { issue: null, written };
  }

  async function removeWrittenArtifacts(
    paths: readonly string[],
  ): Promise<readonly RtcBaselineIssueDto[]> {
    const issues: RtcBaselineIssueDto[] = [];
    for (const path of paths) {
      try {
        await filePort.removeFile(path);
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        issues.push(rtcBaselineIssue('$.baseline', 'cleanup-failed', cause.message));
      }
    }
    return issues;
  }

  async function initialize(
    baselineId: string,
    files: Readonly<Record<string, Uint8Array>>,
    directoryPaths: readonly string[] = [],
  ): Promise<RtcBaselineResult<void>> {
    const initializationPaths = [...directoryPaths, ...Object.keys(files)];
    if (
      !confinedPath.isConfined(baselineId, 'environment.json') ||
      !initializationPaths.every((relativePath) =>
        confinedPath.isConfined(baselineId, relativePath),
      )
    ) {
      return rtcBaselineUnconfinedPathFailure();
    }
    const reserved = await reserveRtcBaselineDirectory({
      baselineId,
      confinedPath,
      filePort,
    });
    if (!reserved.ok) return reserved;
    const lock = await acquireLock(baselineId);
    if (!lock.ok) return lock;

    const written = await writeInitialArtifacts(reserved.value, files, directoryPaths);
    const cleanupIssues =
      written.issue === null ? [] : await removeWrittenArtifacts(written.written);
    const release = await lock.value.release();
    if (written.issue === null) return release;
    return {
      ok: false,
      issues: [written.issue, ...cleanupIssues, ...(release.ok ? [] : release.issues)],
    };
  }

  return { initialize };
}
