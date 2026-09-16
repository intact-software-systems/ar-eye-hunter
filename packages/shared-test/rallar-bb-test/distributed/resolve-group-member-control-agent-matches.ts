import type {
    RallarBlackBoxControlAgentCandidate,
    RallarBlackBoxDistributedGroupRef
} from '../distributed-run.ts';
import { isControlAgentIdentityInGroup, isControlAgentStale } from './control-agent-candidate.ts';

export interface RallarBlackBoxGroupMemberCandidate {
    readonly principalId: string;
    /** Absent when the group member listing names no username. */
    readonly username?: string;
    /** Empty when the member may match an agent in any session. */
    readonly sessionIds: readonly string[];
}

export type RallarBlackBoxGroupControlAgentMatchStatus = RallarBlackBoxGroupControlAgentMatch['status'];

export type RallarBlackBoxGroupControlAgentMatch =
    | RallarBlackBoxMatchedGroupControlAgent
    | RallarBlackBoxUntargetableGroupMember
    | RallarBlackBoxUnmatchedControlAgent;

export interface RallarBlackBoxMatchedGroupControlAgent {
    readonly status: 'matched';
    readonly targetable: true;
    readonly reason: string;
    readonly member: RallarBlackBoxGroupMemberCandidate;
    readonly agent: RallarBlackBoxControlAgentCandidate;
    readonly candidateAgents: readonly RallarBlackBoxControlAgentCandidate[];
}

export interface RallarBlackBoxUntargetableGroupMember {
    readonly status: 'unmatched-group-member' | 'offline-agent' | 'stale-agent' | 'duplicate-session';
    readonly targetable: false;
    readonly reason: string;
    readonly member: RallarBlackBoxGroupMemberCandidate;
    readonly candidateAgents: readonly RallarBlackBoxControlAgentCandidate[];
}

export interface RallarBlackBoxUnmatchedControlAgent {
    readonly status: 'agent-without-group-member' | 'agent-without-identity';
    readonly targetable: false;
    readonly reason: string;
    readonly agent: RallarBlackBoxControlAgentCandidate;
    readonly candidateAgents: readonly RallarBlackBoxControlAgentCandidate[];
}

export interface RallarBlackBoxGroupControlAgentMatchResult {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly matches: readonly RallarBlackBoxGroupControlAgentMatch[];
    readonly targetableAgentIds: readonly string[];
    readonly summary: RallarBlackBoxGroupControlAgentMatchSummary;
}

export interface RallarBlackBoxGroupControlAgentMatchSummary {
    readonly members: number;
    readonly agents: number;
    readonly matched: number;
    readonly targetable: number;
    readonly unmatchedMembers: number;
    readonly offlineAgents: number;
    readonly staleAgents: number;
    readonly duplicateSessions: number;
    readonly agentsWithoutMembers: number;
    readonly agentsWithoutIdentity: number;
}

export interface ResolveGroupMemberControlAgentMatchesInput {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly members: readonly RallarBlackBoxGroupMemberCandidate[];
    readonly agents: readonly RallarBlackBoxControlAgentCandidate[];
    readonly nowEpochMs: number;
    readonly staleAfterMs: number;
}

interface GroupMemberMatch {
    readonly match: RallarBlackBoxMatchedGroupControlAgent | RallarBlackBoxUntargetableGroupMember;
    /** The agents this member accounts for, so they are not reported again as agents without a member. */
    readonly consumedAgents: readonly RallarBlackBoxControlAgentCandidate[];
}

const UNTARGETABLE_MEMBER_REASONS: Readonly<Record<RallarBlackBoxUntargetableGroupMember['status'], string>> = {
    'duplicate-session': 'Group member matches multiple connected control agents; select a target explicitly.',
    'stale-agent': 'Matching control agent is connected but stale.',
    'offline-agent': 'Matching control agent is offline.',
    'unmatched-group-member': 'No connected control agent identity matches this group member.'
};

export function resolveGroupMemberControlAgentMatches(
    input: ResolveGroupMemberControlAgentMatchesInput
): RallarBlackBoxGroupControlAgentMatchResult {
    const memberMatches = input.members.map((member) => resolveGroupMemberMatch(input, member));
    const consumedAgentIds = new Set(
        memberMatches.flatMap(({ consumedAgents }) => consumedAgents.map((agent) => agent.agentId))
    );
    const matches: readonly RallarBlackBoxGroupControlAgentMatch[] = [
        ...memberMatches.map(({ match }) => match),
        ...toUnmatchedControlAgents(input, consumedAgentIds)
    ];
    const targetableAgentIds = matches
        .filter((match) => match.status === 'matched')
        .map((match) => match.agent.agentId);

    return {
        group: input.group,
        matches,
        targetableAgentIds,
        summary: computeMatchSummary(input, matches, targetableAgentIds)
    };
}

