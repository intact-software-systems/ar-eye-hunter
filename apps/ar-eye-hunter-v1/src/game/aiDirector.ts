import {
    createRallarAiAcceptedResultTracker,
    createRallarAiMockProvider,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonSchema,
} from '@shared/rallar-ai/mod.ts';

import {
    type AiDirectorProposal,
    type AiDirectorProposalValue,
    type ArenaEvent,
    type ArenaEventKind,
    type ArenaSnapshot,
    type TargetRarity,
} from './types.ts';
import { arenaRevisionKey, type ArenaSimulationState } from './simulation.ts';

export const AI_DIRECTOR_SCHEMA_ID = 'ar-eye-hunter.ai-director-event';
export const AI_DIRECTOR_SCHEMA_VERSION = '1';

export const AI_DIRECTOR_EVENT_SCHEMA: RallarAiJsonSchema = {
    type: 'object',
    required: ['event', 'urgency', 'reason'],
    additionalProperties: false,
    properties: {
        event: {
            type: 'object',
            required: ['kind', 'headline'],
            additionalProperties: false,
            properties: {
                kind: {
                    type: 'string',
                    enum: [
                        'spawn-eye',
                        'mutate-target',
                        'arena-shift',
                        'hazard-burst',
                        'combo-bounty',
                        'reward-drop',
                        'overdrive-window',
                    ],
                },
                targetId: { type: 'string', minLength: 1, maxLength: 80 },
                radius: { type: 'number', minimum: 1, maximum: 12 },
                intensity: { type: 'number', minimum: 0.25, maximum: 4 },
                durationMs: { type: 'integer', minimum: 2500, maximum: 16000 },
                rarity: {
                    type: 'string',
                    enum: ['common', 'volatile', 'bounty', 'rift'],
                },
                scoreBonus: { type: 'integer', minimum: 25, maximum: 500 },
                headline: { type: 'string', minLength: 1, maxLength: 48 },
            },
        },
        urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
        reason: { type: 'string', minLength: 1, maxLength: 140 },
    },
};

export type AiDirectorValidation =
    | Readonly<{ ok: true; value: AiDirectorProposalValue }>
    | Readonly<{ ok: false; reason: string }>;

export const acceptedAiDirectorTracker = createRallarAiAcceptedResultTracker<
    AiDirectorProposalValue
>();

const ALLOWED_EVENTS: readonly ArenaEventKind[] = [
    'spawn-eye',
    'mutate-target',
    'arena-shift',
    'hazard-burst',
    'combo-bounty',
    'reward-drop',
    'overdrive-window',
];

const ALLOWED_RARITIES: readonly TargetRarity[] = [
    'common',
    'volatile',
    'bounty',
    'rift',
];

export function createAiDirectorMockProvider(): RallarAiJsonProvider {
    return createRallarAiMockProvider({
        providerId: 'ar-eye-hunter-chaos-mock',
        modelId: 'deterministic-chaos-v1',
        value: (request: RallarAiJsonRequest<AiDirectorContext>) => {
            const context = request.context;
            const index = context?.revision ?? 0;
            const target = context?.targets[index % Math.max(1, context.targets.length)];
            const kind: ArenaEventKind = index % 4 === 0
                ? 'combo-bounty'
                : index % 4 === 1
                ? 'arena-shift'
                : index % 4 === 2
                ? 'spawn-eye'
                : 'overdrive-window';
            return {
                event: {
                    kind,
                    targetId: target?.id,
                    durationMs: kind === 'arena-shift' ? 6000 : 9000,
                    intensity: kind === 'arena-shift' ? 1.8 : 1.1,
                    rarity: kind === 'spawn-eye' ? 'volatile' : 'bounty',
                    scoreBonus: 150,
                    headline: kind === 'arena-shift'
                        ? 'Arena vectors snapped'
                        : kind === 'spawn-eye'
                        ? 'New volatile eye breached'
                        : kind === 'overdrive-window'
                        ? 'Overdrive window open'
                        : 'Bounty eye marked',
                },
                urgency: 'medium',
                reason: 'Keep the arena tempo changing without requiring server input.',
            };
        },
    });
}

export type AiDirectorContext = Readonly<{
    roomId?: string;
    revision: number;
    activeEventKind?: ArenaEventKind;
    targetCount: number;
    bountyCount: number;
    targets: readonly Readonly<{
        id: string;
        rarity: TargetRarity;
        health: number;
    }>[];
}>;

export function buildAiDirectorContext(
    state: ArenaSimulationState,
    roomId?: string,
): AiDirectorContext {
    return {
        roomId,
        revision: state.revision,
        activeEventKind: state.activeEvent?.kind,
        targetCount: state.targets.length,
        bountyCount: state.targets.filter((target) => target.rarity === 'bounty').length,
        targets: state.targets.slice(0, 10).map((target) => ({
            id: target.id,
            rarity: target.rarity,
            health: target.health,
        })),
    };
}

