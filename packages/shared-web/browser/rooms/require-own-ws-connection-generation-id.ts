import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';

/** A presence row names the open socket's generation, so only that socket's close cleans it (D284). */
export async function requireOwnWsConnectionGenerationId(
    context: ApiMiddleware,
    signal: AbortSignal | undefined
): Promise<string> {
    return (await context.middleware.ownWsConnectionGeneration.read(signal)).fold(
        (failure) => {
            throw failure;
        },
        (generationId) => generationId
    );
}
