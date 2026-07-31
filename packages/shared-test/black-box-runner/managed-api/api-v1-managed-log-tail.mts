/// <reference lib="deno.ns" />

export type BoundedLogTailFile = Readonly<{
  size: () => Promise<number>;
  readAt: (offset: number, target: Uint8Array) => Promise<number | null>;
  close: () => void;
}>;

export type ReadBoundedLogTailOptions = Readonly<{
  openFile?: (path: string) => Promise<BoundedLogTailFile>;
}>;

export interface ManagedLogTailInput {
  readonly readLogTail?: (path: string) => Promise<string>;
  readonly readTextFile?: (path: string) => Promise<string>;
}

const LOG_TAIL_MAX_BYTES = 4096;

export async function readBoundedLogTail(
  logPath: string,
  options: ReadBoundedLogTailOptions = {},
): Promise<string> {
  let file: BoundedLogTailFile | undefined;
  try {
    file = await (options.openFile ?? openDenoBoundedLogTailFile)(logPath);
    const size = Math.max(0, await file.size());
    const length = Math.min(size, LOG_TAIL_MAX_BYTES);
    if (length === 0) return '(empty)';
    const bytes = new Uint8Array(length);
    const start = size - length;
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = await file.readAt(start + bytesRead, bytes.subarray(bytesRead));
      if (count === null || count <= 0) break;
      bytesRead += Math.min(count, length - bytesRead);
    }
    return normalizeLogTail(new TextDecoder().decode(bytes.subarray(0, bytesRead)));
  } catch (error) {
    return `[unable to read ${logPath}: ${error instanceof Error ? error.message : String(error)}]`;
  } finally {
    try {
      file?.close();
    } catch (_error) {
      // Diagnostic cleanup must not replace the readiness outcome.
    }
  }
}

export function resolveLogTailReader(
  input: ManagedLogTailInput,
): (path: string) => Promise<string> {
  if (input.readLogTail) return input.readLogTail;
  if (input.readTextFile) {
    const readTextFile = input.readTextFile;
    return async (path) => normalizeLogTail((await readTextFile(path)).slice(-LOG_TAIL_MAX_BYTES));
  }
  return readBoundedLogTail;
}

export async function readLogTailSafely(
  path: string,
  readLogTail: (path: string) => Promise<string>,
): Promise<string> {
  try {
    return normalizeLogTail(await readLogTail(path));
  } catch (error) {
    return `[unable to read ${path}: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

async function openDenoBoundedLogTailFile(path: string): Promise<BoundedLogTailFile> {
  const file = await Deno.open(path, { read: true });
  return {
    size: async () => (await file.stat()).size,
    readAt: async (offset, target) => {
      await file.seek(offset, Deno.SeekMode.Start);
      return await file.read(target);
    },
    close: () => file.close(),
  };
}

function normalizeLogTail(contents: string): string {
  return contents.trimEnd() || '(empty)';
}
