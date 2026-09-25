import { RALLAR_BLACK_BOX_ASSERT_OPERATORS } from './assert/assert-value-operators.ts';
import {
    RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_ORDERINGS,
    RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_POLICY_MODES,
    RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_PATTERNS,
    RALLAR_BLACK_BOX_DISTRIBUTED_START_MODES,
    RALLAR_BLACK_BOX_DISTRIBUTED_TARGET_POLICY_MODES
} from './distributed-run.ts';
import { RALLAR_BLACK_BOX_GROUP_ASSERTIONS_SCHEMA } from './distributed/rallar-black-box-group-assertions-schema.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommandKind
} from './rallar-black-box-test-contracts.ts';
import type { JsonSchema } from './schema/json-schema-validation.ts';
import { RALLAR_BLACK_BOX_COMMAND_CAPABILITIES } from './schema/rallar-black-box-command-capabilities.ts';
import {
    RALLAR_BLACK_BOX_COMMAND_BASE_FIELDS,
    RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES,
    RALLAR_BLACK_BOX_COMMAND_FIELDS,
    RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS,
    type RallarBlackBoxCommandFieldName,
    type RallarBlackBoxCommandFieldSet
} from './schema/rallar-black-box-command-fields.ts';

export const RALLAR_BLACK_BOX_SCHEMA_VERSION = 1;
export const RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION = RALLAR_BLACK_BOX_SCHEMA_VERSION;
export const RALLAR_BLACK_BOX_SUPPORTED_RECIPE_SCHEMA_VERSIONS = [
    RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION
] as const;

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const SCHEMA_BASE_ID = 'https://rallar.dev/schemas/black-box';

const anySchema: JsonSchema = {};

const stringSchema: JsonSchema = { type: 'string' };
const numberSchema: JsonSchema = { type: 'number' };
const integerSchema: JsonSchema = { type: 'integer' };
const booleanSchema: JsonSchema = { type: 'boolean' };
const recordSchema: JsonSchema = { type: 'object', additionalProperties: true };
const stringRecordSchema: JsonSchema = { type: 'object', additionalProperties: stringSchema };
const recursiveCommandSchema: JsonSchema = { $ref: '#/$defs/command' };

type CommandPropertySchemas<Kind extends RallarBlackBoxTestCommandKind> = Readonly<
    Record<RallarBlackBoxCommandFieldName<(typeof RALLAR_BLACK_BOX_COMMAND_FIELDS)[Kind]>, JsonSchema>
>;

type ObjectPropertySchemas<FieldSet extends RallarBlackBoxCommandFieldSet> = Readonly<
    Record<RallarBlackBoxCommandFieldName<FieldSet>, JsonSchema>
>;

function commandBaseProperties(
    kind: RallarBlackBoxTestCommandKind
): Readonly<Record<'kind' | (typeof RALLAR_BLACK_BOX_COMMAND_BASE_FIELDS)[number], JsonSchema>> {
    return {
        kind: { const: kind },
        commandId: stringSchema,
        label: stringSchema,
        deadlineEpochMs: integerSchema,
        timeoutMs: integerSchema,
        metadata: recordSchema
    };
}

function strictCommandSchema<Kind extends RallarBlackBoxTestCommandKind>(
    kind: Kind,
    properties: CommandPropertySchemas<Kind>
): JsonSchema {
    return {
        type: 'object',
        required: ['kind', ...RALLAR_BLACK_BOX_COMMAND_FIELDS[kind].required],
        properties: {
            ...commandBaseProperties(kind),
            ...properties
        },
        additionalProperties: false
    };
}

function strictObjectSchema<FieldSet extends RallarBlackBoxCommandFieldSet>(
    fields: FieldSet,
    properties: ObjectPropertySchemas<FieldSet>
): JsonSchema {
    return {
        type: 'object',
        ...(fields.required.length > 0 ? { required: fields.required } : {}),
        properties,
        additionalProperties: false
    };
}

const inlineRecipeSchema: JsonSchema = { $ref: '#/$defs/recipe' };