function resolveGroupMemberMatch(
    input: ResolveGroupMemberControlAgentMatchesInput,
    member: RallarBlackBoxGroupMemberCandidate
): GroupMemberMatch {
    const isStale = (agent: RallarBlackBoxControlAgentCandidate): boolean =>
        isControlAgentStale(agent, input.nowEpochMs, input.staleAfterMs);
    const candidates = input.agents.filter((agent) => isAgentMatchingMemberInGroup(agent, member, input.group));
    const activeCandidates = candidates.filter((agent) => agent.connected && !isStale(agent));

    if (activeCandidates.length === 1) {
        return {
            match: {
                status: 'matched',
                targetable: true,
                reason: 'Group member has one connected control agent with matching identity.',
                member,
                agent: activeCandidates[0],
                candidateAgents: candidates
            },
            consumedAgents: activeCandidates
        };
    }
    if (activeCandidates.length > 1) {
        return {
            match: toUntargetableMember('duplicate-session', member, candidates),
            consumedAgents: activeCandidates
        };
    }
    if (candidates.some((agent) => agent.connected && isStale(agent))) {
        return { match: toUntargetableMember('stale-agent', member, candidates), consumedAgents: candidates };
    }
    if (candidates.some((agent) => !agent.connected)) {
        return { match: toUntargetableMember('offline-agent', member, candidates), consumedAgents: candidates };
    }
    return { match: toUntargetableMember('unmatched-group-member', member, []), consumedAgents: [] };
}

function toUntargetableMember(
    status: RallarBlackBoxUntargetableGroupMember['status'],
    member: RallarBlackBoxGroupMemberCandidate,
    candidateAgents: readonly RallarBlackBoxControlAgentCandidate[]
): RallarBlackBoxUntargetableGroupMember {
    return {
        status,
        targetable: false,
        reason: UNTARGETABLE_MEMBER_REASONS[status],
        member,
        candidateAgents
    };
}

function toUnmatchedControlAgents(
    input: ResolveGroupMemberControlAgentMatchesInput,
    consumedAgentIds: ReadonlySet<string>
): readonly RallarBlackBoxUnmatchedControlAgent[] {
    return input.agents
        .filter((agent) => !consumedAgentIds.has(agent.agentId))
        .flatMap((agent): readonly RallarBlackBoxUnmatchedControlAgent[] => {
            const identity = agent.identity;
            if (!identity || !toTrimmedText(identity.principalId ?? identity.clientId ?? identity.username)) {
                return [{
                    status: 'agent-without-identity',
                    targetable: false,
                    reason: 'Control agent has not reported Rallar identity metadata.',
                    agent,
                    candidateAgents: [agent]
                }];
            }
            return isControlAgentIdentityInGroup(identity, input.group)
                ? [{
                    status: 'agent-without-group-member',
                    targetable: false,
                    reason: 'Control agent reports this group but no matching group member was observed.',
                    agent,
                    candidateAgents: [agent]
                }]
                : [];
        });
}

function computeMatchSummary(
    input: ResolveGroupMemberControlAgentMatchesInput,
    matches: readonly RallarBlackBoxGroupControlAgentMatch[],
    targetableAgentIds: readonly string[]
): RallarBlackBoxGroupControlAgentMatchSummary {
    const count = (status: RallarBlackBoxGroupControlAgentMatchStatus): number =>
        matches.filter((match) => match.status === status).length;
    return {
        members: input.members.length,
        agents: input.agents.length,
        matched: count('matched'),
        targetable: targetableAgentIds.length,
        unmatchedMembers: count('unmatched-group-member'),
        offlineAgents: count('offline-agent'),
        staleAgents: count('stale-agent'),
        duplicateSessions: count('duplicate-session'),
        agentsWithoutMembers: count('agent-without-group-member'),
        agentsWithoutIdentity: count('agent-without-identity')
    };
}

function isAgentMatchingMemberInGroup(
    agent: RallarBlackBoxControlAgentCandidate,
    member: RallarBlackBoxGroupMemberCandidate,
    group: RallarBlackBoxDistributedGroupRef
): boolean {
    const identity = agent.identity;
    if (!isControlAgentIdentityInGroup(identity, group)) {
        return false;
    }

    const memberIds = new Set(toTrimmedTexts([member.principalId, member.username]));
    const identityIds = toTrimmedTexts([identity.principalId, identity.clientId, identity.username]);
    if (!identityIds.some((id) => memberIds.has(id))) {
        return false;
    }

    const memberSessionIds = new Set(toTrimmedTexts(member.sessionIds));
    if (memberSessionIds.size === 0) {
        return true;
    }

    return Boolean(identity.sessionId && memberSessionIds.has(identity.sessionId));
}

function toTrimmedTexts(values: readonly (string | undefined)[]): readonly string[] {
    return values.map(toTrimmedText).filter((value): value is string => Boolean(value));
}

function toTrimmedText(value: string | undefined): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined;
}
