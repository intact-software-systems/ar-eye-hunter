import { describe, expect, it } from 'vitest';

import {
    createGroupFormationMetricsRecorder,
    emptyGroupFormationMetrics,
    toGroupFormationOperationKind
} from '@shared-server/rallar-system/formation-metrics.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '@shared-server/rallar-system/services/rtc-topology-outbox-entry.ts';
import { AppTopics } from '@shared/api/api-config.ts';

describe('group formation metrics recorder', () => {
    it('maps group mutation operations onto formation operation kinds', () => {
        expect(toGroupFormationOperationKind('joinGroup')).toBe('join');
        expect(toGroupFormationOperationKind('acceptGroupInvite')).toBe('join');
        expect(toGroupFormationOperationKind('connectPresence')).toBe('presenceConnect');
        expect(toGroupFormationOperationKind('heartbeatPresence')).toBe('heartbeat');
        expect(toGroupFormationOperationKind('disconnectPresence')).toBe('disconnect');
        expect(toGroupFormationOperationKind('upsertMember')).toBe('membership');
        expect(toGroupFormationOperationKind('setGroupMemberRole')).toBe('membership');
        expect(toGroupFormationOperationKind('createGroup')).toBe('other');
        expect(toGroupFormationOperationKind('unknown-op')).toBe('other');
    });

    it('counts group mutations by operation kind and outcome', () => {
        const recorder = createGroupFormationMetricsRecorder();

        recorder.groupMutation({ operation: 'joinGroup', outcome: 'write' });
        recorder.groupMutation({ operation: 'joinGroup', outcome: 'write' });
        recorder.groupMutation({ operation: 'acceptGroupInvite', outcome: 'noOp' });
        recorder.groupMutation({ operation: 'heartbeatPresence', outcome: 'write' });
        recorder.groupMutation({ operation: 'connectPresence', outcome: 'rejected' });

        const metrics = recorder.readMetrics();
        expect(metrics.groupMutationCount.join).toEqual({ write: 2, noOp: 1, rejected: 0 });
        expect(metrics.groupMutationCount.heartbeat).toEqual({ write: 1, noOp: 0, rejected: 0 });
        expect(metrics.groupMutationCount.presenceConnect).toEqual({
            write: 0,
            noOp: 0,
            rejected: 1
        });
        expect(metrics.groupMutationCount.other).toEqual({ write: 0, noOp: 0, rejected: 0 });
    });

    it('classifies presence-summary downstream rows by topic', () => {
        const recorder = createGroupFormationMetricsRecorder();

        recorder.presenceSummary({
            downstreamTopicIds: [
                AppTopics.groupStateEvent,
                AppTopics.groupStateSnapshot,
                AppTopics.groupDirectorySnapshot,
                APP_OUTBOX_RTC_TOPOLOGY_TOPIC
            ]
        });
        recorder.presenceSummary({
            downstreamTopicIds: [AppTopics.groupStateEvent, APP_OUTBOX_RTC_TOPOLOGY_TOPIC]
        });

        const metrics = recorder.readMetrics();
        expect(metrics.presenceSummaryExpansionCount).toBe(2);
        expect(metrics.presenceSummaryWsRowCount).toEqual({ event: 2, snapshot: 1, directory: 1 });
        expect(metrics.presenceSummaryTopologyEntryCount).toBe(2);
        expect(metrics.topologyRecomputeTriggeredCount).toBe(2);
    });

    it('counts topology outbox writes and RTT accepted writes into one triggered total', () => {
        const recorder = createGroupFormationMetricsRecorder();

        recorder.topologyOutboxWritten();
        recorder.topologyOutboxWritten();
        recorder.rttMutation({ topologyEffectCount: 3 });
        recorder.presenceSummary({ downstreamTopicIds: [APP_OUTBOX_RTC_TOPOLOGY_TOPIC] });

        const metrics = recorder.readMetrics();
        expect(metrics.topologyRecomputeTriggeredCount).toBe(3);
        expect(metrics.rttAcceptedWriteCount).toBe(1);
        expect(metrics.rttTopologyEffectCount).toBe(3);
    });

    it('counts WS delivery events by bounded topic dimension', () => {
        const recorder = createGroupFormationMetricsRecorder();

        recorder.wsDelivery({
            kind: 'live-send',
            topicId: AppTopics.overlayTopology,
            recipientCount: 5,
            sentCount: 4,
            payloadBytes: 100
        });
        recorder.wsDelivery({
            kind: 'outbox-send',
            topicId: AppTopics.groupStateSnapshot,
            payloadBytes: 250
        });
        recorder.wsDelivery({
            kind: 'outbox-send',
            topicId: AppTopics.groupStateSnapshot,
            payloadBytes: 250
        });
        recorder.wsDelivery({ kind: 'no-local-recipient', topicId: AppTopics.groupStateEvent });

        const metrics = recorder.readMetrics();
        expect(metrics.wsOutboxSendCountByTopicId).toEqual({
            [AppTopics.overlayTopology]: 1,
            [AppTopics.groupStateSnapshot]: 2
        });
        expect(metrics.wsOutboxRecipientCountByTopicId).toEqual({
            [AppTopics.overlayTopology]: 5,
            [AppTopics.groupStateSnapshot]: 2
        });
        expect(metrics.wsEgressBytesByTopicId).toEqual({
            [AppTopics.overlayTopology]: 400,
            [AppTopics.groupStateSnapshot]: 500
        });
        expect(metrics.wsOutboxNoLocalRecipientCount).toBe(1);
    });

    it('routes topic overflow into one bounded bucket', () => {
        const recorder = createGroupFormationMetricsRecorder();

        for (let index = 0; index < 60; index += 1) {
            recorder.wsDelivery({
                kind: 'outbox-send',
                topicId: `unexpected-topic-${index}`,
                payloadBytes: 1
            });
        }

        const metrics = recorder.readMetrics();
        const keys = Object.keys(metrics.wsOutboxSendCountByTopicId);
        expect(keys.length).toBeLessThanOrEqual(51);
        expect(metrics.wsOutboxSendCountByTopicId['untracked-topic-overflow']).toBe(10);
    });

    it('never throws on malformed sink input', () => {
        const recorder = createGroupFormationMetricsRecorder();

        expect(() =>
            recorder.presenceSummary({
                downstreamTopicIds: undefined as unknown as readonly string[]
            })
        ).not.toThrow();
        expect(() =>
            recorder.groupMutation({
                operation: 'joinGroup',
                outcome: 'unexpected' as 'write'
            })
        ).not.toThrow();
        expect(() => recorder.rttMutation({ topologyEffectCount: Number.NaN })).not.toThrow();

        const metrics = recorder.readMetrics();
        expect(metrics.groupMutationCount.join.rejected).toBe(1);
        expect(metrics.rttAcceptedWriteCount).toBe(1);
        expect(metrics.rttTopologyEffectCount).toBe(0);
    });

    it('round-trips read and reset back to the empty metrics shape', () => {
        const recorder = createGroupFormationMetricsRecorder();

        recorder.groupMutation({ operation: 'joinGroup', outcome: 'write' });
        recorder.topologyOutboxWritten();
        recorder.wsDelivery({
            kind: 'outbox-send',
            topicId: AppTopics.groupStateEvent,
            payloadBytes: 42
        });

        const observed = recorder.readMetrics();
        expect(observed.groupMutationCount.join.write).toBe(1);

        recorder.resetMetrics();
        expect(recorder.readMetrics()).toEqual(emptyGroupFormationMetrics());
        expect(observed.groupMutationCount.join.write).toBe(1);
    });
});
