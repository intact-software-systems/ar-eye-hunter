import type { ManagedApiServerPlan } from '../managed-api/with-managed-api-server-plans.mts';
import { ApiV1RtcTopologyProofApi, type ProofGroupInput, type ProofSession } from './api-v1-rtc-topology-proof-api.mts';
import { ApiV1RtcTopologyProofSocket } from './api-v1-rtc-topology-proof-websocket.mts';

type ProofServerTopologyInput = Readonly<{
    env: Record<string, string>;
    primaryPlan: ManagedApiServerPlan;
    secondaryPlan: ManagedApiServerPlan;
    tertiaryPlan: ManagedApiServerPlan;
}>;

export async function loginProofSessions(
    api: ApiV1RtcTopologyProofApi,
    input: ProofServerTopologyInput
): Promise<readonly ProofSession[]> {
    const nodes = [
        { label: 'N1', principal: 'alice' as const, plan: input.primaryPlan },
        { label: 'N2', principal: 'bob' as const, plan: input.primaryPlan },
        { label: 'N3', principal: 'alice' as const, plan: input.secondaryPlan },
        { label: 'N4', principal: 'bob' as const, plan: input.secondaryPlan },
        { label: 'N5', principal: 'alice' as const, plan: input.tertiaryPlan },
        { label: 'N6', principal: 'bob' as const, plan: input.tertiaryPlan }
    ];
    const sessions: ProofSession[] = [];
    for (const node of nodes) {
        sessions.push(
            await api.login({
                label: node.label,
                principal: node.principal,
                apiBaseUrl: node.plan.baseUrl,
                wsBaseUrl: node.plan.baseUrl.replace(/^http/, 'ws')
            })
        );
    }
    return sessions;
}

export function assertPrincipalSessionContract(sessions: readonly ProofSession[]): void {
    const alice = sessions.filter((session) => session.principal === 'alice');
    const bob = sessions.filter((session) => session.principal === 'bob');
    for (const principalSessions of [alice, bob]) {
        if (principalSessions.length !== 3) {
            throw new Error('Proof principal session count is invalid.');
        }
        if (new Set(principalSessions.map((session) => session.clientId)).size !== 1) {
            throw new Error('Proof sessions for one principal did not share one client identity.');
        }
        if (new Set(principalSessions.map((session) => session.sessionId)).size !== 3) {
            throw new Error('Proof sessions for one principal were not distinct.');
        }
    }
}

export async function prepareGroup(
    api: ApiV1RtcTopologyProofApi,
    group: ProofGroupInput,
    sessions: readonly ProofSession[]
): Promise<void> {
    await api.createGroup({ ...group, owner: sessions[0]! });
    await api.activateMember({
        ...group,
        actor: sessions[0]!,
        memberClientId: sessions[0]!.clientId
    });
    await api.activateMember({
        ...group,
        actor: sessions[1]!,
        memberClientId: sessions[1]!.clientId
    });
    for (const session of sessions) {
        await api.connectPresence({ ...group, actor: session });
    }
}

export async function attachAllSessions(
    api: ApiV1RtcTopologyProofApi,
    sessions: readonly ProofSession[]
): Promise<readonly ApiV1RtcTopologyProofSocket[]> {
    const sockets: ApiV1RtcTopologyProofSocket[] = [];
    try {
        for (const session of sessions) {
            const ticket = await api.issueWebSocketTicket(session);
            sockets.push(await ApiV1RtcTopologyProofSocket.open(session, ticket));
        }
        return sockets;
    }
    catch (error) {
        sockets.forEach((socket) => socket.close());
        throw error;
    }
}

export function toReplacementPlan(
    tertiaryPlan: ManagedApiServerPlan,
    artifactDir: string
): ManagedApiServerPlan {
    return {
        ...tertiaryPlan,
        logPath: `${artifactDir.replace(/\/+$/, '')}/api-v1-server-tertiary-restart.log`
    };
}

export function requireExecutionToken(value: string): string {
    if (!/^[a-f0-9]{24}$/.test(value)) {
        throw new TypeError('RTC topology replay proof execution token is invalid.');
    }
    return value;
}
