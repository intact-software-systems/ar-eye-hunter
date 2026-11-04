import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '@shared-server/rallar-system/auth/persistence/auth-storage-keys.ts';
import { CLIENT_STATE_SESSIONS_NAMESPACE } from '@shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts';
import { GROUPS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { computeViewWatch, type ViewWatchRead } from '@shared-server/rallar-system/view-watch/compute-view-watch.ts';
import { VIEW_WATCH_RESOURCES_NAMESPACE, VIEW_WATCH_SLOTS_NAMESPACE } from '@shared-server/rallar-system/view-watch/view-watch-repository.ts';
import { writeViewWatch } from '@shared-server/rallar-system/view-watch/view-watch-service.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { expect, it } from 'vitest';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createViewWatchTestRuntime, ref, viewWatchCommand, type ViewWatchTestRuntime } from './view-watch-test-runtime.ts';

it('rejects a captured release after auth, client and watch rows are physically collected and reissued at matching revisions', async () => {
    const storage = await createResourceInboxTestStorage('watch_authority_incarnation');
    try {
        const test = await createViewWatchTestRuntime(storage);
        const initial = { ...viewWatchCommand(test, 'old-watch', null), family: 'tournament' as const };
        await test.run(initial);
        const release = { ...initial, requestId: 'old-release', request: { ...initial.request, resourceId: null, expectedRegistrationId: 'old-watch' } };
        const read = await test.service.read(release);
        const computed = computeViewWatch(read);
        test.party.clock.now = read.auth!.value.expiresAtEpochMs + 1;
        const issuedAtEpochMs = test.party.clock.now;
        const expiresAtEpochMs = issuedAtEpochMs + 3600000;
        const auth = { ...read.auth!.value, issuedAtEpochMs, expiresAtEpochMs, accessTokenDigest: 'new-token-digest' };
        const client = { ...read.client!.value, generationId: 'new-generation', connectionId: 'new-generation', expiresAtEpochMs };
        await collectCapturedRows(storage.sql, read);
        await recreateBeforeRegistration(test, {
            namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            previous: read.auth!.entry,
            value: JSON.stringify(auth),
            expiresAtEpochMs
        });
        await recreateBeforeRegistration(test, {
            namespace: CLIENT_STATE_SESSIONS_NAMESPACE,
            previous: read.client!.entry,
            value: JSON.stringify(client),
            expiresAtEpochMs
        });
        const current = {
            ...initial,
            requestId: 'new-watch',
            sessionIssuedAtEpochMs: issuedAtEpochMs,
            sessionExpiresAtEpochMs: expiresAtEpochMs,
            request: { ...initial.request, connectionGenerationId: 'new-generation' }
        };
        await test.run(current);
        const fresh = await test.service.read({ ...current, request: { ...current.request, expectedRegistrationId: 'new-watch' } });
        expect(fresh.auth!.entry.revision).toBe(read.auth!.entry.revision);
        expect(fresh.client!.entry.revision).toBe(read.client!.entry.revision);
        expect(fresh.previous!.entry.revision).toBe(read.previous!.entry.revision);
        await expect(storage.sql.begin((transaction) => writeViewWatch(transaction, computed))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        const retained = await test.service.read({ ...current, request: { ...current.request, expectedRegistrationId: 'new-watch' } });
        expect(retained.auth!.value).toEqual(auth);
        expect(retained.client!.value).toEqual(client);
        expect(retained.previous!.value.registrationId).toBe('new-watch');
    }
    finally {
        await storage.close();
    }
});

it('rejects a pending first registration when only the client generation is collected and recreated', async () => {
    const storage = await createResourceInboxTestStorage('watch_client_incarnation');
    try {
        const test = await createViewWatchTestRuntime(storage);
        const command = viewWatchCommand(test, 'pending-first-watch', null);
        const read = await test.service.read(command);
        expect(read.previous).toBeNull();
        const computed = computeViewWatch(read);
        const client = { ...read.client!.value, generationId: 'replacement-generation', connectionId: 'replacement-generation' };
        const namespace = CLIENT_STATE_SESSIONS_NAMESPACE;
        await storage.sql`delete from runtime_state_store where store_namespace=${namespace} and store_key=${read.client!.entry.key}`;
        await recreateBeforeRegistration(test, {
            namespace,
            previous: read.client!.entry,
            value: JSON.stringify(client),
            expiresAtEpochMs: client.expiresAtEpochMs
        });
        await test.party.runtime.upsert({ namespace, key: read.client!.entry.key, value: JSON.stringify(client), expireAtTimestamp: client.expiresAtEpochMs });
        expect((await test.party.clients.findSessionEntry(client))!.entry.revision).toBe(read.client!.entry.revision);
        await expect(storage.sql.begin((transaction) => writeViewWatch(transaction, computed))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        const retained = await test.repository.readSession({ ...command.scope, sessionId: command.sessionId, family: command.family });
        expect(retained.auth).toEqual(read.auth);
        expect(retained.previous).toBeNull();
        expect((await test.party.clients.findSessionEntry(client))!.value).toEqual(client);
    }
    finally {
        await storage.close();
    }
});

it('rejects a pending preview registration after physical group deletion and a new incarnation at the same revision', async () => {
    const storage = await createResourceInboxTestStorage('watch_group_incarnation');
    try {
        const test = await createViewWatchTestRuntime(storage);
        const command = viewWatchCommand(test, 'pending-preview', null);
        const read = await test.service.read(command);
        const computed = computeViewWatch(read);
        const previous = (await test.party.groups.findGroupEntry(ref))!;
        const replacement = { ...previous.value, displayName: 'Recreated room', created: { ...previous.value.created, atEpochMs: test.party.clock.now } };
        await storage.sql`delete from runtime_state_store where store_namespace=${GROUPS_NAMESPACE} and store_key=${previous.entry.key}`;
        await test.party.groups.putGroup(replacement);
        expect((await test.party.groups.findGroupEntry(ref))!.entry.revision).toBe(previous.entry.revision);
        await expect(storage.sql.begin((transaction) => writeViewWatch(transaction, computed))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect((await test.party.groups.findGroupEntry(ref))!.value).toEqual(replacement);
        expect(await test.repository.readSlot({ ...command.scope, sessionId: command.sessionId, family: command.family })).toBeNull();
    }
    finally {
        await storage.close();
    }
});

async function collectCapturedRows(sql: PSqlSql, read: ViewWatchRead): Promise<void> {
    const rows = [
        { namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE, entry: read.auth!.entry },
        { namespace: CLIENT_STATE_SESSIONS_NAMESPACE, entry: read.client!.entry },
        { namespace: VIEW_WATCH_SLOTS_NAMESPACE, entry: read.previous!.entry },
        { namespace: VIEW_WATCH_RESOURCES_NAMESPACE, entry: read.previousResource!.entry }
    ];
    for (const row of rows) {
        await sql`delete from runtime_state_store where store_namespace=${row.namespace} and store_key=${row.entry.key}`;
    }
}

interface RecreatedWatchAuthority {
    readonly namespace: string;
    readonly previous: RuntimeStateEntry;
    readonly value: string;
    readonly expiresAtEpochMs: number;
}

async function recreateBeforeRegistration(test: ViewWatchTestRuntime, input: RecreatedWatchAuthority): Promise<void> {
    // Physical deletion resets revision; ordinary presence/auth writes can reach any previous revision again.
    for (let revision = 0; revision < input.previous.revision; revision++) {
        await test.party.runtime.upsert({ namespace: input.namespace, key: input.previous.key, value: input.value, expireAtTimestamp: input.expiresAtEpochMs });
    }
}