const configSchema: JsonSchema = {
    type: 'object',
    properties: {
        runId: stringSchema,
        agentId: stringSchema,
        environment: stringSchema,
        apiBaseUrl: stringSchema,
        actor: stringSchema,
        sessionId: stringSchema,
        roomId: stringSchema,
        transport: { type: 'string', enum: ['realtime', 'messages.rtc', 'messages.ws', 'ws', 'http'] },
        rallar: recordSchema,
        browser: recordSchema,
        control: recordSchema,
        defaults: recordSchema,
        redaction: {
            type: 'object',
            properties: {
                keys: { type: 'array', items: stringSchema },
                keySubstrings: { type: 'array', items: stringSchema },
                secretValues: { type: 'array', items: stringSchema },
                replacement: stringSchema
            },
            additionalProperties: false
        }
    },
    additionalProperties: false
};

const rtcTransportSchema: JsonSchema = { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.rtcSendTransport };
const rtcConnectTransportSchema: JsonSchema = {
    type: 'string',
    enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.rtcConnectTransport
};
const rtcConnectReadinessSchema = strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.rtcConnectReadiness, {
    minReadyPeers: { type: 'integer', minimum: 1 },
    timeoutMs: { type: 'integer', minimum: 1 },
    intervalMs: { type: 'integer', minimum: 1 }
});
const rtcStreamThresholdsSchema = strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.rtcStreamThresholds, {
    minSendSuccessRatio: { type: 'number', minimum: 0, maximum: 1 },
    maxDroppedFrames: { type: 'number', minimum: 0 },
    maxBackpressureCount: { type: 'number', minimum: 0 },
    maxP95SendDurationMs: { type: 'number', minimum: 0 },
    maxP99SendDurationMs: { type: 'number', minimum: 0 },
    maxAverageStartDriftMs: { type: 'number', minimum: 0 },
    maxStartDriftMs: { type: 'number', minimum: 0 },
    maxJitterMs: { type: 'number', minimum: 0 }
});
const crdtTransportSchema: JsonSchema = {
    type: 'string',
    enum: ['local-only', 'ws', 'rtc', 'ws-then-rtc', 'rtc-with-ws-fallback']
};
const crdtDurableCatchUpSchema: JsonSchema = {
    oneOf: [
        { const: false },
        { const: 'http' }
    ]
};
const crdtPathSchema: JsonSchema = { type: 'array', items: stringSchema };
const crdtUpdateIdArraySchema: JsonSchema = { type: 'array', items: stringSchema };
const crdtWaitOperatorSchema: JsonSchema = {
    type: 'string',
    enum: ['equals', 'notEquals', 'contains', 'exists', 'gte', 'lte']
};
const crdtOperationSchema: JsonSchema = {
    oneOf: [
        {
            type: 'object',
            required: ['kind', 'path', 'elementId', 'value'],
            properties: {
                kind: { const: 'orset.add' },
                path: crdtPathSchema,
                elementId: stringSchema,
                value: anySchema
            },
            additionalProperties: false
        },
        {
            type: 'object',
            required: ['kind', 'path', 'elementId', 'observedAddUpdateIds'],
            properties: {
                kind: { const: 'orset.remove' },
                path: crdtPathSchema,
                elementId: stringSchema,
                observedAddUpdateIds: crdtUpdateIdArraySchema
            },
            additionalProperties: false
        },
        {
            type: 'object',
            required: ['kind', 'path', 'value', 'policy'],
            properties: {
                kind: { const: 'register.set' },
                path: crdtPathSchema,
                value: anySchema,
                policy: { type: 'string', enum: ['lww', 'multi'] }
            },
            additionalProperties: false
        },
        {
            type: 'object',
            required: ['kind', 'path', 'key', 'value'],
            properties: {
                kind: { const: 'map.set' },
                path: crdtPathSchema,
                key: stringSchema,
                value: anySchema
            },
            additionalProperties: false
        },
        {
            type: 'object',
            required: ['kind', 'path', 'key', 'observedUpdateIds'],
            properties: {
                kind: { const: 'map.delete' },
                path: crdtPathSchema,
                key: stringSchema,
                observedUpdateIds: crdtUpdateIdArraySchema
            },
            additionalProperties: false
        },
        {
            type: 'object',
            required: ['kind', 'path', 'elementId', 'positionId', 'value'],
            properties: {
                kind: { const: 'sequence.insert' },
                path: crdtPathSchema,
                elementId: stringSchema,
                positionId: stringSchema,
                value: anySchema
            },
            additionalProperties: false
        },
        {
            type: 'object',
            required: ['kind', 'path', 'elementId', 'observedUpdateIds'],
            properties: {
                kind: { const: 'sequence.delete' },
                path: crdtPathSchema,
                elementId: stringSchema,
                observedUpdateIds: crdtUpdateIdArraySchema
            },
            additionalProperties: false
        },
        {
            type: 'object',
            required: ['kind', 'path', 'elementId', 'positionId', 'observedUpdateIds'],
            properties: {
                kind: { const: 'sequence.move' },
                path: crdtPathSchema,
                elementId: stringSchema,
                positionId: stringSchema,
                observedUpdateIds: crdtUpdateIdArraySchema
            },
            additionalProperties: false
        },
        {
            type: 'object',
            required: ['kind', 'path', 'delta'],
            properties: {
                kind: { const: 'counter.add' },
                path: crdtPathSchema,
                delta: numberSchema
            },
            additionalProperties: false
        },
        {
            type: 'object',
            required: ['kind', 'path', 'value'],
            properties: {
                kind: { const: 'number.min' },
                path: crdtPathSchema,
                value: numberSchema
            },
            additionalProperties: false
        },
        {
            type: 'object',
            required: ['kind', 'path', 'value'],
            properties: {
                kind: { const: 'number.max' },
                path: crdtPathSchema,
                value: numberSchema
            },
            additionalProperties: false
        }
    ]
};
const crdtOperationBatchSchema: JsonSchema = {
    type: 'object',
    required: ['kind', 'operations'],
    properties: {
        kind: { const: 'batch' },
        operations: {
            type: 'array',
            minItems: 1,
            items: crdtOperationSchema
        },
        operationGroupId: stringSchema,
        metadata: recordSchema
    },
    additionalProperties: false
};
const crdtOperationArraySchema: JsonSchema = {
    type: 'array',
    items: crdtOperationSchema
};
const crdtPoliciesSchema: JsonSchema = {
    type: 'array',
    items: recordSchema
};
const crdtWaitConditionSchema: JsonSchema = {
    type: 'object',
    required: ['source', 'operator'],
    properties: {
        source: { type: 'string', enum: ['value', 'health'] },
        path: stringSchema,
        operator: crdtWaitOperatorSchema,
        expected: anySchema
    },
    additionalProperties: false
};

