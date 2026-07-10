export type AnalyzeWorkerPort = Pick<
    Worker,
    'addEventListener' | 'postMessage' | 'removeEventListener' | 'terminate'
>;

export type AnalyzeWorkerFactory = () => AnalyzeWorkerPort;

export function createAnalyzeWorkerFactory(
    construct: AnalyzeWorkerFactory = createBrowserAnalyzeWorker,
): AnalyzeWorkerFactory {
    return () => construct();
}

function createBrowserAnalyzeWorker(): Worker {
    return new Worker(
        new URL('./analyze-artifact.worker.ts', import.meta.url),
        { name: 'rallar-recipe-console-analyze', type: 'module' },
    );
}
