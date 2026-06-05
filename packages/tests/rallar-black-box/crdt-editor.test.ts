import { describe, expect, it } from 'vitest';
import {
    addCrdtEditorCardBatch,
    addCrdtEditorColumnBatch,
    addCrdtEditorEntityBatch,
    addCrdtEditorEntityScoreBatch,
    addCrdtEditorTagBatch,
    changeCrdtEditorEntityHealthBatch,
    createCrdtEditorInitialValue,
    deleteCrdtEditorCardBatch,
    moveCrdtEditorCardBatch,
    removeCrdtEditorTagBatch,
    renameCrdtEditorColumnBatch,
    setCrdtEditorCooldownMinBatch,
    updateCrdtEditorCardStatusBatch,
    updateCrdtEditorEntityBatch,
} from '../../../apps/rallar-black-box/src/crdt-editor.ts';

describe('rallar black-box CRDT editor helpers', () => {
    it('creates a board and entity seed value', () => {
        const value = createCrdtEditorInitialValue();

        expect(value.columns?.map((column) => column.id)).toEqual([
            'column-backlog',
            'column-playing',
        ]);
        expect(value.entities?.[0]).toMatchObject({
            id: 'entity-player-1',
            type: 'player',
            health: 100,
            score: 0,
        });
    });

    it('builds ordered-list board operations', () => {
        expect(
            addCrdtEditorColumnBatch({
                columnId: 'column-review',
                title: 'Review',
                positionId: 'column-review@1',
                operationGroupId: 'group-column',
            }),
        ).toMatchObject({
            kind: 'batch',
            operationGroupId: 'group-column',
            operations: [
                {
                    kind: 'sequence.insert',
                    path: ['columns'],
                    elementId: 'column-review',
                    positionId: 'column-review@1',
                },
            ],
        });

        expect(
            addCrdtEditorCardBatch({
                columnId: 'column-review',
                cardId: 'card-1',
                title: 'Test convergence',
                positionId: 'card-1@1',
                operationGroupId: 'group-card',
            }).operations.map((operation) => operation.kind),
        ).toEqual(['sequence.insert', 'map.set']);

        expect(
            moveCrdtEditorCardBatch({
                columnId: 'column-review',
                cardId: 'card-1',
                positionId: 'card-1@2',
                operationGroupId: 'group-move',
            }).operations[0],
        ).toMatchObject({
            kind: 'sequence.move',
            path: ['columns', 'column-review', 'cards'],
            observedUpdateIds: [],
        });

        expect(
            deleteCrdtEditorCardBatch({
                columnId: 'column-review',
                cardId: 'card-1',
                operationGroupId: 'group-delete',
            }).operations.map((operation) => operation.kind),
        ).toEqual(['sequence.delete', 'map.delete']);
    });

    it('builds register and OR-set operations for collaboration metadata', () => {
        expect(
            renameCrdtEditorColumnBatch({
                columnId: 'column-review',
                title: 'QA',
                operationGroupId: 'group-rename',
            }).operations[0],
        ).toMatchObject({
            kind: 'register.set',
            path: ['records', 'columns', 'column-review', 'title'],
            value: 'QA',
            policy: 'lww',
        });

        expect(
            updateCrdtEditorCardStatusBatch({
                cardId: 'card-1',
                status: 'done',
                operationGroupId: 'group-status',
            }).operations[0],
        ).toMatchObject({
            kind: 'register.set',
            path: ['records', 'cards', 'card-1', 'status'],
            value: 'done',
        });

        expect(
            addCrdtEditorTagBatch({
                tagId: 'tag-live',
                label: 'live',
                operationGroupId: 'group-add-tag',
            }).operations[0].kind,
        ).toBe('orset.add');

        expect(
            removeCrdtEditorTagBatch({
                tagId: 'tag-live',
                operationGroupId: 'group-remove-tag',
            }).operations[0],
        ).toMatchObject({
            kind: 'orset.remove',
            observedAddUpdateIds: [],
        });
    });

    it('builds lightweight game entity operations', () => {
        expect(
            addCrdtEditorEntityBatch({
                entityId: 'entity-2',
                type: 'npc',
                x: 1,
                y: 2,
                operationGroupId: 'group-add-entity',
            }).operations.map((operation) => operation.kind),
        ).toEqual(['sequence.insert', 'map.set']);

        expect(
            updateCrdtEditorEntityBatch({
                entityId: 'entity-2',
                x: 3,
                y: 4,
                status: 'moving',
                operationGroupId: 'group-update-entity',
            }).operations.map((operation) => operation.kind),
        ).toEqual(['register.set', 'register.set', 'register.set']);

        expect(
            changeCrdtEditorEntityHealthBatch({
                entityId: 'entity-2',
                delta: -5,
                operationGroupId: 'group-health',
            }).operations[0],
        ).toMatchObject({
            kind: 'counter.add',
            path: ['records', 'entities', 'entity-2', 'healthDelta'],
            delta: -5,
        });

        expect(
            addCrdtEditorEntityScoreBatch({
                entityId: 'entity-2',
                delta: 10,
                operationGroupId: 'group-score',
            }).operations.map((operation) => operation.kind),
        ).toEqual(['counter.add', 'number.max']);

        expect(
            setCrdtEditorCooldownMinBatch({
                entityId: 'entity-2',
                value: 2,
                operationGroupId: 'group-min',
            }).operations[0].kind,
        ).toBe('number.min');
    });
});
