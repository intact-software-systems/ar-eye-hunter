import { describe, expect, it } from 'vitest';
import type { ControlEventEnvelope } from '../../shared-test/rallar-bb-test/control-protocol.ts';
import { toDistributedRunEventRows } from '../../shared-test/rallar-bb-test/distributed-run-observation/distributed-run-event-rows.ts';
import { toDistributedRunRuntimeDiagnosticRows } from '../../shared-test/rallar-bb-test/distributed-run-observation/distributed-run-runtime-diagnostic-rows.ts';
import { toDistributedRunIdentitySummary } from '../../shared-test/rallar-bb-test/distributed-run-observation/to-distributed-run-identity-summary.ts';

const SENTINEL = 'payload must never enter diagnostics';

const SEND_FAILED_EVENT: ControlEventEnvelope = {
    eventId: 'e-1',
    agentId: 'a',
    kind: 'diagnostic',
    atEpochMs: 1,
    protocolVersion: 1,
    runId: 'run-1',
    payload: {
        diagnosticSchemaVersion: 1,
        kind: 'diagnostic',
        topic: 'rallar.browser.ws.send_failed',
        transport: 'ws',
        data: { msgId: 'm-1', handleId: 'h-1', traceId: 't-1', corrId: 'm-1', payload: { secret: SENTINEL } }
    }
};

describe('distributed run identity summary', () => {
    it('lists the identity keys of both row kinds and never the payload', () => {
        const diagnosticRows = toDistributedRunRuntimeDiagnosticRows([SEND_FAILED_EVENT]);
        const eventRows = toDistributedRunEventRows([SEND_FAILED_EVENT]);

        expect(diagnosticRows[0].identitySummary).toBe(
            'kind=diagnostic topic=rallar.browser.ws.send_failed transport=ws msgId=m-1 handleId=h-1 traceId=t-1 corrId=m-1'
        );
        expect(diagnosticRows[0].message).toBe('rallar.browser.ws.send_failed');
        expect(eventRows[0].identitySummary).toBe(diagnosticRows[0].identitySummary);
        expect(JSON.stringify(diagnosticRows)).not.toContain(SENTINEL);
        expect(JSON.stringify(eventRows)).not.toContain(SENTINEL);
    });

    it('orders every identity key and reads each from the event, its payload and its data', () => {
        const summary = toDistributedRunIdentitySummary({
            kind: 'event',
            topic: 'message.received',
            transport: 'rtc',
            messageId: 'message-1',
            status: 'ok',
            payload: { distributedRunId: 'run-1', groupId: 'group-1', roomId: 'room-1', typeId: 'type-1' },
            data: {
                topicId: 'topic-1',
                contextId: 'context-1',
                resourceId: 'resource-1',
                msgId: 'msg-1',
                handleId: 'handle-1',
                traceId: 'trace-1',
                corrId: 'corr-1'
            }
        });

        expect(summary).toBe([
            'kind=event',
            'topic=message.received',
            'transport=rtc',
            'messageId=message-1',
            'distributedRunId=run-1',
            'groupId=group-1',
            'roomId=room-1',
            'typeId=type-1',
            'topicId=topic-1',
            'contextId=context-1',
            'resourceId=resource-1',
            'status=ok',
            'msgId=msg-1',
            'handleId=handle-1',
            'traceId=trace-1',
            'corrId=corr-1'
        ].join(' '));
    });

    it('reads the data of a nested runtime diagnostic payload', () => {
        const summary = toDistributedRunIdentitySummary({
            topic: 'rallar.browser.ws.send_failed',
            payload: { diagnosticSchemaVersion: 1, transport: 'ws', data: { msgId: 'm-1', traceId: 't-1' } }
        });

        expect(summary).toBe('topic=rallar.browser.ws.send_failed transport=ws msgId=m-1 traceId=t-1');
    });
});
