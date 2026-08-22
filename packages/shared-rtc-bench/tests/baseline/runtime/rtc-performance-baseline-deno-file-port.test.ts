import { describe, expect, it } from 'vitest';

import { createRtcBaselineDenoFilePort } from '../../../baseline/runtime/rtc-baseline-deno-file-port.ts';
import type { RtcBaselineDenoFile, RtcBaselineDenoPort } from '../../../baseline/runtime/rtc-baseline-deno-port.ts';

class AlreadyExists extends Error {}

function createFileDouble(input: { readonly dev?: number; readonly ino?: number; } = {}) {
    let bytes = new Uint8Array([1, 2, 3]);
    let position = 0;
    const events: string[] = [];
    const file: RtcBaselineDenoFile = {
        stat: async () => ({
            isFile: true,
            isDirectory: false,
            isSymlink: false,
            dev: input.dev ?? 10,
            ino: input.ino ?? 20,
            size: bytes.length
        }),
        seek: async (offset) => {
            position = offset;
            return position;
        },
        read: async (buffer) => {
            const available = bytes.subarray(position, position + buffer.length);
            buffer.set(available);
            position += available.length;
            return available.length === 0 ? null : available.length;
        },
        write: async (value) => {
            const requiredLength = position + value.length;
            if (requiredLength > bytes.length) {
                const expanded = new Uint8Array(requiredLength);
                expanded.set(bytes);
                bytes = expanded;
            }
            bytes.set(value, position);
            position += value.length;
            return value.length;
        },
        truncate: async (length = 0) => {
            bytes = bytes.slice(0, length);
        },
        sync: async () => {
            events.push('sync');
        },
        lock: async (exclusive) => {
            events.push(`lock:${String(exclusive)}`);
        },
        tryLock: async (exclusive) => {
            events.push(`try-lock:${String(exclusive)}`);
            return true;
        },
        unlock: async () => {
            events.push('unlock');
        },
        close: () => {
            events.push('close');
        }
    };
    return { file, events, readBytes: () => bytes };
}

function createRuntimeDouble(file: RtcBaselineDenoFile, existing = true) {
    const events: string[] = [];
    const unused = async (): Promise<never> => {
        throw new Error('Unused Deno runtime operation.');
    };
    const runtime: RtcBaselineDenoPort = {
        envGet: () => undefined,
        build: { os: 'darwin', arch: 'aarch64' },
        version: { deno: '2.4.0' },
        pid: 123,
        hostname: () => 'runner-a',
        randomUuid: () => '00000000-0000-4000-8000-000000000001',
        kill: () => undefined,
        errors: { AlreadyExists },
        async lstat(path: string) {
            events.push(`lstat:${path}`);
            return {
                isFile: true,
                isDirectory: false,
                isSymlink: false,
                dev: 10,
                ino: 20,
                size: 3
            };
        },
        async open(path: string, options: { createNew?: boolean; }) {
            events.push(`open:${path}:createNew=${String(options.createNew)}`);
            if (options.createNew && existing) {
                throw new AlreadyExists();
            }
            return file;
        },
        mkdir: unused,
        readFile: unused,
        writeFile: unused,
        remove: unused,
        async *readDir(): AsyncIterable<never> {
            throw new Error('Unused Deno runtime operation.');
        },
        command: unused,
        now: () => new Date('2026-08-07T10:00:00.000Z'),
        performanceNow: () => 0,
        systemMemoryInfo: () => ({ total: 1 }),
        availableParallelism: () => 1
    };
    return { runtime, events };
}

describe('RTC baseline Deno file lock port', () => {
    it('waits for the advisory lock when this process atomically created the lock file', async () => {
        const fileDouble = createFileDouble();
        const runtimeDouble = createRuntimeDouble(fileDouble.file, false);
        const port = createRtcBaselineDenoFilePort(runtimeDouble.runtime);

        const lock = await port.tryAcquireExclusiveFileLock('/evidence/.writer.lock');

        expect(lock?.created).toBe(true);
        expect(fileDouble.events).toEqual(['lock:true']);
        await lock?.release();
    });

    it('locks the inspected file identity and performs durable handle-scoped metadata I/O', async () => {
        const fileDouble = createFileDouble();
        const runtimeDouble = createRuntimeDouble(fileDouble.file);
        const port = createRtcBaselineDenoFilePort(runtimeDouble.runtime);

        const lock = await port.tryAcquireExclusiveFileLock('/evidence/.writer.lock');

        expect(lock?.created).toBe(false);
        expect(await lock?.readBytes()).toEqual(new Uint8Array([1, 2, 3]));
        await lock?.writeBytes(new Uint8Array([4, 5]));
        expect(fileDouble.readBytes()).toEqual(new Uint8Array([4, 5]));
        await lock?.release();
        expect(runtimeDouble.events).toEqual([
            'open:/evidence/.writer.lock:createNew=true',
            'lstat:/evidence/.writer.lock',
            'open:/evidence/.writer.lock:createNew=undefined',
            'lstat:/evidence/.writer.lock',
            'lstat:/evidence/.writer.lock'
        ]);
        expect(fileDouble.events).toEqual(['try-lock:true', 'sync', 'unlock', 'close']);
    });

    it('rejects a path-to-handle identity swap before attempting the advisory lock', async () => {
        const fileDouble = createFileDouble({ ino: 21 });
        const runtimeDouble = createRuntimeDouble(fileDouble.file);
        const port = createRtcBaselineDenoFilePort(runtimeDouble.runtime);

        await expect(port.tryAcquireExclusiveFileLock('/evidence/.writer.lock')).rejects.toThrow(
            'Writer lock path changed while it was being opened.'
        );
        expect(fileDouble.events).toEqual(['close']);
    });

    it('closes the file and reports contention when the advisory lock is held', async () => {
        const fileDouble = createFileDouble();
        fileDouble.file.tryLock = async () => false;
        const runtimeDouble = createRuntimeDouble(fileDouble.file);
        const port = createRtcBaselineDenoFilePort(runtimeDouble.runtime);

        expect(await port.tryAcquireExclusiveFileLock('/evidence/.writer.lock')).toBeNull();
        expect(fileDouble.events).toEqual(['close']);
    });
});