const commandRoomProperties = {
    roomId: stringSchema,
    applicationId: stringSchema,
    workspaceId: stringSchema,
    scope: recordSchema,
    roomRef: recordSchema
};

const directorRelayConfigProperties = {
    handle: stringSchema,
    laneId: stringSchema,
    topicId: stringSchema,
    intentTypeId: stringSchema,
    outputTypeId: stringSchema,
    heartbeatTypeId: stringSchema,
    snapshotTypeId: stringSchema,
    syncRequestTypeId: stringSchema,
    heartbeatIntervalMs: { type: 'integer', minimum: 0 },
    snapshotIntervalMs: { type: 'integer', minimum: 0 },
    snapshot: anySchema
};
const crdtWaitSyncSchema: JsonSchema = {
    oneOf: [
        { const: false },
        {
            type: 'object',
            properties: {
                reason: stringSchema,
                transport: crdtTransportSchema
            },
            additionalProperties: false
        }
    ]
};

const httpRequestSchema = strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.httpRequest, {
    url: stringSchema,
    path: stringSchema,
    method: stringSchema,
    headers: stringRecordSchema,
    body: anySchema,
    credentials: { type: 'string', enum: ['omit', 'same-origin', 'include'] },
    mode: { type: 'string', enum: ['cors', 'navigate', 'no-cors', 'same-origin'] }
});

