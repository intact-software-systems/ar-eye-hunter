import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';

export function decodeAlmRuntimeRecord(value: unknown): RallarBlackBoxTestRecord {
    return typeof value === 'object' && value !== null
        ? value as RallarBlackBoxTestRecord
        : {};
}
