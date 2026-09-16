import type {
    RallarBlackBoxDistributedRoleAssignment,
    RallarBlackBoxDistributedRoleAssignmentPolicy
} from '../distributed-run.ts';

export type DistributedRecipeRolePattern =
    | 'all-agents'
    | 'sender-receiver'
    | 'one-sender-many-receivers'
    | 'three-browser-matrix';

export const DISTRIBUTED_RECIPE_ROLE_PATTERN_OPTIONS: readonly Readonly<{
    value: DistributedRecipeRolePattern;
    label: string;
    description: string;
}>[] = [
    {
        value: 'all-agents',
        label: 'All agents same recipe',
        description: 'Every selected browser receives every selected recipe.'
    },
    {
        value: 'sender-receiver',
        label: 'Sender / receiver pair',
        description: 'First target is sender, second target is receiver.'
    },
    {
        value: 'one-sender-many-receivers',
        label: 'One sender, many receivers',
        description: 'First target is sender, remaining targets are receivers.'
    },
    {
        value: 'three-browser-matrix',
        label: 'Three-browser matrix',
        description: 'First target publishes, second relays, third and later observe.'
    }
];

export function toRoleAssignmentsForPattern(
    pattern: DistributedRecipeRolePattern,
    agentIds: readonly string[]
): readonly RallarBlackBoxDistributedRoleAssignment[] {
    const roles = toRolesForPattern(pattern, agentIds);
    return Object.entries(roles).flatMap(([role, ids]) =>
        ids.map((agentId) => ({
            role,
            agentId,
            required: true,
            recipeIds: [],
            variables: {}
        }))
    );
}

export function toOrderedTargetRoleAssignmentPolicy(
    pattern: DistributedRecipeRolePattern
): RallarBlackBoxDistributedRoleAssignmentPolicy {
    return {
        mode: 'ordered-targets',
        pattern,
        orderBy: 'agent-id'
    };
}

export function toRolesForPattern(
    pattern: DistributedRecipeRolePattern,
    agentIds: readonly string[]
): Readonly<Record<string, readonly string[]>> {
    if (pattern === 'all-agents') {
        return {};
    }
    if (pattern === 'sender-receiver') {
        return {
            sender: agentIds.slice(0, 1),
            receiver: agentIds.slice(1, 2)
        };
    }
    if (pattern === 'one-sender-many-receivers') {
        return {
            sender: agentIds.slice(0, 1),
            receiver: agentIds.slice(1)
        };
    }
    return {
        publisher: agentIds.slice(0, 1),
        relay: agentIds.slice(1, 2),
        observer: agentIds.slice(2)
    };
}

export function toRecipeRoleForPattern(
    pattern: DistributedRecipeRolePattern,
    recipeIndex: number,
    recipeCount: number
): string | undefined {
    if (pattern === 'all-agents' || recipeCount < 2) {
        return undefined;
    }
    if (pattern === 'sender-receiver' || pattern === 'one-sender-many-receivers') {
        return recipeIndex === 0 ? 'sender' : 'receiver';
    }
    const roles = ['publisher', 'relay', 'observer'];
    return roles[Math.min(recipeIndex, roles.length - 1)];
}