const httpResponseSchema = strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.httpResponse, {
    body: { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.httpResponseBody },
    maxBodyChars: integerSchema,
    acceptedStatusCodes: {
        type: 'array',
        minItems: 1,
        items: { type: 'integer', minimum: 100, maximum: 599 }
    }
});

const waitMatchSchema = strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.waitMatch, {
    kind: { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.waitMatchKind },
    topic: stringSchema,
    commandId: stringSchema,
    connection: stringSchema,
    transport: { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.waitMatchTransport },
    severity: { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.waitMatchSeverity },
    payloadPath: stringSchema,
    equals: anySchema,
    contains: stringSchema,
    exists: booleanSchema,
    sinceEpochMs: { type: 'integer', minimum: 0 }
});

const assertOperatorSchema: JsonSchema = {
    type: 'string',
    enum: RALLAR_BLACK_BOX_ASSERT_OPERATORS
};

const parallelGroupSchema = strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.parallelGroup, {
    groupId: stringSchema,
    label: stringSchema,
    commands: {
        type: 'array',
        minItems: 1,
        items: recursiveCommandSchema
    },
    metadata: recordSchema
});

const loopThresholdsSchema = strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.loopThresholds, {
    minAchievedRateHz: { type: 'number', minimum: 0 },
    maxAverageStartDriftMs: { type: 'number', minimum: 0 },
    maxStartDriftMs: { type: 'number', minimum: 0 },
    maxJitterMs: { type: 'number', minimum: 0 },
    minSendSuccessRatio: { type: 'number', minimum: 0, maximum: 1 },
    failOnBackpressure: booleanSchema
});

const messagesCarrierSchema: JsonSchema = {
    type: 'string',
    enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesCarrier
};
const messagesReliabilitySchema: JsonSchema = {
    type: 'string',
    enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesReliability
};
const messagesScopeSchema: JsonSchema = { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesScope };
const messagesAckSchema: JsonSchema = { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesAck };
const messagesReplaySchema = strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.messagesReplay, {
    handleId: stringSchema,
    carrier: { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesReplayCarrier }
});
/** Exactly one form: `absolute`, or `aboveCurrentBy` the sender's room version at send time. */
const messagesSnapshotFloorSchema: JsonSchema = {
    oneOf: RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.messagesSnapshotFloor.optional.map((field) => ({
        type: 'object',
        required: [field],
        properties: { [field]: { type: 'integer', minimum: 1 } },
        additionalProperties: false
    }))
};
const messagesQosSchema = strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.messagesQos, {
    ack: strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.messagesQosAck, {
        algo: { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesQosAckAlgo }
    })
});
const faultMatchSchema = strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.faultMatch, {
    controlType: { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.faultControlType },
    typeId: stringSchema,
    msgId: stringSchema
});
const faultActionSchema: JsonSchema = {
    oneOf: [
        { type: 'string', enum: ['drop', 'not-ready'] },
        strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.faultDelayAction, { delayMs: numberSchema })
    ]
};

/**
 * An ordinary send requires its carrier, type and payload; a replay names `replayOnCarrier` instead. The control
 * validator and the page decoder refuse a replay that also names an ordinary send field.
 */
function toMessagesSendSchema(schema: JsonSchema): JsonSchema {
    return {
        ...schema,
        required: ['kind'],
        requiredAnyOf: RALLAR_BLACK_BOX_COMMAND_FIELDS['messages.send'].required.map((field) => ({
            properties: [field, 'replayOnCarrier'],
            message: `messages.send requires ${field}, unless it is a replay naming replayOnCarrier.`
        }))
    };
}

