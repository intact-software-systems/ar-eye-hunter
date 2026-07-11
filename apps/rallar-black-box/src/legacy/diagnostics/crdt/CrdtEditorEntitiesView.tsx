import {
    addCrdtEditorEntityBatch,
    addCrdtEditorEntityScoreBatch,
    changeCrdtEditorEntityHealthBatch,
    crdtEditorOperationGroupId,
    setCrdtEditorCooldownMinBatch,
    updateCrdtEditorEntityBatch,
} from '../../../crdt-editor.ts';
import type { CrdtEditorControllerModel } from './use-crdt-editor-controller.ts';

export function CrdtEditorEntitiesView({
    model,
}: Readonly<{ model: CrdtEditorControllerModel }>) {
    const {
        entityId,
        setEntityId,
        entityType,
        setEntityType,
        entityX,
        setEntityX,
        entityY,
        setEntityY,
        entityStatus,
        setEntityStatus,
        entityDelta,
        setEntityDelta,
        cooldownMin,
        setCooldownMin,
        opened,
        value,
        health,
        entities,
        applyBatch,
    } = model;
    return (
        <section className="crdt-editor-workbench">
            <div className="form-grid">
                <label>
                    Entity id
                    <input
                        value={entityId}
                        onChange={(event) => setEntityId(event.target.value)}
                    />
                </label>
                <label>
                    Type
                    <input
                        value={entityType}
                        onChange={(event) => setEntityType(event.target.value)}
                    />
                </label>
                <label>
                    X
                    <input
                        type="number"
                        value={entityX}
                        onChange={(event) =>
                            setEntityX(Number(event.target.value))
                        }
                    />
                </label>
                <label>
                    Y
                    <input
                        type="number"
                        value={entityY}
                        onChange={(event) =>
                            setEntityY(Number(event.target.value))
                        }
                    />
                </label>
                <label>
                    Status
                    <input
                        value={entityStatus}
                        onChange={(event) =>
                            setEntityStatus(event.target.value)
                        }
                    />
                </label>
                <label>
                    Delta
                    <input
                        type="number"
                        value={entityDelta}
                        onChange={(event) =>
                            setEntityDelta(Number(event.target.value))
                        }
                    />
                </label>
                <label>
                    Cooldown min
                    <input
                        type="number"
                        value={cooldownMin}
                        onChange={(event) =>
                            setCooldownMin(Number(event.target.value))
                        }
                    />
                </label>
            </div>
            <div className="button-row">
                <button
                    type="button"
                    disabled={!opened || !entityId.trim()}
                    onClick={() =>
                        void applyBatch(
                            'add-entity',
                            addCrdtEditorEntityBatch({
                                entityId,
                                type: entityType,
                                x: entityX,
                                y: entityY,
                                operationGroupId:
                                    crdtEditorOperationGroupId('add-entity'),
                            }),
                        )
                    }
                >
                    Add Entity
                </button>
                <button
                    type="button"
                    disabled={!opened || !entityId.trim()}
                    onClick={() =>
                        void applyBatch(
                            'update-entity',
                            updateCrdtEditorEntityBatch({
                                entityId,
                                x: entityX,
                                y: entityY,
                                status: entityStatus,
                                operationGroupId:
                                    crdtEditorOperationGroupId('update-entity'),
                            }),
                        )
                    }
                >
                    Update Entity
                </button>
                <button
                    type="button"
                    disabled={!opened || !entityId.trim()}
                    onClick={() =>
                        void applyBatch(
                            'entity-health',
                            changeCrdtEditorEntityHealthBatch({
                                entityId,
                                delta: entityDelta,
                                operationGroupId:
                                    crdtEditorOperationGroupId('entity-health'),
                            }),
                        )
                    }
                >
                    Health Delta
                </button>
                <button
                    type="button"
                    disabled={!opened || !entityId.trim()}
                    onClick={() =>
                        void applyBatch(
                            'entity-score',
                            addCrdtEditorEntityScoreBatch({
                                entityId,
                                delta: entityDelta,
                                operationGroupId:
                                    crdtEditorOperationGroupId('entity-score'),
                            }),
                        )
                    }
                >
                    Add Score
                </button>
                <button
                    type="button"
                    disabled={!opened || !entityId.trim()}
                    onClick={() =>
                        void applyBatch(
                            'entity-cooldown-min',
                            setCrdtEditorCooldownMinBatch({
                                entityId,
                                value: cooldownMin,
                                operationGroupId:
                                    crdtEditorOperationGroupId('cooldown-min'),
                            }),
                        )
                    }
                >
                    Min Cooldown
                </button>
            </div>
            <div className="table-shell">
                <table>
                    <thead>
                        <tr>
                            <th>Entity</th>
                            <th>Type</th>
                            <th>Position</th>
                            <th>Status</th>
                            <th>Health</th>
                            <th>Score</th>
                        </tr>
                    </thead>
                    <tbody>
                        {entities.map((entity) => (
                            <tr
                                key={entity.id}
                                className={
                                    entity.id === entityId ? 'selected' : ''
                                }
                                onClick={() => {
                                    setEntityId(entity.id);
                                    setEntityType(entity.type);
                                    setEntityX(entity.x);
                                    setEntityY(entity.y);
                                    setEntityStatus(entity.status);
                                }}
                            >
                                <td>{entity.id}</td>
                                <td>{entity.type}</td>
                                <td>
                                    {entity.x}, {entity.y}
                                </td>
                                <td>{entity.status}</td>
                                <td>{entity.health}</td>
                                <td>{entity.score}</td>
                            </tr>
                        ))}
                        {entities.length === 0 && (
                            <tr>
                                <td colSpan={6}>No entities.</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
