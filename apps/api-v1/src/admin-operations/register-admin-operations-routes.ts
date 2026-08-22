import type { Hono } from 'jsr:@hono/hono@4.11.9';

import {
    registerAdminOperationMutationRoutes,
    type AdminOperationMutationRouteDependencies,
    type AdminOperationMutationRouteService
} from './register-admin-operation-mutation-routes.ts';
import {
    registerAdminOperationReadRoutes,
    type AdminOperationReadRouteDependencies,
    type AdminOperationReadRouteService
} from './register-admin-operation-read-routes.ts';

export type { AdminOperationMutationWriteInput } from './register-admin-operation-mutation-routes.ts';
export type {
    AdminOperationReadInput,
    AdminOperationWriteInput
} from './register-admin-operation-read-routes.ts';

export type AdminOperationsRouteService =
    & AdminOperationReadRouteService
    & AdminOperationMutationRouteService;

export type AdminOperationsRouteDependencies =
    & AdminOperationReadRouteDependencies
    & AdminOperationMutationRouteDependencies
    & Readonly<{ operations: AdminOperationsRouteService; }>;

export function registerAdminOperationsRoutes(
    app: Hono,
    dependencies: AdminOperationsRouteDependencies
): void {
    registerAdminOperationReadRoutes(app, dependencies);
    registerAdminOperationMutationRoutes(app, dependencies);
}