export function createAiDirectorRequest(
    state: ArenaSimulationState,
    roomId: string | undefined,
    signal?: AbortSignal,
): RallarAiJsonRequest<AiDirectorContext> {
    const context = buildAiDirectorContext(state, roomId);
    const baseStateRevision = arenaRevisionKey(state);
    return {
        requestId: `ar-eye-chaos:${roomId ?? 'solo'}:${state.revision}`,
        schemaId: AI_DIRECTOR_SCHEMA_ID,
        schemaVersion: AI_DIRECTOR_SCHEMA_VERSION,
        schema: AI_DIRECTOR_EVENT_SCHEMA,
        prompt: [
            'You are the AR Eye Hunter live chaos director.',
            'Return one legal JSON event that makes the next 10 seconds faster, stranger, and rewarding.',
            'Only use target ids from context when a target id is needed.',
            'Keep effects readable for a first-person shooter.',
        ].join(' '),
        context,
        baseStateRevision,
        dedupeKey: `ar-eye-chaos:${roomId ?? 'solo'}:${state.revision}`,
        maxOutputTokens: 180,
        temperature: 0.65,
        timeoutMs: 3_000,
        signal,
    };
}

export function validateAiDirectorProposalValue(
    value: unknown,
    snapshot: ArenaSnapshot | ArenaSimulationState,
): AiDirectorValidation {
    if (!isRecord(value)) {
        return { ok: false, reason: 'AI proposal must be an object.' };
    }
    const event = value['event'];
    if (!isRecord(event)) {
        return { ok: false, reason: 'AI proposal event is missing.' };
    }
    const kind = event['kind'];
    if (typeof kind !== 'string' || !ALLOWED_EVENTS.includes(kind as ArenaEventKind)) {
        return { ok: false, reason: 'AI proposal event kind is not allowed.' };
    }
    const targetId = typeof event['targetId'] === 'string'
        ? event['targetId']
        : undefined;
    if (targetId && !snapshot.targets.some((target) => target.id === targetId)) {
        return { ok: false, reason: 'AI proposal target id is not in the arena.' };
    }
    const durationMs = clampNumber(event['durationMs'], 2_500, 16_000, 8_000);
    const radius = clampNumber(event['radius'], 1, 12, undefined);
    const intensity = clampNumber(event['intensity'], 0.25, 4, 1);
    const scoreBonus = clampNumber(event['scoreBonus'], 25, 500, undefined);
    const rarity = typeof event['rarity'] === 'string' &&
        ALLOWED_RARITIES.includes(event['rarity'] as TargetRarity)
        ? event['rarity'] as TargetRarity
        : undefined;
    const headline = typeof event['headline'] === 'string' && event['headline'].trim()
        ? event['headline'].slice(0, 48)
        : defaultHeadline(kind as ArenaEventKind);
    const urgency = value['urgency'] === 'high' || value['urgency'] === 'low'
        ? value['urgency']
        : 'medium';
    const reason = typeof value['reason'] === 'string' && value['reason'].trim()
        ? value['reason'].slice(0, 140)
        : 'Validated fallback event.';

    return {
        ok: true,
        value: {
            event: {
                kind: kind as ArenaEventKind,
                targetId,
                radius,
                intensity,
                durationMs,
                rarity,
                scoreBonus,
                headline,
            },
            urgency,
            reason,
        },
    };
}

export function materializeAiArenaEvent(
    proposal: AiDirectorProposal,
    revision: number,
    nowEpochMs: number,
): ArenaEvent {
    const durationMs = proposal.value.event.durationMs ?? 8_000;
    return {
        id: `ai-event:${proposal.generationId}`,
        kind: proposal.value.event.kind,
        targetId: proposal.value.event.targetId,
        radius: proposal.value.event.radius,
        intensity: proposal.value.event.intensity,
        durationMs,
        rarity: proposal.value.event.rarity,
        scoreBonus: proposal.value.event.scoreBonus,
        startsAtEpochMs: nowEpochMs,
        expiresAtEpochMs: nowEpochMs + durationMs,
        revision,
        source: 'ai',
        headline: proposal.value.event.headline,
    };
}

function defaultHeadline(kind: ArenaEventKind): string {
    if (kind === 'arena-shift') {
        return 'Arena shifted';
    }
    if (kind === 'combo-bounty') {
        return 'Bounty marked';
    }
    if (kind === 'overdrive-window') {
        return 'Overdrive window';
    }
    if (kind === 'hazard-burst') {
        return 'Hazard burst';
    }
    if (kind === 'reward-drop') {
        return 'Reward drop';
    }
    if (kind === 'mutate-target') {
        return 'Eye mutation';
    }
    return 'New eye spawned';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampNumber(
    value: unknown,
    min: number,
    max: number,
    fallback: number | undefined,
): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, value));
}
