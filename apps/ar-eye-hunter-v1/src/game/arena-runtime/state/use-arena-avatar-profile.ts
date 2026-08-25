import { createRallarBrowserAi } from '@shared-web/browser/rallar-ai.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
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
    const {
        arenaSnapshotRef,
        isCurrentNetworkGeneration,
        localAvatarProfileRef,
        networkGenerationRef,
        roomId,
        session
    } = input;

    useEffect(() => {
        if (!session) {
            localAvatarProfileRef.current = undefined;
            return;
        }
        const fallback = createDeterministicAvatarProfile(session.sessionId, session.username);
        localAvatarProfileRef.current = fallback;
        const providerSelection = createArenaBrowserAiProvider({
            config: BROWSER_RALLAR_AI_CONFIG,
            createMockProvider: createAvatarProfileMockProvider
        });
        if (providerSelection.status !== 'ready') {
            return;
        }
        let cancelled = false;
        const generation = networkGenerationRef.current;
        const ai = createRallarBrowserAi({
            rallar,
            provider: providerSelection.provider,
            policy: {
                mode: 'browser-only',
                staleResultMode: 'allow'
            }
        });
        if (typeof ai.generateJson !== 'function') {
            return;
        }
        void ai.generateJson<AvatarProfile>({
            ...createAvatarProfileRequest({
                sessionId: session.sessionId,
                username: session.username,
                roomId,
                revision: arenaSnapshotRef.current?.revision ?? 0
            })
        }).then((result) => {
            if (cancelled || !isCurrentNetworkGeneration(generation)) {
                return;
            }
            const validation = validateAvatarProfile(result.value, session.sessionId);
            localAvatarProfileRef.current = validation.ok ? validation.profile : fallback;
        }).catch(() => {
            if (!cancelled && isCurrentNetworkGeneration(generation)) {
                localAvatarProfileRef.current = fallback;
            }
        });
        return () => {
            cancelled = true;
        };
    }, [isCurrentNetworkGeneration, roomId, session]);
}