const COMMAND_SCHEMAS: Readonly<Record<RallarBlackBoxTestCommandKind, JsonSchema>> = {
    configure: strictCommandSchema('configure', {
        config: configSchema
    }),
    'recipe.load': strictCommandSchema('recipe.load', {
        recipe: inlineRecipeSchema
    }),
    'recipe.run': strictCommandSchema('recipe.run', {
        recipe: inlineRecipeSchema
    }),
    'recipe.cancel': strictCommandSchema('recipe.cancel', {
        reason: stringSchema,
        targetCommandId: stringSchema
    }),
    loop: strictCommandSchema('loop', {
        commands: {
            type: 'array',
            minItems: 1,
            items: recursiveCommandSchema
        },
        count: {
            type: 'integer',
            minimum: 1,
            maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount
        },
        durationMs: {
            type: 'integer',
            minimum: 1,
            maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopDurationMs
        },
        intervalMs: { type: 'integer', minimum: 0 },
        delayMs: { type: 'integer', minimum: 0 },
        continueOnFailure: booleanSchema,
        until: { const: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.loopUntil[0] },
        backoffMultiplier: { type: 'number', minimum: 1 },
        maxCommands: {
            type: 'integer',
            minimum: 1,
            maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands
        },
        thresholds: loopThresholdsSchema
    }),
    parallel: strictCommandSchema('parallel', {
        groups: {
            type: 'array',
            minItems: 1,
            items: parallelGroupSchema
        },
        maxConcurrency: {
            type: 'integer',
            minimum: 1,
            maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxParallelConcurrency
        },
        failFast: booleanSchema,
        continueOnFailure: booleanSchema
    }),
    wait: strictCommandSchema('wait', {
        match: waitMatchSchema,
        absent: { const: true }
    }),
    assert: strictCommandSchema('assert', {
        source: stringSchema,
        operator: assertOperatorSchema,
        expected: anySchema
    }),
    'rtc.connect': strictCommandSchema('rtc.connect', {
        connection: stringSchema,
        actor: stringSchema,
        roomId: stringSchema,
        applicationId: stringSchema,
        workspaceId: stringSchema,
        scope: recordSchema,
        roomRef: recordSchema,
        minSnapshotVersion: numberSchema,
        transport: rtcConnectTransportSchema,
        rallar: recordSchema,
        readiness: rtcConnectReadinessSchema
    }),
    'rtc.send': strictCommandSchema('rtc.send', {
        connection: stringSchema,
        send: anySchema,
        applicationId: stringSchema,
        workspaceId: stringSchema,
        scope: recordSchema,
        roomRef: recordSchema,
        minSnapshotVersion: numberSchema,
        transport: rtcTransportSchema
    }),
    'rtc.stream': {
        ...strictCommandSchema('rtc.stream', {
            connection: stringSchema,
            actor: stringSchema,
            roomId: stringSchema,
            applicationId: stringSchema,
            workspaceId: stringSchema,
            scope: recordSchema,
            roomRef: recordSchema,
            minSnapshotVersion: numberSchema,
            transport: rtcTransportSchema,
            send: anySchema,
            count: { type: 'integer', minimum: 1 },
            durationMs: {
                type: 'integer',
                minimum: 1,
                maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopDurationMs
            },
            intervalMs: { type: 'integer', minimum: 1 },
            rateHz: { type: 'number', exclusiveMinimum: 0 },
            maxInFlight: { type: 'integer', minimum: 1 },
            drainTimeoutMs: { type: 'integer', minimum: 0 },
            continueOnSendFailure: booleanSchema,
            progressEveryMs: { type: 'integer', minimum: 1 },
            sampleEvery: { type: 'integer', minimum: 1 },
            thresholds: rtcStreamThresholdsSchema
        }),
        requiredAnyOf: [
            {
                properties: ['count', 'durationMs'],
                message: 'rtc.stream requires count or durationMs.'
            },
            {
                properties: ['intervalMs', 'rateHz'],
                message: 'rtc.stream requires intervalMs or rateHz.'
            }
        ]
    },
    'messages.send': toMessagesSendSchema(strictCommandSchema('messages.send', {
        connection: stringSchema,
        carrier: messagesCarrierSchema,
        typeId: stringSchema,
        topicId: stringSchema,
        payload: anySchema,
        roomRef: recordSchema,
        scope: messagesScopeSchema,
        reliability: messagesReliabilitySchema,
        ack: messagesAckSchema,
        ttlMs: { type: 'integer', minimum: 0 },
        orderingKey: stringSchema,
        seq: numberSchema,
        handleId: stringSchema,
        minSnapshotVersion: messagesSnapshotFloorSchema,
        qos: messagesQosSchema,
        replayOnCarrier: messagesReplaySchema
    })),
    'messages.observe': strictCommandSchema('messages.observe', {
        connection: stringSchema,
        handleId: stringSchema,
        state: { type: 'array', items: stringSchema }
    }),
    'messages.cancel': strictCommandSchema('messages.cancel', {
        connection: stringSchema,
        handleId: stringSchema
    }),
    'messages.received': strictCommandSchema('messages.received', {
        connection: stringSchema,
        typeId: stringSchema,
        msgId: stringSchema,
        count: { type: 'integer', minimum: 0 },
        absent: booleanSchema,
        windowMs: { type: 'integer', minimum: 0 }
    }),
    'messages.receipts': strictCommandSchema('messages.receipts', {
        connection: stringSchema,
        handleId: stringSchema
    }),
    'fault.inject': {
        oneOf: ['ws', 'rtc'].map((carrier) =>
            strictCommandSchema('fault.inject', {
                faultId: stringSchema,
                carrier: { const: carrier },
                match: faultMatchSchema,
                action: carrier === 'ws' ? faultActionSchema : { const: 'drop' },
                remaining: { oneOf: [numberSchema, { const: 'until-cleared' }] }
            })
        )
    },
    'storage.counters': strictCommandSchema('storage.counters', {
        reset: booleanSchema
    }),
    'agent.reload': strictCommandSchema('agent.reload', {
        readyTimeoutMs: { type: 'integer', minimum: 0 }
    }),
    'ws.open': strictCommandSchema('ws.open', {
        connection: stringSchema,
        url: stringSchema,
        protocols: {
            oneOf: [
                stringSchema,
                { type: 'array', items: stringSchema }
            ]
        },
        headers: stringRecordSchema
    }),
    'ws.send': strictCommandSchema('ws.send', {
        connection: stringSchema,
        data: anySchema
    }),
    'ws.close': strictCommandSchema('ws.close', {
        connection: stringSchema,
        code: integerSchema,
        reason: stringSchema
    }),
    'http.request': strictCommandSchema('http.request', {
        request: httpRequestSchema,
        response: httpResponseSchema
    }),
    'crdt.open': strictCommandSchema('crdt.open', {
        handle: stringSchema,
        name: stringSchema,
        applicationId: stringSchema,
        workspaceId: stringSchema,
        documentId: stringSchema,
        documentType: stringSchema,
        scope: recordSchema,
        roomRef: recordSchema,
        principalId: stringSchema,
        customScope: stringSchema,
        transport: crdtTransportSchema,
        persist: booleanSchema,
        tabSync: booleanSchema,
        initialValue: anySchema,
        policies: crdtPoliciesSchema,
        validation: recordSchema,
        encryption: recordSchema,
        durableCatchUp: crdtDurableCatchUpSchema
    }),
    'crdt.apply': strictCommandSchema('crdt.apply', {
        handle: stringSchema,
        batch: crdtOperationBatchSchema
    }),
    'crdt.read': strictCommandSchema('crdt.read', {
        handle: stringSchema
    }),
    'crdt.sync': strictCommandSchema('crdt.sync', {
        handle: stringSchema,
        reason: stringSchema,
        transport: crdtTransportSchema
    }),
    'crdt.health': strictCommandSchema('crdt.health', {
        handle: stringSchema
    }),
    'crdt.wait': strictCommandSchema('crdt.wait', {
        handle: stringSchema,
        intervalMs: { type: 'integer', minimum: 0 },
        stableForMs: { type: 'integer', minimum: 0 },
        sync: crdtWaitSyncSchema,
        conditions: {
            type: 'array',
            minItems: 1,
            items: crdtWaitConditionSchema
        }
    }),
    'crdt.undo': strictCommandSchema('crdt.undo', {
        handle: stringSchema,
        targetOperationGroupId: stringSchema,
        operations: crdtOperationArraySchema,
        operationGroupId: stringSchema
    }),
    'crdt.redo': strictCommandSchema('crdt.redo', {
        handle: stringSchema,
        targetOperationGroupId: stringSchema,
        operations: crdtOperationArraySchema,
        operationGroupId: stringSchema
    }),
    'crdt.close': strictCommandSchema('crdt.close', {
        handle: stringSchema
    }),
    'crdt.destroy': strictCommandSchema('crdt.destroy', {
        handle: stringSchema
    }),
    'director.appoint': strictCommandSchema('director.appoint', {
        ...commandRoomProperties,
        heartbeatTtlMs: { type: 'integer', minimum: 1 }
    }),
    'director.resign': strictCommandSchema('director.resign', {
        ...commandRoomProperties
    }),
    'director.status': strictCommandSchema('director.status', {
        ...commandRoomProperties,
        refresh: booleanSchema,
        now: numberSchema
    }),
    'director.relay.start': strictCommandSchema('director.relay.start', {
        ...commandRoomProperties,
        ...directorRelayConfigProperties
    }),
    'director.intent': strictCommandSchema('director.intent', {
        handle: stringSchema,
        intent: anySchema
    }),
    'director.sync.request': strictCommandSchema('director.sync.request', {
        handle: stringSchema,
        payload: anySchema
    }),
    'director.relay.stop': strictCommandSchema('director.relay.stop', {
        handle: stringSchema
    }),
    'formation.command': strictCommandSchema('formation.command', {
        ...commandRoomProperties,
        command: {
            type: 'string',
            enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.formationCommand
        },
        layout: recordSchema,
        landing: { type: 'string', enum: ['apply', 'hold'] },
        reason: stringSchema
    }),
    'formation.readiness': strictCommandSchema('formation.readiness', {
        ...commandRoomProperties
    }),
    health: strictCommandSchema('health', {
        includeRtcDiagnostics: booleanSchema
    }),
    stats: strictCommandSchema('stats', {}),
    close: strictCommandSchema('close', { targetCommandId: { type: 'string' } }),
    reset: strictCommandSchema('reset', {})
};
const commandSchema: JsonSchema = {
    oneOf: RALLAR_BLACK_BOX_COMMAND_CAPABILITIES.map((capability) => COMMAND_SCHEMAS[capability.kind])
};
const recipeSchema = strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.recipe, {
    schemaVersion: { const: RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION },
    recipeId: stringSchema,
    name: stringSchema,
    description: stringSchema,
    continueOnFailure: booleanSchema,
    metadata: recordSchema,
    commands: {
        type: 'array',
        items: recursiveCommandSchema
    }
});
const commandDefinitions: Readonly<Record<string, JsonSchema>> = { command: commandSchema, recipe: recipeSchema };

