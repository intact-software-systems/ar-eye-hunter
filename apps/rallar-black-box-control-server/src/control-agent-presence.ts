import type { ControlHeartbeatEnvelope, ControlRegisterEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';

import type { ControlAgentState } from './control-service-state.ts';

/** A registration after a disconnect is a reconnect; either way the socket sequence and the resume set move. */
export function markControlAgentRegistered(
    agent: ControlAgentState,
    envelope: ControlRegisterEnvelope,
    nowEpochMs: number
): void {
    const reconnecting = agent.registeredAtEpochMs !== undefined && !agent.connected;
    agent.connected = true;
    agent.registeredAtEpochMs = envelope.atEpochMs;
    agent.disconnectedAtEpochMs = undefined;
    agent.lastSeenAtEpochMs = nowEpochMs;
    agent.identity = envelope.identity;
    agent.connectionSequence += 1;
    if (reconnecting) {
        agent.reconnectCount += 1;
    }
    agent.resumeCompletedCommandIds = new Set(envelope.resume.completedCommandIds);
}

export function markControlAgentHeartbeat(
    agent: ControlAgentState,
    envelope: ControlHeartbeatEnvelope,
    nowEpochMs: number
): void {
    agent.lastHeartbeatAtEpochMs = envelope.atEpochMs;
    agent.lastSeenAtEpochMs = nowEpochMs;
    agent.status = envelope.status;
    agent.identity = envelope.identity;
}
