import {
    addCrdtEditorCardBatch,
    addCrdtEditorColumnBatch,
    addCrdtEditorTagBatch,
    crdtEditorOperationGroupId,
    deleteCrdtEditorCardBatch,
    moveCrdtEditorCardBatch,
    removeCrdtEditorTagBatch,
    renameCrdtEditorColumnBatch,
    updateCrdtEditorCardStatusBatch
} from '../../../crdt-editor.ts';
import type { CrdtEditorControllerModel } from './use-crdt-editor-controller.ts';

export function CrdtEditorBoardView({
    model
}: Readonly<{ model: CrdtEditorControllerModel; }>) {
    const {
        newColumnTitle,
        setNewColumnTitle,
        newCardTitle,
        setNewCardTitle,
        selectedColumnId,
        setSelectedColumnId,
        selectedCardId,
        setSelectedCardId,
        cardStatus,
        setCardStatus,
        tagLabel,
        setTagLabel,
        busyAction,
        opened,
        value,
        columns,
        selectedColumn,
        selectedCard,
        applyBatch
    } = model;
    return (
        <section className="crdt-editor-workbench">
            <div className="form-grid">
                <label>
                    Column
                    <select
                        value={selectedColumnId}
                        onChange={(event) => setSelectedColumnId(event.target.value)}
                    >
                        {columns.map((column) => (
                            <option key={column.id} value={column.id}>
                                {column.title}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Card
                    <select
                        value={selectedCardId}
                        onChange={(event) => setSelectedCardId(event.target.value)}
                    >
                        {columns.flatMap((column) =>
                            column.cards.map((card) => (
                                <option key={card.id} value={card.id}>
                                    {card.title}
                                </option>
                            ))
                        )}
                    </select>
                </label>
                <label>
                    New column
                    <input
                        value={newColumnTitle}
                        onChange={(event) => setNewColumnTitle(event.target.value)}
                    />
                </label>
                <label>
                    New card
                    <input
                        value={newCardTitle}
                        onChange={(event) => setNewCardTitle(event.target.value)}
                    />
                </label>
                <label>
                    Card status
                    <input
                        value={cardStatus}
                        onChange={(event) => setCardStatus(event.target.value)}
                    />
                </label>
                <label>
                    Tag
                    <input
                        value={tagLabel}
                        onChange={(event) => setTagLabel(event.target.value)}
                    />
                </label>
            </div>
            <div className="button-row">
                <button
                    type="button"
                    disabled={!opened || Boolean(busyAction)}
                    onClick={() => {
                        const columnId = `column-${Date.now()}`;
                        setSelectedColumnId(columnId);
                        void applyBatch(
                            'add-column',
                            addCrdtEditorColumnBatch({
                                columnId,
                                title: newColumnTitle,
                                positionId: `${columnId}@${Date.now()}`,
                                operationGroupId: crdtEditorOperationGroupId('add-column')
                            })
                        );
                    }}
                >
                    Add Column
                </button>
                <button
                    type="button"
                    disabled={!opened || !selectedColumn || Boolean(busyAction)}
                    onClick={() =>
                        void applyBatch(
                            'rename-column',
                            renameCrdtEditorColumnBatch({
                                columnId: selectedColumnId,
                                title: newColumnTitle,
                                operationGroupId: crdtEditorOperationGroupId('rename-column')
                            })
                        )}
                >
                    Rename Column
                </button>
                <button
                    type="button"
                    disabled={!opened || !selectedColumn || Boolean(busyAction)}
                    onClick={() => {
                        const cardId = `card-${Date.now()}`;
                        setSelectedCardId(cardId);
                        void applyBatch(
                            'add-card',
                            addCrdtEditorCardBatch({
                                columnId: selectedColumnId,
                                cardId,
                                title: newCardTitle,
                                positionId: `${cardId}@${Date.now()}`,
                                operationGroupId: crdtEditorOperationGroupId('add-card')
                            })
                        );
                    }}
                >
                    Add Card
                </button>
                <button
                    type="button"
                    disabled={!opened || !selectedCard}
                    onClick={() =>
                        void applyBatch(
                            'move-card',
                            moveCrdtEditorCardBatch({
                                columnId: selectedColumnId,
                                cardId: selectedCardId,
                                positionId: `${selectedCardId}@${Date.now()}`,
                                operationGroupId: crdtEditorOperationGroupId('move-card')
                            })
                        )}
                >
                    Move Card
                </button>
                <button
                    type="button"
                    disabled={!opened || !selectedCard}
                    onClick={() =>
                        void applyBatch(
                            'set-card-status',
                            updateCrdtEditorCardStatusBatch({
                                cardId: selectedCardId,
                                status: cardStatus,
                                operationGroupId: crdtEditorOperationGroupId('card-status')
                            })
                        )}
                >
                    Set Status
                </button>
                <button
                    type="button"
                    disabled={!opened || !selectedCard}
                    onClick={() =>
                        void applyBatch(
                            'delete-card',
                            deleteCrdtEditorCardBatch({
                                columnId: selectedColumnId,
                                cardId: selectedCardId,
                                operationGroupId: crdtEditorOperationGroupId('delete-card')
                            })
                        )}
                >
                    Delete Card
                </button>
                <button
                    type="button"
                    disabled={!opened || !tagLabel.trim()}
                    onClick={() => {
                        const tagId = `tag-${tagLabel.trim().toLowerCase().replaceAll(/\s+/g, '-')}`;
                        void applyBatch(
                            'add-tag',
                            addCrdtEditorTagBatch({
                                tagId,
                                label: tagLabel,
                                operationGroupId: crdtEditorOperationGroupId('add-tag')
                            })
                        );
                    }}
                >
                    Add Tag
                </button>
                <button
                    type="button"
                    disabled={!opened || !tagLabel.trim()}
                    onClick={() => {
                        const tagId = `tag-${tagLabel.trim().toLowerCase().replaceAll(/\s+/g, '-')}`;
                        void applyBatch(
                            'remove-tag',
                            removeCrdtEditorTagBatch({
                                tagId,
                                operationGroupId: crdtEditorOperationGroupId('remove-tag')
                            })
                        );
                    }}
                >
                    Remove Tag
                </button>
            </div>
            <div className="crdt-board-preview">
                {columns.map((column) => (
                    <section key={column.id} className="crdt-board-column">
                        <h4>{column.title}</h4>
                        {column.cards.map((card) => (
                            <button
                                key={card.id}
                                type="button"
                                className={selectedCardId === card.id
                                    ? 'crdt-card selected'
                                    : 'crdt-card'}
                                onClick={() => {
                                    setSelectedColumnId(column.id);
                                    setSelectedCardId(card.id);
                                }}
                            >
                                <strong>{card.title}</strong>
                                <span>{card.status}</span>
                            </button>
                        ))}
                        {column.cards.length === 0 && <span className="muted">No cards</span>}
                    </section>
                ))}
            </div>
        </section>
    );
}
