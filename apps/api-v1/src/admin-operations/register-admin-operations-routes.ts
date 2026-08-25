import type { AdminOperationUseCases } from '@shared-server/rallar-system/admin-operations/admin-operation-use-cases.ts';
import type { Hono } from 'jsr:@hono/hono@4.11.9';

import {
    registerAdminOperationMutationRoutes,
    type AdminOperationMutationRouteDependencies
} from './register-admin-operation-mutation-routes.ts';
import {
    registerAdminOperationReadRoutes,
    type AdminOperationReadRouteDependencies
} from './register-admin-operation-read-routes.ts';

export type AdminOperationsRouteDependencies =
    & AdminOperationReadRouteDependencies
    & AdminOperationMutationRouteDependencies
    & Readonly<{ operations: AdminOperationUseCases; }>;

export function registerAdminOperationsRoutes(
    app: Hono,
    dependencies: AdminOperationsRouteDependencies
): void {
    registerAdminOperationReadRoutes(app, dependencies);
    registerAdminOperationMutationRoutes(app, dependencies);
}
