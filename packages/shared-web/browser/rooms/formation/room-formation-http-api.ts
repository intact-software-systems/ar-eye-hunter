import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';

import { readApiBaseUrl } from '../../api-client-config.ts';
import { executeHttpRequest, type ApiMutationRequestOptions } from '../../api/http-request.ts';
import { defaultStateScope, toStateGroupHttpPath } from '../../api/state-http-path.ts';
import type {
    GroupSnapshot,
    RoomFormationCommandName,
    RoomFormationGroupStateRequest,
    StateScope
} from '../room-group-state-translation.ts';

export interface CommandRoomFormationHttpInput {
    readonly groupId: string;
    readonly command: RoomFormationCommandName;
    readonly request: RoomFormationGroupStateRequest;
    readonly options: ApiMutationRequestOptions;
    readonly scope?: StateScope;
}

async function commandStateGroupFormation(input: CommandRoomFormationHttpInput): Promise<GroupSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    return await executeHttpRequest<RoomFormationGroupStateRequest, GroupSnapshot>(
        readApiBaseUrl(),
        toApiMutationRequestPath(
            `${toStateGroupHttpPath(scope, input.groupId)}/lifecycle/${input.command}`,
            input.options.requestId
        ),
        'POST',
        input.request,
        input.options
    );
}

export const roomFormationHttpApi = Object.freeze({
    command: commandStateGroupFormation
});
