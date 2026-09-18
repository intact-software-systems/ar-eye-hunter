import type {
    ControlFleetReportBundle,
    ControlFleetReportFilter,
    ControlFleetReportsResponse,
    ControlFleetRunReport
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    toAuthorizationHeaders,
    toNormalizedBaseUrl,
    type ControlDistributedRunRequest,
    type ControlEndpointRequest
} from './control-endpoint-request.ts';
import { readJsonResponse } from './control-reply-reader.ts';
import { readBoundedControlArtifactResponseBytes } from './read-bounded-control-artifact-response-bytes.ts';

const CONTROL_FLEET_REPORT_BUNDLE_TRANSFER_MAX_BYTES = 64 * 1_024 * 1_024;

export async function readFleetReports(
    input:
        & ControlEndpointRequest
        & Readonly<{
            /** Absent when the caller wants every report the server holds. */
            filter?: ControlFleetReportFilter;
        }>
): Promise<ControlFleetReportsResponse> {
    const url = new URL('/fleet/reports', toNormalizedBaseUrl(input.baseUrl));
    setFleetReportFilter(url, input.filter ?? {});
    const response = await (input.fetchFn ?? fetch)(url, {
        headers: toAuthorizationHeaders(input.token)
    });
    return readJsonResponse<ControlFleetReportsResponse>(response);
}

export async function readFleetReport(
    input: ControlDistributedRunRequest
): Promise<ControlFleetRunReport> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/fleet/reports/${encodeURIComponent(input.distributedRunId)}`, toNormalizedBaseUrl(input.baseUrl)),
        {
            headers: toAuthorizationHeaders(input.token)
        }
    );
    return readJsonResponse<ControlFleetRunReport>(response);
}

export async function readFleetReportBundle(
    input: ControlDistributedRunRequest
): Promise<ControlFleetReportBundle> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(
            `/fleet/reports/${encodeURIComponent(input.distributedRunId)}/artifacts`,
            toNormalizedBaseUrl(input.baseUrl)
        ),
        {
            headers: toAuthorizationHeaders(input.token)
        }
    );
    return readJsonResponse<ControlFleetReportBundle>(response);
}

export async function readFleetReportBundleBytes(
    input: ControlDistributedRunRequest
): Promise<ArrayBuffer> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(
            `/fleet/reports/${encodeURIComponent(input.distributedRunId)}/artifacts`,
            toNormalizedBaseUrl(input.baseUrl)
        ),
        {
            headers: toAuthorizationHeaders(input.token)
        }
    );
    return readBoundedControlArtifactResponseBytes(
        response,
        CONTROL_FLEET_REPORT_BUNDLE_TRANSFER_MAX_BYTES
    );
}

export async function rebuildFleetReports(
    input: ControlEndpointRequest
): Promise<ControlFleetReportsResponse> {
    const response = await (input.fetchFn ?? fetch)(
        new URL('/fleet/reports/rebuild', toNormalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: toAuthorizationHeaders(input.token)
        }
    );
    return readJsonResponse<ControlFleetReportsResponse>(response);
}

function setFleetReportFilter(url: URL, filter: ControlFleetReportFilter): void {
    const entries: Array<[string, string | number | undefined]> = [
        ['region', filter.region],
        ['provider', filter.provider],
        ['recipeId', filter.recipeId],
        ['groupId', filter.groupId],
        ['state', filter.state],
        ['fromEpochMs', filter.fromEpochMs],
        ['toEpochMs', filter.toEpochMs]
    ];
    entries.forEach(([name, value]) => {
        if (value !== undefined && String(value).trim().length > 0) {
            url.searchParams.set(name, String(value));
        }
    });
}
