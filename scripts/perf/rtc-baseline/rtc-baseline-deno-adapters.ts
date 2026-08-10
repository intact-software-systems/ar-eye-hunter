import type {
  RtcBaselineJson,
  RtcBaselineResult,
  RtcBaselineRuntimeObservationDto,
} from './rtc-baseline-contracts.ts';
import type { RtcBaselineFilePort } from './rtc-baseline-evidence-store.ts';

interface CommandInput {
  executable: string;
  arguments: readonly string[];
}
export interface RtcBaselineCommandOutput {
  exitStatus: number;
  stdout: string;
  stderr: string;
}
interface RuntimeFileInfo {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}
interface RuntimeDirectoryEntry extends RuntimeFileInfo {
  name: string;
}
interface RuntimeErrorConstructor {
  new (...args: string[]): Error;
}
export interface RtcBaselineDenoPort {
  envGet(name: string): string | undefined;
  build: { os: string; arch: string };
  version: { deno: string };
  lstat(path: string): Promise<RuntimeFileInfo>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array, options: { createNew: boolean }): Promise<void>;
  remove(path: string, options: { recursive: boolean }): Promise<void>;
  readDir(path: string): AsyncIterable<RuntimeDirectoryEntry>;
  command(
    executable: string,
    arguments_: readonly string[],
  ): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }>;
  now(): Date;
  performanceNow(): number;
  systemMemoryInfo(): { total: number };
  availableParallelism(): number;
  errors?: {
    NotFound?: RuntimeErrorConstructor;
    AlreadyExists?: RuntimeErrorConstructor;
    PermissionDenied?: RuntimeErrorConstructor;
  };
}
interface ProcessPort {
  run(input: CommandInput): Promise<RtcBaselineResult<RtcBaselineCommandOutput>>;
}
export interface DenoRtcBaselineAdapters {
  filePort: RtcBaselineFilePort;
  sha256(bytes: Uint8Array): Promise<string>;
  clock: { nowUtc(): string; monotonicNowMs(): number };
  environment: { readAllowlisted(names: readonly string[]): Readonly<Record<string, string>> };
  runtimeHost: {
    read(): Promise<RtcBaselineRuntimeObservationDto['host'] & { deno: string }>;
  };
  process: ProcessPort;
  freshWorker: ProcessPort;
  git: {
    readHeadCommit(): Promise<RtcBaselineResult<string>>;
    readHeadTree(): Promise<RtcBaselineResult<string>>;
    readRef(): Promise<RtcBaselineResult<string>>;
    readStatus(): Promise<RtcBaselineResult<string>>;
  };
  sourceConfigHashing: {
    read(
      inputs: readonly { path: string; kind: 'source' | 'config' }[],
    ): Promise<RtcBaselineResult<RtcBaselineRuntimeObservationDto['sourceHashes']>>;
  };
}

const allowedExecutables = new Set(['git', 'node', 'npm', 'deno', 'uname', 'sysctl']);
const decoder = new TextDecoder();

