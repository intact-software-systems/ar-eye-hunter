interface ApiProcessStartupOptions<THttpServer> {
    readonly runtimeReadiness: Promise<void>;
    readonly listen: () => THttpServer;
    readonly startApplication: () => void;
    readonly stopAfterStartupFailure: (httpServer: THttpServer | undefined) => Promise<void>;
}

export interface ApiProcessStartup<THttpServer> {
    readonly httpServer: THttpServer;
}

export async function startApiProcess<THttpServer>(
    options: ApiProcessStartupOptions<THttpServer>
): Promise<ApiProcessStartup<THttpServer>> {
    let httpServer: THttpServer | undefined;
    try {
        httpServer = options.listen();
        await options.runtimeReadiness;
        options.startApplication();

        return { httpServer };
    }
    catch (startupError) {
        try {
            await options.stopAfterStartupFailure(httpServer);
        }
        catch (shutdownError) {
            throw new AggregateError(
                [startupError, shutdownError],
                'API-v1 process startup and cleanup failed'
            );
        }

        throw startupError;
    }
}
