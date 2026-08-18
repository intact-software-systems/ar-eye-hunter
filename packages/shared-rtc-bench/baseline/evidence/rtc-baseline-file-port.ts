export interface RtcBaselineExclusiveFileLock {
  readonly created: boolean;
  readBytes(): Promise<Uint8Array>;
  writeBytes(bytes: Uint8Array): Promise<void>;
  release(): Promise<void>;
}

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
  tryAcquireExclusiveFileLock(path: string): Promise<RtcBaselineExclusiveFileLock | null>;
  classifyError?(error: Error): 'already-exists' | 'permission-denied' | 'other';
}
