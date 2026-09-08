import {
    describe,
    expect,
    it
} from 'vitest';
import { isValidPersistedResult, validateReceiptResultBindings } from '../../../../../scripts/perf/api-v1-state-write-result-binding.mjs';
import {
    binding,
    durableResult,
    type StateWriteResultBinding
} from './test-support/state-write-performance-result-fixture.ts';

describe('API-v1 state-write persisted result binding', () => {
    it('rejects missing command or invalid receipt identity arrays at its own boundary', () => {
        const command = { kind: 'membership', commandId: 'request' } as const;
        const resultBinding = binding(command, 'command');
        for (
            const input of [
                { command: undefined, receipt: { receiptIds: ['receipt'], resultBindings: [resultBinding] } },
                { command, receipt: { receiptIds: { toString: 0 }, resultBindings: [resultBinding] } }
            ]
        ) {
            const errors: string[] = [];
            expect(() => validateReceiptResultBindings({ ...input, path: 'sample', index: 0, errors })).not.toThrow();
            expect(errors).toContainEqual(expect.stringContaining('sample.durableEvidence.receipts[0]'));
        }
    });

    it('rejects the removed nested Either success envelope', () => {
        const command = {
            kind: 'membership',
            commandId: 'nested-predecessor-result',
            commandType: 'GROUP_MEMBER_UPSERT',
            operationId: 'command'
        } as const;
        const currentResult = durableResult(command, command.operationId);
        if (!('status' in currentResult)) {
            throw new Error('Expected complete membership result fixture');
        }
        const predecessorResult = {
            status: currentResult.status,
            result: { right: currentResult.result }
        };

        expect(isValidPersistedResult(
            {
                commandId: command.commandId,
                commandType: command.commandType,
                durableResult: predecessorResult
            },
            command,
            binding(command, command.operationId)
        )).toBe(false);
    });

    it.each(
        [
            { kind: 'profile-instance', commandType: 'CLIENT_INSTANCE_UPSERT', operationId: 'instance' },
            { kind: 'membership', commandType: 'GROUP_MEMBER_UPSERT', operationId: 'command' }
        ] as const
    )('rejects a complete $kind result swapped from another command', (shape) => {
        const first = { ...shape, commandId: `first:${shape.kind}` };
        const second = { ...shape, commandId: `second:${shape.kind}` };
        const swappedEntry = {
            commandId: first.commandId,
            commandType: shape.commandType,
            durableResult: durableResult(second, shape.operationId)
        };
        expect(isValidPersistedResult(
            swappedEntry,
            first,
            binding(first, shape.operationId)
        )).toBe(false);
    });

    it.each([
        mutateTopologyKind,
        mutateAcceptedCausalRevision,
        (value: StateWriteResultBinding) => value.outcome = 'no-op',
        (value: StateWriteResultBinding) => value.outboxIds = ['invented-effect']
    ])('rejects malformed topology receipt truth', (mutate) => {
        const command = { kind: 'topology-source', commandId: 'topology-command' } as const;
        const authoritative = binding(command, 'command');
        mutate(authoritative);
        const errors: string[] = [];
        validateReceiptResultBindings({
            receipt: {
                commandId: command.commandId,
                receiptIds: [command.commandId],
                resultBindings: [authoritative]
            },
            command,
            path: 'sample',
            index: 0,
            errors
        });
        expect(errors).not.toEqual([]);
    });
});

function mutateTopologyKind(value: StateWriteResultBinding): void {
    if (!value.acceptedConfig) {
        throw new Error('Expected accepted topology config fixture');
    }
    value.acceptedConfig.topologyKind = 'invented';
}

function mutateAcceptedCausalRevision(value: StateWriteResultBinding): void {
    if (!value.acceptedCausalRevision) {
        throw new Error('Expected accepted topology causal revision fixture');
    }
    Reflect.set(value.acceptedCausalRevision, 'unexpected', 1);
}
