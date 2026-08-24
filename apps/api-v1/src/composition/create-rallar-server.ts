import type { Hono } from 'jsr:@hono/hono@4.11.9';

import type { AppDataRepository } from '@shared-server/app-data/app-data-repository.ts';
import {
    createRallarServerApplication,
    type RallarServerApplication,
    type RallarServerApplicationSystemInstallers
} from '@shared-server/rallar-server/rallar-server-application.ts';
import type { RallarServerWsRouterOptions } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';

import type { ApiV1Runtime } from './api-v1-runtime.ts';
import type { ApiV1RouteInstallers } from './create-api-v1-route-installers.ts';

export interface CreateRallarServerInput {
    readonly runtime: ApiV1Runtime;
    readonly repositories: RepositoryManager;
    readonly appDataRepository: AppDataRepository;
    readonly nowEpochMs: () => number;
    readonly ws: RallarServerWsRouterOptions;
    readonly systemInstallers: RallarServerApplicationSystemInstallers<ApiV1Runtime>;
    readonly routeInstallers: ApiV1RouteInstallers;
}

export function createRallarServer(
    input: CreateRallarServerInput
): RallarServerApplication<ApiV1Runtime, Hono> {
    return createRallarServerApplication({
        runtime: input.runtime,
        repositories: input.repositories,
        appDataRepository: input.appDataRepository,
        nowEpochMs: input.nowEpochMs,
        ws: input.ws,
        systemInstallers: input.systemInstallers,
        routeInstallers: input.routeInstallers
    });
}
