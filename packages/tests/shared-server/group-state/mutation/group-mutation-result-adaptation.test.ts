import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { type GroupStateMutationCommand } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/state-events/state-event-store.ts';
import type { CreateGroupRequest } from '@shared/api/state-types.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { GroupStateTestMutationExecutor } from '../group-state-test-mutation-executor.ts';
import { createTestAuthSession, createTestGroupStateRuntime, type TestGroupStateRuntime } from '../group-state-test-runtime.ts';
import { SCOPE } from './group-mutation-test-runtime.ts';

describe('group mutation result adaptation', () => {
    it('constructs one result repository and shares its event view across result branches', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const persistedEvents = new InMemoryGroupStateEventStore();
        let observeResultAdapter = false;
        let resultStoreCreations = 0;
        const createGroupStateEventStore = () => {
            if (!observeResultAdapter) {
                return persistedEvents;
            }
            resultStoreCreations += 1;
            const resultView = new InMemoryGroupStateEventStore();
            if (resultStoreCreations === 1) {
                resultView.events.push(...persistedEvents.events);
            }
            return resultView;
        };
        const runtime = createTestGroupStateRuntime({
            runtimeRepository,
            createGroupStateEventStore,
            now: () => 1_000,
            randomId: () => 'result-adapter-id',
            serviceId: 'group-service'
        });
        const request: CreateGroupRequest = {
            groupId: 'result-adapter-room',
            displayName: 'Result Adapter Room',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: 'result-adapter-create'
        };
        await runtime.service.createGroup(SCOPE, request);
        const computed = await computeCreateReplay(runtime, request);
        const executor = new GroupStateTestMutationExecutor({
            durableService: runtime.durable,
            runtimeRepository,
            createGroupStateEventStore,
            serviceId: 'group-service',
            randomId: () => 'unused-result-id'
        });

        observeResultAdapter = true;
        const written = await executor.toMutationResult('createGroup', computed);
        expect.soft(resultStoreCreations).toBe(1);
        expect.soft(written.result?.snapshot.group.groupId).toBe('result-adapter-room');
        expect.soft(written.result?.event?.eventId).toBe(computed.receipt.eventId);

        resultStoreCreations = 0;
        const receipt = await executor.toMutationResult('createGroup', computed, true);
        expect.soft(resultStoreCreations).toBe(1);
        expect(receipt).toBe(computed.receipt);
    });
});

async function computeCreateReplay(runtime: TestGroupStateRuntime, request: CreateGroupRequest) {
    const authority = createTestAuthSession('alice');
    const prepared = await runtime.durable.prepareMutation(
        mutationDescriptor('createGroup', SCOPE, request.groupId, request),
        authority
    );
    const command: GroupStateMutationCommand = {
        authorityProof: prepared.authorityProof,
        descriptor: prepared.descriptor,
        command: prepared.command,
        facts: { ...prepared.facts, attemptCount: 1 }
    };
    const read = await runtime.durable.read(command);
    const computed = runtime.durable.compute(command, read);
    runtime.durable.validate(command, read, computed);
    if (computed.outcome === 'idempotency-conflict') {
        throw new Error('Expected an idempotent create replay');
    }
    return computed;
}
