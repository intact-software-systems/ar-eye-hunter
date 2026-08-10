import type { RtcBaselineJson, RtcBaselineResult } from './rtc-baseline-contracts.ts';
import { isRtcBaselineConfinedArtifactPath } from './rtc-baseline-validation.ts';

export interface RtcBaselineFilePort {
  inspectPath(path: string): Promise<{ kind: 'file' | 'directory' | 'symlink' | 'other' } | null>;
  createDirectory(path: string, options: { recursive: boolean }): Promise<void>;
  writeFileCreateNew(path: string, bytes: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  removeFile(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  listDirectory(
    path: string,
  ): Promise<readonly { name: string; kind: 'file' | 'directory' | 'symlink' | 'other' }[]>;
  classifyError?(error: Error): 'already-exists' | 'permission-denied' | 'other';
}

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
export interface RtcBaselineStoredFile {
  relativePath: string;
  kind: 'file';
}
type StoreVoidResult = Promise<RtcBaselineResult<void>>;
type StoreFilesResult = Promise<RtcBaselineResult<readonly RtcBaselineStoredFile[]>>;
function issue(path: string, code: string, message: string) {
  return { path, code, message };
}
function failure(path: string, code: string, failureMessage: string) {
  return { ok: false as const, issues: [issue(path, code, failureMessage)] };
}
const cleanMessage = (value: string) => value.replace(/^Error: /, '');
const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);
function symlinkFailure() {
  return failure(
    '$.path',
    'symlink-component',
    'Artifact paths may not contain symlink components.',
  );
}
function unconfinedFailure() {
  return failure(
    '$.path',
    'unconfined-path',
    'Artifact path must remain beneath the baseline directory.',
  );
}

export function createRtcBaselineFileStore(input: {
  rootPath: string;
  filePort: RtcBaselineFilePort;
}): RtcBaselineFileStore {
  const { rootPath, filePort } = input;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const baselinePath = (baselineId: string) => `${rootPath}/${baselineId}`;
  const confined = isRtcBaselineConfinedArtifactPath;
  function errorKind(error: Error) {
    return (
      filePort.classifyError?.(error) ??
      ((error as { name?: string }).name === 'AlreadyExists' ? 'already-exists' : 'other')
    );
  }
  async function inspectConfined(baselineId: string, relativePath: string) {
    if (!confined(baselineId, relativePath)) {
      return unconfinedFailure();
    }
    const components = [rootPath, baselinePath(baselineId)];
    let current = baselinePath(baselineId);
    for (const component of relativePath.split('/')) {
      current = `${current}/${component}`;
      components.push(current);
    }
    try {
      for (const component of components) {
        if ((await filePort.inspectPath(component))?.kind === 'symlink') {
          return symlinkFailure();
        }
      }
      return { ok: true as const, value: current };
    } catch (error) {
      return failure('$.path', 'inspect-failed', cleanMessage(String(error)));
    }
  }
  async function acquireLock(baselineId: string) {
    const inspected = await inspectConfined(baselineId, '.writer.lock');
    if (!inspected.ok) return inspected;
    const path = inspected.value;
    try {
      await filePort.writeFileCreateNew(path, new Uint8Array());
      return { ok: true as const, value: undefined };
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      if (errorKind(cause) !== 'already-exists') {
        return failure('$.lock', 'lock-acquire-failed', cause.message);
      }
      return failure('$.lock', 'lock-conflict', 'RTC baseline writer lock already exists.');
    }
  }
  async function releaseLock(baselineId: string) {
    const inspected = await inspectConfined(baselineId, '.writer.lock');
    if (!inspected.ok) return inspected;
    try {
      await filePort.removeFile(inspected.value);
      return { ok: true as const, value: undefined };
    } catch (error) {
      return failure('$.lock', 'lock-release-failed', cleanMessage(String(error)));
    }
  }
  async function rollbackBaseline(path: string, issues: readonly ReturnType<typeof issue>[]) {
    const rollbackIssues = [...issues];
    try {
      await filePort.removeDirectory(path);
    } catch (error) {
      rollbackIssues.push(issue('$.baseline', 'rollback-failed', cleanMessage(String(error))));
    }
    return { ok: false as const, issues: rollbackIssues };
  }
  async function initializeBaseline(
    baselineId: string,
    files: Readonly<Record<string, Uint8Array>>,
    directoryPaths: readonly string[] = [],
  ) {
    const path = baselinePath(baselineId);
    const initializationPaths = [...directoryPaths, ...Object.keys(files)];
    if (
      !confined(baselineId, 'environment.json') ||
      !initializationPaths.every((relativePath) => confined(baselineId, relativePath))
    ) {
      return unconfinedFailure();
    }
    try {
      const root = await filePort.inspectPath(rootPath);
      if (root?.kind === 'symlink') return symlinkFailure();
      if (root === null) await filePort.createDirectory(rootPath, { recursive: true });
      const existing = await filePort.inspectPath(path);
      if (existing?.kind === 'symlink') return symlinkFailure();
      if (existing !== null) {
        return failure(
          '$.baseline',
          'baseline-already-exists',
          'Baseline directory already exists.',
        );
      }
      await filePort.createDirectory(path, { recursive: false });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      if (errorKind(cause) === 'already-exists') {
        const existing = await filePort.inspectPath(path);
        return existing?.kind === 'symlink'
          ? symlinkFailure()
          : failure('$.baseline', 'baseline-already-exists', 'Baseline directory already exists.');
      }
      return failure('$.baseline', 'directory-create-failed', cleanMessage(String(error)));
    }
    const lock = await acquireLock(baselineId);
    if (!lock.ok) return rollbackBaseline(path, lock.issues);
    const written: string[] = [];
    let initializationFailure: ReturnType<typeof issue> | null = null;
    for (const relativePath of directoryPaths) {
      try {
        await filePort.createDirectory(`${path}/${relativePath}`, { recursive: true });
      } catch (error) {
        initializationFailure = issue(
          `$.${relativePath}`,
          'directory-create-failed',
          cleanMessage(String(error)),
        );
        break;
      }
    }
    for (const [relativePath, bytes] of initializationFailure ? [] : Object.entries(files)) {
      try {
        await filePort.writeFileCreateNew(`${path}/${relativePath}`, bytes);
        written.push(`${path}/${relativePath}`);
      } catch (error) {
        initializationFailure = issue(
          `$.${relativePath}`,
          'write-failed',
          cleanMessage(String(error)),
        );
        break;
      }
    }
    const release = await releaseLock(baselineId);
    if (!initializationFailure && !release.ok) return release;
    if (initializationFailure) {
      for (const writtenPath of written) {
        try {
          await filePort.removeFile(writtenPath);
        } catch {
          // Directory rollback remains authoritative for initialization cleanup.
        }
      }
      return rollbackBaseline(path, [initializationFailure, ...(release.ok ? [] : release.issues)]);
    }
    return { ok: true as const, value: undefined };
  }
  async function withLock<T>(
    baselineId: string,
    operation: (writer: RtcBaselineLockedWriter) => Promise<RtcBaselineResult<T>>,
  ): Promise<RtcBaselineResult<T>> {
    const lock = await acquireLock(baselineId);
    if (!lock.ok) return lock;
    let result: RtcBaselineResult<T>;
    try {
      result = await operation({
        writeJsonCreateNew: writeJsonCreateNewUnderLock,
        publishSummary: publishSummaryUnderLock,
      });
    } catch (error) {
      result = failure('$.operation', 'operation-threw', cleanMessage(String(error)));
    }
    const release = await releaseLock(baselineId);
    if (!release.ok && !result.ok) {
      return { ok: false as const, issues: [...(result.issues ?? []), ...release.issues] };
    }
    return !release.ok ? release : result;
  }
  async function writeJsonCreateNew(
    baselineId: string,
    relativePath: string,
    value: RtcBaselineJson | object,
  ): Promise<RtcBaselineResult<void>> {
    if (!confined(baselineId, relativePath)) return unconfinedFailure();
    return withLock(baselineId, (writer) =>
      writer.writeJsonCreateNew(baselineId, relativePath, value),
    );
  }

  async function writeJsonCreateNewUnderLock(
    baselineId: string,
    relativePath: string,
    value: RtcBaselineJson | object,
  ): Promise<RtcBaselineResult<void>> {
    const inspected = await inspectConfined(baselineId, relativePath);
    if (!inspected.ok) return inspected;
    try {
      await filePort.writeFileCreateNew(
        inspected.value,
        encoder.encode(`${JSON.stringify(value)}\n`),
      );
      return { ok: true as const, value: undefined };
    } catch (error) {
      return failure(`$.${relativePath}`, 'write-failed', cleanMessage(String(error)));
    }
  }

  async function readBytes(
    baselineId: string,
    relativePath: string,
  ): Promise<RtcBaselineResult<Uint8Array>> {
    const inspected = await inspectConfined(baselineId, relativePath);
    if (!inspected.ok) return inspected;
    try {
      return { ok: true as const, value: await filePort.readFile(inspected.value) };
    } catch (error) {
      return failure(`$.${relativePath}`, 'read-failed', cleanMessage(String(error)));
    }
  }

  async function readJson(
    baselineId: string,
    relativePath: string,
  ): Promise<RtcBaselineResult<RtcBaselineJson>> {
    const bytes = await readBytes(baselineId, relativePath);
    if (!bytes.ok) return bytes;
    try {
      return { ok: true as const, value: JSON.parse(decoder.decode(bytes.value)) };
    } catch (error) {
      return failure(`$.${relativePath}`, 'malformed-json', cleanMessage(String(error)));
    }
  }

  async function publishSummaryUnderLock(
    baselineId: string,
    summaryBytes: Uint8Array,
    checksumBytes: Uint8Array,
  ) {
    const summary = await inspectConfined(baselineId, 'summary.json');
    if (!summary.ok) return summary;
    const checksum = await inspectConfined(baselineId, 'SHA256SUMS');
    if (!checksum.ok) return checksum;
    const summaryPath = summary.value;
    try {
      const summaryEntry = await filePort.inspectPath(summaryPath);
      const checksumEntry = await filePort.inspectPath(checksum.value);
      if (summaryEntry?.kind === 'file' && checksumEntry?.kind === 'file') {
        const existingSummary = await filePort.readFile(summaryPath);
        const existingChecksum = await filePort.readFile(checksum.value);
        if (
          sameBytes(existingSummary, summaryBytes) &&
          sameBytes(existingChecksum, checksumBytes)
        ) {
          return { ok: true as const, value: undefined };
        }
        return failure(
          '$.summary',
          'finalization-conflict',
          'Finalized summary and checksum already exist with different bytes.',
        );
      }
      if (summaryEntry?.kind === 'file' && checksumEntry === null) {
        await filePort.removeFile(summaryPath);
      }
      if (summaryEntry === null && checksumEntry?.kind === 'file') {
        await filePort.removeFile(checksum.value);
      }
      await filePort.writeFileCreateNew(summaryPath, summaryBytes);
      await filePort.writeFileCreateNew(checksum.value, checksumBytes);
      return { ok: true as const, value: undefined };
    } catch (error) {
      try {
        if ((await filePort.inspectPath(summaryPath))?.kind === 'file') {
          await filePort.removeFile(summaryPath);
        }
      } catch {
        // Retry removes an orphaned summary before its next create-new write.
      }
      return failure('$.summary', 'write-failed', cleanMessage(String(error)));
    }
  }

  async function listArtifacts(baselineId: string, relativePath: string) {
    const inspected = await inspectConfined(baselineId, relativePath);
    if (!inspected.ok) return inspected;
    try {
      const found: RtcBaselineStoredFile[] = [];
      async function visit(
        directoryPath: string,
        absolutePath: string,
      ): Promise<RtcBaselineResult<void>> {
        const entries = [...(await filePort.listDirectory(absolutePath))].sort((left, right) =>
          left.name.localeCompare(right.name),
        );
        for (const entry of entries) {
          const entryPath = `${directoryPath}/${entry.name}`;
          if (entry.kind === 'symlink') {
            return failure(
              `$.${entryPath}`,
              'symlink-entry',
              'Artifact enumeration rejects symlink entries.',
            );
          }
          if (entry.kind === 'directory') {
            const nested = await visit(entryPath, `${absolutePath}/${entry.name}`);
            if (!nested.ok) return nested;
          } else if (entry.kind === 'file') {
            found.push({ relativePath: entryPath, kind: 'file' });
          }
        }
        return { ok: true as const, value: undefined };
      }
      const visited = await visit(relativePath, inspected.value);
      if (!visited.ok) return visited;
      return { ok: true as const, value: found };
    } catch (error) {
      return failure(`$.${relativePath}`, 'list-failed', cleanMessage(String(error)));
    }
  }
  return {
    initializeBaseline,
    writeJsonCreateNew,
    readBytes,
    readJson,
    listArtifacts,
    withFinalizationLock: withLock,
  };
}
