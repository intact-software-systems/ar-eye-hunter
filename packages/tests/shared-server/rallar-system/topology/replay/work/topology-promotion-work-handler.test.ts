import { describe, expect, it } from 'vitest';

import type { GroupSystemCommandSubmission } from '@shared-server/rallar-system/group-state/inbox/group-system-command-submission.ts';
import { computeTopologyPromotionEntry } from '@shared-server/rallar-system/group-state/topology-promotion-outbox-entry.ts';
import { createTopologyPromotionWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-topology-promotion-work-handler.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';

describe('topology promotion work handler', () => {
    it('submits the promotion under the promotion message trace', async () => {
        const submissions: GroupSystemCommandSubmission[] = [];
        const handler = createTopologyPromotionWorkHandler({
            topologyPublication: {
                submitCommand: async (submission) => {
                    submissions.push(submission);
                }
            },
            nowEpochMs: () => 2_000
        });
        const entry = computeTopologyPromotionEntry({
            work: {
                groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
                formationEpoch: 2,
                expectedLayout: { groupRevision: 4, presenceRevision: 0, version: 1, state: 'active' }
            },
            sourceWorkId: 'source-work:1',
            senderId: 'promotion-test',
            createdAtEpochMs: 1_000,
            expireAtEpochMs: 60_000,
            traceId: 'trace-topology-promotion-1'
        });

        await handler.onMessage(decodePersistedALMessage(entry.resource), entry);

        expect(submissions.map(({ command, atEpochMs, traceId }) => ({ operation: command.operation, atEpochMs, traceId })))
            .toEqual([{ operation: 'applyPlannedLayout', atEpochMs: 2_000, traceId: 'trace-topology-promotion-1' }]);
    });
});