export const RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA: JsonSchema = {
    $schema: JSON_SCHEMA_DRAFT,
    $id: `${SCHEMA_BASE_ID}/rallar-bb-test-command.schema.json`,
    $defs: commandDefinitions,
    title: 'Rallar black-box browser-agent command',
    description: 'Command JSON accepted by the SPA runtime and browser control agents.',
    ...commandSchema,
    examples: RALLAR_BLACK_BOX_COMMAND_CAPABILITIES.map((capability) => capability.example)
};

export const RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA: JsonSchema = {
    $schema: JSON_SCHEMA_DRAFT,
    $id: `${SCHEMA_BASE_ID}/rallar-bb-test-recipe.schema.json`,
    $defs: commandDefinitions,
    title: 'Rallar black-box browser-agent recipe',
    description: 'A browser-agent recipe made from rallar-bb-test commands.',
    ...recipeSchema
};

export const RALLAR_BLACK_BOX_CONTROL_COMMAND_ENVELOPE_SCHEMA: JsonSchema = {
    $schema: JSON_SCHEMA_DRAFT,
    $id: `${SCHEMA_BASE_ID}/rallar-bb-test-control-command-envelope.schema.json`,
    title: 'Rallar black-box control command envelope',
    description: 'Server-to-browser control message that dispatches one command to an agent.',
    type: 'object',
    required: ['kind', 'protocolVersion', 'runId', 'commandId', 'command'],
    properties: {
        kind: { const: 'command' },
        protocolVersion: { const: 1 },
        runId: stringSchema,
        agentId: stringSchema,
        commandId: stringSchema,
        command: RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
        deadlineEpochMs: integerSchema
    },
    additionalProperties: false
};

