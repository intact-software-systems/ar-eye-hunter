import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const ALM_TOPIC = 'room.alm-conformance';
const MAX_EVENTS = 4_000;
const MAX_LINE_LENGTH = 64_000;
const OPERATIONS = new Set([
    'route-publish',
    'outbox-dequeued',
    'outbox-cluster-publish',
    'outbox-cluster-publish-failed',
    'outbox-key-loaded',
    'outbox-direct-send',
    'outbox-remote-send-failed'
]);
const SAFE_VALUES = {
    fanout: new Set(['outbox', 'live-only', 'none']),
    verdict: new Set([
        'admitted',
        'duplicate',
        'pending',
        'deferred',
        'refused',
        'unroutable',
        'superseded',
        'expired',
        'skipped',
        'failed',
        'threw',
        'sent-live',
        'queued-outbox',
        'none',
        'no-recipients',
        'partial-failure',
        'no-route',
        'rate-limited',
        'circuit-open',
        'cluster-published'
    ]),
    verdictReason: new Set([
        'not-yet-in-sync',
        'unauthorized',
        'malformed',
        'oversized',
        'unsupported',
        'no-route',
        'rate-limited',
        'circuit-open',
        'disposed',
        'repair-exhausted',
        'pending-terminated',
        'planner-drop'
    ]),
    deliveryStatus: new Set(['sent-live', 'expired', 'no-recipients', 'partial-failure', 'failed'])
};

function toSafeAlmServerTiming(line) {
    if (line.length > MAX_LINE_LENGTH || !line.startsWith('{')) {
        return undefined;
    }
    let event;
    try {
        event = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    const details = event?.details;
    if (
        event.type !== 'rallar.timing' ||
        !['rallar-ws-publication', 'queuebox-pubsub'].includes(event.component) ||
        !OPERATIONS.has(event.operation) ||
        !['ok', 'error'].includes(event.status) ||
        !Number.isSafeInteger(event.atEpochMs) ||
        details?.messageTopicId !== ALM_TOPIC ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(details.msgId)
    ) {
        return undefined;
    }

    const hasKey = details.keyTopicId !== undefined || details.keyResourceId !== undefined ||
        details.keyContextId !== undefined;
    if (
        hasKey && (
            details.keyTopicId !== 'AL_OUTBOUND_MESSAGE' ||
            !/^scope-[a-z0-9]{1,32}$/.test(details.keyResourceId) ||
            !/^message-[a-z0-9]{1,32}$/.test(details.keyContextId)
        )
    ) {
        return undefined;
    }
    const safe = {
        atEpochMs: event.atEpochMs,
        component: event.component,
        operation: event.operation,
        status: event.status,
        msgId: details.msgId,
        ...(hasKey
            ? {
                outboxKey: {
                    topicId: details.keyTopicId,
                    resourceId: details.keyResourceId,
                    contextId: details.keyContextId
                }
            }
            : {})
    };
    for (const [field, allowed] of Object.entries(SAFE_VALUES)) {
        if (details[field] !== undefined && !allowed.has(details[field])) {
            return undefined;
        }
        if (details[field] !== undefined) {
            safe[field] = details[field];
        }
    }
    for (const field of ['reservationAttempt', 'recipientCount', 'sentCount', 'failedCount']) {
        if (Number.isSafeInteger(details[field]) && details[field] >= 0 && details[field] <= 1_000_000) {
            safe[field] = details[field];
        }
    }
    return safe;
}

const artifact = process.argv[2];
if (!artifact) {
    throw new Error('ALM server timing artifact path is required.');
}
mkdirSync(path.dirname(artifact), { recursive: true });
writeFileSync(artifact, '', 'utf8');

let retained = 0;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (retained >= MAX_EVENTS) {
        continue;
    }
    const safe = toSafeAlmServerTiming(line);
    if (safe) {
        mkdirSync(path.dirname(artifact), { recursive: true });
        appendFileSync(artifact, `${JSON.stringify(safe)}\n`, 'utf8');
        retained += 1;
    }
}
