interface RtcBaselineDenoFileInfo {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

interface RtcBaselineDenoDirectoryEntry extends RtcBaselineDenoFileInfo {
  name: string;
}

interface RtcBaselineDenoErrorConstructor {
  new (...args: string[]): Error;
}

export interface RtcBaselineDenoPort {
  envGet(name: string): string | undefined;
  build: { os: string; arch: string };
  version: { deno: string };
  lstat(path: string): Promise<RtcBaselineDenoFileInfo>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array, options: { createNew: boolean }): Promise<void>;
  remove(path: string, options: { recursive: boolean }): Promise<void>;
  readDir(path: string): AsyncIterable<RtcBaselineDenoDirectoryEntry>;
  command(
    executable: string,
    arguments_: readonly string[],
  ): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }>;
  now(): Date;
  performanceNow(): number;
  systemMemoryInfo(): { total: number };
  availableParallelism(): number;
  errors?: {
    NotFound?: RtcBaselineDenoErrorConstructor;
    AlreadyExists?: RtcBaselineDenoErrorConstructor;
    PermissionDenied?: RtcBaselineDenoErrorConstructor;
  };
}
