import { describe, expect, it, vi } from 'vitest';

import { readBoundedLogTail } from '@shared-test/black-box-runner/api-v1-black-box-run.mts';

describe('managed API-v1 bounded log tail', () => {
    it('reads only the fixed-size suffix of a large production log tail', async () => {
        const bytes = new TextEncoder().encode('x'.repeat(16_384) + 'useful-tail');
        const reads: Array<{ offset: number; length: number; }> = [];
        const close = vi.fn();

        const tail = await readBoundedLogTail('/large/api-v1.log', {
            openFile: async (_path: string) => ({
                size: async () => bytes.byteLength,
                readAt: async (offset: number, target: Uint8Array) => {
                    reads.push({ offset, length: target.byteLength });
                    const source = bytes.subarray(offset, offset + target.byteLength);
                    target.set(source);
                    return source.byteLength;
                },
                close
            })
        });

        expect(reads).toEqual([
            {
                offset: bytes.byteLength - 4096,
                length: 4096
            }
        ]);
        expect(tail.endsWith('useful-tail')).toBe(true);
        expect(close).toHaveBeenCalledOnce();
    });

    it('continues partial bounded reads with advancing offsets and shrinking targets', async () => {
        const bytes = new TextEncoder().encode('x'.repeat(16_384) + 'useful-tail');
        const reads: Array<{ offset: number; length: number; }> = [];
        const close = vi.fn();
        const firstOffset = bytes.byteLength - 4096;

        const tail = await readBoundedLogTail('/partial/api-v1.log', {
            openFile: async () => ({
                size: async () => bytes.byteLength,
                readAt: async (offset: number, target: Uint8Array) => {
                    reads.push({ offset, length: target.byteLength });
                    const length = Math.min(1024, target.byteLength);
                    target.set(bytes.subarray(offset, offset + length));
                    return length;
                },
                close
            })
        });

        expect(reads).toEqual([
            { offset: firstOffset, length: 4096 },
            { offset: firstOffset + 1024, length: 3072 },
            { offset: firstOffset + 2048, length: 2048 },
            { offset: firstOffset + 3072, length: 1024 }
        ]);
        expect(tail.endsWith('useful-tail')).toBe(true);
        expect(close).toHaveBeenCalledOnce();
    });

    it('tolerates a UTF-8 suffix starting inside a multibyte code point', async () => {
        const bytes = new Uint8Array(4098).fill('x'.charCodeAt(0));
        bytes.set([0xe2, 0x82, 0xac], 0);
        const suffix = new TextEncoder().encode('useful-tail');
        bytes.set(suffix, bytes.byteLength - suffix.byteLength);
        const close = vi.fn();

        const tail = await readBoundedLogTail('/utf8/api-v1.log', {
            openFile: async () => ({
                size: async () => bytes.byteLength,
                readAt: async (offset: number, target: Uint8Array) => {
                    const source = bytes.subarray(offset, offset + target.byteLength);
                    target.set(source);
                    return source.byteLength;
                },
                close
            })
        });

        expect(tail.startsWith('\ufffd')).toBe(true);
        expect(tail.endsWith('useful-tail')).toBe(true);
        expect(close).toHaveBeenCalledOnce();
    });

    it.each(['size', 'readAt'] as const)(
        'closes the bounded tail file after %s failure',
        async (failure) => {
            const close = vi.fn();

            const tail = await readBoundedLogTail(`/failure/${failure}.log`, {
                openFile: async () => ({
                    size: async () => {
                        if (failure === 'size') {
                            throw new Error('size failed');
                        }
                        return 64;
                    },
                    readAt: async () => {
                        throw new Error('readAt failed');
                    },
                    close
                })
            });

            expect(tail).toContain(`unable to read /failure/${failure}.log`);
            expect(close).toHaveBeenCalledOnce();
        }
    );
});
