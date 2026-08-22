import type { Hono } from 'jsr:@hono/hono@4.11.9';

import type { AppDataRepositoryLike } from '@shared-server/app-data/AppDataRepository.ts';
import type { RallarServerSystemInstallers } from '@shared-server/rallar-facade/RallarServer.ts';
import {
    createRallarServerApplication,
    type RallarServerApplication
} from '@shared-server/rallar-facade/RallarServerApplication.ts';
import type { RallarServerWsFacadeOptions } from '@shared-server/rallar-facade/ws-topic-router.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';

import type { ApiV1Runtime } from './api-v1-runtime.ts';
import type { ApiV1RouteInstallers } from './create-api-v1-route-installers.ts';

export interface CreateRallarServerInput {
    readonly runtime: ApiV1Runtime;
    readonly repositories: RepositoryManager;
    readonly appDataRepository: AppDataRepositoryLike;
    readonly ws: RallarServerWsFacadeOptions;
    readonly systemInstallers: RallarServerSystemInstallers<ApiV1Runtime>;
    readonly routeInstallers: ApiV1RouteInstallers;
}

export function createRallarServer(
    input: CreateRallarServerInput
): RallarServerApplication<ApiV1Runtime, Hono> {
    return createRallarServerApplication({
        runtime: input.runtime,
        repositories: input.repositories,
        appData: { repository: input.appDataRepository },
        ws: input.ws,
        system: input.systemInstallers,
        routes: input.routeInstallers
    });
}
