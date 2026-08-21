interface ApiProcessStartupOptions<THttpServer> {
    readonly runtimeReadiness: Promise<void>;
    readonly listen: () => THttpServer;
    readonly startQueueWorkers: () => void;
}

export interface ApiProcessStartup<THttpServer> {
    readonly httpServer: THttpServer;
    readonly readiness: Promise<void>;
}

export function startApiProcess<THttpServer>(
    options: ApiProcessStartupOptions<THttpServer>
): ApiProcessStartup<THttpServer> {
    const httpServer = options.listen();
    const readiness = options.runtimeReadiness.then(() => options.startQueueWorkers());

    return { httpServer, readiness };
}
