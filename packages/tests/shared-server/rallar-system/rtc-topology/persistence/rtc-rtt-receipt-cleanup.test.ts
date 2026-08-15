import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('RTC RTT receipt cleanup ownership', () => {
    it('keeps receipt-family cleanup reads and validation outside its write transaction', () => {
        const source = readFileSync(
            new URL(
                '../../../../../shared-server/rallar-system/repositories/RtcRttRepository.ts',
                import.meta.url,
            ),
            'utf8',
        );
        const cleanupStart = source.indexOf(
            'private async cleanupExpiredReceiptFamily(',
        );
        const writeStart = source.indexOf(
            'private async writeExpiredReceiptFamilyCleanup(',
            cleanupStart,
        );
        const cleanupSection = source.slice(cleanupStart, writeStart);
        const readIndex = cleanupSection.indexOf(
            'await this.readExpiredReceiptFamilyCleanup(',
        );
        const computeIndex = cleanupSection.indexOf(
            'this.computeExpiredReceiptFamilyCleanup(',
        );
        const validateIndex = cleanupSection.indexOf(
            'this.validateExpiredReceiptFamilyCleanup(',
        );
        const writeIndex = cleanupSection.indexOf(
            'await this.writeExpiredReceiptFamilyCleanup(',
        );

        expect(cleanupStart).toBeGreaterThanOrEqual(0);
        expect(writeStart).toBeGreaterThan(cleanupStart);
        expect([readIndex, computeIndex, validateIndex, writeIndex]).toEqual(
            [
                ...new Set([
                    readIndex,
                    computeIndex,
                    validateIndex,
                    writeIndex,
                ]),
            ].toSorted((left, right) => left - right),
        );
        expect(readIndex).toBeGreaterThanOrEqual(0);

        const writeEnd = source.indexOf(
            '\n    }\n}\n\nexport function',
            writeStart,
        );
        const writeSection = source.slice(writeStart, writeEnd);
        expect(writeSection).toContain('runtime.begin(');
        expect(writeSection).not.toMatch(/\.findEntry|\.findEntriesByPrefix/);
        expect(writeSection.indexOf('.upsertIfRevision(')).toBeLessThan(
            writeSection.indexOf('.deleteIfRevision('),
        );
    });
});
