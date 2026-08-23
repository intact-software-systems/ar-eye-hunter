import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const topologyConfigSource = readFileSync(
    'packages/shared-server/rallar-system/topology/config/mutation/write-topology-config-mutation.ts',
    'utf8'
);

describe('authoritative conditional-write structural contract', () => {
    it('keeps topology config writes on the caller transaction without an owned transaction or retry', () => {
        const writer = topologyConfigWriter();
        expect(writer).toMatch(/writeTopologyConfigMutation\(\s*transaction:\s*PSqlSql/);
        expect(writer).not.toMatch(/\.begin\s*\(/);
        expect(writer).not.toMatch(/waitForRuntimeStateWriteRetry/);
        expect(writer).not.toMatch(/for\s*\([^)]*attempt/);
    });

    it('advances the authority fence before conditional state, receipt, and APP_OUTBOX writes', () => {
        expectInOrder(topologyConfigWriter(), [
            'writeTopologyConfigAuthorityFence(runtime, computed)',
            'writeTopologyConfigState(repository, computed)',
            'insertMutationRecord(computed.idempotency)',
            'writeRtcTopologyOutbox(transaction, computed.outbox)'
        ]);
        expectInOrder(topologyConfigAuthorityFence(), [
            'advanceGroupStateAuthorityFence(',
            'computed.groupAuthorityGuard',
            'throw new RuntimeStateWriteConflictError()'
        ]);
        expectInOrder(topologyConfigStateWriter(), [
            'writeTopologyConfigTarget(repository, computed)',
            'commitInvariantGeneration(',
            'computed.invariantGenerationGuard.expectedRevision',
            'commitGeneration(',
            'computed.generationGuard.expectedRevision'
        ]);
        expectInOrder(topologyConfigTargetWriter(), [
            'const guard = computed.guard',
            'guard.expectedRevision'
        ]);
    });

    it('writes direct immutable APP_OUTBOX work without an intermediate mutation intent', () => {
        const writer = topologyConfigWriter();
        expect(writer).not.toContain('StateMutation' + 'Outbox');
        expect(writer).not.toContain('materializeTopologyConfigGuardedBatch');
        expect(writer).not.toContain('executeGuardedBatch');
        expect(writer).toContain('writeRtcTopologyOutbox(transaction, computed.outbox)');
    });
});

function topologyConfigWriter(): string {
    const start = topologyConfigSource.indexOf('export async function writeTopologyConfigMutation');
    if (start < 0) {
        throw new Error('Missing topology config writer');
    }
    return topologyConfigSource.slice(start);
}

function topologyConfigAuthorityFence(): string {
    return functionSource('writeTopologyConfigAuthorityFence');
}

function topologyConfigStateWriter(): string {
    return functionSource('writeTopologyConfigState');
}

function topologyConfigTargetWriter(): string {
    return functionSource('writeTopologyConfigTarget');
}

function functionSource(name: string): string {
    const start = topologyConfigSource.indexOf(`function ${name}`);
    if (start < 0) {
        throw new Error(`Missing ${name}`);
    }
    const next = topologyConfigSource.indexOf('\nasync function ', start + 1);
    return topologyConfigSource.slice(start, next < 0 ? undefined : next);
}

function expectInOrder(source: string, markers: readonly string[]): void {
    let cursor = -1;
    for (const marker of markers) {
        const index = source.indexOf(marker, cursor + 1);
        expect(index, `Missing or reordered marker: ${marker}`).toBeGreaterThan(cursor);
        cursor = index;
    }
}
