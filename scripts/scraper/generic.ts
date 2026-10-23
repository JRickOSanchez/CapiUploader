/**
 * Lectores genéricos para webs que no están en el catálogo de HaruNeko pero usan uno de los temas
 * de WordPress más comunes entre los scans: Madara y MangaStream/MangaThemesia. Se arman con las
 * mismas plantillas de HaruNeko y prueban sus variantes en orden hasta que una funciona.
 */
import { Tags } from '@engine/Tags';
import { DecoratableMangaScraper, type Manga, type Chapter, type Page } from '@engine/providers/MangaPlugin';
import { FetchHTML, FetchWindowScript } from '@engine/platform/FetchProvider';
import * as Common from '@engine/websites/decorators/Common';
import * as Madara from '@engine/websites/decorators/WordPressMadara';
import * as MangaStream from '@engine/websites/decorators/WordPressMangaStream';

export type GenericTheme = 'madara' | 'mangastream';

export const GenericThemeTitle: Record<GenericTheme, string> = {
    madara: 'Madara (WordPress)',
    mangastream: 'MangaStream / Themesia (WordPress)',
};

/** Devuelve el primer resultado no vacío de las variantes, o el último error. */
async function firstNonEmpty<T>(attempts: Array<() => Promise<T[]>>): Promise<T[]> {
    let lastError: unknown = null;
    for (const attempt of attempts) {
        try {
            const result = await attempt();
            if (result?.length) return result;
        } catch (error) {
            lastError = error;
        }
    }
    if (lastError) throw lastError;
    return [];
}

function siteName(origin: string) {
    return new URL(origin).hostname.replace(/^www\./, '');
}

/** Como ChaptersMultiPageAJAX de HaruNeko: las listas largas vienen en páginas («?t=2»…). */
async function FetchMadaraChaptersPaged(this: DecoratableMangaScraper, manga: Manga): Promise<Chapter[]> {
    const { slug } = JSON.parse(manga.Identifier) as Madara.MangaID;
    const uri = new URL(`${slug}/ajax/chapters/`.replace(/\/+/g, '/'), this.URI);
    const all: Chapter[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 200; page++) {
        uri.searchParams.set('t', String(page));
        const chapters: Chapter[] = await Madara.FetchChaptersCSS.call(this, manga, new Request(uri, { method: 'POST', headers: { Referer: this.URI.href } }));
        const fresh = chapters.filter((c) => !seen.has(c.Identifier));
        if (!fresh.length) break;
        fresh.forEach((c) => seen.add(c.Identifier));
        all.push(...fresh);
    }
    return all;
}

@Madara.MangaCSS(/^{origin}\/[^?#]+$/)
@Common.ImageAjax()
class GenericMadara extends DecoratableMangaScraper {
    public constructor(origin: string) {
        super(`generic-madara:${siteName(origin)}`, siteName(origin), origin, Tags.Media.Manhwa, Tags.Source.Scanlator);
    }
    public override async FetchChapters(manga: Manga): Promise<Chapter[]> {
        return firstNonEmpty([
            () => FetchMadaraChaptersPaged.call(this, manga),
            () => Madara.FetchChaptersSinglePageAJAXv1.call(this, manga),
            () => Madara.FetchChaptersSinglePageCSS.call(this, manga),
        ]);
    }
    public override async FetchPages(chapter: Chapter): Promise<Page[]> {
        return firstNonEmpty([
            () => Madara.FetchPagesSinglePageCSS.call(this, chapter),
            () => Madara.FetchPagesSinglePageCSS.call(this, chapter, 'div.reading-content img'),
            () => Madara.FetchPagesSinglePageCSS.call(this, chapter, 'div.entry-content img, div.text-left img'),
        ]);
    }
}

@MangaStream.MangaCSS(/^{origin}\/[^?#]+$/)
@MangaStream.ChaptersSinglePageCSS()
@Common.ImageAjax()
class GenericMangaStream extends DecoratableMangaScraper {
    public constructor(origin: string) {
        super(`generic-mangastream:${siteName(origin)}`, siteName(origin), origin, Tags.Media.Manhwa, Tags.Source.Scanlator);
    }
    public override async FetchPages(chapter: Chapter): Promise<Page[]> {
        return firstNonEmpty([
            () => MangaStream.FetchPagesSinglePageJS.call(this, chapter),
            () => MangaStream.FetchPagesSinglePageCSS.call(this, chapter),
        ]);
    }
}

export function CreateGenericScraper(theme: GenericTheme, url: string): DecoratableMangaScraper {
    const origin = new URL(url).origin;
    return theme === 'madara' ? new GenericMadara(origin) : new GenericMangaStream(origin);
}

/** Marcas de cada tema en el HTML de la página de la obra. */
function DetectFromDocument(dom: Document): GenericTheme | null {
    const html = dom.documentElement?.outerHTML ?? '';
    if (dom.querySelector('div#manga-chapters-holder, li.wp-manga-chapter, div.summary_content, .c-page-content .manga-title-badges')
        || /wp-content\/themes\/madara|wp-manga|madara_load_more|manga_get_chapters/i.test(html)) {
        return 'madara';
    }
    if (dom.querySelector('div#chapterlist, div.eph-num, div.bixbox.bxcl, div#readerarea')
        || /ts_reader|wp-content\/themes\/(mangastream|mangareader|themesia)|themesia/i.test(html)) {
        return 'mangastream';
    }
    return null;
}

/**
 * Descubre el tema leyendo la página. Si el sitio la protege (p. ej. Cloudflare), se abre en una
 * ventana de navegador, que se muestra si hay que resolver un captcha.
 */
export async function DetectGenericTheme(url: string): Promise<GenericTheme | null> {
    let dom: Document;
    try {
        dom = await FetchHTML(new Request(url, { headers: { Referer: new URL(url).origin } }));
    } catch {
        const html = await FetchWindowScript<string>(new Request(url), 'document.documentElement.outerHTML', 500, 60_000);
        dom = new DOMParser().parseFromString(html, 'text/html');
    }
    return DetectFromDocument(dom);
}
