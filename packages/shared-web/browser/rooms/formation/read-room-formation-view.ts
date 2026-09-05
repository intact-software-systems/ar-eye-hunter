import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarCommandOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import type { GroupFormationView } from '@shared/api/group-lifecycle/group-formation-view.ts';
import { validateGroupFormationView } from '@shared/api/group-lifecycle/validate-group-formation-view.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { Command } from '@shared/cache/Command.ts';

import type { RoomFormationCommandPorts } from './command-room-formation.ts';
import { roomFormationHttpApi } from './room-formation-http-api.ts';

export interface ReadRoomFormationViewInput {
    readonly roomRef: GroupRef;
    readonly options: RallarScopedOperationOptions;
    readonly ports: Pick<
        RoomFormationCommandPorts,
        'connect' | 'requireSession' | 'resolveOperationOptions' | 'runAuthAwareOperation'
    >;
}

/** A view naming another group or missing a field is a protocol breach, not a domain outcome. */
export async function readRoomFormationView(input: ReadRoomFormationViewInput): Promise<GroupFormationView> {
    const { ports } = input;
    return await ports.runAuthAwareOperation(async () => {
        const operationOptions = ports.resolveOperationOptions(input.options);
        await ports.connect(operationOptions);
        const scope = input.options.scope ?? toStateScope(input.roomRef);
        const view = await new Command<GroupFormationView>(
            (signal) =>
                roomFormationHttpApi.readView(input.roomRef.groupId, scope, {
                    signal,
                    authSession: ports.requireSession()
                }),
            toRallarCommandOptions(operationOptions)
        ).run();
        const issues = validateGroupFormationView(view, input.roomRef);
        if (issues.length > 0) {
            throw new TypeError(
                `Formation view for ${input.roomRef.groupId} is invalid: ${
                    issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
                }`
            );
        }
        return view;
    });
}
