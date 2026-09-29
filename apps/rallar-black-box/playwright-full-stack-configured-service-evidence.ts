import { assertFullStackApiConfigEvidence } from './playwright-full-stack-api-server.ts';

export function assertFullStackReadinessHttpEvidence(
    input: Readonly<{
        service: 'API' | 'control';
        ok: boolean;
        status: number;
        statusText: string;
    }>
): void {
    if (!input.ok) {
        throw new Error(
            `Configured ${input.service} readiness returned HTTP ${input.status} ${input.statusText}.`
        );
    }
}

export function assertFullStackControlHealthEvidence(value: unknown): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Configured control health must be a JSON object.');
    }
    const health = value as Readonly<{ ok?: boolean; app?: string; protocolVersion?: number; }>;
    if (health.ok !== true) {
        throw new Error(`Configured control health ok must be true. Received: ${String(health.ok)}`);
    }
    if (health.app !== 'rallar-black-box-control-server') {
        throw new Error(
            `Configured control health app must be rallar-black-box-control-server. Received: ${String(health.app)}`
        );
    }
    if (health.protocolVersion !== 1) {
        throw new Error(
            `Configured control health protocolVersion must be 1. Received: ${String(health.protocolVersion)}`
        );
    }
}

export type FullStackConfiguredServiceProbe =
    | Readonly<{ kind: 'unavailable'; }>
    | Readonly<{
        kind: 'reachable';
        ok: boolean;
        status: number;
        statusText: string;
        readJson(): Promise<unknown>;
    }>;

export async function evaluateFullStackConfiguredServiceEvidence(
    input: Readonly<{
        api: FullStackConfiguredServiceProbe;
        control: FullStackConfiguredServiceProbe;
        expectedApiBaseUrl: string;
    }>
): Promise<'ready' | 'unavailable'> {
    if (input.api.kind === 'reachable') {
        assertFullStackReadinessHttpEvidence({
            service: 'API',
            ok: input.api.ok,
            status: input.api.status,
            statusText: input.api.statusText
        });
        assertFullStackApiConfigEvidence(
            await input.api.readJson(),
            input.expectedApiBaseUrl
        );
    }
    if (input.control.kind === 'reachable') {
        assertFullStackReadinessHttpEvidence({
            service: 'control',
            ok: input.control.ok,
            status: input.control.status,
            statusText: input.control.statusText
        });
        assertFullStackControlHealthEvidence(await input.control.readJson());
    }
    return input.api.kind === 'unavailable' || input.control.kind === 'unavailable'
        ? 'unavailable'
        : 'ready';
}
