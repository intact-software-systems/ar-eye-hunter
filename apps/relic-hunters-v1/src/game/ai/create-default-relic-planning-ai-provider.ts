import type { RallarAiJsonProvider } from '@shared/rallar-ai/mod.ts';
import { createRelicPlanningAiMockProvider } from './relic-planning-ai.ts';

/** Development and test builds answer locally with the deterministic companion; a production build has no local provider. */
export function createDefaultRelicPlanningAiProvider(): RallarAiJsonProvider | undefined {
    return isDevelopmentOrTestBuild() ? createRelicPlanningAiMockProvider() : undefined;
}

function isDevelopmentOrTestBuild(): boolean {
    const env = (import.meta as {
        env?: Readonly<{ DEV?: boolean; MODE?: string; VITEST?: string; }>;
    }).env;
    const processEnv = (globalThis as {
        process?: { env?: Readonly<Record<string, string | undefined>>; };
    }).process?.env;
    return !!env?.DEV ||
        env?.MODE === 'test' ||
        !!env?.VITEST ||
        !!processEnv?.VITEST;
}
