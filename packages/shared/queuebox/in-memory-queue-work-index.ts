import type { ResourceInboxWorkPage } from './queue-box-types.ts';
import { validateResourceInboxWorkPageRequest } from './resource-entry-observations.ts';
import type { ResourceEntry } from './ResourceEntry.ts';

export namespace InMemoryQueueWorkIndex {
    export interface Node {
        readonly key: string;
        readonly height: number;
        readonly left: Node | null;
        readonly right: Node | null;
    }

    export interface Page {
        readonly keys: readonly string[];
        readonly nextCursor: ResourceInboxWorkPage.Cursor | null;
    }
}

/** An index of queue-owned keys; message values remain in InMemoryQueueBox. */
export class InMemoryQueueWorkIndex {
    private readonly rootsByTypeAndStatus = new Map<string, InMemoryQueueWorkIndex.Node>();

    read(request: ResourceInboxWorkPage.Request): InMemoryQueueWorkIndex.Page {
        const validated = validateResourceInboxWorkPageRequest(request);
        if (validated.left) {
            throw validated.left;
        }
        const root = this.rootsByTypeAndStatus.get(JSON.stringify([request.typeId, request.status])) ?? null;
        const selected = readQueueWorkKeys(root, request.cursor?.position, request.maxToRead);
        return {
            keys: selected,
            nextCursor: selected.length === request.maxToRead
                ? { typeId: request.typeId, status: request.status, position: selected[selected.length - 1] }
                : null
        };
    }

    replace(key: string, previous: ResourceEntry | undefined, entry: ResourceEntry): void {
        if (previous?.typeId === entry.typeId && previous?.status === entry.status) {
            return;
        }
        this.remove(key, previous);
        const scope = JSON.stringify([entry.typeId, entry.status]);
        const root = this.rootsByTypeAndStatus.get(scope) ?? null;
        this.rootsByTypeAndStatus.set(scope, insertQueueWorkKey(root, key));
    }

    remove(key: string, entry: ResourceEntry | undefined): void {
        if (entry === undefined) {
            return;
        }
        const scope = JSON.stringify([entry.typeId, entry.status]);
        const root = removeQueueWorkKey(this.rootsByTypeAndStatus.get(scope) ?? null, key);
        if (root === null) {
            this.rootsByTypeAndStatus.delete(scope);
        }
        else {
            this.rootsByTypeAndStatus.set(scope, root);
        }
    }
}

/** AVL updates rebuild only the search path; unrelated queue keys never move. */
function insertQueueWorkKey(root: InMemoryQueueWorkIndex.Node | null, key: string): InMemoryQueueWorkIndex.Node {
    if (root === null) {
        return createQueueWorkNode(key, null, null);
    }
    if (key === root.key) {
        return root;
    }
    return balanceQueueWorkNode(
        key < root.key
            ? createQueueWorkNode(root.key, insertQueueWorkKey(root.left, key), root.right)
            : createQueueWorkNode(root.key, root.left, insertQueueWorkKey(root.right, key))
    );
}

function removeQueueWorkKey(root: InMemoryQueueWorkIndex.Node | null, key: string): InMemoryQueueWorkIndex.Node | null {
    if (root === null) {
        return null;
    }
    if (key < root.key) {
        return balanceQueueWorkNode(createQueueWorkNode(root.key, removeQueueWorkKey(root.left, key), root.right));
    }
    if (key > root.key) {
        return balanceQueueWorkNode(createQueueWorkNode(root.key, root.left, removeQueueWorkKey(root.right, key)));
    }
    if (root.left === null || root.right === null) {
        return root.left ?? root.right;
    }
    let successor = root.right;
    while (successor.left !== null) {
        successor = successor.left;
    }
    return balanceQueueWorkNode(
        createQueueWorkNode(successor.key, root.left, removeQueueWorkKey(root.right, successor.key))
    );
}

function createQueueWorkNode(
    key: string,
    left: InMemoryQueueWorkIndex.Node | null,
    right: InMemoryQueueWorkIndex.Node | null
): InMemoryQueueWorkIndex.Node {
    return { key, left, right, height: 1 + Math.max(left?.height ?? 0, right?.height ?? 0) };
}

function balanceQueueWorkNode(root: InMemoryQueueWorkIndex.Node): InMemoryQueueWorkIndex.Node {
    const difference = (root.left?.height ?? 0) - (root.right?.height ?? 0);
    if (difference > 1) {
        const left = root.left!;
        return rotateQueueWorkRight(
            (left.left?.height ?? 0) >= (left.right?.height ?? 0)
                ? root
                : createQueueWorkNode(root.key, rotateQueueWorkLeft(left), root.right)
        );
    }
    if (difference < -1) {
        const right = root.right!;
        return rotateQueueWorkLeft(
            (right.right?.height ?? 0) >= (right.left?.height ?? 0)
                ? root
                : createQueueWorkNode(root.key, root.left, rotateQueueWorkRight(right))
        );
    }
    return root;
}

function rotateQueueWorkLeft(root: InMemoryQueueWorkIndex.Node): InMemoryQueueWorkIndex.Node {
    const right = root.right!;
    return createQueueWorkNode(right.key, createQueueWorkNode(root.key, root.left, right.left), right.right);
}

function rotateQueueWorkRight(root: InMemoryQueueWorkIndex.Node): InMemoryQueueWorkIndex.Node {
    const left = root.left!;
    return createQueueWorkNode(left.key, left.left, createQueueWorkNode(root.key, left.right, root.right));
}

function readQueueWorkKeys(
    root: InMemoryQueueWorkIndex.Node | null,
    after: string | undefined,
    maxToRead: number
): readonly string[] {
    const path: InMemoryQueueWorkIndex.Node[] = [];
    const keys: string[] = [];
    let current = root;
    while (current !== null || path.length > 0) {
        while (current !== null) {
            if (after === undefined || current.key > after) {
                path.push(current);
                current = current.left;
            }
            else {
                current = current.right;
            }
        }
        const next = path.pop();
        if (next === undefined) {
            break;
        }
        keys.push(next.key);
        if (keys.length === maxToRead) {
            break;
        }
        current = next.right;
    }
    return keys;
}
