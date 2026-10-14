import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';

import type { RallarBlackBoxControlService } from '../../src/control-service.ts';

export function takeAgentDispatchableCommands(
    service: Pick<RallarBlackBoxControlService, 'takeDispatchableCommandsForAgents'>,
    runId: string,
    agentId: string
): readonly ControlCommandEnvelope[] {
    return service.takeDispatchableCommandsForAgents(runId, [agentId]).get(agentId) ?? [];
}
