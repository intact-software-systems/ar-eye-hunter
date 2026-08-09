import { describe, expect, it } from 'vitest';
import {
    DEFAULT_BOOTSTRAP_DEGREE,
    resolveBootstrapDegree,
    selectBootstrapPeers,
} from '@shared/rtc/bootstrap-peer-selection.ts';

describe('resolveBootstrapDegree', () => {
    it('defaults to the bootstrap degree clamped by the connection budget', () => {
        expect(resolveBootstrapDegree({})).toBe(DEFAULT_BOOTSTRAP_DEGREE);
        expect(resolveBootstrapDegree({ bootstrapDegree: 3 })).toBe(3);
        expect(resolveBootstrapDegree({ maxPeerConnections: 3 })).toBe(3);
        expect(
            resolveBootstrapDegree({ bootstrapDegree: 8, maxPeerConnections: 6 }),
        ).toBe(6);
        expect(
            resolveBootstrapDegree({ bootstrapDegree: 4, maxPeerConnections: 20 }),
        ).toBe(4);
    });

    it('ignores non-positive and non-integer inputs', () => {
        expect(resolveBootstrapDegree({ bootstrapDegree: 0 }))
            .toBe(DEFAULT_BOOTSTRAP_DEGREE);
        expect(resolveBootstrapDegree({ bootstrapDegree: -2 }))
            .toBe(DEFAULT_BOOTSTRAP_DEGREE);
        expect(resolveBootstrapDegree({ bootstrapDegree: 2.5 }))
            .toBe(DEFAULT_BOOTSTRAP_DEGREE);
        expect(resolveBootstrapDegree({ maxPeerConnections: Number.NaN }))
            .toBe(DEFAULT_BOOTSTRAP_DEGREE);
    });
});

describe('selectBootstrapPeers', () => {
    const memberSessionIds = [
        'session-a',
        'session-b',
        'session-c',
        'session-d',
        'session-e',
        'session-f',
    ];

    it('is deterministic per (groupKey, localSessionId) and self-excluding', () => {
        const input = {
            localSessionId: 'session-a',
            memberSessionIds,
            groupKey: 'app|ws|group-1',
            bootstrapDegree: 3,
        };

        const first = selectBootstrapPeers(input);
        const second = selectBootstrapPeers({
            ...input,
            memberSessionIds: [...memberSessionIds].reverse(),
        });

        expect(first).toEqual(second);
        expect(first).toHaveLength(3);
        expect(first).not.toContain('session-a');
    });

    it('bounds the selection and deduplicates members', () => {
        expect(
            selectBootstrapPeers({
                localSessionId: 'session-a',
                memberSessionIds: [...memberSessionIds, ...memberSessionIds],
                groupKey: 'group',
                bootstrapDegree: 2,
            }),
        ).toHaveLength(2);
        expect(
            selectBootstrapPeers({
                localSessionId: 'session-a',
                memberSessionIds: ['session-a', 'session-b'],
                groupKey: 'group',
                bootstrapDegree: 5,
            }),
        ).toEqual(['session-b']);
        expect(
            selectBootstrapPeers({
                localSessionId: 'session-a',
                memberSessionIds,
                groupKey: 'group',
                bootstrapDegree: 0,
            }),
        ).toEqual([]);
    });

    it('varies the selection across sessions and group keys', () => {
        const bySession = new Set(
            memberSessionIds.map((localSessionId) =>
                selectBootstrapPeers({
                    localSessionId,
                    memberSessionIds,
                    groupKey: 'group-vary',
                    bootstrapDegree: 2,
                }).join(',')
            ),
        );

        expect(bySession.size).toBeGreaterThan(1);
    });

    // Program-plan risk 3: every session keeps a small rendezvous-selected
    // set, and the undirected union over all sessions must stay connected at
    // the black-box tiers. Deterministic inputs make this a regression test,
    // not a probabilistic one.
    it.each([
        { tier: 'small', memberCount: 6 },
        { tier: 'medium', memberCount: 20 },
        { tier: 'large', memberCount: 50 },
    ])(
        'keeps the $tier tier (N=$memberCount) union bootstrap graph connected across seeds',
        ({ memberCount }) => {
            for (let seed = 0; seed < 100; seed++) {
                const sessions = Array.from(
                    { length: memberCount },
                    (_, index) => `seed${seed}-session-${index}`,
                );
                const groupKey = `app|ws|group-${seed}`;

                const edges = new Map<string, Set<string>>(
                    sessions.map((session) => [session, new Set<string>()]),
                );
                for (const localSessionId of sessions) {
                    const selected = selectBootstrapPeers({
                        localSessionId,
                        memberSessionIds: sessions,
                        groupKey,
                        bootstrapDegree: DEFAULT_BOOTSTRAP_DEGREE,
                    });
                    for (const peerId of selected) {
                        edges.get(localSessionId)?.add(peerId);
                        edges.get(peerId)?.add(localSessionId);
                    }
                }

                expect(countReachableSessions(sessions[0], edges))
                    .toBe(memberCount);
            }
        },
    );
});

function countReachableSessions(
    start: string,
    edges: ReadonlyMap<string, ReadonlySet<string>>,
): number {
    const visited = new Set<string>([start]);
    const queue = [start];

    while (queue.length > 0) {
        const current = queue.pop();
        if (current === undefined) {
            break;
        }
        for (const neighbor of edges.get(current) ?? []) {
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push(neighbor);
            }
        }
    }

    return visited.size;
}
