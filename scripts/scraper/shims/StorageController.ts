// Reemplazo de engine/StorageController.ts: CapiUploader no guarda listas ni marcadores.
export const enum Store {
    Settings = 'Settings',
    Bookmarks = 'Bookmarks',
    Itemflags = 'Itemflags',
    TagManager = 'CustomTags',
    MediaLists = 'MediaLists',
}

export interface StorageController {
    SavePersistent<T>(value: T, store: Store, key?: string): Promise<void>;
    LoadPersistent<T>(store: Store, key?: string): Promise<T>;
    RemovePersistent(store: Store, ...keys: string[]): Promise<void>;
    SaveTemporary<T>(value: T): Promise<string>;
    LoadTemporary<T>(key: string): Promise<T>;
    RemoveTemporary(...keys: string[]): Promise<void>;
}

const memory = new Map<string, unknown>();

export function CreateStorageController(): StorageController {
    return {
        async SavePersistent(value, store, key = '') { memory.set(`${store}:${key}`, value); },
        async LoadPersistent<T>(store, key = '') { return memory.get(`${store}:${key}`) as T; },
        async RemovePersistent(store, ...keys) { keys.forEach(key => memory.delete(`${store}:${key}`)); },
        async SaveTemporary(value) { const key = Math.random().toString(36).slice(2); memory.set(`tmp:${key}`, value); return key; },
        async LoadTemporary<T>(key) { return memory.get(`tmp:${key}`) as T; },
        async RemoveTemporary(...keys) { keys.forEach(key => memory.delete(`tmp:${key}`)); },
    };
}

export function SanitizeFileName(name: string): string {
    return name.replace(/[<>:"/\|?*~]/g, ' ').trim();
}
