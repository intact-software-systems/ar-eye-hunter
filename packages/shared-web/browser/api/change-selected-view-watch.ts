import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { decodeViewWatchResult, type ViewWatchFamily, type ViewWatchResult } from '@shared/api/views/view-watch.ts';
import { Command } from '@shared/cache/Command.ts';
import { readApiBaseUrl } from '../api-client-config.ts';
import type { SelectedViewWatch } from './selected-view-watch.ts';
import { sendApiHttpRequest } from './send-api-http-request.ts';
import { toStateScopeHttpPath } from './state-http-path.ts';

export interface SelectedViewWatchRoute extends StateScope {
    readonly family: ViewWatchFamily;
}

/** Retrying a lost response keeps the same command key and conditional predecessor. */
export async function changeSelectedViewWatch(
    route: SelectedViewWatchRoute,
    input: SelectedViewWatch.ChangeInput
): Promise<ViewWatchResult> {
    return await new Command(async (signal) => {
        const response = await sendApiHttpRequest<SelectedViewWatch.ChangeInput['request'], ApiJsonValue>({
            baseUrl: readApiBaseUrl(),
            path: toApiMutationRequestPath(
                `${toStateScopeHttpPath(route)}/view-watches/${route.family}`,
                input.requestId
            ),
            method: 'POST',
            body: input.request,
            options: { authSession: input.session, signal }
        });
        return decodeViewWatchResult(response);
    }, { signal: input.signal, timeoutMs: 10_000, maxAttempts: 2, errorOnNull: false }).run();
}
