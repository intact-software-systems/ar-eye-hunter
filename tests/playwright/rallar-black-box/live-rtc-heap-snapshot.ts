import {
    closeSync,
    lstatSync,
    mkdirSync,
    openSync,
    writeSync
} from 'node:fs';
import { join, resolve } from 'node:path';

import { toError } from '@shared/resilience/to-error.ts';

export interface LiveRtcHeapSession {
    send(method: 'Runtime.getHeapUsage'): Promise<{ usedSize: number; }>;
    send(
        method: 'HeapProfiler.enable' | 'HeapProfiler.collectGarbage' | 'HeapProfiler.takeHeapSnapshot'
    ): Promise<object>;
    on(event: 'HeapProfiler.addHeapSnapshotChunk', listener: (event: { chunk: string; }) => void): object;
    off(event: 'HeapProfiler.addHeapSnapshotChunk', listener: (event: { chunk: string; }) => void): object;
    detach(): Promise<void>;
}

export interface LiveRtcHeapCapture {
    readonly session: LiveRtcHeapSession;
    readonly path: string;
    readonly pageId: string;
    readonly cycle: 0 | 20;
    readonly now: () => number;
}

export interface LiveRtcHeapSnapshot {
    readonly pageId: string;
    readonly cycle: 0 | 20;
    readonly path: string;
    readonly postGcUsedBytes: number | undefined;
    readonly durationMs: number;
    readonly snapshotDurationMs: number | undefined;
    readonly byteSize: number;
    readonly captureErrors: readonly string[];
    readonly cleanupErrors: readonly string[];
}

export interface LiveRtcHeapDiagnosticConfig {
    readonly apiMode: string | undefined;
    readonly baselineId: string | undefined;
    readonly workers: number;
    readonly retries: number;
}

export function validateLiveRtcHeapDiagnostic(config: LiveRtcHeapDiagnosticConfig): readonly string[] {
    return [
        ...(config.apiMode === 'memory' ? [] : ['Heap ownership diagnostics require E3-memory.']),
        ...(config.baselineId === undefined ? [] : ['Heap ownership diagnostics cannot record acceptance evidence.']),
        ...(config.workers === 1 ? [] : ['Heap ownership diagnostics require one worker.']),
        ...(config.retries === 0 ? [] : ['Heap ownership diagnostics require zero retries.'])
    ];
}

export function createLiveRtcHeapDirectory(root: string, label: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(label)) {
        throw new Error('Heap diagnostic label must be a single safe path component.');
    }
    let directory = resolve(root);
    for (const component of ['tmp', 'perf', 'rtc-heap-owner']) {
        directory = join(directory, component);
        try {
            mkdirSync(directory, { mode: 0o700 });
        }
        catch (cause) {
            const error = toError(cause);
            if (!('code' in error && error.code === 'EEXIST')) {
                throw error;
            }
        }
        const metadata = lstatSync(directory);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new Error('Heap diagnostic directory must not contain a symlink.');
        }
    }
    const runDirectory = join(directory, label);
    mkdirSync(runDirectory, { mode: 0o700 });
    return runDirectory;
}

export async function captureLiveRtcHeapSnapshot(capture: LiveRtcHeapCapture): Promise<LiveRtcHeapSnapshot> {
    const writer = new HeapSnapshotWriter();
    const captureErrors: string[] = [];
    const cleanupErrors: string[] = [];
    let postGcUsedBytes: number | undefined;
    let snapshotStartedAt: number | undefined;
    let snapshotDurationMs: number | undefined;
    const startedAt = capture.now();
    const writeChunk = (event: { chunk: string; }): void => writer.writeChunk(event.chunk);
    try {
        writer.open(capture.path);
        capture.session.on('HeapProfiler.addHeapSnapshotChunk', writeChunk);
        await capture.session.send('HeapProfiler.enable');
        await capture.session.send('HeapProfiler.collectGarbage');
        postGcUsedBytes = (await capture.session.send('Runtime.getHeapUsage')).usedSize;
        snapshotStartedAt = capture.now();
        await capture.session.send('HeapProfiler.takeHeapSnapshot');
    }
    catch (cause) {
        captureErrors.push(toError(cause).message);
    }
    finally {
        snapshotDurationMs = snapshotStartedAt === undefined ? undefined : capture.now() - snapshotStartedAt;
        try {
            capture.session.off('HeapProfiler.addHeapSnapshotChunk', writeChunk);
        }
        catch (cause) {
            cleanupErrors.push(toError(cause).message);
        }
        cleanupErrors.push(...writer.close());
        try {
            await capture.session.detach();
        }
        catch (cause) {
            cleanupErrors.push(toError(cause).message);
        }
    }
    return {
        pageId: capture.pageId,
        cycle: capture.cycle,
        path: capture.path,
        postGcUsedBytes,
        durationMs: capture.now() - startedAt,
        snapshotDurationMs,
        byteSize: writer.byteSize,
        captureErrors: [...captureErrors, ...writer.errors],
        cleanupErrors
    };
}

class HeapSnapshotWriter {
    private descriptor: number | undefined;
    byteSize = 0;
    readonly errors: string[] = [];

    open(path: string): void {
        this.descriptor = openSync(path, 'wx', 0o600);
    }

    writeChunk(chunk: string): void {
        if (this.descriptor === undefined || this.errors.length > 0) {
            return;
        }
        try {
            // CDP event delivery cannot await backpressure. Synchronous chunk writes keep the
            // snapshot out of the Node write queue and bound memory to the current CDP chunk.
            const bytes = Buffer.from(chunk);
            let offset = 0;
            while (offset < bytes.length) {
                const written = writeSync(this.descriptor, bytes, offset, bytes.length - offset);
                if (written === 0) {
                    throw new Error('Heap snapshot write made no progress.');
                }
                offset += written;
                this.byteSize += written;
            }
        }
        catch (cause) {
            this.errors.push(toError(cause).message);
        }
    }

    close(): readonly string[] {
        if (this.descriptor === undefined) {
            return [];
        }
        try {
            closeSync(this.descriptor);
        }
        catch (cause) {
            return [toError(cause).message];
        }
        finally {
            this.descriptor = undefined;
        }
        return [];
    }
}
