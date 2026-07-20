import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

const MESSAGE_SECTIONS = [
    'id', 'route', 'targets', 'forwarding', 'constraints', 'ordering',
    'delivery', 'actions', 'qos', 'payload', 'audit', 'diagnostics',
] as const;

/** Validates the complete persisted AL envelope without imposing topic semantics. */
export function validatePersistedALMessage(
    value: unknown,
): asserts value is ALMessage {
    const message = record(value, 'Persisted AL message');
    exactAllowedRequired(message, MESSAGE_SECTIONS, ['id', 'route', 'payload']);
    validateId(message.id);
    validateRoute(message.route);
    validatePayload(message.payload);
    if (message.targets !== undefined) validateTargets(message.targets);
    if (message.forwarding !== undefined) {
        const section = sectionRecord(message.forwarding, 'forwarding');
        exactAllowedRequired(section, ['nextHopPeerIds', 'overlayId', 'fanoutLimit'], []);
        optionalStringArray(section.nextHopPeerIds, 'forwarding next hops');
        optionalNonEmptyString(section.overlayId, 'forwarding overlay id');
        optionalSafeInteger(section.fanoutLimit, 1, 'forwarding fanout limit');
    }
    if (message.constraints !== undefined) {
        const section = sectionRecord(message.constraints, 'constraints');
        exactAllowedRequired(section, ['ttlHops', 'expiresAtMs'], []);
        optionalSafeInteger(section.ttlHops, 0, 'constraint hop ttl');
        optionalSafeInteger(section.expiresAtMs, 0, 'constraint expiry');
    }
    if (message.ordering !== undefined) {
        const section = sectionRecord(message.ordering, 'ordering');
        exactAllowedRequired(section, ['orderingKey', 'epoch', 'seq'], []);
        optionalNonEmptyString(section.orderingKey, 'ordering key');
        optionalSafeInteger(section.epoch, 0, 'ordering epoch');
        optionalSafeInteger(section.seq, 0, 'ordering sequence');
    }
    if (message.delivery !== undefined) validateDelivery(message.delivery);
    if (message.actions !== undefined) {
        const section = sectionRecord(message.actions, 'actions');
        exactAllowedRequired(section, ['corrId', 'replyToMsgId'], []);
        optionalNonEmptyString(section.corrId, 'action correlation id');
        optionalNonEmptyString(section.replyToMsgId, 'action reply id');
    }
    if (message.qos !== undefined) validateQos(message.qos);
    if (message.audit !== undefined) {
        const section = sectionRecord(message.audit, 'audit');
        exactAllowedRequired(section, ['createdBy', 'createdTs'], []);
        optionalNonEmptyString(section.createdBy, 'audit creator');
        optionalSafeInteger(section.createdTs, 0, 'audit creation time');
    }
    if (message.diagnostics !== undefined) {
        const section = sectionRecord(message.diagnostics, 'diagnostics');
        exactAllowedRequired(section, ['visitedPeerIds'], []);
        optionalStringArray(section.visitedPeerIds, 'diagnostic visited peers');
    }
}

function validateId(value: unknown): void {
    const id = sectionRecord(value, 'id');
    exactAllowedRequired(
        id,
        ['v', 'msgId', 'ts', 'senderId', 'sessionId', 'traceId'],
        ['v', 'msgId', 'ts', 'senderId'],
    );
    if (id.v !== 2) throw new TypeError('Persisted AL id version is invalid');
    nonEmptyString(id.msgId, 'id message id');
    safeInteger(id.ts, 0, 'id timestamp');
    nonEmptyString(id.senderId, 'id sender');
    optionalNonEmptyString(id.sessionId, 'id session');
    optionalNonEmptyString(id.traceId, 'id trace');
}

function validateRoute(value: unknown): void {
    const route = sectionRecord(value, 'route');
    exactAllowedRequired(
        route,
        ['topicId', 'resourceId', 'contextId'],
        ['topicId', 'resourceId', 'contextId'],
    );
    nonEmptyString(route.topicId, 'route topic');
    nonEmptyString(route.resourceId, 'route resource');
    nonEmptyString(route.contextId, 'route context');
}

