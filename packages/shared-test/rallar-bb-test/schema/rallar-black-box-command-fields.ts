import type { RallarBlackBoxTestCommandKind } from '../rallar-black-box-test-contracts.ts';

export interface RallarBlackBoxCommandFieldSet {
    readonly required: readonly string[];
    readonly optional: readonly string[];
}

export type RallarBlackBoxCommandFieldName<FieldSet extends RallarBlackBoxCommandFieldSet> =
    | FieldSet['required'][number]
    | FieldSet['optional'][number];

export const RALLAR_BLACK_BOX_COMMAND_BASE_FIELDS = [
    'commandId',
    'label',
    'timeoutMs',
    'deadlineEpochMs',
    'metadata'
] as const;

export const RALLAR_BLACK_BOX_COMMAND_FIELDS = {
    configure: { required: ['config'], optional: [] },
    'recipe.load': { required: ['recipe'], optional: [] },
    'recipe.run': { required: [], optional: ['recipe'] },
    'recipe.cancel': { required: [], optional: ['reason'] },
    loop: {
        required: ['commands'],
        optional: [
            'count',
            'durationMs',
            'intervalMs',
            'delayMs',
            'continueOnFailure',
            'until',
            'backoffMultiplier',
            'maxCommands',
            'thresholds'
        ]
    },
    parallel: { required: ['groups'], optional: ['maxConcurrency', 'failFast', 'continueOnFailure'] },
    wait: { required: ['match'], optional: ['absent'] },
    assert: { required: ['source', 'operator'], optional: ['expected'] },
    'rtc.connect': {
        required: [],
        optional: [
            'connection',
            'actor',
            'roomId',
            'applicationId',
            'workspaceId',
            'scope',
            'roomRef',
            'minSnapshotVersion',
            'transport',
            'rallar',
            'readiness'
        ]
    },
    'rtc.send': {
        required: [],
        optional: [
            'connection',
            'send',
            'applicationId',
            'workspaceId',
            'scope',
            'roomRef',
            'minSnapshotVersion',
            'transport'
        ]
    },
    'rtc.stream': {
        required: ['send'],
        optional: [
            'connection',
            'actor',
            'roomId',
            'applicationId',
            'workspaceId',
            'scope',
            'roomRef',
            'minSnapshotVersion',
            'transport',
            'count',
            'durationMs',
            'intervalMs',
            'rateHz',
            'maxInFlight',
            'drainTimeoutMs',
            'continueOnSendFailure',
            'progressEveryMs',
            'sampleEvery',
            'thresholds'
        ]
    },
    'messages.send': {
        required: ['carrier', 'typeId', 'payload'],
        optional: [
            'connection',
            'topicId',
            'roomRef',
            'scope',
            'reliability',
            'ack',
            'ttlMs',
            'orderingKey',
            'seq',
            'handleId'
        ]
    },
    'messages.observe': { required: ['handleId', 'state'], optional: ['connection'] },
    'messages.cancel': { required: ['handleId'], optional: ['connection'] },
    'messages.received': { required: ['typeId', 'count', 'windowMs'], optional: ['connection', 'msgId', 'absent'] },
    'messages.receipts': { required: ['handleId'], optional: ['connection'] },
    'fault.inject': { required: ['faultId', 'carrier', 'match', 'action', 'remaining'], optional: [] },
    'storage.counters': { required: [], optional: ['reset'] },
    'agent.reload': { required: ['readyTimeoutMs'], optional: [] },
    'ws.open': { required: [], optional: ['connection', 'url', 'protocols', 'headers'] },
    'ws.send': { required: [], optional: ['connection', 'data'] },
    'ws.close': { required: [], optional: ['connection', 'code', 'reason'] },
    'http.request': { required: ['request'], optional: ['response'] },
    'crdt.open': {
        required: ['name'],
        optional: [
            'handle',
            'applicationId',
            'workspaceId',
            'documentId',
            'documentType',
            'scope',
            'roomRef',
            'principalId',
            'customScope',
            'transport',
            'persist',
            'tabSync',
            'initialValue',
            'policies',
            'validation',
            'encryption',
            'durableCatchUp'
        ]
    },
    'crdt.apply': { required: ['handle', 'batch'], optional: [] },
    'crdt.read': { required: ['handle'], optional: [] },
    'crdt.sync': { required: ['handle'], optional: ['reason', 'transport'] },
    'crdt.health': { required: ['handle'], optional: [] },
    'crdt.wait': { required: ['handle', 'conditions'], optional: ['intervalMs', 'stableForMs', 'sync'] },
    'crdt.undo': { required: ['handle', 'targetOperationGroupId', 'operations'], optional: ['operationGroupId'] },
    'crdt.redo': { required: ['handle', 'targetOperationGroupId', 'operations'], optional: ['operationGroupId'] },
    'crdt.close': { required: ['handle'], optional: [] },
    'crdt.destroy': { required: ['handle'], optional: [] },
    'director.appoint': {
        required: [],
        optional: ['roomId', 'applicationId', 'workspaceId', 'scope', 'roomRef', 'heartbeatTtlMs']
    },
    'director.resign': { required: [], optional: ['roomId', 'applicationId', 'workspaceId', 'scope', 'roomRef'] },
    'director.status': {
        required: [],
        optional: ['roomId', 'applicationId', 'workspaceId', 'scope', 'roomRef', 'refresh', 'now']
    },
    'director.relay.start': {
        required: ['handle', 'intentTypeId', 'outputTypeId'],
        optional: [
            'roomId',
            'applicationId',
            'workspaceId',
            'scope',
            'roomRef',
            'laneId',
            'topicId',
            'heartbeatTypeId',
            'snapshotTypeId',
            'syncRequestTypeId',
            'heartbeatIntervalMs',
            'snapshotIntervalMs',
            'snapshot'
        ]
    },
    'director.intent': { required: ['handle', 'intent'], optional: [] },
    'director.sync.request': { required: ['handle'], optional: ['payload'] },
    'director.relay.stop': { required: ['handle'], optional: [] },
    'formation.command': {
        required: ['command'],
        optional: ['roomId', 'applicationId', 'workspaceId', 'scope', 'roomRef', 'layout', 'landing', 'reason']
    },
    'formation.readiness': { required: [], optional: ['roomId', 'applicationId', 'workspaceId', 'scope', 'roomRef'] },
    health: { required: [], optional: ['includeRtcDiagnostics'] },
    stats: { required: [], optional: [] },
    close: { required: [], optional: [] },
    reset: { required: [], optional: [] }
} as const satisfies Readonly<Record<RallarBlackBoxTestCommandKind, RallarBlackBoxCommandFieldSet>>;

