import {
    decodeGroupPublicationGrant,
    GROUP_PUBLICATION_GRANT_LIMITS,
    validateGroupPublicationGrant,
    type GroupPublicationGrant,
    type GroupPublicationTopicGrants
} from '@shared/api/group-publication/group-publication-grants.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import { describe, expect, it } from 'vitest';

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
