import { AL_TRACE_ID_HTTP_HEADER } from '@shared/al-contracts/trace/al-trace-id.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestHttpRequestCommand
} from '../../../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../../schema/json-schema-validation.ts';
import { toConnectedSessionIds } from './assess-alm-acknowledged-identity.ts';
import type { RecordedAlmConformanceParticipant } from './assess-alm-conformance-identity.ts';
import { toAlmJsonPathValue, toRecordedAlmResultValue } from './to-recorded-alm-result-value.ts';

export interface AlmServerOriginatedIdentityInput {
    readonly sender: RecordedAlmConformanceParticipant;
    readonly receiver: RecordedAlmConformanceParticipant;
}

/** The platform admin's read of this API process's ALM receipt entries, which the receiver's recipe sends. */
export const ALM_ADMIN_REALTIME_PATH = '/api/admin/operations/realtime';

/**
 * A send the server originates carries the trace of the request that caused it: each traced request's response
 * echoes it, exactly one receiver wait observes the delta under it, and the receiver's admin read lists the receipt of
 * the last one, confirmed by the receiver's own session.
 */
export function assessAlmServerOriginatedIdentity(
    { sender, receiver }: AlmServerOriginatedIdentityInput
): readonly string[] {
    const requests = toTracedRequests(sender.participant.recipe.commands);
    const last = requests.at(-1);
    return [
        ...requests.flatMap((request) => [
            ...assessTraceEcho(sender, request),
            ...assessObservedDelta(receiver, request)
        ]),
        ...(last === undefined ? [] : assessAdminReceipt(receiver, last))
    ];
}

export function toTracedRequests(
    commands: readonly RallarBlackBoxTestCommand[]
): readonly RallarBlackBoxTestHttpRequestCommand[] {
    return commands.filter((command): command is RallarBlackBoxTestHttpRequestCommand =>
        command.kind === 'http.request' && toRequestTraceId(command) !== undefined
    );
}

function assessTraceEcho(
    sender: RecordedAlmConformanceParticipant,
    request: RallarBlackBoxTestHttpRequestCommand
): readonly string[] {
    const echoed = toAlmJsonPathValue(toRecordedAlmResultValue(sender, request), `headers.${AL_TRACE_ID_HTTP_HEADER}`);
    return echoed === toRequestTraceId(request)
        ? []
        : [`${request.commandId}: the response does not echo the request trace.`];
}

function assessObservedDelta(
    receiver: RecordedAlmConformanceParticipant,
    request: RallarBlackBoxTestHttpRequestCommand
): readonly string[] {
    const traceId = toRequestTraceId(request);
    const waits = receiver.participant.recipe.commands.filter((command) =>
        command.kind === 'wait' && command.absent !== true && command.match.payloadFields?.['data.traceId'] === traceId
    );
    if (waits.length !== 1) {
        return [`${request.commandId}: exactly one authored receiver wait must name the request trace.`];
    }
    const value = toRecordedAlmResultValue(receiver, waits[0]);
    const data = toAlmJsonPathValue(value, 'event.payload.data');
    const carried = isJsonRecordValue(value) && value.matched === true && isJsonRecordValue(data) &&
        typeof data.msgId === 'string' && data.msgId.length > 0 && data.traceId === traceId &&
        toAlmJsonPathValue(value, 'event.payload.data.payload.event.traceId') === traceId;
    return carried ? [] : [`${request.commandId}: the receiver's delta does not carry the request trace.`];
}

function assessAdminReceipt(
    receiver: RecordedAlmConformanceParticipant,
    request: RallarBlackBoxTestHttpRequestCommand
): readonly string[] {
    const read = receiver.participant.recipe.commands.find((command) =>
        command.kind === 'http.request' && command.request.method === 'GET' &&
        command.request.path === ALM_ADMIN_REALTIME_PATH
    );
    const entries = toAlmJsonPathValue(
        toRecordedAlmResultValue(receiver, read),
        'body.almReceipts.diagnostics.messages'
    );
    const sessionIds = toConnectedSessionIds(receiver);
    const confirmed = Array.isArray(entries) &&
        entries.some((entry) =>
            isJsonRecordValue(entry) && entry.traceId === toRequestTraceId(request) &&
            Array.isArray(entry.confirmedPeerIds) &&
            entry.confirmedPeerIds.some((peerId) => sessionIds.some((sessionId) => sessionId === peerId))
        );
    return confirmed
        ? []
        : [`${request.commandId}: the receiver's admin read lists no receipt of the trace it confirmed.`];
}

function toRequestTraceId(request: RallarBlackBoxTestHttpRequestCommand): string | undefined {
    return request.request.headers?.[AL_TRACE_ID_HTTP_HEADER];
}
