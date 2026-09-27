import { EventEmitter } from 'node:events';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    captureLiveRtcHeapSnapshot,
    createLiveRtcHeapDirectory,
    validateLiveRtcHeapDiagnostic
} from '../../../tests/playwright/rallar-black-box/live-rtc-heap-snapshot.ts';

vi.mock('node:fs', async (importOriginal) => {
    const filesystem = await importOriginal<typeof import('node:fs')>();
    return { ...filesystem, writeSync: vi.fn(filesystem.writeSync) };
});

interface HeapSessionOptions {
    readonly failCapture: boolean;
    readonly failDetach: boolean;
    readonly emitSnapshotChunks: boolean;
    readonly usedSize: number;
}

describe('local RTC heap ownership evidence', () => {
    it('rejects acceptance recording, retries, multiple workers and a non-memory run', () => {
        expect(validateLiveRtcHeapDiagnostic({ apiMode: 'memory', baselineId: undefined, workers: 1, retries: 0 })).toEqual([]);
        expect(validateLiveRtcHeapDiagnostic({ apiMode: 'postgres', baselineId: 'acceptance', workers: 2, retries: 1 })).toHaveLength(4);
    });
    it('writes each chunk before the next arrives and releases the CDP session', async () => {
        const root = createRoot();
        const directory = createLiveRtcHeapDirectory(root, 'source-abc-dirty');
        const path = join(directory, 'A-cycle-0.heapsnapshot');
        const session = new HeapSession(path, {
            failCapture: false,
            failDetach: false,
            emitSnapshotChunks: true,
            usedSize: 1234
        });
        const result = await captureLiveRtcHeapSnapshot({ session, path, pageId: 'agent-a', cycle: 0, now: () => 12 });

        expect(readFileSync(path, 'utf8')).toBe('{"nodes":[]}');
        expect(result).toEqual({
            pageId: 'agent-a',
            cycle: 0,
            path,
            postGcUsedBytes: 1234,
            durationMs: 0,
            snapshotDurationMs: 0,
            byteSize: 12,
            captureErrors: [],
            cleanupErrors: []
        });
        expect(session.detached).toBe(true);
        expect(session.listenerCount('HeapProfiler.addHeapSnapshotChunk')).toBe(0);
    });

    it('reports a successful snapshot command that emits no snapshot bytes', async () => {
        const directory = createLiveRtcHeapDirectory(createRoot(), 'source-empty-snapshot');
        const path = join(directory, 'A-cycle-0.heapsnapshot');
        const session = new HeapSession(path, {
            failCapture: false,
            failDetach: false,
            emitSnapshotChunks: false,
            usedSize: 1234
        });

        const result = await captureLiveRtcHeapSnapshot({ session, path, pageId: 'agent-a', cycle: 0, now: () => 12 });

        expect(result.captureErrors).toEqual(['Heap snapshot completed without writing any bytes.']);
        expect(result.byteSize).toBe(0);
        expect(session.listenerCount('HeapProfiler.addHeapSnapshotChunk')).toBe(0);
        expect(session.detached).toBe(true);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('rejects invalid post-GC heap usage %s', async (usedSize) => {
        const directory = createLiveRtcHeapDirectory(createRoot(), `source-invalid-usage-${String(usedSize)}`);
        const path = join(directory, 'A-cycle-0.heapsnapshot');
        const session = new HeapSession(path, {
            failCapture: false,
            failDetach: false,
            emitSnapshotChunks: true,
            usedSize
        });

        const result = await captureLiveRtcHeapSnapshot({ session, path, pageId: 'agent-a', cycle: 0, now: () => 12 });

        expect(result.postGcUsedBytes).toBeUndefined();
        expect(result.captureErrors).toContain('Post-GC heap usage must be a finite nonnegative number.');
        expect(session.listenerCount('HeapProfiler.addHeapSnapshotChunk')).toBe(0);
        expect(session.detached).toBe(true);
    });

    it('retains partial bytes and both capture and cleanup failures without retrying', async () => {
        const directory = createLiveRtcHeapDirectory(createRoot(), 'source-first-failure');
        const path = join(directory, 'C-cycle-20.heapsnapshot');
        const session = new HeapSession(path, {
            failCapture: true,
            failDetach: true,
            emitSnapshotChunks: true,
            usedSize: 1234
        });
        const result = await captureLiveRtcHeapSnapshot({ session, path, pageId: 'agent-c', cycle: 20, now: () => 10 });

        expect(readFileSync(path, 'utf8')).toBe('{"nodes":');
        expect(result.captureErrors).toEqual(['snapshot failed']);
        expect(result.cleanupErrors).toEqual(['detach failed']);
        expect(result.byteSize).toBe(9);
        expect(session.detached).toBe(true);
    });

    it('retains the first chunk and reports a later disk write failure while detaching CDP', async () => {
        const directory = createLiveRtcHeapDirectory(createRoot(), 'source-disk-failure');
        const path = join(directory, 'B-cycle-20.heapsnapshot');
        const session = new HeapSession(path, {
            failCapture: false,
            failDetach: false,
            emitSnapshotChunks: true,
            usedSize: 1234
        });
        const diskWrite = vi.mocked(writeSync);
        const realWrite = diskWrite.getMockImplementation();
        if (!realWrite) {
            throw new Error('Filesystem write implementation is required.');
        }
        diskWrite.mockImplementationOnce(realWrite).mockImplementationOnce(() => {
            throw new Error('disk-write-failed');
        });
        onTestFinished(() => {
            diskWrite.mockReset();
        });

        const result = await captureLiveRtcHeapSnapshot({ session, path, pageId: 'agent-b', cycle: 20, now: () => 10 });

        expect(readFileSync(path, 'utf8')).toBe('{"nodes":');
        expect(result.byteSize).toBe(9);
        expect(result.captureErrors).toEqual(['disk-write-failed']);
        expect(result.cleanupErrors).toEqual([]);
        expect(session.detached).toBe(true);
        expect(session.listenerCount('HeapProfiler.addHeapSnapshotChunk')).toBe(0);
    });

    it('rejects traversal, symlink directories and reuse of a first-attempt directory', () => {
        const root = createRoot();
        expect(() => createLiveRtcHeapDirectory(root, '../escape')).toThrow();
        const directory = createLiveRtcHeapDirectory(root, 'first-attempt');
        expect(() => createLiveRtcHeapDirectory(root, 'first-attempt')).toThrow();
        symlinkSync(directory, join(root, 'tmp/perf/rtc-heap-owner/linked'));
        expect(() => createLiveRtcHeapDirectory(root, 'linked')).toThrow();
    });
});

function createRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'rtc-heap-test-'));
    onTestFinished(() => rmSync(root, { recursive: true }));
    return root;
}

