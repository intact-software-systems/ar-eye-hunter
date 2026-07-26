import { describe, expect, it } from 'vitest';
import { deriveApiV1StateWriteEvidence } from
    '@shared-test/black-box-runner/api-v1-state-write-evidence.ts';

const commandId = 'topology-command-1';
const effectId = `${commandId}:rtc-topology-recompute:1`;
const command = {
    ri_row_id: 1,
    ri_resource_id: commandId,
    ri_topic_id: 'app-inbox.group-topology',
    fk_ext_bank_id: 'scope',
    ri_status: 'COMPLETED',
    ri_attempts: 1,
    start_ts: new Date(1),
    end_ts: new Date(2),
    next_ts: null,
    result_status: 'COMPLETED',
    result_resource: JSON.stringify({
        receipt: {
            commandId,
            outcome: 'applied',
            attemptCount: 1,
            outboxIds: [effectId],
        },
    }),
    ri_resource: JSON.stringify({ payload: {
        typeId: 'TOPOLOGY_CONFIG_PUT',
        resource: JSON.stringify({ requestId: commandId }),
    } }),
};
const effect = {
    ri_resource_id: 'physical-queue-key-1',
    ri_topic_id: 'app-outbox.rtc-topology',
    ri_type_id: 'APP_OUTBOX',
    ri_status: 'NEW',
    ri_resource: JSON.stringify({
        id: { msgId: effectId },
    }),
};
const spec = {
    match: 'scope',
    commandTypes: ['TOPOLOGY_CONFIG_PUT'],
    expectedEffectsByCommandType: {
        TOPOLOGY_CONFIG_PUT: ['rtc-topology-recompute'],
    },
};

describe('durable AppInbox result evidence', () => {
    it('accepts an exact persisted receipt and ResourceInbox effect identity', () => {
        expect(deriveApiV1StateWriteEvidence(spec, [command], [effect])).toMatchObject({
            atomicCompletionFailures: 0,
            receiptOutboxIds: [effectId],
            resourceOutbox: [{ resourceId: 'physical-queue-key-1', outboxId: effectId }],
            appInbox: [{ durableResultValid: true, receipt: {
                commandId, identityKind: 'logical-msg-id',
            } }],
        });
    });

    it('accepts a physical queue-key receipt without conflating it with logical msgId', () => {
        const presenceCommandId = 'presence-command-1';
        const physicalEffectId = 'presence-effect-physical-1';
        const presence = {
            ...command,
            ri_resource_id: presenceCommandId,
            ri_resource: JSON.stringify({ payload: {
                typeId: 'GROUP_PRESENCE_CONNECT',
                resource: JSON.stringify({ commandId: presenceCommandId }),
            } }),
            result_resource: JSON.stringify({
                commandId: presenceCommandId, outcome: 'applied', attemptCount: 1,
                outboxIds: [physicalEffectId],
            }),
        };
        const presenceEffect = {
            ...effect,
            ri_resource_id: physicalEffectId,
            ri_topic_id: 'app-outbox.group-presence-summary',
            ri_resource: JSON.stringify({ id: {
                msgId: `${presenceCommandId}:group-presence-summary:1`,
            } }),
        };
        expect(deriveApiV1StateWriteEvidence({
            match: 'scope', commandTypes: ['GROUP_PRESENCE_CONNECT'],
            expectedEffectsByCommandType: {
                GROUP_PRESENCE_CONNECT: ['group-presence-summary'],
            },
        }, [presence], [presenceEffect])).toMatchObject({
            atomicCompletionFailures: 0,
            appInbox: [{ receipt: { identityKind: 'physical-resource-id' } }],
            resourceOutbox: [{
                resourceId: physicalEffectId,
                outboxId: `${presenceCommandId}:group-presence-summary:1`,
            }],
        });
    });

    it.each([
        ['missing', null],
        ['malformed', '{'],
        ['wrong command', JSON.stringify({ receipt: {
            commandId: 'invented-command', outcome: 'applied', attemptCount: 1,
            outboxIds: [effectId],
        } })],
        ['duplicate effect identity', JSON.stringify({ receipt: {
            commandId, outcome: 'applied', attemptCount: 1,
            outboxIds: [effectId, effectId],
        } })],
    ])('rejects a %s durable result', (_name, resultResource) => {
        expect(deriveApiV1StateWriteEvidence(
            spec,
            [{ ...command, result_resource: resultResource }],
            [effect],
        )).toMatchObject({ atomicCompletionFailures: 1, statusResultFailures: 1 });
    });

    it('rejects a receipt whose exact effect identity is absent or unexpected', () => {
        expect(deriveApiV1StateWriteEvidence(spec, [command], [{
            ...effect,
            ri_resource: JSON.stringify({
                id: { msgId: `${commandId}:rtc-topology-recompute:different-effect` },
            }),
        }])).toMatchObject({
            atomicCompletionFailures: 1,
            finalEffectFailures: [commandId],
        });
        expect(deriveApiV1StateWriteEvidence(spec, [command], [effect, {
            ...effect,
            ri_resource_id: 'unexpected-effect',
        }])).toMatchObject({
            atomicCompletionFailures: 1,
            finalEffectFailures: [commandId],
        });
    });

    it('requires the public client response shape without inventing outbox ids', () => {
        const client = {
            ...command,
            ri_resource_id: 'client-command-1',
            ri_resource: JSON.stringify({ payload: {
                typeId: 'CLIENT_INSTANCE_UPSERT',
                resource: JSON.stringify({ requestId: 'client-command-1' }),
            } }),
            result_resource: JSON.stringify({ status: 'ok', result: { right: {
                snapshot: {}, event: null,
            } } }),
        };
        const valid = deriveApiV1StateWriteEvidence({
            match: 'scope', commandTypes: ['CLIENT_INSTANCE_UPSERT'],
        }, [client]);
        expect(valid).toMatchObject({
            atomicCompletionFailures: 0,
            receiptOutboxIdCount: 0,
            appInbox: [{ durableResultValid: true }],
        });
        const tampered = deriveApiV1StateWriteEvidence({
            match: 'scope', commandTypes: ['CLIENT_INSTANCE_UPSERT'],
        }, [{ ...client, result_resource: JSON.stringify({ status: 'ok' }) }]);
        expect(tampered).toMatchObject({ atomicCompletionFailures: 1 });
    });
});
