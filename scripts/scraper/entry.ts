/**
 * Puente entre CapiUploader y el motor de sitios de HaruNeko.
 *
 * Se compila junto con los sitios (scripts/build-scraper.mjs) y corre en una ventana oculta.
 * El proceso principal manda órdenes por «scrape:cmd» y recibe las respuestas por «scrape:reply».
 */
// Extensiones globales que usan los sitios (como en web/src/index.ts de HaruNeko).
import '@engine/ArrayExtensions';
import '@engine/RegExpSafe';
import * as websites from '@engine/websites/_index';
import { SettingsManager } from '@engine/SettingsManager';
import { CreateStorageController } from '@engine/StorageController';
import { Priority } from '@engine/taskpool/DeferredTask';
import type { MangaScraper, MangaPlugin, Manga, Chapter, Page } from '@engine/providers/MangaPlugin';
import { CreateGenericScraper, DetectGenericTheme, GenericThemeTitle, type GenericTheme } from './generic';

type IpcBridge = {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => void;
    send: (channel: string, ...args: unknown[]) => void;
};
const ipc = (globalThis as unknown as { ipcRenderer: IpcBridge }).ipcRenderer;

// Ajustes globales que lee el motor al reconstruir imágenes desordenadas.
const globalSettings: Record<string, unknown> = {
    'descrambling-format': 'image/jpeg',
    'descrambling-quality': 95,
};
(globalThis as unknown as Record<string, unknown>).HakuNeko = {
    SettingsManager: { OpenScope: () => ({ Get: (key: string) => ({ Value: globalSettings[key] }) }) },
};

const storage = CreateStorageController();
const settingsManager = new SettingsManager(storage);
const scrapers: MangaScraper[] = Object.values(websites).map((Website) => new (Website as unknown as new () => MangaScraper)());
const plugins = new Map<string, MangaPlugin>();

function pluginFor(scraper: MangaScraper): MangaPlugin {
    let plugin = plugins.get(scraper.Identifier);
    if (!plugin) {
        plugin = scraper.CreatePlugin(storage, settingsManager);
        plugins.set(scraper.Identifier, plugin);
    }
    return plugin;
}

const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
// «Tags_Language_Spanish» → «spanish»
const languageTags = (tags: ReadonlyArray<{ Category: unknown, Title: unknown }>) => tags
    .filter((tag) => String(tag.Category) === 'Tags_Language')
    .map((tag) => String(tag.Title).replace(/^Tags_Language_/, '').toLowerCase());
const languages = (scraper: MangaScraper) => languageTags(scraper.Tags);

function describe(scraper: MangaScraper) {
    return { id: scraper.Identifier, title: scraper.Title, url: scraper.URI.href, icon: scraper.Icon, languages: languages(scraper) };
}

const matching = (url: string) => scrapers.filter((s) => { try { return s.ValidateMangaURL(url); } catch { return false; } });

// Lectores genéricos ya creados, por id («generic-madara:sitio.com»).
const generics = new Map<string, MangaScraper>();
function genericFor(theme: GenericTheme, url: string): MangaScraper {
    const scraper = CreateGenericScraper(theme, url) as unknown as MangaScraper;
    const existing = generics.get(scraper.Identifier);
    if (existing) return existing;
    generics.set(scraper.Identifier, scraper);
    return scraper;
}

// Obras abiertas: cada consulta guarda sus objetos para pedir después capítulos, páginas e imágenes.
const mangas = new Map<string, { scraper: MangaScraper, manga: Manga, chapters: Chapter[], pages: Map<number, Page[]> }>();
let seq = 0;

