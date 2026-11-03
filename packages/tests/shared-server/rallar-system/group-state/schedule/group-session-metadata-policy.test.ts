import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { validateGroupMutationRequest } from '@shared-server/rallar-system/group-state/mutation/command-validation/group-mutation-request-validation.ts';
import {
    createAuthorityHarness,
    processAuthenticated,
    requireGroupStateResult,
    SCOPE
} from '../inbox/group-state-inbox-test-runtime.ts';

const schedule = { revision: 1, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: null };

describe('server ownership of session schedule metadata', () => {
    it.each(['createGroup', 'updateGroup'] as const)('refuses schedule injection through generic %s metadata', (operation) => {
        const request = {
            requestId: 'inject-schedule',
            actorPrincipalId: 'host',
            actorSessionId: 'host-session',
            ...(operation === 'createGroup'
                ? { groupId: 'room', displayName: 'Room', kind: 'room', createdByPrincipalId: 'host' }
                : {}),
            metadata: { rallarSessionSchedule: schedule }
        };
        expect(validateGroupMutationRequest(operation, request).map((issue) => issue.message))
            .toContain('Group session schedule metadata is server-owned; use the scheduling commands');
    });

    it('preserves the authoritative schedule when the owner replaces unrelated metadata', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const ref = { ...SCOPE, groupId: 'scheduled-room' };
        const upcoming = { ...schedule, startsAtEpochMs: harness.nowEpochMs + 3_600_000 };
        requireGroupStateResult(
            await processAuthenticated({
                service: harness.service,
                reader: harness.reader,
                authority: harness.sessions.owner,
                input: {
                    traceId: 'schedule-metadata-test',
                    type: AppInboxType.GROUP_CREATE,
                    resourceId: 'create-room',
                    contextId: ref.groupId,
                    data: {
                        scope: SCOPE,
                        request: {
                            requestId: 'create-room',
                            groupId: ref.groupId,
                            displayName: 'Scheduled room',
                            kind: 'room',
                            joinMode: 'open',
                            maxMembers: 4,
                            retention: { mode: 'temporary' },
                            scheduledStartAtEpochMs: upcoming.startsAtEpochMs,
                            metadata: { theme: 'forest' },
                            createdByPrincipalId: 'owner'
                        }
                    }
                }
            })
        );

        const updated = requireGroupStateResult(
            await processAuthenticated({
                service: harness.service,
                reader: harness.reader,
                authority: harness.sessions.owner,
                input: {
                    traceId: 'schedule-metadata-test',
                    type: AppInboxType.GROUP_UPDATE,
                    resourceId: 'change-theme',
                    contextId: ref.groupId,
                    data: {
                        scope: SCOPE,
                        groupId: ref.groupId,
                        request: { requestId: 'change-theme', metadata: { theme: 'ocean' } }
                    }
                }
            })
        );

        expect(updated.result.snapshot.group.metadata).toEqual({
            theme: 'ocean',
            rallarSessionSchedule: upcoming,
            rallarRetention: { mode: 'temporary', reconnectGraceMs: 600_000, emptyPresenceFingerprint: null }
        });
        expect((await harness.repository.readSnapshot(ref))?.group.metadata)
            .toEqual({
                theme: 'ocean',
                rallarSessionSchedule: upcoming,
                rallarRetention: { mode: 'temporary', reconnectGraceMs: 600_000, emptyPresenceFingerprint: null }
            });
    });
});
