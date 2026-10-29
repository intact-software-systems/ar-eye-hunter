import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecord } from '../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
import { toConnectCommand } from './alm-conformance-session-commands.ts';
import { toCommandId } from './alm-conformance-step-identities.ts';

/**
 * A session reads its lane-only limits once, when it initialises, so the page closes first and connects again with
 * `limits`, the connect fields that lower or raise them; an empty record connects as the prologue does.
 */
export function toLimitsReconnectCommands(
    step: AlmConformanceStepInput,
    name: string,
    limits: RallarBlackBoxTestRecord
): readonly RallarBlackBoxTestCommand[] {
    const connect = toConnectCommand(step);
    return [
        { kind: 'close', commandId: toCommandId(step, `close-before-${name}`) },
        { ...connect, commandId: toCommandId(step, `connect-${name}`), rallar: { ...connect.rallar, ...limits } }
    ];
}
