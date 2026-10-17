import { createReadStream } from 'node:fs';
import {
    mkdtemp,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    readRecorderJsonlRows,
    toRecorderJsonlRow,
    type RecorderJsonlRead
} from '@shared-test/black-box-runner/artifacts/read-recorder-jsonl-rows.ts';

const RECORD_BYTES = 8_388_608;

async function* toBytes(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
    yield* chunks;
}

describe('strict recorder JSONL byte decoding', () => {
    it('keeps split Unicode, blank framing, final unterminated row and exact source facts', async () => {
        const bytes = Buffer.from(' \n{"name":"blåbær"}\r\n\n{"last":true}');
        const split = bytes.indexOf(Buffer.from('å')) + 1;
        const reads = await Array.fromAsync(readRecorderJsonlRows(toBytes([bytes.subarray(0, split), bytes.subarray(split)]), RECORD_BYTES));
        expect(reads.map((read) => read.right)).toEqual([
            { kind: 'row', row: { name: 'blåbær' }, bytesRead: bytes.length, decodedRecords: 1 },
            { kind: 'row', row: { last: true }, bytesRead: bytes.length, decodedRecords: 2 },
            { kind: 'complete', bytesRead: bytes.length, decodedRecords: 2 }
        ]);
    });

    it('preserves number normalization recursively without changing string content', async () => {
        expect(toRecorderJsonlRow('{"positive":1e400,"negative":-1e400,"zero":-0,"nested":[-0,{"text":"-0"}]}')).toEqual({
            positive: null,
            negative: null,
            zero: 0,
            nested: [0, { text: '-0' }]
        });
        expect(Object.is(toRecorderJsonlRow('{"zero":-0}')?.zero, -0)).toBe(false);
    });

    it.each(['json', 'array', 'scalar', 'utf8', 'oversized'])('refuses %s before or after otherwise valid records and closes the source', async (variant) => {
        const corrupt = variant === 'json'
            ? Buffer.from('{broken\n')
            : variant === 'array'
            ? Buffer.from('[]\n')
            : variant === 'scalar'
            ? Buffer.from('false\n')
            : variant === 'utf8'
            ? Buffer.from([0xc3])
            : Buffer.from(' '.repeat(RECORD_BYTES + 1));
        for (const after of [false, true]) {
            let closed = false;
            async function* source(): AsyncGenerator<Uint8Array> {
                try {
                    if (after) {
                        yield Buffer.from('{"first":true}\n');
                    }
                    yield corrupt;
                    yield Buffer.from('{"later":true}\n');
                }
                finally {
                    closed = true;
                }
            }
            const reads = await Array.fromAsync(readRecorderJsonlRows(source(), RECORD_BYTES));
            expect(reads.at(-1)?.left?.code).toBe(variant === 'oversized' ? 'input-limit' : 'malformed-jsonl');
            expect(reads.some((read) => read.right?.kind === 'complete')).toBe(false);
            expect(reads.filter((read) => read.right?.kind === 'row')).toHaveLength(after ? 1 : 0);
            expect(closed).toBe(true);
        }
    });

    it('refuses an incomplete Unicode sequence at EOF and reports stream failures as values', async () => {
        const truncated = await Array.fromAsync(readRecorderJsonlRows(toBytes([Buffer.from('{"first":true}\n'), Buffer.from([0xc3])]), RECORD_BYTES));
        expect(truncated.at(-1)?.left?.code).toBe('malformed-jsonl');
        async function* interrupted(): AsyncGenerator<Uint8Array> {
            yield Buffer.from('{"first":true}\n');
            throw new Error('owned stream failed');
        }
        const reads = await Array.fromAsync(readRecorderJsonlRows(interrupted(), RECORD_BYTES));
        expect(reads.at(-1)?.left).toMatchObject({ code: 'runtime-read-failed', decodedRecords: 1 });
        expect(reads.some((read) => read.right?.kind === 'complete')).toBe(false);
    });

    it('allows the exact per-record limit after another row, with or without a newline', async () => {
        const row = '{"padding":"' + 'x'.repeat(RECORD_BYTES - 14) + '"}';
        expect(Buffer.byteLength(row)).toBe(RECORD_BYTES);
        for (const suffix of ['', '\n']) {
            const reads = await Array.fromAsync(readRecorderJsonlRows(toBytes([Buffer.from('{}\n' + row + suffix)]), RECORD_BYTES));
            expect(reads.at(-1)?.right).toMatchObject({ kind: 'complete', decodedRecords: 2 });
        }
    });

    it('has no aggregate byte or record ceiling', async () => {
        const line = Buffer.from('{"padding":"' + 'x'.repeat(3200) + '"}\n');
        async function* large(): AsyncGenerator<Uint8Array> {
            for (let index = 0; index < 21_000; index += 1) {
                yield line;
            }
        }
        let complete: RecorderJsonlRead | undefined;
        for await (const read of readRecorderJsonlRows(large(), RECORD_BYTES)) {
            expect(read.left).toBeUndefined();
            if (read.right?.kind === 'complete') {
                complete = read.right;
            }
        }
        expect(complete).toEqual({ kind: 'complete', bytesRead: line.length * 21_000, decodedRecords: 21_000 });
        expect(complete?.bytesRead).toBeGreaterThan(67_108_864);
    });

    it('reports clean empty EOF and closes a real file stream when malformed input stops admission', async () => {
        const empty = await Array.fromAsync(readRecorderJsonlRows(toBytes([]), RECORD_BYTES));
        expect(empty[0]?.right).toEqual({ kind: 'complete', bytesRead: 0, decodedRecords: 0 });
        const directory = await mkdtemp(join(tmpdir(), 'recorder-jsonl-'));
        try {
            const path = join(directory, 'events.jsonl');
            await writeFile(path, '{broken\n' + '{}\n'.repeat(100));
            const source = createReadStream(path, { highWaterMark: 16 });
            const reads = await Array.fromAsync(readRecorderJsonlRows(source, RECORD_BYTES));
            expect(reads.at(-1)?.left?.code).toBe('malformed-jsonl');
            expect(source.destroyed).toBe(true);
            const missing = createReadStream(join(directory, 'missing.jsonl'));
            const failed = await Array.fromAsync(readRecorderJsonlRows(missing, RECORD_BYTES));
            expect(failed.at(-1)?.left?.code).toBe('runtime-read-failed');
            expect(missing.destroyed).toBe(true);
        }
        finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
