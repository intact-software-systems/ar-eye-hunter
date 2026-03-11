import {
    IDBCursor,
    IDBCursorWithValue,
    IDBDatabase,
    IDBFactory,
    IDBIndex,
    IDBKeyRange,
    IDBObjectStore,
    IDBOpenDBRequest,
    IDBRequest,
    IDBTransaction,
    IDBVersionChangeEvent,
    indexedDB,
} from 'fake-indexeddb';

Object.assign(
    globalThis,
    {
        indexedDB,
        IDBCursor,
        IDBCursorWithValue,
        IDBDatabase,
        IDBFactory,
        IDBIndex,
        IDBKeyRange,
        IDBObjectStore,
        IDBOpenDBRequest,
        IDBRequest,
        IDBTransaction,
        IDBVersionChangeEvent,
    },
);
