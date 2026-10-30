import {
    decodeGroupPublicationGrant,
    GROUP_PUBLICATION_GRANT_LIMITS,
    resolveGroupPublicationPermissions,
    resolveMemberPublicationPermissions,
    validateGroupPublicationGrant,
    type GroupPublicationGrant,
    type GroupPublicationTopicGrants
} from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import { describe, expect, it } from 'vitest';

import { createActiveGroupMemberFixture, createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

const GRANT: GroupPublicationGrant = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1',
    principalId: 'bob',
    topics: {
        'room.feed': { publish: true, subscribe: true },
        'app.scores': { publish: false, subscribe: true }
    },
    updated: {
        atEpochMs: 1_000,
        actor: { kind: 'principal', principalId: 'alice' },
        reason: null,
        traceId: null,
        requestId: 'grant-bob-feed-0000001'
    }
};

function decodeIssues(value: unknown): readonly RallarValidationIssue[] {
    return decodeGroupPublicationGrant(value).fold((issues) => issues, () => []);
}

function topicsOf(count: number): GroupPublicationTopicGrants {
    return Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`room.topic-${index}`, { publish: true, subscribe: false }])
    );
}

describe('group publication grant contract', () => {
    it('decodeGroupPublicationGrant returns a complete row unchanged', () => {
        expect(decodeGroupPublicationGrant(structuredClone(GRANT)).fold(() => undefined, (grant) => grant))
            .toEqual(GRANT);
    });

    it('refuses an extra key and names its path', () => {
        expect(decodeIssues({ ...GRANT, extra: true }).map((issue) => issue.path)).toEqual(['$.extra']);
    });

    it('refuses a topic entry with both permissions false', () => {
        const issues = decodeIssues({ ...GRANT, topics: { 'room.feed': { publish: false, subscribe: false } } });

        expect(issues.map((issue) => issue.path)).toEqual(['$.topics["room.feed"]']);
    });

    it('refuses a reserved or prefix-less topic id', () => {
        for (const topicId of ['rallar.state', 'feed']) {
            const issues = decodeIssues({ ...GRANT, topics: { [topicId]: { publish: true, subscribe: true } } });

            expect(issues.map((issue) => issue.path)).toEqual([`$.topics["${topicId}"]`]);
        }
    });

    it('refuses an empty topics object', () => {
        expect(decodeIssues({ ...GRANT, topics: {} }).map((issue) => issue.path)).toEqual(['$.topics']);
    });

    it('refuses 65 topics and accepts 64', () => {
        const limit = GROUP_PUBLICATION_GRANT_LIMITS.maxTopicsPerPrincipal;
        const issues = decodeIssues({ ...GRANT, topics: topicsOf(limit + 1) });

        expect(limit).toBe(64);
        expect(issues.map((issue) => issue.path)).toEqual(['$.topics']);
        expect(issues[0]?.message).toContain('64');
        expect(decodeIssues({ ...GRANT, topics: topicsOf(limit) })).toEqual([]);
    });

    it('validateGroupPublicationGrant returns every issue, not the first', () => {
        const issues = validateGroupPublicationGrant({
            ...GRANT,
            topics: {
                feed: { publish: true, subscribe: true },
                'room.feed': { publish: false, subscribe: false }
            }
        });

        expect(issues.map((issue) => issue.path)).toEqual(['$.topics["feed"]', '$.topics["room.feed"]']);
    });

    it('reports the topic count and every bad entry of an oversized row together', () => {
        const issues = validateGroupPublicationGrant({
            ...GRANT,
            topics: { ...topicsOf(GROUP_PUBLICATION_GRANT_LIMITS.maxTopicsPerPrincipal), feed: { publish: true, subscribe: false } }
        });

        expect(issues.map((issue) => issue.path)).toEqual(['$.topics', '$.topics["feed"]']);
    });

    it('reports a bad topic id and its malformed permissions together', () => {
        const issues = decodeIssues({ ...GRANT, topics: { feed: { publish: 'yes', subscribe: false } } });

        expect(issues.map((issue) => issue.path)).toEqual(['$.topics["feed"]', '$.topics["feed"].publish']);
    });

    it('refuses an empty audit string as the persisted member rows do', () => {
        const issues = decodeIssues({ ...GRANT, updated: { ...GRANT.updated, requestId: '', reason: '' } });

        expect(issues.map((issue) => issue.path)).toEqual(['$.updated.reason', '$.updated.requestId']);
    });
});

