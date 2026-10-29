import {
    describe,
    expect,
    it
} from 'vitest';

import type { ApiV1StateWriteEvidence } from '@shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-contracts.ts';
import type { GroupEventType } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';
import {
    createGroupStateWriteEvidenceFixture,
    type GroupStateWriteEvidenceFixture
} from './group-state-write-evidence-fixtures.ts';

const commandPolicies = [
    ['GROUP_CREATE', ['group-created'], false],
    ['GROUP_UPDATE', ['group-updated', 'group-archived', 'group-deleted'], true],
    ['GROUP_DIRECTOR_APPOINT', ['group-updated'], false],
    ['GROUP_JOIN', ['member-joined'], true],
    ['GROUP_INVITE_CREATE', ['member-invited'], true],
    ['GROUP_INVITE_REVOKE', ['member-left'], true],
    ['GROUP_INVITE_ACCEPT', ['member-joined'], true],
    ['GROUP_JOIN_CODE_ROTATE', ['group-updated'], false],
    ['GROUP_MEMBER_REMOVE', ['member-removed'], true],
    ['GROUP_MEMBER_BAN', ['member-banned'], true],
    ['GROUP_MEMBER_UNBAN', ['member-unbanned'], true],
    ['GROUP_MEMBER_ROLE_SET', ['member-role-changed'], true],
    ['GROUP_PUBLICATION_GRANT', ['publication-grant-changed'], true],
    ['GROUP_PUBLICATION_REVOKE', ['publication-grant-changed'], true],
    ['GROUP_OWNERSHIP_TRANSFER', ['ownership-transferred'], true],
    ['GROUP_MEMBER_UPSERT', [
        'member-invited',
        'member-joined',
        'member-left',
        'member-removed',
        'member-banned'
    ], true]
] as const satisfies readonly (
    readonly [string, readonly GroupEventType[], boolean]
)[];

function groupEvidenceCase(commandType: string, eventType: GroupEventType): GroupStateWriteEvidenceFixture {
    return createGroupStateWriteEvidenceFixture({
        resourceId: `physical-${commandType}`,
        commandId: `command-${commandType}`,
        commandType,
        commandHash: `sha256:${'a'.repeat(64)}`,
        eventId: `event-${commandType}`,
        eventType
    });
}

function expectValid(evidence: ApiV1StateWriteEvidence): void {
    expect(evidence).toMatchObject({
        atomicCompletionFailures: 0,
        statusResultFailures: 0
    });
}

function expectInvalid(evidence: ApiV1StateWriteEvidence): void {
    expect(evidence).toMatchObject({
        atomicCompletionFailures: 1,
        statusResultFailures: 1
    });
}

describe('durable group event semantics evidence', () => {
    it('requires an applied event causal revision to equal its receipt', () => {
        const { event, evidence } = groupEvidenceCase(
            'GROUP_MEMBER_UPSERT',
            'member-joined'
        );

        expectValid(evidence());
        expectInvalid(evidence({
            ...event,
            causalRevision: { groupRevision: 999, presenceRevision: 999 }
        }));
    });

    it('requires receipt snapshotVersion to equal its causal groupRevision', () => {
        const { event, evidence } = groupEvidenceCase(
            'GROUP_MEMBER_UPSERT',
            'member-joined'
        );

        expectInvalid(evidence(
            { ...event, snapshotVersion: 9 },
            { snapshotVersion: 9 }
        ));
    });

    it('keeps applied groupRevision exact when the returned snapshot is canonical', () => {
        const { event, evidence } = groupEvidenceCase(
            'GROUP_MEMBER_UPSERT',
            'member-joined'
        );
        const fixture = createGroupSnapshotFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            sessionIds: ['owner-session', 'member-session']
        });
        const groupAhead = {
            ...fixture,
            causalRevision: { groupRevision: 9, presenceRevision: 2 },
            group: { ...fixture.group, snapshotVersion: 9, presenceVersion: 2 }
        };

        expectInvalid(evidence(event, {}, groupAhead));
    });

    it('accepts a canonical no-op snapshot advanced on both causal axes', () => {
        const { evidence } = groupEvidenceCase('GROUP_MEMBER_UPSERT', 'member-joined');
        const fixture = createGroupSnapshotFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            sessionIds: ['owner-session', 'member-session']
        });
        const snapshotAhead = {
            ...fixture,
            causalRevision: { groupRevision: 9, presenceRevision: 3 },
            group: { ...fixture.group, snapshotVersion: 9, presenceVersion: 3 }
        };

        expectValid(evidence(
            null,
            { outcome: 'no-op', eventId: null },
            snapshotAhead
        ));
    });

    it.each([
        ['group', { groupRevision: 7, presenceRevision: 2 }],
        ['presence', { groupRevision: 9, presenceRevision: 0 }]
    ])('rejects a no-op snapshot that regresses the %s causal axis', (_axis, causal) => {
        const { evidence } = groupEvidenceCase('GROUP_MEMBER_UPSERT', 'member-joined');
        const fixture = createGroupSnapshotFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            sessionIds: ['owner-session', 'member-session']
        });
        const regressed = {
            ...fixture,
            causalRevision: causal,
            group: {
                ...fixture.group,
                snapshotVersion: causal.groupRevision,
                presenceVersion: causal.presenceRevision
            }
        };

        expectInvalid(evidence(
            null,
            { outcome: 'no-op', eventId: null },
            regressed
        ));
    });

    it.each(commandPolicies)(
        'accepts only semantically possible events for %s',
        (commandType, allowedEventTypes) => {
            for (const eventType of allowedEventTypes) {
                expectValid(groupEvidenceCase(commandType, eventType).evidence());
            }
            const { event, evidence } = groupEvidenceCase(
                commandType,
                allowedEventTypes[0]
            );
            expectInvalid(evidence({ ...event, eventType: 'session-heartbeat' }));
        }
    );

    it.each(commandPolicies.filter((policy) => policy[2]))(
        'accepts a canonical no-op without an event for %s',
        (commandType, [eventType]) => {
            const { evidence } = groupEvidenceCase(commandType, eventType);
            expectValid(evidence(null, { outcome: 'no-op', eventId: null }));
        }
    );

    it.each(commandPolicies.filter((policy) => !policy[2]))(
        'rejects an impossible no-op for %s',
        (commandType, [eventType]) => {
            const { evidence } = groupEvidenceCase(commandType, eventType);
            expectInvalid(evidence(null, { outcome: 'no-op', eventId: null }));
        }
    );

    it('binds an event to applied and a null event to no-op', () => {
        const { event, evidence } = groupEvidenceCase(
            'GROUP_MEMBER_UPSERT',
            'member-joined'
        );

        expectInvalid(evidence(null, { outcome: 'applied', eventId: null }));
        expectInvalid(evidence(event, { outcome: 'no-op' }));
    });

    it('fails closed for an unsupported group command mapping', () => {
        const { evidence } = groupEvidenceCase('GROUP_UNKNOWN', 'member-joined');
        expectInvalid(evidence());
    });
});
