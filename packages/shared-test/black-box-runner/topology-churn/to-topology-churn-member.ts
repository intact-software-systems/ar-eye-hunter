import type { TopologyChurnMember } from './topology-churn-api.mts';

interface ToTopologyChurnMemberInput {
    readonly runToken: string;
    readonly roomIndex: number;
    /** Unique across the run, so each member has its own username and client address. */
    readonly memberIndex: number;
    readonly apiBaseUrls: readonly string[];
}

const MEMBERS_PER_ADDRESS_BLOCK = 250;

export function toTopologyChurnMember(input: ToTopologyChurnMemberInput): TopologyChurnMember {
    const block = 1 + Math.floor(input.memberIndex / MEMBERS_PER_ADDRESS_BLOCK);
    const host = 1 + (input.memberIndex % MEMBERS_PER_ADDRESS_BLOCK);
    return {
        username: `churn-${input.runToken}-${input.roomIndex}-${input.memberIndex}`,
        clientIp: `10.${block}.0.${host}`,
        apiBaseUrl: input.apiBaseUrls[input.memberIndex % input.apiBaseUrls.length]
    };
}