function validatePayload(value: unknown): void {
    const payload = sectionRecord(value, 'payload');
    exactAllowedRequired(
        payload,
        ['typeId', 'contentType', 'resource'],
        ['typeId', 'resource'],
    );
    nonEmptyString(payload.typeId, 'payload type');
    nonEmptyString(payload.resource, 'payload resource');
    if (payload.contentType !== undefined && payload.contentType !== 'application/json') {
        throw new TypeError('Persisted AL payload content type is invalid');
    }
}

function validateTargets(value: unknown): void {
    const targets = sectionRecord(value, 'targets');
    if (targets.mode === 'unicast') {
        exactAllowedRequired(targets, ['mode', 'toPeerId'], ['mode', 'toPeerId']);
        nonEmptyString(targets.toPeerId, 'unicast peer');
        return;
    }
    if (targets.mode === 'multicast') {
        exactAllowedRequired(
            targets,
            ['mode', 'groupRef', 'membershipEpoch', 'minSnapshotVersion'],
            ['mode', 'groupRef'],
        );
        validateCanonicalGroupRef(targets.groupRef);
        optionalSafeInteger(targets.membershipEpoch, 0, 'membership epoch');
        optionalSafeInteger(targets.minSnapshotVersion, 1, 'minimum snapshot version');
        return;
    }
    if (targets.mode !== 'broadcast') {
        throw new TypeError('Persisted AL target mode is invalid');
    }
    exactAllowedRequired(
        targets,
        ['mode', 'scope', 'groupRef', 'exceptPeerIds', 'minSnapshotVersion'],
        ['mode', 'scope'],
    );
    if (!['room', 'world', 'all'].includes(targets.scope as string)) {
        throw new TypeError('Persisted AL broadcast scope is invalid');
    }
    if (targets.scope === 'room' && targets.groupRef === undefined) {
        throw new TypeError('Persisted AL room broadcast group ref is missing');
    }
    if (targets.groupRef !== undefined) validateCanonicalGroupRef(targets.groupRef);
    optionalStringArray(targets.exceptPeerIds, 'broadcast exclusions');
    optionalSafeInteger(targets.minSnapshotVersion, 1, 'minimum snapshot version');
}

function validateDelivery(value: unknown): void {
    const delivery = sectionRecord(value, 'delivery');
    exactAllowedRequired(
        delivery,
        ['ownership', 'reliability', 'ack'],
        ['reliability', 'ack'],
    );
    if (
        delivery.ownership !== undefined &&
        !['shared', 'exclusive'].includes(delivery.ownership as string)
    ) throw new TypeError('Persisted AL delivery ownership is invalid');
    if (!['best-effort', 'at-least-once'].includes(delivery.reliability as string)) {
        throw new TypeError('Persisted AL delivery reliability is invalid');
    }
    if (!['none', 'receiver', 'all-logical-recipients', 'group-leader'].includes(
        delivery.ack as string,
    )) throw new TypeError('Persisted AL delivery ack is invalid');
}

function validateQos(value: unknown): void {
    const qos = sectionRecord(value, 'qos');
    const algorithms = {
        delivery: ['best-effort', 'at-least-once'],
        forwarding: ['target'],
        repair: ['none', 'retransmit'],
        ack: ['none', 'hop', 'subtree'],
        expiry: ['ttl-only', 'expires-at', 'fresh-until'],
        retry: ['none', 'exp-backoff'],
        dedup: ['msg-id', 'msg-id+sender', 'semantic-key'],
        supersedence: ['none', 'latest-wins'],
        fanout: ['all', 'limit', 'random-k'],
        congestion: ['drop-low', 'defer', 'reject'],
        durability: ['volatile', 'local-outbox', 'local-inbox'],
        ownership: ['shared', 'exclusive'],
    } as const;
    exactAllowedRequired(qos, Object.keys(algorithms), []);
    for (const [aspect, allowed] of Object.entries(algorithms)) {
        const request = qos[aspect];
        if (request === undefined) continue;
        const requestRecord = sectionRecord(request, `qos ${aspect}`);
        exactAllowedRequired(requestRecord, ['algo', 'opts'], ['algo']);
        if (!allowed.includes(requestRecord.algo as never)) {
            throw new TypeError(`Persisted AL qos ${aspect} algorithm is invalid`);
        }
        if (requestRecord.opts !== undefined) validateQosOptions(aspect, requestRecord.opts);
    }
}

