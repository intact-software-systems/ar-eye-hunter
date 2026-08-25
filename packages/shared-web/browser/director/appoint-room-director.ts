import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import type { AppointStateGroupDirectorBody } from '@shared-web/browser/api/state-mutation-http-contracts.ts';
import { roomGroupStateHttpApi } from '@shared-web/browser/rooms/room-group-state-http-api.ts';
import { toApiMutationWorkflowRequestId } from '@shared-web/browser/state-read/state-workflow-support.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command, type CommandOptions } from '@shared/cache/Command.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';

import type { GroupSnapshot } from '../rooms/room-group-state-translation.ts';
import type { StateGroupWorkflowValue } from '../rooms/room-group-state-workflows.ts';

export interface AppointRoomDirectorInput {
    readonly groupId: string;
    readonly request: AppointStateGroupDirectorBody;
    readonly principalId: string;
    readonly sessionId: string;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
}

export async function appointStateGroupDirector(
    input: AppointRoomDirectorInput
): Promise<GroupSnapshot> {
    const requestId = toApiMutationWorkflowRequestId();
    const commandOptions = (input.policies?.command ?? {}) as CommandOptions<GroupSnapshot>;

    return await new Command<GroupSnapshot>(
        (signal) =>
            roomGroupStateHttpApi.appointDirector({
                groupId: input.groupId,
                request: {
                    ...input.request,
                    actorPrincipalId: input.principalId,
                    actorSessionId: input.sessionId
                },
                options: { requestId, signal },
                scope: input.scope ?? defaultStateScope()
            }),
        commandOptions
    ).run();
}
