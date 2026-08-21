interface RtcBaselineDenoFileInfo {
    isFile: boolean;
    isDirectory: boolean;
    isSymlink: boolean;
    dev: number | null;
    ino: number | null;
    size: number;
}

interface RtcBaselineDenoDirectoryEntry {
    name: string;
    isFile: boolean;
    isDirectory: boolean;
    isSymlink: boolean;
}

interface RtcBaselineDenoErrorConstructor {
    new(...args: string[]): Error;
}

export interface RtcBaselineDenoFile {
    stat(): Promise<RtcBaselineDenoFileInfo>;
    seek(offset: number, whence: 0 | 1 | 2): Promise<number>;
    read(buffer: Uint8Array): Promise<number | null>;
    write(bytes: Uint8Array): Promise<number>;
    truncate(length?: number): Promise<void>;
    sync(): Promise<void>;
    lock(exclusive?: boolean): Promise<void>;
    tryLock(exclusive?: boolean): Promise<boolean>;
    unlock(): Promise<void>;
    close(): void;
}

export interface RtcBaselineDenoPort {
    envGet(name: string): string | undefined;
    build: { os: string; arch: string; };
    version: { deno: string; };
    pid: number;
    hostname(): string;
    randomUuid(): string;
    kill(processId: number, signal: number): void;
    lstat(path: string): Promise<RtcBaselineDenoFileInfo>;
    open(
        path: string,
        options: { read: boolean; write: boolean; createNew?: boolean; }
    ): Promise<RtcBaselineDenoFile>;
    mkdir(path: string, options: { recursive: boolean; }): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, bytes: Uint8Array, options: { createNew: boolean; }): Promise<void>;
    remove(path: string, options: { recursive: boolean; }): Promise<void>;
    readDir(path: string): AsyncIterable<RtcBaselineDenoDirectoryEntry>;
    command(
        executable: string,
        arguments_: readonly string[]
    ): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array; }>;
    now(): Date;
    performanceNow(): number;
    systemMemoryInfo(): { total: number; };
    availableParallelism(): number;
    errors?: {
        NotFound?: RtcBaselineDenoErrorConstructor;
        AlreadyExists?: RtcBaselineDenoErrorConstructor;
        PermissionDenied?: RtcBaselineDenoErrorConstructor;
    };
}
