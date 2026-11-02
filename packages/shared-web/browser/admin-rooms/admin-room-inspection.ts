import type { AdminRoomDirectoryResponse } from '@shared/api/admin-rooms/admin-room-directory.ts';
import type { AdminSupportNarrativeResponse } from '@shared/api/admin-support/admin-support-types.ts';
import { AuthenticatedResource } from '../api/authenticated-resource.ts';
import { readAdminRoomDirectory, readAdminRoomExplanation } from './admin-room-http-api.ts';

export namespace AdminRoomInspection {
    export interface View {
        readonly directory: AdminRoomDirectoryResponse;
        readonly explanation: AdminSupportNarrativeResponse | null;
    }
    export interface Config extends AuthenticatedResource.Config {
        readonly apiBaseUrl: string;
        readonly afterGroupId: string | null;
        readonly selectedGroupId: string | null;
    }
}

export class AdminRoomInspection extends AuthenticatedResource<AdminRoomInspection.View, never> {
    constructor(dependencies: AuthenticatedResource.Dependencies, config: AdminRoomInspection.Config) {
        super(dependencies, config, {
            read: async (input) => {
                const context = { apiBaseUrl: config.apiBaseUrl, session: input.session, signal: input.signal };
                const [directory, explanation] = await Promise.all([
                    readAdminRoomDirectory({
                        ...context,
                        scope: input.scope,
                        afterGroupId: config.afterGroupId,
                        limit: 50
                    }),
                    config.selectedGroupId === null ? Promise.resolve(null) : readAdminRoomExplanation({
                        ...context,
                        roomRef: { ...input.scope, groupId: config.selectedGroupId }
                    })
                ]);
                return { directory, explanation };
            },
            change: async () => {
                throw new TypeError('Inspection is read-only');
            }
        });
    }
}
