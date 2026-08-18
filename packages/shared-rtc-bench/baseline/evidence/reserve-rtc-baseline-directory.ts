import { rtcBaselineIssue, type RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import {
  rtcBaselineSymlinkPathFailure,
  type RtcBaselineConfinedPath,
} from './rtc-baseline-confined-path.ts';
import type { RtcBaselineFilePort } from './rtc-baseline-file-port.ts';

function failure(code: string, message: string): RtcBaselineResult<never> {
  return { ok: false, issues: [rtcBaselineIssue('$.baseline', code, message)] };
}

function errorKind(filePort: RtcBaselineFilePort, error: Error) {
  return (
    filePort.classifyError?.(error) ??
    ((error as { name?: string }).name === 'AlreadyExists' ? 'already-exists' : 'other')
  );
}

export async function reserveRtcBaselineDirectory(input: {
  readonly baselineId: string;
  readonly confinedPath: RtcBaselineConfinedPath;
  readonly filePort: RtcBaselineFilePort;
}) {
  const { baselineId, confinedPath, filePort } = input;
  const path = confinedPath.baselinePath(baselineId);
  try {
    const root = await filePort.inspectPath(confinedPath.rootPath);
    if (root?.kind === 'symlink') return rtcBaselineSymlinkPathFailure();
    if (root === null) {
      await filePort.createDirectory(confinedPath.rootPath, { recursive: true });
    }
    const existing = await filePort.inspectPath(path);
    if (existing?.kind === 'symlink') return rtcBaselineSymlinkPathFailure();
    if (existing !== null) {
      return failure('baseline-already-exists', 'Baseline directory already exists.');
    }
    await filePort.createDirectory(path, { recursive: false });
    return { ok: true as const, value: path };
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    if (errorKind(filePort, cause) !== 'already-exists') {
      return failure('directory-create-failed', cause.message);
    }
    const existing = await filePort.inspectPath(path);
    return existing?.kind === 'symlink'
      ? rtcBaselineSymlinkPathFailure()
      : failure('baseline-already-exists', 'Baseline directory already exists.');
  }
}
