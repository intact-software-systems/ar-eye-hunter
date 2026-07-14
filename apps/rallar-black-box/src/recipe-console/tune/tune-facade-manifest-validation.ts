import { validateDistributedRunManifest } from
    '@shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { AnalyzeTuneArtifactFacade } from
    '../analyze/analyze-worker-contract.ts';

export type TuneFacadeManifestValidation = Readonly<{
    status: 'omitted' | 'valid' | 'invalid';
    validationCount: 0 | 1;
    firstError?: Readonly<{ path: string; message: string }>;
}>;

const validationBindings = new WeakMap<
    TuneFacadeManifestValidation,
    Readonly<{
        facade: AnalyzeTuneArtifactFacade;
        manifest: AnalyzeTuneArtifactFacade['candidateManifest'];
    }>
>();

export function projectTuneFacadeManifestValidation(
    facade: AnalyzeTuneArtifactFacade,
): TuneFacadeManifestValidation {
    if (!facade.candidateManifest) {
        return bind(facade, { status: 'omitted', validationCount: 0 });
    }
    const validation = validateDistributedRunManifest(facade.candidateManifest);
    if (validation.ok) {
        return bind(facade, { status: 'valid', validationCount: 1 });
    }
    const first = validation.errors[0];
    return bind(facade, {
        status: 'invalid',
        validationCount: 1,
        ...(first === undefined
            ? {}
            : { firstError: { path: first.path, message: first.message } }),
    });
}

export function resolveTuneFacadeManifestValidation(
    facade: AnalyzeTuneArtifactFacade,
    candidate?: TuneFacadeManifestValidation,
): TuneFacadeManifestValidation {
    const binding = candidate ? validationBindings.get(candidate) : undefined;
    return binding?.facade === facade &&
        binding.manifest === facade.candidateManifest
        ? candidate as TuneFacadeManifestValidation
        : projectTuneFacadeManifestValidation(facade);
}

function bind(
    facade: AnalyzeTuneArtifactFacade,
    validation: TuneFacadeManifestValidation,
): TuneFacadeManifestValidation {
    validationBindings.set(validation, {
        facade,
        manifest: facade.candidateManifest,
    });
    return validation;
}