export const RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS = {
    recipe: {
        required: ['schemaVersion', 'recipeId', 'commands'],
        optional: ['name', 'description', 'continueOnFailure', 'metadata']
    },
    parallelGroup: { required: ['commands'], optional: ['groupId', 'label', 'metadata'] },
    loopThresholds: {
        required: [],
        optional: [
            'minAchievedRateHz',
            'maxAverageStartDriftMs',
            'maxStartDriftMs',
            'maxJitterMs',
            'minSendSuccessRatio',
            'failOnBackpressure'
        ]
    },
    waitMatch: {
        required: [],
        optional: [
            'kind',
            'topic',
            'commandId',
            'connection',
            'transport',
            'severity',
            'payloadPath',
            'equals',
            'contains',
            'exists',
            'sinceEpochMs'
        ]
    },
    rtcConnectReadiness: { required: [], optional: ['minReadyPeers', 'timeoutMs', 'intervalMs'] },
    rtcStreamThresholds: {
        required: [],
        optional: [
            'minSendSuccessRatio',
            'maxDroppedFrames',
            'maxBackpressureCount',
            'maxP95SendDurationMs',
            'maxP99SendDurationMs',
            'maxAverageStartDriftMs',
            'maxStartDriftMs',
            'maxJitterMs'
        ]
    },
    httpRequest: { required: [], optional: ['url', 'path', 'method', 'headers', 'body', 'credentials', 'mode'] },
    httpResponse: { required: [], optional: ['body', 'maxBodyChars', 'acceptedStatusCodes'] },
    faultMatch: { required: [], optional: ['controlType', 'typeId', 'msgId'] },
    faultDelayAction: { required: ['delayMs'], optional: [] }
} as const satisfies Readonly<Record<string, RallarBlackBoxCommandFieldSet>>;

export const RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES = {
    waitMatchKind: ['event', 'diagnostic', 'message', 'stats', 'report', 'result', 'state'],
    waitMatchTransport: ['realtime', 'messages.rtc', 'ws', 'http'],
    waitMatchSeverity: ['debug', 'info', 'warning', 'error'],
    rtcConnectTransport: ['realtime', 'messages.rtc', 'messages.ws'],
    rtcSendTransport: ['realtime', 'messages.rtc'],
    loopUntil: ['first-success'],
    formationCommand: ['plan', 'connect', 'activate', 'reconfigure', 'pause', 'resume', 'reset', 'start'],
    httpResponseBody: ['none', 'text', 'json'],
    messagesCarrier: ['ws', 'rtc', 'rtc-with-ws-fallback'],
    messagesScope: ['room', 'world', 'all'],
    messagesReliability: ['best-effort', 'at-least-once'],
    messagesAck: ['none', 'receiver', 'all-logical-recipients', 'group-leader'],
    faultCarrier: ['ws', 'rtc'],
    faultControlType: ['ack', 'nack', 'repair']
} as const;
