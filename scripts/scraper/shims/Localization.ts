// Reemplazo de i18n/Localization.ts: solo español, sin depender de los ajustes de HaruNeko.
import { type ILocale, type VariantResource, VariantResourceKey, InvariantResourceKey } from '@i18n/ILocale';
import { invariant } from '@i18n/locales/_invariant';
import es_ES from '@i18n/locales/es_ES';

function Format(this: string, ...params: string[]) {
    let text = this.toString();
    for (const index in params) {
        text = text.replace(`{${index}}`, params[index]);
    }
    return text;
}

export function CreateLocale(resource: VariantResource): ILocale {
    const result = {};
    for (const key in InvariantResourceKey) {
        result[key] = Format.bind(invariant[key] ?? key);
    }
    for (const key in VariantResourceKey) {
        result[key] = Format.bind(resource[key] ?? key);
    }
    return result as ILocale;
}

const locale = CreateLocale(es_ES);
export function GetLocale(): ILocale {
    return locale;
}
