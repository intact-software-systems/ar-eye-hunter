import type { RtcBaselineFilePort } from '../evidence/rtc-baseline-file-port.ts';
import type { RtcBaselineDenoPort } from './rtc-baseline-deno-port.ts';
import {
  tryAcquireRtcBaselineDenoWriterLock,
} from './try-acquire-rtc-baseline-deno-writer-lock.ts';

export function createRtcBaselineDenoFilePort(runtime: RtcBaselineDenoPort): RtcBaselineFilePort {
  return {
    async inspectPath(path: string) {
      try {
        const value = await runtime.lstat(path);
        if (value.isSymlink) {
          return { kind: 'symlink' as const };
        }
        if (value.isDirectory) {
          return { kind: 'directory' as const };
        }
        if (value.isFile) {
          return { kind: 'file' as const };
        }
        return { kind: 'other' as const };
      } catch (error) {
        const NotFound = runtime.errors?.NotFound;
        if (NotFound && error instanceof NotFound) {
          return null;
        }
        throw error;
      }
    },
    createDirectory: (path, options) => runtime.mkdir(path, options),
    writeFileCreateNew: (path, bytes) => runtime.writeFile(path, bytes, { createNew: true }),
    readFile: (path) => runtime.readFile(path),
    removeFile: (path) => runtime.remove(path, { recursive: false }),
    removeDirectory: (path) => runtime.remove(path, { recursive: true }),
    classifyError(error) {
      if (runtime.errors?.AlreadyExists && error instanceof runtime.errors.AlreadyExists) {
        return 'already-exists';
      }
      if (runtime.errors?.PermissionDenied && error instanceof runtime.errors.PermissionDenied) {
        return 'permission-denied';
      }
      return 'other';
    },
    tryAcquireExclusiveFileLock: (path) => tryAcquireRtcBaselineDenoWriterLock(runtime, path),
    async listDirectory(path) {
      const entries = [];
      for await (const entry of runtime.readDir(path)) {
        const kind = entry.isSymlink
          ? ('symlink' as const)
          : entry.isDirectory
            ? ('directory' as const)
            : entry.isFile
              ? ('file' as const)
              : ('other' as const);
        entries.push({ name: entry.name, kind });
      }
      return entries;
    },
  };
}
