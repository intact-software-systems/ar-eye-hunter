import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { MESSAGE_CONTROL_TIMEOUT_MS, NON_EXPIRING_SEND_TIMEOUT_MS, toBudgetMs } from '../../alm-conformance-budgets.ts';
import {
    toResultAssertion,
    toVerdictCommands,
    type AlmConformanceVerdictFact
} from '../../alm-conformance-message-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toRoomRef } from '../../alm-conformance-step-identities.ts';

/** An appointment or a resignation is one group-state write, budgeted as the prologue's ensure writes are. */
const DIRECTOR_TIMEOUT_MS = 5_000;
const LEADER_POLL_INTERVAL_MS = 200;

/** The RTC origin refuses from the snapshot its own page holds, so no carrier attempt follows. */
const RTC_NO_LEADER_FACTS: readonly AlmConformanceVerdictFact[] = [
    ['refused', 'failure.kind', 'equals', 'refused'],
    ['no-leader', 'failure.reason', 'equals', 'no-leader'],
    ['no-attempt', 'attempts', 'equals', 0]
];

/** The WS server refuses at ingress after the frame left, so its NACK settles the one attempt the send made. */
const WS_NO_LEADER_FACTS: readonly AlmConformanceVerdictFact[] = [
    ['relay-rejected', 'failure.kind', 'equals', 'relay-rejected'],
    ['trusted-server', 'failure.rejection.relay', 'equals', 'trusted-server'],
    ['no-leader', 'failure.rejection.reason', 'equals', 'no-leader'],
    ['one-attempt', 'attempts', 'equals', 1]
];

/**
 * The step's own page appoints its session the room's director. The receiver's prologue creates the run's group, so
 * the receiver owns it and may appoint itself while the other roles are online.
 */
export function toDirectorAppointCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'director.appoint',
        commandId: toCommandId(step, 'director-appoint'),
        roomRef: toRoomRef(step.input.group),
        timeoutMs: toBudgetMs(DIRECTOR_TIMEOUT_MS, step.input.deadlineMs)
    };
}

/** The step's own page ends an appointment of its own session; it leaves any other appointment as it is. */
export function toDirectorResignCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'director.resign',
        commandId: toCommandId(step, 'director-resign'),
        roomRef: toRoomRef(step.input.group),
        timeoutMs: toBudgetMs(DIRECTOR_TIMEOUT_MS, step.input.deadlineMs)
    };
}

/**
 * The RTC origin resolves the leader from the room snapshot its own page holds, so the sender refreshes that snapshot
 * until it reads the room's director active, or not, before it sends. Each read is the loop child of its iteration.
 */
export function toLeaderActivityWait(sender: AlmConformanceStepInput, active: boolean): RallarBlackBoxTestCommand {
    const name = active ? 'await-leader' : 'await-no-leader';
    const status = toCommandId(sender, 'leader-status');
    return {
        kind: 'loop',
        commandId: toCommandId(sender, name),
        until: 'first-success',
        count: NON_EXPIRING_SEND_TIMEOUT_MS / LEADER_POLL_INTERVAL_MS,
        intervalMs: LEADER_POLL_INTERVAL_MS,
        commands: [
            {
                kind: 'director.status',
                commandId: status,
                roomRef: toRoomRef(sender.input.group),
                refresh: true,
                timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, sender.input.deadlineMs)
            },
            toResultAssertion({
                step: sender,
                name: active ? 'assert-leader-active' : 'assert-leader-inactive',
                resultName: `${name}:i{loop.iteration}:c1:${status}`,
                field: 'directorStatus.active',
                operator: 'equals',
                expected: active
            })
        ]
    };
}

/** The leader send ends rejected for `no-leader`: refused by the RTC origin, or NACKed by the WS server. */
export function toNoLeaderVerdictCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return toVerdictCommands(
        sender,
        'rejected',
        sender.input.carrier === 'rtc' ? RTC_NO_LEADER_FACTS : WS_NO_LEADER_FACTS
    );
}
