import { AppTopics } from '@shared/api/api-config.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestHttpRequestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../rallar-black-box-test-contracts.ts';

import { MESSAGE_CONTROL_TIMEOUT_MS, RESPONSE_MARGIN_MS, toBudgetMs } from '../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import { toVerdictTimeoutMs } from '../alm-conformance-diagnostic-waits.ts';
import { toResultAssertion } from '../alm-conformance-message-commands.ts';
import {
    SMOKE_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import {
    toTracedSelfMembershipCommands,
    type AlmConformanceSelfMembershipStatus
} from '../alm-conformance-session-commands.ts';
import { toCommandId, toConnectionName } from '../alm-conformance-step-identities.ts';
import { ALM_ADMIN_REALTIME_PATH } from '../identity/assess-alm-server-originated-identity.ts';
import { toPauseCommand } from '../to-pause-command.ts';

/** The server's group-state deltas reach a page over WS only. */
const SERVER_ORIGINATED_CARRIERS: readonly AlmConformanceCarrier[] = ['ws'];

/** The sender leaves and then rejoins, so it ends the cell an active member of the group the next cell shares. */
const TRACED_STATUSES: readonly AlmConformanceSelfMembershipStatus[] = ['left', 'active'];

const READ_ADMIN_REALTIME = 'read-admin-realtime';

/**
 * A send the server originates: each traced membership write of the sender reaches the receiver as a `group-state.event`
 * delta whose envelope and event carry the request's `x-request-id`, and the receiver, a platform admin in the local
 * lane, reads the process-local receipt its own ACK of the last delta settled. The hosted combined connect subscribes
 * the scenario topic only, so only the local lane runs the cell.
 */
export const serverOriginated: AlmConformanceScenarioDefinition = {
    scenarioId: 'server-originated',
    scenarioKey: 'server-originated',
    tags: SMOKE_TAGS,
    carriers: SERVER_ORIGINATED_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    messageSelector: { topicId: AppTopics.groupStateEvent },
    toSenderCommands: (sender) =>
        TRACED_STATUSES.flatMap((status) =>
            toTracedSelfMembershipCommands(sender, status, toRequestTraceId(sender, status))
        ),
    toRecipientCommands: toServerOriginatedReceiverCommands
};

/** The ACK leaves at admission, so one settle margin after the last delta its receipt entry is recorded. */
function toServerOriginatedReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...TRACED_STATUSES.map((status) => toTracedDeltaWait(receiver, status)),
        toPauseCommand(receiver, 'receipt-settles', RESPONSE_MARGIN_MS),
        toAdminRealtimeReadCommand(receiver),
        toResultAssertion({
            step: receiver,
            name: 'assert-admin-receipt',
            resultName: READ_ADMIN_REALTIME,
            field: 'body.almReceipts.diagnostics.messages',
            operator: 'matchesShape',
            expected: [{ traceId: toRequestTraceId(receiver, 'active'), lastSettlementKind: 'acknowledgement' }]
        })
    ];
}

/** The sender's command id names each trace, so both roles derive it, and it stays in the trace grammar. */
function toRequestTraceId(step: AlmConformanceStepInput, status: AlmConformanceSelfMembershipStatus): string {
    return toCommandId({ ...step, role: 'sender' }, `trace-${status}`);
}

/** The wait starts before the sender's writes, so it owns the verdict budget. */
function toTracedDeltaWait(
    receiver: AlmConformanceStepInput,
    status: AlmConformanceSelfMembershipStatus
): RallarBlackBoxTestWaitCommand {
    const traceId = toRequestTraceId(receiver, status);
    return {
        kind: 'wait',
        commandId: toCommandId(receiver, `delta-trace-${status}`),
        match: {
            kind: 'message',
            topic: 'rallar.browser.ws.message',
            connection: toConnectionName(receiver),
            payloadFields: {
                'data.topicId': AppTopics.groupStateEvent,
                'data.traceId': traceId,
                'data.payload.event.traceId': traceId
            }
        },
        timeoutMs: toVerdictTimeoutMs(receiver.input.deadlineMs)
    };
}

function toAdminRealtimeReadCommand(receiver: AlmConformanceStepInput): RallarBlackBoxTestHttpRequestCommand {
    return {
        kind: 'http.request',
        commandId: toCommandId(receiver, READ_ADMIN_REALTIME),
        timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, receiver.input.deadlineMs),
        metadata: { purpose: 'Read the receipt entries this API process records, as a platform admin.' },
        request: { method: 'GET', path: ALM_ADMIN_REALTIME_PATH },
        response: { body: 'json', acceptedStatusCodes: [200] }
    };
}
