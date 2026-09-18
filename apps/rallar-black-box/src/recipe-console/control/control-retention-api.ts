import { Either } from '@shared/resilience/Either.ts';
import type { ControlAuthorizedEndpoint } from './control-authorized-transport.ts';
import type { ControlRetentionRefusal } from './control-retention-refusal.ts';
import { requestControlRetentionConfirmation, requestControlRetentionPreview } from './control-retention-request.ts';
import {
    parseControlRetentionConfirmation,
    parseControlRetentionPreview,
    type ControlRetentionConfirmation,
    type ControlRetentionPreview
} from './control-retention-validation.ts';

type RetentionSignal = Readonly<{ signal?: AbortSignal; }>;

export type RecipeConsoleControlRetentionApi = Readonly<{
    preview(
        input?: RetentionSignal
    ): Promise<Either<ControlRetentionRefusal, ControlRetentionPreview>>;
    confirm(
        input: RetentionSignal & Readonly<{ preview: ControlRetentionPreview; }>
    ): Promise<Either<ControlRetentionRefusal, ControlRetentionConfirmation>>;
}>;

export function createRecipeConsoleControlRetentionApi(
    input: Readonly<{
        baseUrl: string;
        endpoint: ControlAuthorizedEndpoint;
        contextSignal: AbortSignal;
    }>
): RecipeConsoleControlRetentionApi {
    let currentPreview: ControlRetentionPreview | undefined;
    let previewGeneration = 0;
    let confirming = false;

    return {
        async preview(request = {}) {
            if (confirming) {
                return Either.ofLeft({
                    code: 'confirmation-in-progress',
                    message: 'Retention confirmation is in progress.'
                });
            }
            const generation = ++previewGeneration;
            currentPreview = undefined;
            return withContextSignal(
                input.contextSignal,
                request.signal,
                async (signal) => {
                    const result = await input.endpoint.response(
                        async (fetchFn) =>
                            (await requestControlRetentionPreview({
                                baseUrl: input.baseUrl,
                                fetchFn
                            })).mapRight(parseControlRetentionPreview),
                        signal
                    );
                    throwIfAborted(signal);
                    if (generation !== previewGeneration) {
                        throw new DOMException(
                            'The retention preview was superseded.',
                            'AbortError'
                        );
                    }
                    currentPreview = result.value;
                    return Either.ofRight(result.value);
                }
            );
        },
        async confirm(request) {
            ++previewGeneration;
            return withContextSignal(
                input.contextSignal,
                request.signal,
                async (signal) => {
                    if (request.preview !== currentPreview) {
                        return Either.ofLeft({
                            code: 'foreign-preview',
                            message: 'The retention preview does not belong to the current control connection.'
                        });
                    }
                    currentPreview = undefined;
                    confirming = true;
                    try {
                        const result = await input.endpoint.response(
                            async (fetchFn) =>
                                (await requestControlRetentionConfirmation({
                                    baseUrl: input.baseUrl,
                                    planToken: request.preview.planToken,
                                    fetchFn
                                })).mapRight((reply) => parseControlRetentionConfirmation(reply, request.preview)),
                            signal
                        );
                        throwIfAborted(signal);
                        return Either.ofRight(result.value);
                    }
                    finally {
                        confirming = false;
                        currentPreview = undefined;
                    }
                }
            );
        }
    };
}

async function withContextSignal<Value>(
    contextSignal: AbortSignal,
    operationSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<Value>
): Promise<Value> {
    const linked = linkSignals(contextSignal, operationSignal);
    try {
        throwIfAborted(linked.signal);
        const value = await operation(linked.signal);
        throwIfAborted(linked.signal);
        return value;
    }
    finally {
        linked.dispose();
    }
}

function linkSignals(
    contextSignal: AbortSignal,
    operationSignal: AbortSignal | undefined
): Readonly<{ signal: AbortSignal; dispose(): void; }> {
    if (!operationSignal || operationSignal === contextSignal) {
        return { signal: contextSignal, dispose() {} };
    }
    const controller = new AbortController();
    const sources = [contextSignal, operationSignal] as const;
    const onAbort = (event: Event) => {
        const source = event.currentTarget as AbortSignal;
        if (!controller.signal.aborted) {
            controller.abort(source.reason);
        }
    };
    for (const source of sources) {
        if (source.aborted && !controller.signal.aborted) {
            controller.abort(source.reason);
        }
        else {
            source.addEventListener('abort', onAbort, { once: true });
        }
    }
    return {
        signal: controller.signal,
        dispose: () => sources.forEach((source) => source.removeEventListener('abort', onAbort))
    };
}

function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) {
        return;
    }
    throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError');
}
