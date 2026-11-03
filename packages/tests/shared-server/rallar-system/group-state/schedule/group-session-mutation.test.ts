import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import {
    IDEMPOTENT_NAMESPACE,
    SUBSCRIPTIONS_NAMESPACE
} from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import type { ChangeGroupSessionRequest } from '@shared/api/group-sessions/group-session-schedule.ts';
import {
    createAuthorityHarness,
    processAuthenticated,
    requireGroupStateResult,
    SCOPE,
    type AuthorityHarness
} from '../inbox/group-state-inbox-test-runtime.ts';
import { subscriptionRowFor, writeSubscriptionRow } from '../mutation/group-topic-subscription-test-runtime.ts';

const groupId = 'scheduled-session';
const ref = { ...SCOPE, groupId };

describe('scheduled session commands through AppInbox', () => {
    it('reserves once per account, replays exactly, and does not publish reservation identities', async () => {
        const harness = await createSession();
        const request: ChangeGroupSessionRequest = {
            requestId: 'alice-rsvp',
            action: 'reserve',
            expectedScheduleRevision: 1,
            startsAtEpochMs: null
        };
        const accepted = requireGroupStateResult(await change(harness, 'alice', request));
        expect(requireGroupStateResult(await change(harness, 'alice', request))).toEqual(accepted);
        requireGroupStateResult(await change(harness, 'alice', { ...request, requestId: 'alice-another-tab' }));
        expect((await harness.repository.findSessionReservationsEntry(ref))?.value.principalIds).toEqual(['alice']);
        expect((await harness.repository.readSnapshot(ref))?.members.map((member) => member.principalId)).toEqual(['owner']);
        expect(JSON.stringify(await harness.repository.listEvents(ref))).not.toContain('alice');
        expect(JSON.stringify(await harness.repository.readSnapshot(ref))).not.toContain('alice');
        expect((await change(harness, 'bob', { ...request, requestId: 'bob-rsvp' })).left)
            .toMatchObject({ code: 'group-mutation-rejected' });
    });

    it.each(['reserve', 'withdraw'] as const)('replays a private %s receipt under a fresh queue delivery identity', async (action) => {
        const harness = await createSession();
        const reservation: ChangeGroupSessionRequest = { requestId: 'reserve-first', action: 'reserve', expectedScheduleRevision: 1, startsAtEpochMs: null };
        if (action === 'withdraw') {
            requireGroupStateResult(await change(harness, 'alice', reservation));
        }
        const request = { ...reservation, action, requestId: 'private-' + action };
        const original = requireGroupStateResult(await change(harness, 'alice', request));
        const replay = requireGroupStateResult(
            await processAuthenticated({
                service: harness.service,
                reader: harness.reader,
                authority: harness.sessions.alice,
                input: {
                    traceId: 'distinct-queue-delivery',
                    type: AppInboxType.GROUP_SESSION_CHANGE,
                    resourceId: 'second-envelope-' + action,
                    contextId: groupId,
                    data: { scope: SCOPE, groupId, request }
                }
            })
        );
        expect(replay).toEqual(original);
        expect(JSON.stringify(await harness.repository.listEvents(ref))).not.toContain('alice');
        expect((await harness.repository.findSessionReservationsEntry(ref))?.value.principalIds)
            .toEqual(action === 'reserve' ? ['alice'] : []);
    });

    it('previews only the caller reservation and lists sessions without exposing another account intent', async () => {
        const harness = await createSession();
        const directory = harness.groupStateService.sessionDirectory;
        expect(await directory.read(ref, 'alice')).toMatchObject({
            participation: 'none',
            availableSeats: 1,
            isOrganizer: false,
            canReserve: true,
            canEnter: false
        });
        requireGroupStateResult(
            await change(harness, 'alice', {
                requestId: 'preview-reserve',
                action: 'reserve',
                expectedScheduleRevision: 1,
                startsAtEpochMs: null
            })
        );
        expect(await directory.read(ref, 'alice')).toMatchObject({
            participation: 'reserved',
            availableSeats: 0,
            canReserve: true,
            canEnter: false
        });
        const other = await directory.read(ref, 'bob');
        expect(other).toMatchObject({ participation: 'none', availableSeats: 0, canReserve: false });
        expect(JSON.stringify(other)).not.toContain('alice');
        expect((await directory.listForPrincipal(SCOPE, 'alice', null)).sessions.map((session) => session.roomRef)).toEqual([ref]);
        expect(await directory.listForPrincipal(SCOPE, 'bob', null)).toEqual({ sessions: [], nextKey: null });
        expect((await directory.listForPrincipal({ ...SCOPE, workspaceId: 'elsewhere' }, 'alice', null)).sessions).toEqual([]);
        expect(await directory.read({ ...ref, workspaceId: 'elsewhere' }, 'alice')).toBeNull();
    });

    it('consumes a reservation on admission so removal cannot hold that seat again', async () => {
        const harness = await createSession(30_000);
        requireGroupStateResult(
            await change(harness, 'alice', {
                requestId: 'alice-reserve',
                action: 'reserve',
                expectedScheduleRevision: 1,
                startsAtEpochMs: null
            })
        );
        requireGroupStateResult(
            await processAuthenticated({
                service: harness.service,
                reader: harness.reader,
                authority: harness.sessions.alice,
                input: {
                    traceId: 'claim-seat',
                    type: AppInboxType.GROUP_JOIN,
                    resourceId: 'alice-join',
                    contextId: groupId,
                    data: { scope: SCOPE, groupId, request: { requestId: 'alice-join' } }
                }
            })
        );
        expect((await harness.repository.findSessionReservationsEntry(ref))?.value.principalIds).toEqual([]);
        requireGroupStateResult(
            await processAuthenticated({
                service: harness.service,
                reader: harness.reader,
                authority: harness.sessions.owner,
                input: {
                    traceId: 'release-seat',
                    type: AppInboxType.GROUP_MEMBER_REMOVE,
                    resourceId: 'remove-alice',
                    contextId: groupId,
                    data: { scope: SCOPE, groupId, principalId: 'alice', request: { requestId: 'remove-alice' } }
                }
            })
        );
        requireGroupStateResult(
            await change(harness, 'bob', {
                requestId: 'bob-reserve',
                action: 'reserve',
                expectedScheduleRevision: 1,
                startsAtEpochMs: null
            })
        );
        expect((await harness.repository.findSessionReservationsEntry(ref))?.value.principalIds).toEqual(['bob']);
    });

    it('indexes directly admitted members and preserves discovery when they become organizer', async () => {
        const harness = await createSession(30_000);
        requireGroupStateResult(
            await processAuthenticated({
                service: harness.service,
                reader: harness.reader,
                authority: harness.sessions.bob,
                input: {
                    traceId: 'direct-join',
                    type: AppInboxType.GROUP_JOIN,
                    resourceId: 'bob-direct-join',
                    contextId: groupId,
                    data: { scope: SCOPE, groupId, request: { requestId: 'bob-direct-join' } }
                }
            })
        );
        expect((await harness.groupStateService.sessionDirectory.listForPrincipal(SCOPE, 'bob', null)).sessions)
            .toContainEqual(expect.objectContaining({ roomRef: ref, participation: 'admitted', isOrganizer: false }));
        requireGroupStateResult(
            await processAuthenticated({
                service: harness.service,
                reader: harness.reader,
                authority: harness.sessions.owner,
                input: {
                    traceId: 'transfer',
                    type: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
                    resourceId: 'transfer',
                    contextId: groupId,
                    data: { scope: SCOPE, groupId, request: { requestId: 'transfer', newOwnerPrincipalId: 'bob' } }
                }
            })
        );
        expect((await harness.groupStateService.sessionDirectory.listForPrincipal(SCOPE, 'bob', null)).sessions)
            .toContainEqual(expect.objectContaining({ roomRef: ref, isOrganizer: true }));
    });

    it.each([AppInboxType.GROUP_MEMBER_BAN, AppInboxType.GROUP_MEMBER_REMOVE])('releases an unclaimed seat when access is revoked by %s', async (type) => {
        const harness = await createSession();
        requireGroupStateResult(
            await change(harness, 'alice', { requestId: 'reserve-revoked', action: 'reserve', expectedScheduleRevision: 1, startsAtEpochMs: null })
        );
        requireGroupStateResult(
            await processAuthenticated({
                service: harness.service,
                reader: harness.reader,
                authority: harness.sessions.owner,
                input: {
                    traceId: 'revoke-seat',
                    type,
                    resourceId: 'revoke-seat',
                    contextId: groupId,
                    data: { scope: SCOPE, groupId, principalId: 'alice', request: { requestId: 'revoke-seat' } }
                }
            })
        );
        expect((await harness.repository.findSessionReservationsEntry(ref))?.value.principalIds).toEqual([]);
        requireGroupStateResult(
            await change(harness, 'bob', { requestId: 'released-seat', action: 'reserve', expectedScheduleRevision: 1, startsAtEpochMs: null })
        );
    });

    it('withdraws a reservation without changing membership and releases its seat', async () => {
        const harness = await createSession();
        requireGroupStateResult(
            await change(harness, 'alice', {
                requestId: 'reserve',
                action: 'reserve',
                expectedScheduleRevision: 1,
                startsAtEpochMs: null
            })
        );
        requireGroupStateResult(
            await change(harness, 'alice', {
                requestId: 'withdraw',
                action: 'withdraw',
                expectedScheduleRevision: 1,
                startsAtEpochMs: null
            })
        );
        requireGroupStateResult(
            await change(harness, 'bob', {
                requestId: 'bob-reserve',
                action: 'reserve',
                expectedScheduleRevision: 1,
                startsAtEpochMs: null
            })
        );
        expect((await harness.repository.findSessionReservationsEntry(ref))?.value.principalIds).toEqual(['bob']);
        expect((await harness.repository.readSnapshot(ref))?.group.activeMemberCount).toBe(1);
    });

    it('keeps the organizer session discoverable when withdrawing an unnecessary reservation', async () => {
        const harness = await createSession();
        requireGroupStateResult(
            await change(harness, 'owner', {
                requestId: 'owner-withdraw',
                action: 'withdraw',
                expectedScheduleRevision: 1,
                startsAtEpochMs: null
            })
        );
        expect((await harness.groupStateService.sessionDirectory.listForPrincipal(SCOPE, 'owner', null)).sessions)
            .toContainEqual(expect.objectContaining({ roomRef: ref, isOrganizer: true, participation: 'admitted' }));
    });

    it('restricts rescheduling to the owner and clears old confirmations atomically', async () => {
        const harness = await createSession();
        requireGroupStateResult(
            await change(harness, 'alice', {
                requestId: 'reserve',
                action: 'reserve',
                expectedScheduleRevision: 1,
                startsAtEpochMs: null
            })
        );
        const request: ChangeGroupSessionRequest = {
            requestId: 'reschedule',
            action: 'reschedule',
            expectedScheduleRevision: 1,
            startsAtEpochMs: harness.nowEpochMs + 7_200_000
        };
        expect((await change(harness, 'alice', { ...request, requestId: 'forbidden-reschedule' })).left).toMatchObject({ code: 'group-mutation-rejected' });
        const result = requireGroupStateResult(await change(harness, 'owner', request));
        expect(result.result.snapshot.group.metadata.rallarSessionSchedule)
            .toEqual({ revision: 2, startsAtEpochMs: request.startsAtEpochMs, cancelledAtEpochMs: null });
        expect((await harness.repository.findSessionReservationsEntry(ref))?.value)
            .toEqual({ ...ref, scheduleRevision: 2, principalIds: [] });
        expect((await harness.groupStateService.sessionDirectory.listForPrincipal(SCOPE, 'alice', null)).sessions)
            .toContainEqual(expect.objectContaining({ roomRef: ref, participation: 'needs-confirmation' }));
        expect(
            (await change(harness, 'alice', {
                requestId: 'stale-rsvp',
                action: 'reserve',
                expectedScheduleRevision: 1,
                startsAtEpochMs: null
            })).left
        ).toMatchObject({ code: 'group-mutation-rejected' });
    });

    it('cancels before opening and refuses new reservations', async () => {
        const harness = await createSession();
        requireGroupStateResult(
            await change(harness, 'alice', {
                requestId: 'alice-before-cancel',
                action: 'reserve',
                expectedScheduleRevision: 1,
                startsAtEpochMs: null
            })
        );
        requireGroupStateResult(
            await change(harness, 'owner', {
                requestId: 'cancel',
                action: 'cancel',
                expectedScheduleRevision: 1,
                startsAtEpochMs: null
            })
        );
        expect(
            (await change(harness, 'alice', {
                requestId: 'reserve',
                action: 'reserve',
                expectedScheduleRevision: 2,
                startsAtEpochMs: null
            })).left
        ).toMatchObject({ code: 'group-mutation-rejected' });
        expect((await harness.repository.findGroup(ref))?.metadata.rallarSessionSchedule)
            .toMatchObject({ revision: 2, cancelledAtEpochMs: expect.any(Number) });
        expect((await harness.groupStateService.sessionDirectory.listForPrincipal(SCOPE, 'alice', null)).sessions)
            .toContainEqual(expect.objectContaining({ roomRef: ref, timing: expect.objectContaining({ phase: 'cancelled' }) }));
    });

    it('changes reservations and the schedule without touching a member subscription row', async () => {
        const harness = await createSession();
        const ownerRow = subscriptionRowFor('owner', 'owner-session', 'room.feed');
        const key = await writeSubscriptionRow(harness.runtimeRepository, ref, ownerRow);
        const changes: readonly (readonly [string, ChangeGroupSessionRequest])[] = [
            ['alice', { requestId: 'alice-reserve', action: 'reserve', expectedScheduleRevision: 1, startsAtEpochMs: null }],
            ['alice', { requestId: 'alice-withdraw', action: 'withdraw', expectedScheduleRevision: 1, startsAtEpochMs: null }],
            ['owner', { requestId: 'owner-reschedule', action: 'reschedule', expectedScheduleRevision: 1, startsAtEpochMs: harness.nowEpochMs + 7_200_000 }],
            ['owner', { requestId: 'owner-cancel', action: 'cancel', expectedScheduleRevision: 2, startsAtEpochMs: null }]
        ];

        for (const [principalId, request] of changes) {
            const before = await readReceiptKeys(harness);
            requireGroupStateResult(await change(harness, principalId, request));
            const records = (await harness.runtimeRepository.findAllEntries(IDEMPOTENT_NAMESPACE))
                .filter((entry) => !before.has(entry.key))
                .map((entry) => JSON.parse(entry.value));
            expect(records, request.requestId).toEqual([
                expect.objectContaining({
                    receipt: expect.objectContaining({ outcome: 'applied', subscriptionOutcome: null })
                })
            ]);
        }

        expect((await harness.repository.readSnapshot(ref))?.members.map((member) => member.status)).toEqual(['active']);
        const entry = await harness.runtimeRepository.findEntry(SUBSCRIPTIONS_NAMESPACE, key);
        expect(entry === undefined ? undefined : JSON.parse(entry.value)).toEqual(ownerRow);
    });
});

