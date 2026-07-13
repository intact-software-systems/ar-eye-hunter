import { createAnalyzeWorkerRuntime } from './analyze-worker-runtime.ts';
import type {
    AnalyzeWorkerRequest,
    AnalyzeWorkerResponse,
} from './analyze-worker-contract.ts';

type AnalyzeWorkerScope = Readonly<{
    postMessage(message: AnalyzeWorkerResponse, transfer?: readonly Transferable[]): void;
    close(): void;
}> & {
    onmessage: ((event: MessageEvent<AnalyzeWorkerRequest>) => void) | null;
};

const scope = globalThis as unknown as AnalyzeWorkerScope;
const runtime = createAnalyzeWorkerRuntime({
    postMessage(message, transfer) {
        scope.postMessage(message, transfer);
    },
    close() {
        scope.close();
    },
});

scope.onmessage = event => {
    void runtime.handle(event.data);
};