const commands = {
    info() {
        return { websites: scrapers.length };
    },

    /**
     * Sitios del catálogo que reconocen la URL como obra. Si ninguno la reconoce: los sitios del
     * mismo dominio (la URL no es de una obra) o, si el dominio no está, el tema que use la web.
     */
    async identify(url: string) {
        const matches = matching(url);
        const host = hostOf(url);
        const sameHost = matches.length ? [] : scrapers.filter((s) => hostOf(s.URI.href) === host);
        let generic = null;
        if (!matches.length && !sameHost.length) {
            const theme = await DetectGenericTheme(url).catch(() => null);
            if (theme) generic = { ...describe(genericFor(theme, url)), theme, template: GenericThemeTitle[theme] };
        }
        return { matches: matches.map(describe), sameHost: sameHost.map(describe), generic };
    },

    async manga(url: string, websiteId?: string) {
        const scraper = generics.get(websiteId) ?? scrapers.find((s) => s.Identifier === websiteId) ?? matching(url)[0];
        if (!scraper) throw new Error('Este sitio no está soportado.');
        const manga = await pluginFor(scraper).TryGetEntry(url);
        if (!manga) throw new Error('No se encontró la obra en ese enlace.');
        await manga.Update();
        const chapters = [...manga.Entries.Value];
        const key = `m${++seq}`;
        mangas.set(key, { scraper, manga, chapters, pages: new Map() });
        return {
            key,
            title: manga.Title,
            website: describe(scraper),
            // Algunos sitios (p. ej. MangaDex) mezclan traducciones: cada capítulo trae sus idiomas.
            chapters: chapters.map((c, index) => ({ index, id: c.Identifier, title: c.Title, languages: languageTags(c.Tags.Value) })),
        };
    },

    async pages(key: string, index: number) {
        const entry = mangas.get(key);
        const chapter = entry?.chapters[index];
        if (!chapter) throw new Error('El capítulo ya no está disponible. Vuelve a buscar la obra.');
        await chapter.Update();
        const pages = [...chapter.Entries.Value] as Page[];
        entry.pages.set(index, pages);
        return { count: pages.length };
    },

    async image(key: string, index: number, page: number, signal: AbortSignal) {
        const target = mangas.get(key)?.pages.get(index)?.[page];
        if (!target) throw new Error('La página ya no está disponible.');
        const blob = await target.Fetch(Priority.High, signal);
        return new Uint8Array(await blob.arrayBuffer());
    },

    /**
     * Convierte una imagen (WEBP, AVIF, PNG, GIF…) a JPG o PNG con el decodificador del navegador.
     * En JPG las transparencias quedan sobre blanco. Usado por «Descargar».
     */
    async convert(bytes: Uint8Array, format: 'jpg' | 'png', quality: number) {
        const bitmap = await createImageBitmap(new Blob([bytes]));
        try {
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext('2d');
            if (format === 'jpg') {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, bitmap.width, bitmap.height);
            }
            ctx.drawImage(bitmap, 0, 0);
            const blob = await canvas.convertToBlob(format === 'jpg' ? { type: 'image/jpeg', quality } : { type: 'image/png' });
            return new Uint8Array(await blob.arrayBuffer());
        } finally {
            bitmap.close();
        }
    },

    release(key: string) {
        mangas.delete(key);
        return true;
    },
};

const running = new Map<number, AbortController>();

ipc.on('scrape:cmd', async (_event, message) => {
    const { id, method, args = [] } = message as { id: number, method: keyof typeof commands, args: unknown[] };
    const controller = new AbortController();
    running.set(id, controller);
    try {
        const fn = commands[method] as (...a: unknown[]) => unknown;
        if (!fn) throw new Error(`Orden desconocida: ${String(method)}`);
        const data = await fn(...args, controller.signal);
        ipc.send('scrape:reply', { id, ok: true, data });
    } catch (error) {
        ipc.send('scrape:reply', { id, ok: false, error: { message: (error as Error)?.message || String(error), name: (error as Error)?.name } });
    } finally {
        running.delete(id);
    }
});

ipc.on('scrape:abort', (_event, id) => running.get(id as number)?.abort());

ipc.send('scrape:ready', { websites: scrapers.length });
