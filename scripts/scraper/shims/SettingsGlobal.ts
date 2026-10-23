// Reemplazo de engine/SettingsGlobal.ts: solo las claves que usan los sitios.
export const Scope = '*';

export const enum Key {
    Frontend = 'frontend',
    Language = 'language',
    MediaDirectory = 'media-directory',
    UseWebsiteSubDirectory = 'website-subdirectory',
    MangaExportFormat = 'manga-export-format',
    DescramblingFormat = 'descrambling-format',
    DescramblingQuality = 'descrambling-quality',
    UserAgent = 'UserAgent',
    CaptchaToken = 'captcha-token',
    PostCommand = 'post-command',
    CheckNewContent = 'check-new-content',
    CheckNewContentPeriod = 'check-new-content-period',
    NotifyNewContent = 'notify-new-content',
    RPCEnabled = 'RPCEnabled',
    RPCPort = 'RPCPort',
    RPCSecret = 'RPCSecret',
}

export async function Initialize(): Promise<void> {}
