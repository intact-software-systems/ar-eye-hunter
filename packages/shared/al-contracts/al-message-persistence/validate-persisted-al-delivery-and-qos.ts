import {
    requireOptionalPersistedALNonEmptyString,
    requireOptionalPersistedALSafeInteger,
    requirePersistedALFields,
    requirePersistedALRecord,
    type PersistedALValue
} from './persisted-al-value-validation.ts';

const ALGORITHMS: Readonly<Record<string, readonly string[]>> = {
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
    ownership: ['shared', 'exclusive']
};

const OPTION_KEYS: Readonly<Record<string, readonly string[]>> = {
    delivery: [],
    forwarding: ['overlayId'],
    repair: ['maxRepairs'],
    ack: ['timeoutMs'],
    expiry: ['ttlHops', 'expiresAtMs', 'maxStalenessMs'],
    retry: ['maxAttempts'],
    dedup: ['windowMs', 'semanticKey'],
    supersedence: ['supersedenceKey', 'replacesMsgId'],
    fanout: ['limit'],
    congestion: ['priority'],
    durability: [],
    ownership: []
};

export function validatePersistedALDelivery(value: PersistedALValue): void {
    const delivery = requirePersistedALRecord(value, 'delivery');
    requirePersistedALFields(
        delivery,
        ['ownership', 'reliability', 'ack'],
        ['reliability', 'ack']
    );
    if (
        delivery.ownership !== undefined &&
        (
            typeof delivery.ownership !== 'string' ||
            !['shared', 'exclusive'].includes(delivery.ownership)
        )
    ) {
        throw new TypeError('Persisted AL delivery ownership is invalid');
    }
    if (
        typeof delivery.reliability !== 'string' ||
        !['best-effort', 'at-least-once'].includes(delivery.reliability)
    ) {
        throw new TypeError('Persisted AL delivery reliability is invalid');
    }
    if (
        typeof delivery.ack !== 'string' ||
        !['none', 'receiver', 'all-logical-recipients', 'group-leader'].includes(delivery.ack)
    ) {
        throw new TypeError('Persisted AL delivery ack is invalid');
    }
}

export function validatePersistedALQos(value: PersistedALValue): void {
    const qos = requirePersistedALRecord(value, 'qos');
    requirePersistedALFields(qos, Object.keys(ALGORITHMS), []);
    for (const [aspect, allowed] of Object.entries(ALGORITHMS)) {
        const request = qos[aspect];
        if (request === undefined) {
            continue;
        }
        const requestRecord = requirePersistedALRecord(request, `qos ${aspect}`);
        requirePersistedALFields(requestRecord, ['algo', 'opts'], ['algo']);
        const algorithm = requestRecord.algo;
        if (typeof algorithm !== 'string' || !allowed.includes(algorithm)) {
            throw new TypeError(`Persisted AL qos ${aspect} algorithm is invalid`);
        }
        if (requestRecord.opts !== undefined) {
            validateQosOptions(aspect, requestRecord.opts);
        }
    }
}

function validateQosOptions(aspect: string, value: PersistedALValue): void {
    const options = requirePersistedALRecord(value, `qos ${aspect} options`);
    requirePersistedALFields(options, OPTION_KEYS[aspect] ?? [], []);
    for (const field of ['overlayId', 'semanticKey', 'supersedenceKey', 'replacesMsgId']) {
        requireOptionalPersistedALNonEmptyString(options[field], `qos ${field}`);
    }
    for (
        const field of [
            'maxRepairs',
            'timeoutMs',
            'ttlHops',
            'expiresAtMs',
            'maxStalenessMs',
            'maxAttempts',
            'windowMs',
            'limit'
        ]
    ) {
        requireOptionalPersistedALSafeInteger(options[field], 0, `qos ${field}`);
    }
    if (
        options.priority !== undefined &&
        (typeof options.priority !== 'number' || !Number.isFinite(options.priority))
    ) {
        throw new TypeError('Persisted AL qos priority is invalid');
    }
}
