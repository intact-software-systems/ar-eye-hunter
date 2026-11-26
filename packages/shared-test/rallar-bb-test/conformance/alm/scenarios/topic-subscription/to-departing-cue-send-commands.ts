import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import { toCueSendCommands } from './topic-subscription-publications.ts';

/**
 * A cue its page departs after: the WS server admits an inbound message apart from the socket's close, so a close
 * right after `transport-accepted` can end the session before the cue passes the membership fence. Every session the
 * room held at admission acknowledges the cue first, which proves the server admitted it and every listener has it.
 */
export function toDepartingCueSendCommands(
    step: AlmConformanceStepInput,
    cue: string
): readonly RallarBlackBoxTestCommand[] {
    return toCueSendCommands(step, cue).map((command): RallarBlackBoxTestCommand => {
        switch (command.kind) {
            case 'messages.send':
                return { ...command, ack: 'receiver' };
            case 'messages.observe':
                return {
                    ...command,
                    commandId: toCommandId(step, `cue-${cue}-acknowledged`),
                    state: ['acknowledged'],
                    timeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
                };
            default:
                return command;
        }
    });
}