describe('resolveGroupPublicationPermissions returns the row for an active member, both false for an absent row, topic or non-active member, and publish false for a spectator', () => {
    const ref = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

    function memberOf(principalId: string, role: GroupMember['role']): GroupMember {
        return createActiveGroupMemberFixture({ ...ref, principalId, role, actorPrincipalId: 'creator' });
    }

    function grantOf(principalId: string, topics: GroupPublicationTopicGrants): GroupPublicationGrant {
        return { ...GRANT, ...ref, principalId, topics };
    }

    const lee = memberOf('lee', 'member');
    if (lee.status !== 'active') {
        throw new Error('Expected the active member fixture');
    }
    const snapshot: GroupSnapshot = {
        ...createGroupSnapshotFixture({ ...ref, sessionIds: [] }),
        members: [
            memberOf('bob', 'member'),
            memberOf('creator', 'owner'),
            memberOf('dana', 'spectator'),
            memberOf('erin', 'member'),
            { ...lee, status: 'left', left: lee.updated },
            memberOf('sam', 'spectator')
        ],
        publicationGrants: [
            grantOf('bob', { 'room.feed': { publish: true, subscribe: false } }),
            // dana held publish as a member and was demoted to spectator; the row is kept (D501).
            grantOf('dana', { 'room.feed': { publish: true, subscribe: true } }),
            grantOf('lee', { 'room.feed': { publish: true, subscribe: true } }),
            grantOf('sam', { 'room.feed': { publish: false, subscribe: true } })
        ]
    };

    it.each([
        { principalId: 'bob', topicId: 'room.feed', expected: { publish: true, subscribe: false } },
        { principalId: 'bob', topicId: 'room.other', expected: { publish: false, subscribe: false } },
        { principalId: 'bob', topicId: 'constructor', expected: { publish: false, subscribe: false } },
        { principalId: 'erin', topicId: 'room.feed', expected: { publish: false, subscribe: false } },
        { principalId: 'lee', topicId: 'room.feed', expected: { publish: false, subscribe: false } },
        { principalId: 'zed', topicId: 'room.feed', expected: { publish: false, subscribe: false } },
        { principalId: 'sam', topicId: 'room.feed', expected: { publish: false, subscribe: true } },
        { principalId: 'dana', topicId: 'room.feed', expected: { publish: false, subscribe: true } }
    ])('returns $expected for $principalId on $topicId', ({ principalId, topicId, expected }) => {
        expect(resolveGroupPublicationPermissions(snapshot, principalId, topicId)).toEqual(expected);
    });
});

describe('resolveMemberPublicationPermissions', () => {
    const ref = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
    const active = createActiveGroupMemberFixture({ ...ref, principalId: 'bob', role: 'member', actorPrincipalId: 'creator' });
    if (active.status !== 'active') {
        throw new Error('Expected the active member fixture');
    }
    const spectator = createActiveGroupMemberFixture({ ...ref, principalId: 'bob', role: 'spectator', actorPrincipalId: 'creator' });
    const left: GroupMember = { ...active, status: 'left', left: active.updated };
    const grant: GroupPublicationGrant = { ...GRANT, ...ref, principalId: 'bob', topics: { 'room.feed': { publish: true, subscribe: true } } };

    it.each([
        { label: 'active', member: active, row: grant },
        { label: 'left', member: left, row: grant },
        { label: 'spectator', member: spectator, row: grant },
        { label: 'absent member', member: null, row: grant },
        { label: 'absent row', member: active, row: null }
    ])('matches resolveGroupPublicationPermissions for the $label case', ({ member, row }) => {
        const snapshot: GroupSnapshot = {
            ...createGroupSnapshotFixture({ ...ref, sessionIds: [] }),
            members: member === null ? [] : [member],
            publicationGrants: row === null ? [] : [row]
        };

        for (const topicId of ['room.feed', 'room.other']) {
            expect(resolveMemberPublicationPermissions(member, row, topicId))
                .toEqual(resolveGroupPublicationPermissions(snapshot, 'bob', topicId));
        }
    });
});
