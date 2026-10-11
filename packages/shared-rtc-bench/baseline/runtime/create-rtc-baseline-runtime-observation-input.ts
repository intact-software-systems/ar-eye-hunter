import { RTC_BASELINE_WORKLOAD_CATALOG } from '../catalog/rtc-baseline-workload-catalog.ts';
import type {
    RtcBaselineCaptureRequestDto,
    RtcBaselineConfigurationFieldDescriptorDto,
    RtcBaselineControllerInputDto,
    RtcBaselineIssueDto,
    RtcBaselineResolvedConfigurationValueDto,
    RtcBaselineResult,
    RtcBaselineRuntimeObservationDto,
    RtcBaselineWorkerCommandDto
} from '../contracts/rtc-baseline-contracts.ts';
import { resolveRtcBaselineConfiguration } from '../contracts/rtc-baseline-validation.ts';
import {
    resolveRtcBaselineCaptureAdmission,
    RTC_BASELINE_CAPTURE_ENVIRONMENT_NAME,
    type RtcBaselineCaptureAdmission
} from './rtc-baseline-capture-admission.ts';

export interface RtcBaselineObservationInput {
    sourcePaths: readonly string[];
    configurationInputs: readonly RtcBaselineControllerInputDto[];
    controllerInputs: readonly RtcBaselineControllerInputDto[];
    resolvedConfiguration: readonly RtcBaselineResolvedConfigurationValueDto[];
    workerCommand: RtcBaselineWorkerCommandDto;
    deviations: readonly string[];
    allowlistedEnvironment: Readonly<Record<string, string>>;
}

export interface RtcBaselineRuntimeObservationSetup {
    files: readonly { path: string; kind: 'source' | 'config'; }[];
    observation: RtcBaselineObservationInput;
}

interface RtcBaselineObservationAdmission {
    initialized?: RtcBaselineRuntimeObservationDto;
    captureAdmission?: RtcBaselineCaptureAdmission;
}

interface RtcBaselineObservationConfiguration {
    resolvedConfiguration: RtcBaselineResolvedConfigurationValueDto[];
    configurationInputs: RtcBaselineControllerInputDto[];
}

interface RtcBaselineObservationInventory {
    files: RtcBaselineRuntimeObservationSetup['files'];
    descriptors: readonly RtcBaselineConfigurationFieldDescriptorDto[];
    workerCommand: RtcBaselineWorkerCommandDto;
}

function redactPersistedEnvironment(values: Readonly<Record<string, string>>) {
    return Object.fromEntries(
        Object.entries(values).map(([name, value]) => [
            name,
            name === 'DATABASE_URL' ? (value.length > 0 ? 'present' : 'absent') : value
        ])
    );
}

function resolveObservationConfiguration(
    descriptors: readonly RtcBaselineConfigurationFieldDescriptorDto[],
    environment: Readonly<Record<string, string>>,
    admission: RtcBaselineObservationAdmission
): RtcBaselineResult<RtcBaselineObservationConfiguration> {
    const almIssues = validateAlmSelection(descriptors, environment, admission.initialized);
    if (almIssues.length > 0) {
        return { ok: false, issues: almIssues };
    }
    const selectedCapture = admission.captureAdmission === undefined &&
            descriptors.some((descriptor) => descriptor.field === 'rtcCaptureMode') &&
            admission.initialized === undefined
        ? resolveRtcBaselineCaptureAdmission(undefined, environment[RTC_BASELINE_CAPTURE_ENVIRONMENT_NAME])
        : { ok: true as const, value: admission.captureAdmission };
    if (!selectedCapture.ok) {
        return selectedCapture;
    }
    const resolvedConfiguration: RtcBaselineResolvedConfigurationValueDto[] = [];
    const configurationInputs: RtcBaselineControllerInputDto[] = [];
    for (const descriptor of descriptors) {
        const initialized = admission.initialized?.resolvedConfiguration.find((entry) =>
            entry.field === descriptor.field && JSON.stringify(entry.caseKey) === JSON.stringify(descriptor.caseKey)
        );
        const environmentName = descriptor.allowlistedEnvironmentVariable;
        const resolved = descriptor.field === 'almDiagnostics' && initialized !== undefined
            ? { ok: true as const, value: initialized }
            : descriptor.field === 'rtcCaptureMode'
            ? resolveCaptureDescriptor(descriptor, initialized, selectedCapture.value)
            : resolveRtcBaselineConfiguration(descriptor, {
                cliValue: initialized?.source === 'cli' ? initialized.value : undefined,
                environmentValue: environmentName ? environment[environmentName] : undefined
            });
        if (!resolved.ok) {
            return resolved;
        }
        resolvedConfiguration.push(resolved.value);
        if (resolved.value.source === 'environment') {
            configurationInputs.push({ name: environmentName!, value: String(resolved.value.value), secret: false });
        }
    }
    return { ok: true, value: { resolvedConfiguration, configurationInputs } };
}