function validateQosOptions(aspect: string, value: unknown): void {
    const options = sectionRecord(value, `qos ${aspect} options`);
    const keys: Record<string, readonly string[]> = {
        delivery: [], forwarding: ['overlayId'], repair: ['maxRepairs'],
        ack: ['timeoutMs'], expiry: ['ttlHops', 'expiresAtMs', 'maxStalenessMs'],
        retry: ['maxAttempts'], dedup: ['windowMs', 'semanticKey'],
        supersedence: ['supersedenceKey', 'replacesMsgId'], fanout: ['limit'],
        congestion: ['priority'], durability: [], ownership: [],
    };
    exactAllowedRequired(options, keys[aspect] ?? [], []);
    for (const field of ['overlayId', 'semanticKey', 'supersedenceKey', 'replacesMsgId']) {
        optionalNonEmptyString(options[field], `qos ${field}`);
    }
    for (const field of [
        'maxRepairs', 'timeoutMs', 'ttlHops', 'expiresAtMs', 'maxStalenessMs',
        'maxAttempts', 'windowMs', 'limit',
    ]) optionalSafeInteger(options[field], 0, `qos ${field}`);
    if (options.priority !== undefined &&
        (typeof options.priority !== 'number' || !Number.isFinite(options.priority))) {
        throw new TypeError('Persisted AL qos priority is invalid');
    }
}

function validateCanonicalGroupRef(value: unknown): void {
    const ref = sectionRecord(value, 'group ref');
    if (!Object.hasOwn(ref, 'workspaceId')) {
        throw new TypeError('Persisted AL group workspace id is missing');
    }
    exactAllowedRequired(
        ref,
        ['applicationId', 'workspaceId', 'groupId'],
        ['applicationId', 'workspaceId', 'groupId'],
    );
    nonEmptyString(ref.applicationId, 'group application id');
    nonEmptyString(ref.workspaceId, 'group workspace id');
    nonEmptyString(ref.groupId, 'group id');
}

function sectionRecord(value: unknown, label: string): Record<string, unknown> {
    return record(value, `Persisted AL ${label}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value as Record<string, unknown>;
}

function exactAllowedRequired(
    value: Record<string, unknown>,
    allowed: readonly string[],
    required: readonly string[],
): void {
    if (Object.keys(value).some((key) => !allowed.includes(key))) {
        throw new TypeError('Persisted AL section has unknown fields');
    }
    if (required.some((key) => !Object.hasOwn(value, key))) {
        throw new TypeError('Persisted AL section is missing mandatory fields');
    }
}

function nonEmptyString(value: unknown, label: string): void {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`Persisted AL ${label} is invalid`);
    }
}

function optionalNonEmptyString(value: unknown, label: string): void {
    if (value !== undefined) nonEmptyString(value, label);
}

function safeInteger(value: unknown, minimum: number, label: string): void {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new TypeError(`Persisted AL ${label} is invalid`);
    }
}

function optionalSafeInteger(value: unknown, minimum: number, label: string): void {
    if (value !== undefined) safeInteger(value, minimum, label);
}

function optionalStringArray(value: unknown, label: string): void {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some((item) =>
        typeof item !== 'string' || item.length === 0
    )) throw new TypeError(`Persisted AL ${label} is invalid`);
}
