import { validateControlFleetReportBundle } from '@shared-test/rallar-bb-test/fleet-report-validation.ts';
import type { ControlFleetReportBundle } from '@shared-test/rallar-bb-test/fleet-report.ts';
import { fetchFleetReportBundleBytes } from '../../control-run-manager.ts';
import { throwIfControlAborted } from './control-authorized-fetch.ts';
import type { ControlAuthorizedEndpoint } from './control-authorized-transport.ts';

type FleetSelectionSignal = Readonly<{ signal?: AbortSignal; }>;

export type RecipeConsoleControlFleetApi = Readonly<{
    selectReportBundle(
        input: FleetSelectionSignal & Readonly<{ distributedRunId: string; }>
    ): Promise<ControlFleetReportBundle>;
    getSelectedReportBundle(): ControlFleetReportBundle | undefined;
    clearSelectedReportBundle(): void;
}>;

export function createRecipeConsoleControlFleetApi(
    input: Readonly<{
        baseUrl: string;
        endpoint: ControlAuthorizedEndpoint;
        contextSignal: AbortSignal;
    }>
): RecipeConsoleControlFleetApi {
    let selectedBundle: ControlFleetReportBundle | undefined;
    let selectionGeneration = 0;
    let activeSelection: AbortController | undefined;

    return {
        async selectReportBundle(request) {
            const generation = ++selectionGeneration;
            activeSelection?.abort(supersededSelectionError());
            const selectionController = new AbortController();
            activeSelection = selectionController;
            const linked = linkFleetSelectionSignals([
                input.contextSignal,
                request.signal,
                selectionController.signal
            ]);
            try {
                throwIfControlAborted(linked.signal);
                const pending = input.endpoint.response(
                    async (fetchFn) =>
                        parseFleetReportBundleBytes(
                            await fetchFleetReportBundleBytes({
                                baseUrl: input.baseUrl,
                                distributedRunId: request.distributedRunId,
                                fetchFn
                            }),
                            request.distributedRunId
                        ),
                    linked.signal
                );
                const result = await settleFleetSelection(
                    pending,
                    linked.signal
                );
                throwIfControlAborted(linked.signal);
                if (generation !== selectionGeneration) {
                    throw supersededSelectionError();
                }
                selectedBundle = result.value;
                return result.value;
            }
            finally {
                linked.dispose();
                if (activeSelection === selectionController) {
                    activeSelection = undefined;
                }
            }
        },
        getSelectedReportBundle() {
            return selectedBundle;
        },
        clearSelectedReportBundle() {
            selectionGeneration += 1;
            activeSelection?.abort(clearedSelectionError());
            activeSelection = undefined;
            selectedBundle = undefined;
        }
    };
}

function parseFleetReportBundleBytes(
    bytes: ArrayBuffer,
    requestedDistributedRunId: string
): ControlFleetReportBundle {
    const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
    const validation = validateControlFleetReportBundle(
        value,
        requestedDistributedRunId
    );
    if (!validation.ok || !validation.bundle) {
        const details = validation.issues
            .map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`)
            .join('; ');
        const omitted = validation.omittedIssueCount > 0
            ? `; ${validation.omittedIssueCount} additional issues omitted`
            : '';
        throw new Error(`Invalid Fleet report bundle: ${details}${omitted}`);
    }
    return validation.bundle;
}

async function settleFleetSelection<Value>(
    pending: Promise<Value>,
    signal: AbortSignal
): Promise<Value> {
    throwIfControlAborted(signal);
    return new Promise<Value>((resolve, reject) => {
        const finish = (settle: () => void) => {
            signal.removeEventListener('abort', onAbort);
            settle();
        };
        const onAbort = () => finish(() => reject(controlAbortError(signal)));
        signal.addEventListener('abort', onAbort, { once: true });
        pending.then(
            (value) => finish(() => resolve(value)),
            (error) => finish(() => reject(error))
        );
    });
}

function linkFleetSelectionSignals(
    sources: readonly (AbortSignal | undefined)[]
): Readonly<{ signal: AbortSignal; dispose(): void; }> {
    const controller = new AbortController();
    const activeSources = sources.filter(
        (source): source is AbortSignal => source !== undefined
    );
    const onAbort = (event: Event) => {
        const source = event.currentTarget as AbortSignal;
        if (!controller.signal.aborted) {
            controller.abort(source.reason);
        }
    };
    for (const source of activeSources) {
        if (source.aborted && !controller.signal.aborted) {
            controller.abort(source.reason);
        }
        else {
            source.addEventListener('abort', onAbort, { once: true });
        }
    }
    return {
        signal: controller.signal,
        dispose: () => activeSources.forEach((source) => source.removeEventListener('abort', onAbort))
    };
}

function controlAbortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The Fleet selection was aborted.', 'AbortError');
}

function supersededSelectionError(): DOMException {
    return new DOMException(
        'The Fleet report selection was superseded.',
        'AbortError'
    );
}

function clearedSelectionError(): DOMException {
    return new DOMException(
        'The Fleet report selection was cleared.',
        'AbortError'
    );
}
