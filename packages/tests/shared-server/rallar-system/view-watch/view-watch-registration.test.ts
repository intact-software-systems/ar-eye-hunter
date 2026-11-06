import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import {
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import type { ClientMutationCommandInput } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { toDisconnectClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-disconnect-client-session-mutation-input.ts';
import { toExpireClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-expire-client-session-mutation-input.ts';
import type { ClientExpiryAttempt } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-expiry-sequence.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { assertClientMutationInvariants } from '@shared-server/rallar-system/client-state/mutation/result-validation/assert-client-mutation.ts';
import { writeClientMutation } from '@shared-server/rallar-system/client-state/mutation/write-client-mutation.ts';
import { toClientSessionExpiryCandidate } from '@shared-server/rallar-system/presence/session-expiry.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { writeViewWatch } from '@shared-server/rallar-system/view-watch/view-watch-service.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { expect, it, vi } from 'vitest';
import { createResourceInboxTestStorage, type ResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import {
    computeValidatedViewWatch,
    createViewWatchTestRuntime,
    ref,
    scope,
    sessionWatchResource,
    viewWatchCommand,
    type ViewWatchTestRuntime
} from './view-watch-test-runtime.ts';

it(
    'registers a nonmember preview through AppInbox without adding discovery, seats or membership, and fences stale clear/replay',
    { timeout: 30_000 },
    async () => {
        const storage = await createResourceInboxTestStorage('view_watch_registration');
        try {
            const test = await createViewWatchTestRuntime(storage);
            const first = viewWatchCommand(test, 'first', null);
            expect(await test.run(first)).toEqual({ status: 'applied', requestId: 'first', registrationId: 'first', resourceId: ref.groupId });
            expect(await test.party.groups.findMember({ ...ref, principalId: 'bob' })).toBeUndefined();
            expect(await test.party.groups.findSessionIntentEntry(ref, 'bob')).toBeUndefined();
            expect(await test.party.groups.findSessionReservationsEntry(ref)).toBeUndefined();
            expect(await test.run(viewWatchCommand(test, 'replacement', 'first'))).toMatchObject({ status: 'applied', registrationId: 'replacement' });
            const stale = viewWatchCommand(test, 'stale-clear', 'first');
            expect(await test.run({ ...stale, request: { ...stale.request, resourceId: null } })).toEqual({
                status: 'conflict',
                requestId: 'stale-clear',
                registrationId: 'replacement',
                resourceId: ref.groupId
            });
            expect(await test.run(first)).toMatchObject({ status: 'applied', registrationId: 'first' });
            expect((await test.repository.readSlot({ ...scope, sessionId: 'session-bob', family: 'session-preview' }))?.value.registrationId).toBe(
                'replacement'
            );
            expect(await test.run(viewWatchCommand(test, 'restart', null))).toMatchObject({ status: 'conflict', registrationId: 'replacement' });
            const clear = viewWatchCommand(test, 'clear', 'replacement');
            expect(await test.run({ ...clear, request: { ...clear.request, resourceId: null } })).toMatchObject({
                status: 'applied',
                registrationId: null,
                resourceId: null
            });
            expect(await test.repository.listForResource(sessionWatchResource)).toEqual([]);
        }
        finally {
            await storage.close();
        }
    }
);

it('couples registration and domain mutations through the group predecessor in both commit orders', async () => {
    const storage = await createResourceInboxTestStorage('view_watch_race');
    try {
        const test = await createViewWatchTestRuntime(storage);
        const previous = (await test.party.groups.findGroupEntry(ref))!;
        const registration = computeValidatedViewWatch(await test.service.read(viewWatchCommand(test, 'register', null)));
        expect((await test.party.groups.updateGroup({ ...previous.value, displayName: 'Changed' }, previous.entry.revision)).status).toBe('applied');
        await expect(storage.sql.begin((transaction) => writeViewWatch(transaction, registration))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(await test.repository.listForResource(sessionWatchResource)).toEqual([]);
        const beforeWatch = (await test.party.groups.findGroupEntry(ref))!;
        await test.run(viewWatchCommand(test, 'register', null));
        expect((await test.party.groups.updateGroup({ ...beforeWatch.value, displayName: 'Stale write' }, beforeWatch.entry.revision)).status).toBe('conflict');
        expect((await test.repository.listForResource(sessionWatchResource)).map(({ value }) => value.principalId)).toEqual(['bob']);
    }
    finally {
        await storage.close();
    }
});

it('returns a terminal AppInbox403 for a superseded WebSocket generation', async () => {
    const storage = await createResourceInboxTestStorage('view_watch_denial');
    try {
        const test = await createViewWatchTestRuntime(storage);
        const request = viewWatchCommand(test, 'superseded', null);
        await expect(test.run({ ...request, request: { ...request.request, connectionGenerationId: 'previous-generation' } })).rejects.toMatchObject({
            status: 403,
            code: 'view-watch-authority-denied'
        });
        expect(await test.repository.listForResource(sessionWatchResource)).toEqual([]);
    }
    finally {
        await storage.close();
    }
});

it('retries a slot/resource read torn by a concurrent replacement and then returns the current token', async () => {
    const storage = await createResourceInboxTestStorage('view_watch_torn_read');
    try {
        const test = await createViewWatchTestRuntime(storage);
        await test.run(viewWatchCommand(test, 'first', null));
        const captured = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const readResource = test.repository.readResource.bind(test.repository);
        const spy = vi.spyOn(test.repository, 'readResource').mockImplementationOnce(async (previous) => {
            captured.resolve();
            await release.promise;
            return await readResource(previous);
        });
        const old = viewWatchCommand(test, 'old-owner', 'first');
        const pending = test.service.read(old).then(computeValidatedViewWatch);
        const observed = expect(pending).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        await captured.promise;
        await test.run(viewWatchCommand(test, 'replacement', 'first'));
        release.resolve();
        await observed;
        spy.mockRestore();
        expect(await test.run(old)).toMatchObject({ status: 'conflict', registrationId: 'replacement' });
    }
    finally {
        await storage.close();
    }
});

it('removes the current watch in the disconnect transaction and retries a concurrently replaced slot', async () => {
    const storage = await createResourceInboxTestStorage('view_watch_close');
    try {
        const test = await createViewWatchTestRuntime(storage);
        await test.run(viewWatchCommand(test, 'first', null));
        const stale = await prepareClientChange(test, storage, disconnect());
        await test.run(viewWatchCommand(test, 'replacement', 'first'));
        await expect(commitClientChange(storage, stale)).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        await commitClientChange(storage, await prepareClientChange(test, storage, disconnect()));
        expect(await test.repository.listForResource(sessionWatchResource)).toEqual([]);
        expect(await test.repository.readSlot({ ...scope, sessionId: 'session-bob', family: 'session-preview' })).toBeNull();
    }
    finally {
        await storage.close();
    }
});

it('leaves a new generation watch intact when an old close arrives and removes it on real expiry', async () => {
    const storage = await createResourceInboxTestStorage('view_watch_expiry');
    try {
        const test = await createViewWatchTestRuntime(storage);
        await test.run(viewWatchCommand(test, 'first', null));
        const previous =
            (await test.party.clients.findSessionEntry({ ...scope, principalId: 'bob', clientInstanceId: 'browser-bob', sessionId: 'session-bob' }))!;
        await test.party.clients.updateSession(
            { ...previous.value, generationId: 'new-generation', connectionId: 'new-generation', generationVersion: 2 },
            previous.entry.revision
        );
        const next = viewWatchCommand(test, 'new-watch', 'first');
        await test.run({ ...next, request: { ...next.request, connectionGenerationId: 'new-generation' } });
        const old = await prepareClientChange(test, storage, disconnect());
        expect(old.mutation.outcome).toBe('no-op');
        expect((await test.repository.listForResource(sessionWatchResource))[0].value.registrationId).toBe('new-watch');
        const current = (await test.party.clients.findSessionEntry(previous.value))!;
        test.party.clock.now = current.value.expiresAtEpochMs + 1;
        const expiry = toExpireClientSessionMutationInput(toClientSessionExpiryCandidate(current.value));
        await commitClientChange(storage, await prepareClientChange(test, storage, expiry));
        expect(await test.repository.listForResource(sessionWatchResource)).toEqual([]);
    }
    finally {
        await storage.close();
    }
});

it('rolls back watch removal and disconnected presence when the final state-sync outbox insert fails', async () => {
    const storage = await createResourceInboxTestStorage('view_watch_rollback');
    try {
        const test = await createViewWatchTestRuntime(storage);
        await test.run(viewWatchCommand(test, 'first', null));
        const attempt = await prepareClientChange(test, storage, disconnect());
        await storage.sql`create function reject_watch_close_notice() returns trigger language plpgsql as
            'begin return null; end'`;
        await storage.sql`create trigger reject_watch_close_notice before insert on resource_inbox for each row execute function reject_watch_close_notice()`;
        await expect(commitClientChange(storage, attempt)).rejects.toThrow();
        expect((await test.repository.listForResource(sessionWatchResource))[0].value.registrationId).toBe('first');
        expect(
            (await test.party.clients.findSessionEntry({ ...scope, principalId: 'bob', clientInstanceId: 'browser-bob', sessionId: 'session-bob' }))?.value
                .status
        ).toBe('active');
    }
    finally {
        await storage.close();
    }
});

function disconnect(): ClientMutationCommandInput {
    return toDisconnectClientSessionMutationInput({
        operation: 'disconnectSession',
        scope,
        principalId: 'bob',
        clientInstanceId: 'browser-bob',
        sessionId: 'session-bob',
        request: { generationId: 'generation-bob', requestId: 'watch-client-disconnect' },
        defaultCommandId: 'watch-client-disconnect'
    });
}

async function prepareClientChange(
    test: ViewWatchTestRuntime,
    storage: ResourceInboxTestStorage,
    input: ClientMutationCommandInput
): Promise<ClientExpiryAttempt> {
    const clients = createClientStateService({
        runtimeRepository: test.party.runtime,
        clientStateEventStore: new PSqlClientStateEventRepository(storage.sql),
        serviceId: 'watch-test',
        nowMs: () => test.party.clock.now
    });
    const session = test.party.sessions.find((session) => session.clientId === 'bob')!;
    const mutationCommand = toClientMutationCommand(
        input,
        {
            nowEpochMs: test.party.clock.now,
            expireAtEpochMs: test.party.clock.now + 60000,
            serviceId: 'watch-test',
            traceId: 'watch-client-test',
            eventId: input.commandId,
            attemptCount: 1,
            disconnectedSessionRetentionMs: 600000
        },
        input.operation === 'expireSession'
            ? toClientMutationSystemAuthority('watch-test')
            : toClientMutationIssuedSessionAuthority(session, scope, input.operation)
    );
    const read = await clients.read(mutationCommand);
    const mutation = computeClientMutation({ command: mutationCommand, read });
    assertClientMutationInvariants({ command: mutationCommand, read, computed: mutation });
    return { command: mutationCommand, read, mutation };
}

async function commitClientChange(storage: ResourceInboxTestStorage, attempt: ClientExpiryAttempt): Promise<void> {
    if (attempt.mutation.outcome !== 'write') {
        throw new Error('Expected a persisted session change');
    }
    const mutation = attempt.mutation;
    await storage.sql.begin((transaction) => writeClientMutation(transaction, mutation));
}

it('fences an absent-slot clear against registration using one auth-and-slot observation', async () => {
    const storage = await createResourceInboxTestStorage('view_watch_absent_clear');
    try {
        const test = await createViewWatchTestRuntime(storage);
        const captured = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const batch = test.party.runtime.readRuntimeStateBatch.bind(test.party.runtime);
        const spy = vi.spyOn(test.party.runtime, 'readRuntimeStateBatch').mockImplementationOnce(async (selectors) => {
            expect(selectors.map((selector) => selector.selectorId)).toEqual(['auth', 'slot']);
            const snapshot = await batch(selectors);
            captured.resolve();
            await release.promise;
            return snapshot;
        });
        const clear = viewWatchCommand(test, 'absent-clear', null);
        const request = { ...clear, request: { ...clear.request, resourceId: null } };
        const pending = test.service.read(request);
        await captured.promise;
        await test.run(viewWatchCommand(test, 'registration', null));
        release.resolve();
        const stale = computeValidatedViewWatch(await pending);
        spy.mockRestore();
        await expect(storage.sql.begin((transaction) => writeViewWatch(transaction, stale))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(await test.run(request)).toMatchObject({ status: 'conflict', registrationId: 'registration' });
    }
    finally {
        await storage.close();
    }
});

it('rejects stable slot/resource corruption rather than treating it as a replacement race', async () => {
    const storage = await createResourceInboxTestStorage('view_watch_corruption');
    try {
        const test = await createViewWatchTestRuntime(storage);
        await test.run(viewWatchCommand(test, 'first', null));
        const registration = (await test.repository.listForResource(sessionWatchResource))[0];
        await test.party.runtime.upsert({
            namespace: 'view-watch:resources',
            key: registration.entry.key,
            value: JSON.stringify({ ...registration.value, registrationId: 'corrupt' }),
            expireAtTimestamp: registration.entry.expireAtTimestamp
        });
        await expect(test.service.read(viewWatchCommand(test, 'next', 'first'))).rejects.toThrow(TypeError);
    }
    finally {
        await storage.close();
    }
});

it('cleans every closed watch family for the exact disconnected session generation', async () => {
    const storage = await createResourceInboxTestStorage('view_watch_family_cleanup');
    try {
        const test = await createViewWatchTestRuntime(storage);
        await test.run(viewWatchCommand(test, 'session-watch', null));
        const base = viewWatchCommand(test, 'tournament-watch', null);
        await test.run({ ...base, family: 'tournament', request: { ...base.request, resourceId: 'cup' } });
        await commitClientChange(storage, await prepareClientChange(test, storage, disconnect()));
        expect(await test.repository.listForResource(sessionWatchResource)).toEqual([]);
        expect(await test.repository.listForResource({ ...scope, family: 'tournament', resourceId: 'cup' })).toEqual([]);
    }
    finally {
        await storage.close();
    }
});
