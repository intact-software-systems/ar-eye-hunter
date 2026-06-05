import type {
    RallarCrdtJsonValue,
    RallarCrdtOperation,
    RallarCrdtOperationBatch,
    RallarCrdtPath,
} from '@shared/crdt/crdt-types.ts';

export const CRDT_EDITOR_TRANSPORTS = [
    'local-only',
    'ws',
    'rtc',
    'ws-then-rtc',
    'rtc-with-ws-fallback',
] as const;

export type CrdtEditorTransport = (typeof CRDT_EDITOR_TRANSPORTS)[number];

export type CrdtEditorView = 'board' | 'entities';

export type CrdtEditorCard = Readonly<{
    id: string;
    title: string;
    status: string;
}>;

export type CrdtEditorColumn = Readonly<{
    id: string;
    title: string;
    cards: readonly CrdtEditorCard[];
}>;

export type CrdtEditorEntity = Readonly<{
    id: string;
    type: string;
    x: number;
    y: number;
    status: string;
    health: number;
    score: number;
}>;

export type CrdtEditorValue = Readonly<{
    columns?: readonly CrdtEditorColumn[];
    entities?: readonly CrdtEditorEntity[];
    tags?: readonly unknown[];
    counters?: Readonly<Record<string, unknown>>;
    records?: Readonly<Record<string, unknown>>;
}>;

const BOARD_COLUMNS_PATH = ['columns'] as const;
const ENTITIES_PATH = ['entities'] as const;
const TAGS_PATH = ['tags'] as const;

export function createCrdtEditorInitialValue(): CrdtEditorValue {
    return {
        columns: [
            {
                id: 'column-backlog',
                title: 'Backlog',
                cards: [
                    {
                        id: 'card-first',
                        title: 'First collaborative task',
                        status: 'open',
                    },
                ],
            },
            {
                id: 'column-playing',
                title: 'In Play',
                cards: [],
            },
        ],
        entities: [
            {
                id: 'entity-player-1',
                type: 'player',
                x: 2,
                y: 3,
                status: 'ready',
                health: 100,
                score: 0,
            },
        ],
        tags: [],
        counters: {},
        records: {},
    };
}

