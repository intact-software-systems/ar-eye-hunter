import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('GroupStateRepository persistence ownership', () => {
    it('keeps aggregate, membership, presence, and snapshot owners directly navigable', () => {
        const root = 'packages/shared-server/rallar-system/group-state/persistence';
        for (
            const [file, symbol] of [
                ['group-state-repository.ts', 'GroupStateRepository'],
                ['group-state-repository-reads.ts', 'GroupStateRepositoryReads'],
                ['aggregate/group-aggregate-repository.ts', 'GroupAggregateRepository'],
                ['membership/group-membership-repository.ts', 'GroupMembershipRepository'],
                ['presence/group-presence-repository.ts', 'GroupPresenceRepository'],
                ['group-state-snapshot-repository.ts', 'GroupStateSnapshotRepository']
            ]
        ) {
            expect(readFileSync(`${root}/${file}`, 'utf8')).toContain(`class ${symbol}`);
        }
    });
});
