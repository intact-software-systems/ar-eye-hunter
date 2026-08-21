import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { validateDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run-validation.ts';

export function distributedRunManifestIdentityIssues(
    run: ControlDistributedRunSnapshot
): string[] {
    try {
        const manifest = run.manifest as unknown;
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
            return ['Distributed run manifest identity could not be read safely.'];
        }
        const record = manifest as Record<string, unknown>;
        return [
            record.distributedRunId === run.distributedRunId
                ? undefined
                : 'Manifest distributed-run identity conflicts with its snapshot.',
            record.controlRunId === run.controlRunId
                ? undefined
                : 'Manifest control-run identity conflicts with its snapshot.'
        ].filter((value): value is string => value !== undefined);
    }
    catch {
        return ['Distributed run manifest identity could not be read safely.'];
    }
}

export function distributedRunManifestContractIssues(
    run: ControlDistributedRunSnapshot
): string[] {
    try {
        const validation = validateDistributedRunManifest(run.manifest);
        if (!validation.ok) {
            const first = validation.errors[0];
            return [
                first
                    ? `Distributed run manifest is invalid at ${first.path}: ${first.message}`
                    : 'Distributed run manifest is invalid.'
            ];
        }
        return [];
    }
    catch {
        return ['Distributed run manifest could not be validated safely.'];
    }
}
