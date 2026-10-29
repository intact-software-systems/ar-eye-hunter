import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { decodeFirstNonBlankText, toDistributedRunPayloadTopic } from './distributed-run-payload-summary.ts';

const NESTED_IDENTITY_KEYS = [
    'messageId',
    'distributedRunId',
    'groupId',
    'roomId',
    'typeId',
    'topicId',
    'contextId',
    'resourceId',
    'status',
    'msgId',
    'handleId',
    'traceId',
    'corrId'
] as const;

/** The identity of an event as `key=value` pairs; it never carries the event's payload or message text. */
export function toDistributedRunIdentitySummary(payload: unknown): string {
    const event = decodeRecord(payload);
    const nestedPayload = decodeRecord(event.payload);
    const nestedData = decodeRecord(nestedPayload.data ?? event.data);
    const fields: readonly (readonly [string, string | undefined])[] = [
        ['kind', decodeFirstNonBlankText(event.kind)],
        [
            'topic',
            decodeFirstNonBlankText(
                event.topic,
                nestedPayload.topic,
                nestedData.topic,
                toDistributedRunPayloadTopic(payload)
            )
        ],
        ['transport', decodeFirstNonBlankText(event.transport, nestedPayload.transport)],
        ...NESTED_IDENTITY_KEYS.map((key) =>
            [key, decodeFirstNonBlankText(event[key], nestedPayload[key], nestedData[key])] as const
        )
    ];
    return fields
        .filter((entry) => Boolean(entry[1]))
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
}
