import {
    validateRallarAiJsonSchemaValue,
    type RallarAiJsonSchema,
    type RallarAiJsonValue
} from '@shared/rallar-ai/mod.ts';
import { Either } from '@shared/resilience/Either.ts';
import { RELIC_GAME_PHASES, type RelicActionKind, type RelicGamePhase } from './model.ts';

export const RELIC_PLANNING_AI_SCHEMA_ID = 'relic-hunters.planning-companion';
export const RELIC_PLANNING_AI_SCHEMA_VERSION = '1';

const HEADLINE_MAX_LENGTH = 80;
const RATIONALE_MAX_LENGTH = 240;
const RISK_MAX_LENGTH = 120;
const RELIC_ACTION_KINDS: readonly RelicActionKind[] = ['move', 'search', 'steal', 'escape'];
const RELIC_PLANNING_AI_CONFIDENCES: readonly RelicPlanningAiConfidence[] = ['low', 'medium', 'high'];

export type RelicPlanningAiConfidence = 'low' | 'medium' | 'high';

export interface RelicPlanningAiSuggestedAction {
    readonly kind: RelicActionKind;
    readonly targetRoomId?: string;
    readonly targetPlayerId?: string;
}

export interface RelicPlanningAiSuggestion {
    readonly headline: string;
    readonly action?: RelicPlanningAiSuggestedAction;
    readonly rationale: string;
    readonly risks: readonly string[];
    readonly confidence: RelicPlanningAiConfidence;
}

export interface RelicPlanningAiContextAction {
    readonly kind: RelicActionKind;
    readonly label: string;
    readonly description: string;
    readonly legal: boolean;
    readonly blocker?: string;
    readonly consequence: Readonly<{
        text: string;
        status: string;
    }>;
}

/** The public view of one hunter's turn the companion plans from: no hidden relic names, values or locations. */
export interface RelicPlanningAiContext {
    readonly schema: 'relic-planning-ai-context-v1';
    readonly lang: 'en' | 'no';
    readonly roomId: string;
    readonly phase: RelicGamePhase;
    readonly round: number;
    readonly roundsLeft: number;
    readonly turn: Readonly<{
        activePlayerCount: number;
        submittedPlayerCount: number;
        waitingPlayerCount: number;
        localSubmitted: boolean;
    }>;
    readonly localPlayer?: Readonly<{
        username: string;
        health: number;
        score: number;
        relicCount: number;
        escaped: boolean;
        defeated: boolean;
    }>;
    readonly currentRoom?: Readonly<{
        id: string;
        name: string;
        kind: string;
        unstable: boolean;
        collapsed: boolean;
        investigated: boolean;
    }>;
    readonly objective: string;
    readonly sceneRecommendation?: RelicPlanningAiSuggestedAction;
    readonly currentDraft: RelicPlanningAiSuggestedAction;
    readonly actionOptions: readonly RelicPlanningAiContextAction[];
    readonly moveTargets: readonly Readonly<{
        roomId: string;
        name: string;
        kind: string;
        exitDistance?: number;
        relicSignal: boolean;
        unstable: boolean;
        collapsed: boolean;
    }>[];
    readonly stealTargets: readonly Readonly<{
        playerId: string;
        username: string;
        health: number;
        score: number;
        relicCount: number;
    }>[];
    readonly warnings: readonly Readonly<{
        kind: string;
        severity: string;
        message: string;
    }>[];
    readonly knownInvestigations: readonly Readonly<{
        roomName: string;
        result: string;
        summary: string;
        hint: string;
        danger?: string;
        revealedRoomName?: string;
    }>[];
    readonly recentEvents: readonly Readonly<{
        round: number;
        type: string;
        message: string;
        tone?: string;
    }>[];
}

const SUGGESTED_ACTION_SCHEMA: RallarAiJsonSchema = {
    type: 'object',
    required: ['kind'],
    additionalProperties: false,
    properties: {
        kind: { type: 'string', enum: RELIC_ACTION_KINDS },
        targetRoomId: { type: 'string', minLength: 1, maxLength: 80 },
        targetPlayerId: { type: 'string', minLength: 1, maxLength: 120 }
    }
};

