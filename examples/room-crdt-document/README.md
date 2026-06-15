# Room CRDT Document

Use Rallar CRDT for collaborative authored state such as checklists, plans, or
review notes. Do not use it for competitive live match truth.

```ts
import { rallar } from '@shared-web/browser/rallar.ts';

type Checklist = {
    items?: Record<string, { text: string; done: boolean }>;
};

const doc = await rallar.crdt.open<Checklist>('room-checklist', {
    documentType: 'checklist',
    documentId: currentRoom.group.groupId,
    scope: {
        kind: 'room',
        roomRef: currentRoom.group,
    },
    transport: 'ws-then-rtc',
    initialValue: { items: {} },
});

doc.subscribe((snapshot) => {
    renderChecklist(snapshot.value.items ?? {});
});

const itemId = crypto.randomUUID();
await doc.applyLocal({
    kind: 'batch',
    operations: [
        {
            kind: 'map.set',
            path: ['items', itemId],
            value: { text: 'Check north entrance', done: false },
        },
    ],
});

await doc.applyLocal({
    kind: 'batch',
    operations: [
        {
            kind: 'map.set',
            path: ['items', itemId, 'done'],
            value: true,
        },
    ],
});

const health = doc.health();
renderCrdtHealth(health);
```

Use `roomRef` instead of a bare room ID when a browser can work across multiple
applications or workspaces.