function cleanMessage(value: string) {
  return value.replace(/^Error: /, '');
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createDenoRtcBaselineAdapters(
  runtime: RtcBaselineDenoPort,
): DenoRtcBaselineAdapters {
  async function run(input: CommandInput): Promise<RtcBaselineResult<RtcBaselineCommandOutput>> {
    if (!allowedExecutables.has(input.executable)) {
      return {
        ok: false,
        issues: [
          {
            path: '$.executable',
            code: 'executable-not-allowlisted',
            message: `Executable ${input.executable} is not allowed by the RTC baseline protocol.`,
          },
        ],
      };
    }
    try {
      const output = await runtime.command(input.executable, input.arguments);
      const value = {
        exitStatus: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
      };
      if (output.code === 0) return { ok: true, value };
      return {
        ok: false,
        issues: [
          {
            path: '$.process',
            code: 'command-failed',
            message: `${input.executable} exited with status ${output.code}.`,
            details: value satisfies RtcBaselineJson,
          },
        ],
      };
    } catch (error) {
      return {
        ok: false,
        issues: [
          { path: '$.process', code: 'command-threw', message: cleanMessage(String(error)) },
        ],
      };
    }
  }

  async function gitValue(
    arguments_: readonly string[],
    trim: boolean,
  ): Promise<RtcBaselineResult<string>> {
    const result = await run({ executable: 'git', arguments: arguments_ });
    if (!result.ok) return result;
    return { ok: true, value: trim ? result.value.stdout.trim() : result.value.stdout };
  }

  const filePort = {
    async inspectPath(path: string) {
      try {
        const value = await runtime.lstat(path);
        if (value.isSymlink) return { kind: 'symlink' as const };
        if (value.isDirectory) return { kind: 'directory' as const };
        if (value.isFile) return { kind: 'file' as const };
        return { kind: 'other' as const };
      } catch (error) {
        const NotFound = runtime.errors?.NotFound;
        if (NotFound && error instanceof NotFound) return null;
        throw error;
      }
    },
    createDirectory: (path: string, options: { recursive: boolean }) =>
      runtime.mkdir(path, options),
    writeFileCreateNew: (path: string, bytes: Uint8Array) =>
      runtime.writeFile(path, bytes, { createNew: true }),
    readFile: (path: string) => runtime.readFile(path),
    removeFile: (path: string) => runtime.remove(path, { recursive: false }),
    removeDirectory: (path: string) => runtime.remove(path, { recursive: true }),
    classifyError(error: Error) {
      if (runtime.errors?.AlreadyExists && error instanceof runtime.errors.AlreadyExists) {
        return 'already-exists' as const;
      }
      if (runtime.errors?.PermissionDenied && error instanceof runtime.errors.PermissionDenied) {
        return 'permission-denied' as const;
      }
      return 'other' as const;
    },
    async listDirectory(path: string) {
      const entries = [];
      for await (const entry of runtime.readDir(path)) {
        entries.push({
          name: entry.name,
          kind: entry.isSymlink
            ? ('symlink' as const)
            : entry.isDirectory
              ? ('directory' as const)
              : entry.isFile
                ? ('file' as const)
                : ('other' as const),
        });
      }
      return entries;
    },
  };

  async function sha256(bytes: Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer)));
  }

  async function readGitRef() {
    const symbolic = await gitValue(['symbolic-ref', '--short', '-q', 'HEAD'], true);
    if (symbolic.ok) return symbolic;
    const details = symbolic.issues[0]?.details;
    if (
      typeof details !== 'object' ||
      details === null ||
      Array.isArray(details) ||
      Reflect.get(details, 'exitStatus') !== 1
    ) {
      return symbolic;
    }
    const commit = await gitValue(['rev-parse', 'HEAD'], true);
    return commit.ok ? { ok: true as const, value: `detached@${commit.value}` } : commit;
  }

  return {
    filePort,
    sha256,
    clock: {
      nowUtc: () => runtime.now().toISOString(),
      monotonicNowMs: () => runtime.performanceNow(),
    },
    environment: {
      readAllowlisted(names: readonly string[]) {
        const values: Record<string, string> = {};
        for (const name of names) {
          const value = runtime.envGet(name);
          if (value !== undefined) values[name] = value;
        }
        return values;
      },
    },
    runtimeHost: {
      async read() {
        const kernel = await run({ executable: 'uname', arguments: ['-r'] });
        if (!kernel.ok) throw new Error(kernel.issues[0]!.message);
        let cpuModel: string;
        if (runtime.build.os === 'linux') {
          const cpuInfo = decoder.decode(await runtime.readFile('/proc/cpuinfo'));
          cpuModel = /^model name\s*:\s*(.+)$/m.exec(cpuInfo)?.[1]?.trim() ?? '';
          if (cpuModel.length === 0) throw new Error('Linux CPU model is unavailable.');
        } else {
          const cpu = await run({
            executable: 'sysctl',
            arguments: ['-n', 'machdep.cpu.brand_string'],
          });
          if (!cpu.ok) throw new Error(cpu.issues[0]!.message);
          cpuModel = cpu.value.stdout.trim();
        }
        return {
          deno: runtime.version.deno,
          os: runtime.build.os,
          kernel: kernel.value.stdout.trim(),
          architecture: runtime.build.arch,
          logicalCpuCount: runtime.availableParallelism(),
          cpuModel,
          totalMemoryBytes: runtime.systemMemoryInfo().total,
          executionContext: 'local' as const,
        };
      },
    },
    process: { run },
    freshWorker: { run },
    git: {
      readHeadCommit: () => gitValue(['rev-parse', 'HEAD'], true),
      readHeadTree: () => gitValue(['rev-parse', 'HEAD^{tree}'], true),
      readRef: readGitRef,
      readStatus: () => gitValue(['status', '--porcelain=v1', '--untracked-files=all'], false),
    },
    sourceConfigHashing: {
      async read(inputs: readonly { path: string; kind: 'source' | 'config' }[]) {
        const values = [];
        for (let index = 0; index < inputs.length; index += 1) {
          const input = inputs[index]!;
          try {
            values.push({
              path: input.path,
              kind: input.kind,
              sha256: await sha256(await runtime.readFile(input.path)),
            });
          } catch (error) {
            return {
              ok: false as const,
              issues: [
                {
                  path: `$.files[${index}]`,
                  code: 'file-read-failed',
                  message: cleanMessage(String(error)),
                },
              ],
            };
          }
        }
        return { ok: true as const, value: values };
      },
    },
  };
}