class HeapSession extends EventEmitter {
    readonly path: string;
    readonly failCapture: boolean;
    readonly failDetach: boolean;
    readonly emitSnapshotChunks: boolean;
    readonly usedSize: number;
    detached = false;
    collected = false;

    constructor(path: string, options: HeapSessionOptions) {
        super();
        this.path = path;
        this.failCapture = options.failCapture;
        this.failDetach = options.failDetach;
        this.emitSnapshotChunks = options.emitSnapshotChunks;
        this.usedSize = options.usedSize;
    }

    async send(method: string): Promise<{ usedSize: number; }> {
        if (method === 'HeapProfiler.collectGarbage') {
            this.collected = true;
        }
        if (method === 'HeapProfiler.takeHeapSnapshot') {
            expect(this.collected).toBe(true);
            if (this.emitSnapshotChunks) {
                this.emit('HeapProfiler.addHeapSnapshotChunk', { chunk: '{"nodes":' });
                expect(readFileSync(this.path, 'utf8')).toBe('{"nodes":');
                if (this.failCapture) {
                    throw new Error('snapshot failed');
                }
                this.emit('HeapProfiler.addHeapSnapshotChunk', { chunk: '[]}' });
            }
        }
        return { usedSize: this.usedSize };
    }

    async detach(): Promise<void> {
        this.detached = true;
        if (this.failDetach) {
            throw new Error('detach failed');
        }
    }
}
