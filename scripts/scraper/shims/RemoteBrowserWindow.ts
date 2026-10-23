// Reemplazo de engine/platform/RemoteBrowserWindow.ts: siempre Electron.
import type { IObservable } from '@engine/Observable';
import ElectronRemoteBrowserWindow from '@engine/platform/electron/RemoteBrowserWindow';

export interface IRemoteBrowserWindow {
    get DOMReady(): IObservable<void, IRemoteBrowserWindow>;
    get BeforeWindowNavigate(): IObservable<URL, IRemoteBrowserWindow>;
    get BeforeFrameNavigate(): IObservable<URL, IRemoteBrowserWindow>;
    Open(request: Request, show: boolean, preload: string): Promise<void>;
    Close(): Promise<void>;
    Show(): Promise<void>;
    Hide(): Promise<void>;
    ExecuteScript<T extends void | JSONElement>(script: string): Promise<T>;
    SendDebugCommand<T extends void | JSONElement>(method: string, parameters?: JSONObject): Promise<T>;
}

export function CreateRemoteBrowserWindow(): IRemoteBrowserWindow {
    return new ElectronRemoteBrowserWindow();
}