export const RELIC_PLANNING_AI_SUGGESTION_SCHEMA: RallarAiJsonSchema = {
    type: 'object',
    required: ['headline', 'rationale', 'risks', 'confidence'],
    additionalProperties: false,
    properties: {
        headline: { type: 'string', minLength: 1, maxLength: HEADLINE_MAX_LENGTH },
        action: SUGGESTED_ACTION_SCHEMA,
        rationale: { type: 'string', minLength: 1, maxLength: RATIONALE_MAX_LENGTH },
        risks: {
            type: 'array',
            maxItems: 3,
            items: { type: 'string', minLength: 1, maxLength: RISK_MAX_LENGTH }
        },
        confidence: { type: 'string', enum: RELIC_PLANNING_AI_CONFIDENCES }
    }
};

export const RELIC_PLANNING_AI_PROMPT = [
    'You are a Relic Hunters planning companion.',
    'Return one concise JSON suggestion for the local player.',
    'Only recommend legal actions and target ids from the context.',
    'Do not claim hidden relic names, exact hidden values, or unrevealed secret locations.',
    'Never submit actions or imply that the suggestion is authoritative.'
].join(' ');

const STRING: RallarAiJsonSchema = { type: 'string' };
const NUMBER: RallarAiJsonSchema = { type: 'number' };
const BOOLEAN: RallarAiJsonSchema = { type: 'boolean' };

function objectSchema(
    properties: Readonly<Record<string, RallarAiJsonSchema>>,
    optional: readonly string[] = []
): RallarAiJsonSchema {
    return {
        type: 'object',
        required: Object.keys(properties).filter((key) => !optional.includes(key)),
        additionalProperties: false,
        properties
    };
}

function listSchema(items: RallarAiJsonSchema): RallarAiJsonSchema {
    return { type: 'array', items };
}

const CONTEXT_SCHEMA = objectSchema({
    schema: { type: 'string', const: 'relic-planning-ai-context-v1' },
    lang: { type: 'string', enum: ['en', 'no'] },
    roomId: STRING,
    phase: { type: 'string', enum: RELIC_GAME_PHASES },
    round: NUMBER,
    roundsLeft: NUMBER,
    turn: objectSchema({
        activePlayerCount: NUMBER,
        submittedPlayerCount: NUMBER,
        waitingPlayerCount: NUMBER,
        localSubmitted: BOOLEAN
    }),
    localPlayer: objectSchema({
        username: STRING,
        health: NUMBER,
        score: NUMBER,
        relicCount: NUMBER,
        escaped: BOOLEAN,
        defeated: BOOLEAN
    }),
    currentRoom: objectSchema({
        id: STRING,
        name: STRING,
        kind: STRING,
        unstable: BOOLEAN,
        collapsed: BOOLEAN,
        investigated: BOOLEAN
    }),
    objective: STRING,
    sceneRecommendation: SUGGESTED_ACTION_SCHEMA,
    currentDraft: SUGGESTED_ACTION_SCHEMA,
    actionOptions: listSchema(objectSchema({
        kind: { type: 'string', enum: RELIC_ACTION_KINDS },
        label: STRING,
        description: STRING,
        legal: BOOLEAN,
        blocker: STRING,
        consequence: objectSchema({ text: STRING, status: STRING })
    }, ['blocker'])),
    moveTargets: listSchema(objectSchema({
        roomId: STRING,
        name: STRING,
        kind: STRING,
        exitDistance: NUMBER,
        relicSignal: BOOLEAN,
        unstable: BOOLEAN,
        collapsed: BOOLEAN
    }, ['exitDistance'])),
    stealTargets: listSchema(objectSchema({
        playerId: STRING,
        username: STRING,
        health: NUMBER,
        score: NUMBER,
        relicCount: NUMBER
    })),
    warnings: listSchema(objectSchema({ kind: STRING, severity: STRING, message: STRING })),
    knownInvestigations: listSchema(objectSchema({
        roomName: STRING,
        result: STRING,
        summary: STRING,
        hint: STRING,
        danger: STRING,
        revealedRoomName: STRING
    }, ['danger', 'revealedRoomName'])),
    recentEvents: listSchema(objectSchema({ round: NUMBER, type: STRING, message: STRING, tone: STRING }, ['tone']))
}, ['localPlayer', 'currentRoom', 'sceneRecommendation']);

/** A context that crossed a wire: refused unless every field is the planning context's, with nothing extra. */
export function decodeRelicPlanningAiContext(value: unknown): Either<string, RelicPlanningAiContext> {
    const validation = validateRallarAiJsonSchemaValue(CONTEXT_SCHEMA, value);
    if (!validation.ok) {
        return Either.ofLeft(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join(' '));
    }
    return Either.ofRight(value as RelicPlanningAiContext);
}

