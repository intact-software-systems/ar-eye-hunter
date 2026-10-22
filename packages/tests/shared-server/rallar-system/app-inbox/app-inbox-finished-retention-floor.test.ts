import { describe, expect, it } from 'vitest';

import {
    MAX_APP_INBOX_FINISHED_RETENTION_MS,
    MIN_APP_INBOX_FINISHED_RETENTION_MS
} from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import {
    MAX_GROUP_FORMATION_DEADLINE_MS,
    MAX_GROUP_STAGE_TRIGGER_DELAY_MS,
    MAX_GROUP_TOPOLOGY_REPLAN_WAIT_MS
} from '@shared/api/group-lifecycle/to-normalized-group-lifecycle-policy.ts';

describe('AppInbox finished-retention floor', () => {
    it('outlasts the longest delay a formation timer may wait before it is due', () => {
        const longestTimerDelayMs = Math.max(
            MAX_GROUP_FORMATION_DEADLINE_MS,
            MAX_GROUP_STAGE_TRIGGER_DELAY_MS,
            MAX_GROUP_TOPOLOGY_REPLAN_WAIT_MS
        );

        expect(MIN_APP_INBOX_FINISHED_RETENTION_MS).toBeGreaterThan(longestTimerDelayMs);
        expect(MIN_APP_INBOX_FINISHED_RETENTION_MS).toBeLessThanOrEqual(MAX_APP_INBOX_FINISHED_RETENTION_MS);
    });
});
