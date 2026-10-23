// Reemplazo de engine/platform/FetchProvider.ts: siempre Electron (la app es Electron).
import ElectronFetchProvider from '@engine/platform/electron/FetchProvider';
import type { FeatureFlags } from '@engine/FeatureFlags';

const instance = new ElectronFetchProvider();
instance.Initialize({ VerboseFetchWindow: { Value: false } } as unknown as FeatureFlags);

export function SetupFetchProvider(_featureFlags?: FeatureFlags) {}
export const Fetch: typeof instance.Fetch = (request) => instance.Fetch(request);
export const FetchHTML: typeof instance.FetchHTML = (request) => instance.FetchHTML(request);
export const FetchRegex: typeof instance.FetchRegex = (request, regex) => instance.FetchRegex(request, regex);
export const FetchJSON: typeof instance.FetchJSON = (request) => instance.FetchJSON(request);
export const FetchCSS: typeof instance.FetchCSS = (request, query) => instance.FetchCSS(request, query);
export const FetchProto: typeof instance.FetchProto = (request, schema, messageTypePath) => instance.FetchProto(request, schema, messageTypePath);
export const FetchGraphQL: typeof instance.FetchGraphQL = (request, operationName, query, variables, extensions) => instance.FetchGraphQL(request, operationName, query, variables, extensions);
export const FetchNextJS: typeof instance.FetchNextJS = (request, predicate) => instance.FetchNextJS(request, predicate);
export const FetchNextProps: typeof instance.FetchNextProps = (request) => instance.FetchNextProps(request);
export const FetchWindowScript: typeof instance.FetchWindowScript = (request, script, delay?, timeout?) => instance.FetchWindowScript(request, script, delay, timeout);
export const FetchWindowPreloadScript: typeof instance.FetchWindowPreloadScript = (request, preload, script, delay = 0, timeout = 60_000) => instance.FetchWindowPreloadScript(request, preload, script, delay, timeout);