export const RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA: JsonSchema = {
    $schema: JSON_SCHEMA_DRAFT,
    $id: `${SCHEMA_BASE_ID}/rallar-bb-test-distributed-run-manifest.schema.json`,
    title: 'Rallar black-box distributed run manifest',
    description: 'Orchestration manifest for running one or more recipes across selected browser agents.',
    type: 'object',
    required: [
        'schemaVersion',
        'distributedRunId',
        'controlRunId',
        'group',
        'recipes',
        'targetPolicy',
        'variables',
        'roleAssignments',
        'ackTimeoutMs',
        'barrier',
        'startMode',
        'groupAssertions',
        'metadata'
    ],
    properties: {
        schemaVersion: { const: 1 },
        distributedRunId: stringSchema,
        controlRunId: stringSchema,
        displayName: stringSchema,
        description: stringSchema,
        group: {
            type: 'object',
            required: ['applicationId', 'workspaceId', 'groupId'],
            properties: {
                applicationId: stringSchema,
                workspaceId: stringSchema,
                groupId: stringSchema
            },
            additionalProperties: false
        },
        recipes: {
            type: 'array',
            items: {
                type: 'object',
                required: ['recipeId', 'variables'],
                properties: {
                    recipeId: stringSchema,
                    role: stringSchema,
                    profile: stringSchema,
                    recipe: RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
                    variables: recordSchema
                },
                additionalProperties: false
            }
        },
        targetPolicy: {
            type: 'object',
            required: ['mode'],
            properties: {
                mode: {
                    type: 'string',
                    enum: RALLAR_BLACK_BOX_DISTRIBUTED_TARGET_POLICY_MODES
                },
                expectedParticipantCount: { type: 'integer', minimum: 1 },
                agentIds: { type: 'array', items: stringSchema },
                roles: {
                    type: 'object',
                    additionalProperties: {
                        type: 'array',
                        items: stringSchema
                    }
                }
            },
            additionalProperties: false
        },
        variables: recordSchema,
        roleAssignments: {
            type: 'array',
            items: {
                type: 'object',
                required: ['role', 'agentId', 'recipeIds', 'variables'],
                properties: {
                    role: stringSchema,
                    agentId: stringSchema,
                    recipeIds: { type: 'array', items: stringSchema },
                    variables: recordSchema
                },
                additionalProperties: false
            }
        },
        roleAssignmentPolicy: {
            type: 'object',
            required: ['mode', 'pattern', 'orderBy'],
            properties: {
                mode: {
                    type: 'string',
                    enum: RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_POLICY_MODES
                },
                pattern: {
                    type: 'string',
                    enum: RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_PATTERNS
                },
                orderBy: {
                    type: 'string',
                    enum: RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_ORDERINGS
                }
            },
            additionalProperties: false
        },
        ackTimeoutMs: { type: 'integer', minimum: 1 },
        barrier: {
            type: 'object',
            required: ['enabled'],
            properties: {
                enabled: booleanSchema,
                timeoutMs: { type: 'integer', minimum: 1 }
            },
            additionalProperties: false
        },
        startMode: {
            type: 'string',
            enum: RALLAR_BLACK_BOX_DISTRIBUTED_START_MODES
        },
        startDeadlineEpochMs: integerSchema,
        groupAssertions: RALLAR_BLACK_BOX_GROUP_ASSERTIONS_SCHEMA,
        metadata: recordSchema
    },
    additionalProperties: false
};

export const RALLAR_BLACK_BOX_SCHEMA_CATALOG = {
    schemaVersion: RALLAR_BLACK_BOX_SCHEMA_VERSION,
    command: RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
    recipe: RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
    controlCommandEnvelope: RALLAR_BLACK_BOX_CONTROL_COMMAND_ENVELOPE_SCHEMA,
    distributedRunManifest: RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA
} as const;
