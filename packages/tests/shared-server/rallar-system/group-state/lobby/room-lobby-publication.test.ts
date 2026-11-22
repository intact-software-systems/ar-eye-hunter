import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { computeGroupLobbyPublication } from '@shared-server/rallar-system/group-state/lobby/compute-group-lobby-publication.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';
import { expect, it } from 'vitest';

const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'court' };
const facts = {
    roomRef, groupCreatedAtEpochMs: 1000, createdAtEpochMs: 2000, retentionMs: 60000,
    serviceId: 'api', traceId: 'trace'
};
const window = { generation: 5, dueAtEpochMs: 122000 };
const present = { offerWindow: null, principalId: 'bob', present: true, admissionWindow: null, returnWindow: null };
const alice = { ...present, principalId: 'alice', present: false };

it('publishes the changed private seat across rooms and persists one wake per newly opened window', () => {
    const before = { registration: { revision: 0, atEpochMs: null, closed: false }, capacityClaims: null, waiters: [], expiresAtEpochMs: null, activationId: 'enabled', revision: 4, seats: [alice, present] };
    const after = { registration: { revision: 0, atEpochMs: null, closed: false }, capacityClaims: null, waiters: [], expiresAtEpochMs: null, activationId: 'enabled', revision: 5, seats: [{ ...alice, returnWindow: window }, present] };
    const result = computeGroupLobbyPublication({ ...facts, before, after });
    const entries = result.outbox.map(row => ({ row, message: decodePersistedALMessage(row.entry.resource) }));
    const notices = entries.filter(({ message }) => message.payload.typeId === AppTopics.viewInvalidated);
    expect(notices.map(({ message }) => decodeViewInvalidationMessage(message))).toEqual([
        expect.objectContaining({ resource: 'room-lobby', scope: { applicationId: 'app', workspaceId: 'workspace' }, principalId: 'alice' })
    ]);
    const deadlines = entries.filter(({ message }) => message.payload.typeId === AppOutboxType.ROOM_LOBBY_DEADLINE);
    expect(deadlines.map(({ row }) => row.entry.dequeueAudit.nextTs?.epochMilliseconds)).toEqual([122000]);
    expect(JSON.parse(deadlines[0]!.message.payload.resource)).toEqual({
        kind: 'seat', roomRef, activationId: 'enabled', groupCreatedAtEpochMs: 1000, generation: 5, dueAtEpochMs: 122000
    });
    expect(computeGroupLobbyPublication({ ...facts, before: after, after }).outbox).toEqual([]);
});

it('coalesces simultaneous return deadlines and notifies former holders when the lobby closes', () => {
    const away = { ...alice, principalId: 'chris', returnWindow: window };
    const after = { registration: { revision: 0, atEpochMs: null, closed: false }, capacityClaims: null, waiters: [], expiresAtEpochMs: null, activationId: 'enabled', revision: 5, seats: [{ ...alice, returnWindow: window }, away] };
    const opened = computeGroupLobbyPublication({ ...facts, before: null, after });
    expect(opened.outbox.map(row => decodePersistedALMessage(row.entry.resource).payload.typeId).sort())
        .toEqual([AppOutboxType.ROOM_LOBBY_DEADLINE, AppTopics.viewInvalidated, AppTopics.viewInvalidated].sort());
    const closed = computeGroupLobbyPublication({ ...facts, before: after, after: null });
    expect(closed.outbox.map(row => decodeViewInvalidationMessage(decodePersistedALMessage(row.entry.resource)).principalId).sort())
        .toEqual(['alice', 'chris']);
});

it('schedules a replacement generation without notifying a participant whose visible deadline is unchanged', () => {
    const before = { registration: { revision: 0, atEpochMs: null, closed: false }, capacityClaims: null, waiters: [], expiresAtEpochMs: null, activationId: 'enabled', revision: 5, seats: [{ ...alice, returnWindow: window }] };
    const after = { registration: { revision: 0, atEpochMs: null, closed: false }, capacityClaims: null, waiters: [], expiresAtEpochMs: null, activationId: 'enabled', revision: 6, seats: [{ ...alice, returnWindow: { ...window, generation: 6 } }] };
    const publication = computeGroupLobbyPublication({ ...facts, before, after });
    expect(publication.outbox.map(row => decodePersistedALMessage(row.entry.resource).payload.typeId))
        .toEqual([AppOutboxType.ROOM_LOBBY_DEADLINE]);
});

it('fences reenabled holds even when the same revision and deadline recur', () => {
    const occupied = { registration: { revision: 0, atEpochMs: null, closed: false }, capacityClaims: null, waiters: [], expiresAtEpochMs: null, activationId: 'enabled', revision: 5, seats: [{ ...alice, returnWindow: window }] };
    const first = computeGroupLobbyPublication({ ...facts, before: null, after: { ...occupied, activationId: 'first' } });
    const reopened = computeGroupLobbyPublication({ ...facts, before: null, after: { ...occupied, activationId: 'second' } });
    const oldIds = first.outbox.map(row => row.entry.key.resourceId);
    expect(reopened.outbox.map(row => row.entry.key.resourceId).filter(id => oldIds.includes(id))).toEqual([]);
});

