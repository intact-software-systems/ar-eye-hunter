import { appTabFromValue } from '../../../app-tabs.ts';
import { resolveAppExperience } from '../../../app/experience-route.ts';

export type LegacyRunsUrlSelection = Readonly<{
    controlRunId: string;
    distributedRunId: string;
}>;

export function parseLegacyRunsUrlSelection(
    search: string
): LegacyRunsUrlSelection | undefined {
    const params = new URLSearchParams(search);
    if (
        resolveAppExperience(search) !== 'legacy' ||
        appTabFromValue(params.get('tab')) !== 'runs'
    ) {
        return undefined;
    }
    const controlRunId = cleanId(params.get('controlRunId'));
    const distributedRunId = cleanId(params.get('distributedRunId'));
    return controlRunId && distributedRunId
        ? { controlRunId, distributedRunId }
        : undefined;
}

function cleanId(value: string | null): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

export function readLegacyRunsUrlSelection(): LegacyRunsUrlSelection | undefined {
    return typeof window === 'undefined'
        ? undefined
        : parseLegacyRunsUrlSelection(window.location.search);
}