export function createRtcBaselineRuntimeObservationInput(
    request: RtcBaselineCaptureRequestDto,
    allowlistedEnvironment: Readonly<Record<string, string>>,
    admission: RtcBaselineObservationAdmission = {}
): RtcBaselineResult<RtcBaselineRuntimeObservationSetup> {
    const inventory = computeObservationInventory(request);
    const { files } = inventory;
    const configuration = resolveObservationConfiguration(
        inventory.descriptors,
        allowlistedEnvironment,
        admission
    );
    if (!configuration.ok) {
        return configuration;
    }
    return {
        ok: true,
        value: {
            files,
            observation: {
                sourcePaths: files.map((entry) => entry.path),
                ...configuration.value,
                controllerInputs: admission.initialized?.controllerInputs ?? [
                    { name: 'baselineId', value: request.baselineId, secret: false },
                    { name: 'workloadIds', value: request.workloadIds.join(','), secret: false },
                    { name: 'environmentId', value: request.environmentId, secret: false }
                ],
                workerCommand: inventory.workerCommand,
                deviations: [],
                allowlistedEnvironment: redactPersistedEnvironment(
                    resolveInitializedAlmEnvironment(allowlistedEnvironment, admission.initialized)
                )
            }
        }
    };
}

function computeObservationInventory(request: RtcBaselineCaptureRequestDto): RtcBaselineObservationInventory {
    const cases = request.workloadIds.flatMap((workloadId) => {
        const workload = RTC_BASELINE_WORKLOAD_CATALOG.find((entry) => entry.workloadId === workloadId);
        return workload?.cases.filter((entry) =>
            workloadId !== 'RTC-B06' ||
            entry.inputKey.startsWith(request.environmentId.toLowerCase())
        ) ?? [];
    });
    const files = cases.flatMap((entry) => [
        ...entry.sourcePaths.map((path) => ({ path, kind: 'source' as const })),
        ...entry.configPaths.map((path) => ({ path, kind: 'config' as const }))
    ]).filter((entry, index, all) => all.findIndex((candidate) => candidate.path === entry.path) === index);
    const runtime = cases[0]?.runtime ?? { executable: 'deno', prefixArguments: [] };
    return {
        files,
        descriptors: cases.flatMap((entry) => entry.configuration),
        workerCommand: {
            redactedArgv: { executable: runtime.executable, arguments: runtime.prefixArguments },
            projection: { fixedWorkerFlags: [], configurationFlags: [] }
        }
    };
}

function resolveCaptureDescriptor(
    descriptor: RtcBaselineConfigurationFieldDescriptorDto,
    initialized: RtcBaselineResolvedConfigurationValueDto | undefined,
    admission: RtcBaselineCaptureAdmission | undefined
): RtcBaselineResult<RtcBaselineResolvedConfigurationValueDto> {
    if (initialized !== undefined) {
        return { ok: true, value: initialized };
    }
    if (admission === undefined) {
        return {
            ok: false,
            issues: [{
                path: '$.resolvedConfiguration',
                code: 'missing-capture-admission',
                message: 'Initialized B06 configuration must include its admitted capture selection.'
            }]
        };
    }
    return {
        ok: true,
        value: { caseKey: descriptor.caseKey, field: descriptor.field, value: admission.mode, source: admission.source }
    };
}

function resolveInitializedAlmEnvironment(
    environment: Readonly<Record<string, string>>,
    initialized: RtcBaselineRuntimeObservationDto | undefined
): Readonly<Record<string, string>> {
    if (initialized === undefined) {
        return environment;
    }
    const { RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: _ambientAlm, ...current } = environment;
    const selected = initialized.allowlistedEnvironment.RALLAR_BLACK_BOX_ALM_DIAGNOSTICS;
    return selected === undefined ? current : { ...current, RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: selected };
}

function validateAlmSelection(
    descriptors: readonly RtcBaselineConfigurationFieldDescriptorDto[],
    environment: Readonly<Record<string, string>>,
    initialized: RtcBaselineRuntimeObservationDto | undefined
): RtcBaselineIssueDto[] {
    const almDescriptors = descriptors.filter((descriptor) => descriptor.field === 'almDiagnostics');
    if (almDescriptors.length === 0) {
        return [];
    }
    if (initialized !== undefined) {
        const complete = almDescriptors.every((descriptor) => {
            const values = initialized.resolvedConfiguration.filter((entry) =>
                entry.field === descriptor.field && JSON.stringify(entry.caseKey) === JSON.stringify(descriptor.caseKey)
            );
            return values.length === 1 && typeof values[0]?.value === 'boolean';
        });
        return complete
            ? []
            : [{
                path: '$.resolvedConfiguration',
                code: 'missing-alm-selection',
                message:
                    'Initialized B06 configuration must include its frozen ALM boolean for every exact case and input.'
            }];
    }
    const value = environment.RALLAR_BLACK_BOX_ALM_DIAGNOSTICS;
    return value === undefined || value === 'true' || value === 'false'
        ? []
        : [{
            path: '$.RALLAR_BLACK_BOX_ALM_DIAGNOSTICS',
            code: 'invalid-environment-value',
            message: 'ALM diagnostics environment selection must be true or false.'
        }];
}