it('persists a room closure without a seat timer, and schedules its new boundary on renewal', () => {
    const initial = { registration: { revision: 0, atEpochMs: null, closed: false }, capacityClaims: null, waiters: [], revision: 1, activationId: 'lobby', expiresAtEpochMs: 2100, seats: [present] };
    const renewed = { ...initial, expiresAtEpochMs: 3100, revision: 2 };
    const restored = { ...initial, revision: 3 };
    const ids = [];
    for (const [before, after] of [[null, initial], [initial, renewed], [renewed, restored]] as const) {
        const publication = computeGroupLobbyPublication({ ...facts, before, after });
        const deadlines = publication.outbox.map(row => decodePersistedALMessage(row.entry.resource))
            .filter(message => message.payload.typeId === AppOutboxType.ROOM_LOBBY_DEADLINE);
        ids.push(...deadlines.map(message => message.id.msgId));
        expect(deadlines.map(message => JSON.parse(message.payload.resource))).toEqual([
            { kind: 'room', generation: after.revision, roomRef, groupCreatedAtEpochMs: 1000, activationId: 'lobby', dueAtEpochMs: after.expiresAtEpochMs }
        ]);
    }
    expect(new Set(ids).size).toBe(3);
});

it('notifies only the two affected holders and schedules a durable wake for an offered seat', () => {
    const before = { registration: { revision: 0, atEpochMs: null, closed: false }, expiresAtEpochMs: null, activationId: 'lobby', revision: 4, seats: [present], capacityClaims: null, waiters: [{ principalId: 'alice', generation: 3, eligibleUntilEpochMs: null }, { principalId: 'chris', generation: 4, eligibleUntilEpochMs: null }] };
    const after = { ...before, revision: 5, seats: [{ ...alice, offerWindow: window }], waiters: before.waiters.slice(1) };
    const messages = computeGroupLobbyPublication({ ...facts, before, after }).outbox
        .map(row => decodePersistedALMessage(row.entry.resource));
    expect(messages.filter(message => message.payload.typeId === AppTopics.viewInvalidated)
        .map(message => decodeViewInvalidationMessage(message).principalId).sort()).toEqual(['alice', 'bob']);
    expect(messages.filter(message => message.payload.typeId === AppOutboxType.ROOM_LOBBY_DEADLINE)
        .map(message => JSON.parse(message.payload.resource))).toEqual([
            { kind: 'seat', roomRef, groupCreatedAtEpochMs: 1000, activationId: 'lobby', ...window }
        ]);
});

it('arms one durable registration cutoff and gives a rescheduled cutoff a distinct identity', () => {
    const initial = { expiresAtEpochMs: null, activationId: 'lobby', revision: 1, seats: [], waiters: [], capacityClaims: null,
        registration: { revision: 0, atEpochMs: null, closed: false } };
    const first = { ...initial, revision: 2, registration: { revision: 1, atEpochMs: 5000, closed: false } };
    const revised = { ...first, revision: 3, registration: { ...first.registration, revision: 2, atEpochMs: 6000 } };
    const keys = [];
    for (const [before, after] of [[initial, first], [first, revised]] as const) {
        const messages = computeGroupLobbyPublication({ ...facts, before, after }).outbox
            .map(row => decodePersistedALMessage(row.entry.resource));
        expect(messages).toHaveLength(1);
        const message = messages[0]!;
        expect(JSON.parse(message.payload.resource)).toEqual({
            kind: 'registration', generation: after.registration.revision, dueAtEpochMs: after.registration.atEpochMs,
            activationId: 'lobby', groupCreatedAtEpochMs: 1000, roomRef
        });
        keys.push(message.id.msgId);
    }
    expect(new Set(keys).size).toBe(2);
    expect(computeGroupLobbyPublication({ ...facts, before: revised, after: { ...revised, revision: 4 } }).outbox).toEqual([]);
});

it('persists independent wakes for an expiring access grant and scheduled no-show capacity', () => {
    const before = { registration: { revision: 0, atEpochMs: null, closed: false }, expiresAtEpochMs: null, activationId: 'lobby', revision: 1, seats: [], waiters: [], capacityClaims: null };
    const after = { ...before, revision: 3,
        waiters: [{ principalId: 'alice', generation: 3, eligibleUntilEpochMs: 5000 }],
        capacityClaims: { generation: 2, dueAtEpochMs: 7000, principalIds: ['reserved'] }
    };
    const deadlines = computeGroupLobbyPublication({ ...facts, before, after }).outbox
        .map(row => decodePersistedALMessage(row.entry.resource))
        .filter(message => message.payload.typeId === AppOutboxType.ROOM_LOBBY_DEADLINE)
        .map(message => JSON.parse(message.payload.resource).dueAtEpochMs);
    expect(deadlines.sort()).toEqual([5000, 7000]);
});