export function crdtEditorOperationGroupId(action: string): string {
    return `crdt-editor-${action}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;
}

export function createCrdtEditorBatch(
    operationGroupId: string,
    operations: readonly RallarCrdtOperation[],
): RallarCrdtOperationBatch {
    return {
        kind: 'batch',
        operationGroupId,
        operations,
    };
}

export function addCrdtEditorColumnBatch(input: Readonly<{
    columnId: string;
    title: string;
    positionId: string;
    operationGroupId: string;
}>): RallarCrdtOperationBatch {
    return createCrdtEditorBatch(input.operationGroupId, [
        {
            kind: 'sequence.insert',
            path: BOARD_COLUMNS_PATH,
            elementId: input.columnId,
            positionId: input.positionId,
            value: {
                id: input.columnId,
                title: input.title,
                cards: [],
            },
        },
    ]);
}

export function renameCrdtEditorColumnBatch(input: Readonly<{
    columnId: string;
    title: string;
    operationGroupId: string;
}>): RallarCrdtOperationBatch {
    return createCrdtEditorBatch(input.operationGroupId, [
        registerSet(['records', 'columns', input.columnId, 'title'], input.title),
    ]);
}

export function addCrdtEditorCardBatch(input: Readonly<{
    columnId: string;
    cardId: string;
    title: string;
    positionId: string;
    operationGroupId: string;
}>): RallarCrdtOperationBatch {
    return createCrdtEditorBatch(input.operationGroupId, [
        {
            kind: 'sequence.insert',
            path: ['columns', input.columnId, 'cards'],
            elementId: input.cardId,
            positionId: input.positionId,
            value: {
                id: input.cardId,
                title: input.title,
                status: 'open',
            },
        },
        {
            kind: 'map.set',
            path: ['records', 'cards'],
            key: input.cardId,
            value: {
                id: input.cardId,
                columnId: input.columnId,
                title: input.title,
                status: 'open',
            },
        },
    ]);
}

export function moveCrdtEditorCardBatch(input: Readonly<{
    columnId: string;
    cardId: string;
    positionId: string;
    operationGroupId: string;
}>): RallarCrdtOperationBatch {
    return createCrdtEditorBatch(input.operationGroupId, [
        {
            kind: 'sequence.move',
            path: ['columns', input.columnId, 'cards'],
            elementId: input.cardId,
            positionId: input.positionId,
            observedUpdateIds: [],
        },
    ]);
}

export function deleteCrdtEditorCardBatch(input: Readonly<{
    columnId: string;
    cardId: string;
    operationGroupId: string;
}>): RallarCrdtOperationBatch {
    return createCrdtEditorBatch(input.operationGroupId, [
        {
            kind: 'sequence.delete',
            path: ['columns', input.columnId, 'cards'],
            elementId: input.cardId,
            observedUpdateIds: [],
        },
        {
            kind: 'map.delete',
            path: ['records', 'cards'],
            key: input.cardId,
            observedUpdateIds: [],
        },
    ]);
}

export function updateCrdtEditorCardStatusBatch(input: Readonly<{
    cardId: string;
    status: string;
    operationGroupId: string;
}>): RallarCrdtOperationBatch {
    return createCrdtEditorBatch(input.operationGroupId, [
        registerSet(['records', 'cards', input.cardId, 'status'], input.status),
    ]);
}

export function addCrdtEditorTagBatch(input: Readonly<{
    tagId: string;
    label: string;
    operationGroupId: string;
}>): RallarCrdtOperationBatch {
    return createCrdtEditorBatch(input.operationGroupId, [
        {
            kind: 'orset.add',
            path: TAGS_PATH,
            elementId: input.tagId,
            value: {
                id: input.tagId,
                label: input.label,
            },
        },
    ]);
}

export function removeCrdtEditorTagBatch(input: Readonly<{
    tagId: string;
    operationGroupId: string;
}>): RallarCrdtOperationBatch {
    return createCrdtEditorBatch(input.operationGroupId, [
        {
            kind: 'orset.remove',
            path: TAGS_PATH,
            elementId: input.tagId,
            observedAddUpdateIds: [],
        },
    ]);
}

export function addCrdtEditorEntityBatch(input: Readonly<{
    entityId: string;
    type: string;
    x: number;
    y: number;
    operationGroupId: string;
}>): RallarCrdtOperationBatch {
    return createCrdtEditorBatch(input.operationGroupId, [
        {
            kind: 'sequence.insert',
            path: ENTITIES_PATH,
            elementId: input.entityId,
            positionId: `${input.entityId}@${Date.now()}`,
            value: {
                id: input.entityId,
                type: input.type,
                x: input.x,
                y: input.y,
                status: 'idle',
                health: 100,
                score: 0,
            },
        },
        {
            kind: 'map.set',
            path: ['records', 'entities'],
            key: input.entityId,
            value: {
                id: input.entityId,
                type: input.type,
                x: input.x,
                y: input.y,
                status: 'idle',
                health: 100,
                score: 0,
            },
        },
    ]);
}

export function updateCrdtEditorEntityBatch(input: Readonly<{
    entityId: string;
    x: number;
    y: number;
    status: string;
    operationGroupId: string;
}>): RallarCrdtOperationBatch {
    return createCrdtEditorBatch(input.operationGroupId, [
        registerSet(['records', 'entities', input.entityId, 'x'], input.x),
        registerSet(['records', 'entities', input.entityId, 'y'], input.y),
        registerSet(
            ['records', 'entities', input.entityId, 'status'],
            input.status,
        ),
    ]);
}

export function changeCrdtEditorEntityHealthBatch(input: Readonly<{
    entityId: string;
    delta: number;
    operationGroupId: string;
}>): RallarCrdtOperationBatch {
    return createCrdtEditorBatch(input.operationGroupId, [
        {
            kind: 'counter.add',
            path: ['records', 'entities', input.entityId, 'healthDelta'],
            delta: input.delta,
        },
    ]);
}

export function addCrdtEditorEntityScoreBatch(input: Readonly<{
    entityId: string;
    delta: number;
    operationGroupId: string;
}>): RallarCrdtOperationBatch {
    return createCrdtEditorBatch(input.operationGroupId, [
        {
            kind: 'counter.add',
            path: ['records', 'entities', input.entityId, 'score'],
            delta: input.delta,
        },
        {
            kind: 'number.max',
            path: ['records', 'entities', input.entityId, 'bestScore'],
            value: input.delta,
        },
    ]);
}

export function setCrdtEditorCooldownMinBatch(input: Readonly<{
    entityId: string;
    value: number;
    operationGroupId: string;
}>): RallarCrdtOperationBatch {
    return createCrdtEditorBatch(input.operationGroupId, [
        {
            kind: 'number.min',
            path: ['records', 'entities', input.entityId, 'cooldownMin'],
            value: input.value,
        },
    ]);
}

function registerSet(
    path: RallarCrdtPath,
    value: RallarCrdtJsonValue,
): RallarCrdtOperation {
    return {
        kind: 'register.set',
        path,
        value,
        policy: 'lww',
    };
}
