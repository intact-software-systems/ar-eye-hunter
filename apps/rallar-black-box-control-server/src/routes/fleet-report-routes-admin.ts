import type { RallarBlackBoxControlService } from '../control-service.ts';
import type { ControlSnapshotPersistence } from '../control-snapshot-persistence.ts';
import type { ControlHttpResponses } from '../http/control-http-responses.ts';
import type { ControlHttpSecurity } from '../http/control-http-security.ts';
import { ADMIN_TOKEN_REJECTION } from './control-route-errors.ts';

export interface FleetReportAdminRouteDependencies {
    readonly controlService: Pick<RallarBlackBoxControlService, 'rebuildFleetReports'>;
    readonly security: Pick<ControlHttpSecurity, 'authorizeAdminRequest'>;
    readonly persistence: Pick<ControlSnapshotPersistence, 'persist'>;
    readonly responses: ControlHttpResponses;
}

export async function routeFleetReportAdminRequest(
    request: Request,
    url: URL,
    dependencies: FleetReportAdminRouteDependencies
): Promise<Response | undefined> {
    if (request.method !== 'POST' || url.pathname !== '/fleet/reports/rebuild') {
        return undefined;
    }
    if (!(await dependencies.security.authorizeAdminRequest(request, url))) {
        return dependencies.responses.rejection(ADMIN_TOKEN_REJECTION);
    }

    const rebuilt = dependencies.controlService.rebuildFleetReports();
    dependencies.persistence.persist();
    return dependencies.responses.json(rebuilt, 200);
}
