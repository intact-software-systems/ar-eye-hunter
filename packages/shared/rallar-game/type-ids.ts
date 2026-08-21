import type { RallarGameAuthorityTypeIds } from './types.ts';

export function resolveRallarGameAuthorityTypeIds(
    topicId: string,
    overrides: Partial<RallarGameAuthorityTypeIds> = {}
): RallarGameAuthorityTypeIds {
    return {
        command: `${topicId}.command.v1`,
        commandResult: `${topicId}.command-result.v1`,
        event: `${topicId}.event.v1`,
        snapshot: `${topicId}.snapshot.v1`,
        syncRequest: `${topicId}.sync-request.v1`,
        presence: `${topicId}.presence.v1`,
        ...overrides
    };
}