async function createSession(startOffsetMs = 3_600_000): Promise<AuthorityHarness> {
    const harness = await createAuthorityHarness(['owner', 'alice', 'bob']);
    requireGroupStateResult(
        await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.owner,
            input: {
                traceId: 'session-create',
                type: AppInboxType.GROUP_CREATE,
                resourceId: 'create',
                contextId: groupId,
                data: {
                    scope: SCOPE,
                    request: {
                        requestId: 'create',
                        groupId,
                        displayName: 'Scheduled play',
                        kind: 'room',
                        joinMode: 'open',
                        maxMembers: 2,
                        retention: { mode: 'temporary' },
                        createdByPrincipalId: 'owner',
                        scheduledStartAtEpochMs: harness.nowEpochMs + startOffsetMs
                    }
                }
            }
        })
    );
    return harness;
}

async function readReceiptKeys(harness: AuthorityHarness): Promise<ReadonlySet<string>> {
    return new Set((await harness.runtimeRepository.findAllEntries(IDEMPOTENT_NAMESPACE)).map((entry) => entry.key));
}

function change(harness: AuthorityHarness, principalId: string, request: ChangeGroupSessionRequest) {
    return processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: harness.sessions[principalId],
        input: {
            traceId: 'session-change',
            type: AppInboxType.GROUP_SESSION_CHANGE,
            resourceId: `${principalId}:${request.requestId}`,
            contextId: groupId,
            data: { scope: SCOPE, groupId, request }
        }
    });
}
