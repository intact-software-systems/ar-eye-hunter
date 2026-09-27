import { EventEmitter } from 'node:events';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import {
    captureLiveRtcHeapSnapshot,
    createLiveRtcHeapDirectory,
    validateLiveRtcHeapDiagnostic
} from '../../../tests/playwright/rallar-black-box/live-rtc-heap-snapshot.ts';

describe('local RTC heap ownership evidence', () => {
    it('rejects acceptance recording, retries, multiple workers and a non-memory run', () => {
        expect(validateLiveRtcHeapDiagnostic({ apiMode: 'memory', baselineId: undefined, workers: 1, retries: 0 })).toEqual([]);
        expect(validateLiveRtcHeapDiagnostic({ apiMode: 'postgres', baselineId: 'acceptance', workers: 2, retries: 1 })).toHaveLength(4);
    });
    it('writes each chunk before the next arrives and releases the CDP session', async () => {
        const root = createRoot();
        const directory = createLiveRtcHeapDirectory(root, 'source-abc-dirty');
        const path = join(directory, 'A-cycle-0.heapsnapshot');
        const session = new HeapSession(path, false, false);
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

    it('retains partial bytes and both capture and cleanup failures without retrying', async () => {
        const directory = createLiveRtcHeapDirectory(createRoot(), 'source-first-failure');
        const path = join(directory, 'C-cycle-20.heapsnapshot');
        const session = new HeapSession(path, true, true);
        const result = await captureLiveRtcHeapSnapshot({ session, path, pageId: 'agent-c', cycle: 20, now: () => 10 });

        expect(readFileSync(path, 'utf8')).toBe('{"nodes":');
        expect(result.captureErrors).toEqual(['snapshot failed']);
        expect(result.cleanupErrors).toEqual(['detach failed']);
        expect(result.byteSize).toBe(9);
        expect(session.detached).toBe(true);
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
    detached = false;
    collected = false;

    constructor(path: string, failCapture: boolean, failDetach: boolean) {
        super();
        this.path = path;
        this.failCapture = failCapture;
        this.failDetach = failDetach;
    }

    async send(method: string): Promise<{ usedSize: number; }> {
        if (method === 'HeapProfiler.collectGarbage') {
            this.collected = true;
        }
        if (method === 'HeapProfiler.takeHeapSnapshot') {
            expect(this.collected).toBe(true);
            this.emit('HeapProfiler.addHeapSnapshotChunk', { chunk: '{"nodes":' });
            expect(readFileSync(this.path, 'utf8')).toBe('{"nodes":');
            if (this.failCapture) {
                throw new Error('snapshot failed');
            }
            this.emit('HeapProfiler.addHeapSnapshotChunk', { chunk: '[]}' });
        }
        return { usedSize: 1234 };
    }

    async detach(): Promise<void> {
        this.detached = true;
        if (this.failDetach) {
            throw new Error('detach failed');
        }
    }
}
