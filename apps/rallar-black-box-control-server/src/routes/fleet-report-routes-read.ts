import type { FleetReportFilter } from '../control-fleet.ts';
import type { RallarBlackBoxControlService } from '../control-service.ts';
import type { ControlHttpResponses } from '../http/control-http-responses.ts';
import { toNotFoundRejection } from './control-route-errors.ts';
import { toPathParameters } from './control-route-requests.ts';

export interface FleetReportReadRouteDependencies {
    readonly controlService: Pick<
        RallarBlackBoxControlService,
        'createFleetReportBundle' | 'listFleetReports' | 'snapshotFleetReport'
    >;
    readonly responses: ControlHttpResponses;
}

const FLEET_REPORT_PATH = /^\/fleet\/reports\/([^/]+)$/;
const FLEET_REPORT_ARTIFACTS_PATH = /^\/fleet\/reports\/([^/]+)\/artifacts$/;
const FLEET_REPORT_NOT_FOUND = toNotFoundRejection('Fleet report not found.');

export function routeFleetReportReadRequest(
    url: URL,
    { controlService, responses }: FleetReportReadRouteDependencies
): Response | undefined {
    if (url.pathname === '/fleet/reports') {
        return responses.json(controlService.listFleetReports(toFleetReportFilter(url)), 200);
    }

    const [reportId] = toPathParameters(url.pathname, FLEET_REPORT_PATH) ?? [];
    if (reportId !== undefined) {
        const report = controlService.snapshotFleetReport(reportId);
        return report ? responses.json(report, 200) : responses.rejection(FLEET_REPORT_NOT_FOUND);
    }

    const [bundleReportId] = toPathParameters(url.pathname, FLEET_REPORT_ARTIFACTS_PATH) ?? [];
    if (bundleReportId !== undefined) {
        const bundle = controlService.createFleetReportBundle(bundleReportId);
        return bundle ? responses.json(bundle, 200) : responses.rejection(FLEET_REPORT_NOT_FOUND);
    }
    return undefined;
}

function toFleetReportFilter(url: URL): FleetReportFilter {
    return {
        region: toTextQueryParameter(url, 'region'),
        provider: toTextQueryParameter(url, 'provider'),
        recipeId: toTextQueryParameter(url, 'recipeId'),
        groupId: toTextQueryParameter(url, 'groupId'),
        state: toTextQueryParameter(url, 'state'),
        fromEpochMs: toEpochQueryParameter(url, 'fromEpochMs'),
        toEpochMs: toEpochQueryParameter(url, 'toEpochMs')
    };
}

function toTextQueryParameter(url: URL, key: string): string | undefined {
    const value = url.searchParams.get(key)?.trim();
    return value ? value : undefined;
}

function toEpochQueryParameter(url: URL, key: string): number | undefined {
    const value = Number(url.searchParams.get(key) ?? '');
    return Number.isFinite(value) && value > 0 ? value : undefined;
}
