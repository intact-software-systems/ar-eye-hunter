import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarCommandOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { readStateGroupFormationView } from '@shared-web/browser/state-read/state-snapshot-http-api.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import { decodeGroupFormationView } from '@shared/api/group-lifecycle/decode-group-formation-view.ts';
import type { GroupFormationView } from '@shared/api/group-lifecycle/group-formation-view.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { Command } from '@shared/cache/Command.ts';

import type { RoomFormationServiceDependencies } from './command-room-formation.ts';

export interface ReadRoomFormationViewInput {
    readonly roomRef: GroupRef;
    readonly options: RallarScopedOperationOptions;
    readonly dependencies: Pick<
        RoomFormationServiceDependencies,
        'connect' | 'requireSession' | 'resolveOperationOptions' | 'runAuthAwareOperation'
    >;
}

/** A view naming another group or missing a field is a protocol breach, not a domain outcome. */
export async function readRoomFormationView(input: ReadRoomFormationViewInput): Promise<GroupFormationView> {
    const { dependencies } = input;
    return await dependencies.runAuthAwareOperation(async () => {
        const operationOptions = dependencies.resolveOperationOptions(input.options);
        await dependencies.connect(operationOptions);
        const scope = input.options.scope ?? toStateScope(input.roomRef);
        const view = await new Command<GroupFormationView>(
            (signal) =>
                readStateGroupFormationView(input.roomRef.groupId, scope, {
                    signal,
                    authSession: dependencies.requireSession()
                }),
            toRallarCommandOptions(operationOptions)
        ).run();
        return decodeGroupFormationView(view, input.roomRef).fold(
            (issues) => {
                throw new TypeError(
                    `Formation view for ${input.roomRef.groupId} is invalid: ${
                        issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
                    }`
                );
            },
            (decoded) => decoded
        );
    });
}
