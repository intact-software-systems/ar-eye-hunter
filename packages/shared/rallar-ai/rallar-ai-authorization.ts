import type {
    RallarAiAuthorizationContext,
    RallarAiAuthorize,
} from './rallar-ai-types.ts';
import { RallarAiError } from './rallar-ai-types.ts';

export async function assertRallarAiAuthorized(
    authorize: RallarAiAuthorize | undefined,
    context: RallarAiAuthorizationContext,
): Promise<void> {
    const authorized = authorize ? await authorize(context) : true;
    if (!authorized) {
        throw new RallarAiError(
            'unauthorized',
            `RallarAI action is not authorized: ${context.action}.`,
        );
    }
}
