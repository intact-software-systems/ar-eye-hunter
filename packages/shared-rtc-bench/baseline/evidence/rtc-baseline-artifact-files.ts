import {
  rtcBaselineIssue,
  type RtcBaselineJson,
  type RtcBaselineResult,
} from '../contracts/rtc-baseline-contracts.ts';
import type { RtcBaselineConfinedPath } from './rtc-baseline-confined-path.ts';
import type { RtcBaselineFilePort } from './rtc-baseline-file-port.ts';

export interface RtcBaselineStoredFile {
  readonly relativePath: string;
  readonly kind: 'file';
}

export interface RtcBaselineArtifactFiles {
  writeJsonCreateNew(
    baselineId: string,
    relativePath: string,
    value: RtcBaselineJson | object,
  ): Promise<RtcBaselineResult<void>>;
  readBytes(baselineId: string, relativePath: string): Promise<RtcBaselineResult<Uint8Array>>;
  readJson(baselineId: string, relativePath: string): Promise<RtcBaselineResult<RtcBaselineJson>>;
  listArtifacts(
    baselineId: string,
    relativePath: string,
  ): Promise<RtcBaselineResult<readonly RtcBaselineStoredFile[]>>;
}

function failure(path: string, code: string, message: string): RtcBaselineResult<never> {
  return {
    ok: false as const,
    issues: [rtcBaselineIssue(path, code, message)],
  };
}

export function createRtcBaselineArtifactFiles(input: {
  readonly confinedPath: RtcBaselineConfinedPath;
  readonly filePort: RtcBaselineFilePort;
}): RtcBaselineArtifactFiles {
  const { confinedPath, filePort } = input;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function writeJsonCreateNew(
    baselineId: string,
    relativePath: string,
    value: RtcBaselineJson | object,
  ): Promise<RtcBaselineResult<void>> {
    const inspected = await confinedPath.inspect(baselineId, relativePath);
    if (!inspected.ok) return inspected;
    try {
      await filePort.writeFileCreateNew(
        inspected.value,
        encoder.encode(`${JSON.stringify(value)}\n`),
      );
      return { ok: true, value: undefined };
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      return failure(`$.${relativePath}`, 'write-failed', cause.message);
    }
  }

  async function readBytes(
    baselineId: string,
    relativePath: string,
  ): Promise<RtcBaselineResult<Uint8Array>> {
    const inspected = await confinedPath.inspect(baselineId, relativePath);
    if (!inspected.ok) return inspected;
    try {
      return { ok: true as const, value: await filePort.readFile(inspected.value) };
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      return failure(`$.${relativePath}`, 'read-failed', cause.message);
    }
  }

  async function readJson(
    baselineId: string,
    relativePath: string,
  ): Promise<RtcBaselineResult<RtcBaselineJson>> {
    const bytes = await readBytes(baselineId, relativePath);
    if (!bytes.ok) return bytes;
    try {
      return { ok: true, value: JSON.parse(decoder.decode(bytes.value)) };
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      return failure(`$.${relativePath}`, 'malformed-json', cause.message);
    }
  }

  async function listArtifacts(
    baselineId: string,
    relativePath: string,
  ): Promise<RtcBaselineResult<readonly RtcBaselineStoredFile[]>> {
    const inspected = await confinedPath.inspect(baselineId, relativePath);
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
        return { ok: true, value: undefined };
      }
      const visited = await visit(relativePath, inspected.value);
      return visited.ok ? { ok: true as const, value: found } : visited;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      return failure(`$.${relativePath}`, 'list-failed', cause.message);
    }
  }

  return { writeJsonCreateNew, readBytes, readJson, listArtifacts };
}
