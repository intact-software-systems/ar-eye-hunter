import type { Hono } from 'jsr:@hono/hono@4.11.9';
import * as crdtAdminRoutes from './routes/crdt-admin-routes.ts';
import * as adminOperationsRoutes from './routes/admin-operations-routes.ts';
import * as adminSupportRoutes from './routes/admin-support-routes.ts';
import { authorizeCrdtDocumentAccess } from './services/create-api-crdt-document-authorizer.ts';
import type {
  ApiCrdtDocumentAuthorizerOptions,
} from './services/create-api-crdt-document-authorizer.ts';

export interface CreateRallarAdminRouteInitializersInput {
  readonly crdt: Omit<crdtAdminRoutes.RallarCrdtAdminRoutesOptions, 'authorizeCatchUp'>;
  readonly catchUpSnapshots: ApiCrdtDocumentAuthorizerOptions;
  readonly operations: adminOperationsRoutes.AdminOperationsRouteDependencies;
  readonly support: adminSupportRoutes.AdminSupportRouteDependencies;
}

export function createRallarAdminRouteInitializers(
  input: CreateRallarAdminRouteInitializersInput,
): ReadonlyArray<(app: Hono) => void> {
  return [
    (app) =>
      crdtAdminRoutes.registerCrdtAdminRoutes(app, {
        ...input.crdt,
        authorizeCatchUp: ({ document, session }) =>
          authorizeCrdtDocumentAccess(input.catchUpSnapshots, {
            document,
            actorPrincipalId: session.username,
            sessionId: session.sessionId,
          }),
      }),

    (app) => adminOperationsRoutes.init(app, input.operations),

    (app) => adminSupportRoutes.init(app, input.support),
  ];
}
