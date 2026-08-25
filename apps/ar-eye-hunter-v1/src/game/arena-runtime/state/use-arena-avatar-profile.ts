import { createRallarBrowserAi } from '@shared-web/browser/rallar-ai.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarAiJsonProvider } from '@shared/rallar-ai/mod.ts';
import { useEffect } from 'react';
import type { RefObject } from 'react';

import {
    createAvatarProfileMockProvider,
    createAvatarProfileRequest,
    createDeterministicAvatarProfile,
    validateAvatarProfile,
    type AvatarProfile
} from '../../avatarProfile.ts';
import { resolveArenaBrowserAiConfig } from '../../browser-ai/arena-browser-ai-config.ts';
import { createArenaBrowserAiProvider } from '../../browser-ai/arena-browser-ai-provider.ts';
import type { ArenaSnapshot } from '../../types.ts';

const BROWSER_RALLAR_AI_CONFIG = resolveArenaBrowserAiConfig();

interface ArenaAvatarProfileInput {
    readonly arenaSnapshotRef: RefObject<ArenaSnapshot | undefined>;
    readonly isCurrentNetworkGeneration: (generation: number) => boolean;
    readonly localAvatarProfileRef: RefObject<AvatarProfile | undefined>;
    readonly networkGenerationRef: RefObject<number>;
    readonly roomId: string | undefined;
    readonly session: AuthSession | undefined;
}

export function useArenaAvatarProfile(input: ArenaAvatarProfileInput): void {
    useEffect(() => startArenaAvatarProfileGeneration(input), [
        input.isCurrentNetworkGeneration,
        input.roomId,
        input.session
    ]);
}

function startArenaAvatarProfileGeneration(
    input: ArenaAvatarProfileInput
): (() => void) | undefined {
    if (!input.session) {
        input.localAvatarProfileRef.current = undefined;
        return undefined;
    }
    const session = input.session;
    const defaultProfile = createDeterministicAvatarProfile(
        session.sessionId,
        session.username
    );
    input.localAvatarProfileRef.current = defaultProfile;
    const providerSelection = createArenaBrowserAiProvider({
        config: BROWSER_RALLAR_AI_CONFIG,
        createMockProvider: createAvatarProfileMockProvider
    });
    if (providerSelection.status !== 'ready') {
        return undefined;
    }

    let cancelled = false;
    const generation = input.networkGenerationRef.current;
    const ai = createAvatarProfileAi(providerSelection.provider);
    if (typeof ai.generateJson !== 'function') {
        return undefined;
    }
    void ai
        .generateJson<AvatarProfile>({
            ...createAvatarProfileRequest({
                sessionId: session.sessionId,
                username: session.username,
                roomId: input.roomId,
                revision: input.arenaSnapshotRef.current?.revision ?? 0
            })
        })
        .then((result) => {
            if (cancelled || !input.isCurrentNetworkGeneration(generation)) {
                return;
            }
            const validation = validateAvatarProfile(result.value, session.sessionId);
            input.localAvatarProfileRef.current = validation.ok
                ? validation.profile
                : defaultProfile;
        })
        .catch(() => {
            if (!cancelled && input.isCurrentNetworkGeneration(generation)) {
                input.localAvatarProfileRef.current = defaultProfile;
            }
        });
    return () => {
        cancelled = true;
    };
}

function createAvatarProfileAi(provider: RallarAiJsonProvider) {
    return createRallarBrowserAi({
        rallar,
        provider,
        policy: {
            mode: 'browser-only',
            staleResultMode: 'allow'
        }
    });
}