/**
 * A suggestion as a model or a peer returned it: refused at its first issue, else returned with only the fields the
 * schema names and an action legal for this turn.
 */
export function decodeRelicPlanningAiSuggestion(
    value: unknown,
    context: RelicPlanningAiContext
): Either<string, RelicPlanningAiSuggestion> {
    if (!isJsonObject(value)) {
        return Either.ofLeft('Suggestion must be an object.');
    }
    const headline = decodeCappedString(value.headline, 'headline', HEADLINE_MAX_LENGTH);
    const rationale = decodeCappedString(value.rationale, 'rationale', RATIONALE_MAX_LENGTH);
    const risks = decodeRisks(value.risks);
    const confidence = decodeConfidence(value.confidence);
    const firstIssue = headline.left ?? rationale.left ?? risks.left ??
        (confidence === undefined ? 'Confidence must be low, medium, or high.' : undefined);
    if (firstIssue !== undefined) {
        return Either.ofLeft(firstIssue);
    }
    const suggestion: RelicPlanningAiSuggestion = {
        headline: headline.right!,
        rationale: rationale.right!,
        risks: risks.right!,
        confidence: confidence!
    };
    if (value.action === undefined) {
        return Either.ofRight(suggestion);
    }
    const action = decodeSuggestedAction(value.action);
    if (action.right === undefined) {
        return Either.ofLeft(action.left!);
    }
    return isRelicPlanningAiActionLegal(action.right, context)
        ? Either.ofRight({ ...suggestion, action: action.right })
        : Either.ofLeft('Suggested action is not legal for this turn.');
}

/** Legal when the turn allows the action kind and any target is one the context offers. */
export function isRelicPlanningAiActionLegal(
    action: RelicPlanningAiSuggestedAction,
    context: RelicPlanningAiContext
): boolean {
    const option = context.actionOptions.find((candidate) => candidate.kind === action.kind);
    if (!option?.legal) {
        return false;
    }
    if (action.kind === 'move') {
        return !!action.targetRoomId &&
            context.moveTargets.some((target) => target.roomId === action.targetRoomId);
    }
    if (action.kind === 'steal') {
        return !!action.targetPlayerId &&
            context.stealTargets.some((target) => target.playerId === action.targetPlayerId);
    }
    return true;
}

function decodeRisks(value: unknown): Either<string, readonly string[]> {
    if (!Array.isArray(value) || value.length > 3) {
        return Either.ofLeft('Risks must contain at most 3 entries.');
    }
    const risks: string[] = [];
    for (const entry of value) {
        const risk = decodeCappedString(entry, 'risk', RISK_MAX_LENGTH);
        if (risk.right === undefined) {
            return Either.ofLeft(risk.left!);
        }
        risks.push(risk.right);
    }
    return Either.ofRight(risks);
}

function decodeSuggestedAction(value: unknown): Either<string, RelicPlanningAiSuggestedAction> {
    if (!isJsonObject(value)) {
        return Either.ofLeft('Action kind is invalid.');
    }
    const kind = decodeRelicActionKind(value.kind);
    if (kind === undefined) {
        return Either.ofLeft('Action kind is invalid.');
    }
    return Either.ofRight({
        kind,
        ...(typeof value.targetRoomId === 'string' ? { targetRoomId: value.targetRoomId } : {}),
        ...(typeof value.targetPlayerId === 'string' ? { targetPlayerId: value.targetPlayerId } : {})
    });
}

function decodeCappedString(value: unknown, field: string, maxLength: number): Either<string, string> {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return Either.ofLeft(`${field} must be a non-empty string.`);
    }
    return value.length > maxLength ? Either.ofLeft(`${field} is too long.`) : Either.ofRight(value);
}

function decodeConfidence(value: unknown): RelicPlanningAiConfidence | undefined {
    return typeof value === 'string'
        ? RELIC_PLANNING_AI_CONFIDENCES.find((confidence) => confidence === value)
        : undefined;
}

function decodeRelicActionKind(value: unknown): RelicActionKind | undefined {
    return typeof value === 'string' ? RELIC_ACTION_KINDS.find((kind) => kind === value) : undefined;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, RallarAiJsonValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
