import type { StateScope } from '@shared/api/state-types.ts';

export function readClientStateRouteScope(
    context: Readonly<{
        req: Readonly<{
            param(key: 'applicationId' | 'workspaceId'): string;
        }>;
    }>
): StateScope {
    return {
        applicationId: context.req.param('applicationId'),
        workspaceId: context.req.param('workspaceId')
    };
}
