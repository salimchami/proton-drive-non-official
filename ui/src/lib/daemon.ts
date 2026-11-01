import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
    Activity,
    DaemonEvent,
    HeldDeletions,
    Request,
    Settings,
    Status,
} from "../../../daemon/src/ipc/protocol.ts";

export type { Activity, HeldDeletions, Settings, Status };

type RequestWithoutId = Request extends infer R ? (R extends Request ? Omit<R, "id"> : never) : never;

/** Sends one protocol request through the Tauri side, which owns the daemon socket. */
function request<T>(req: RequestWithoutId): Promise<T> {
    return invoke<T>("daemon_request", { request: req });
}

export const daemon = {
    status: () => request<Status>({ method: "status" }),
    recentActivity: () => request<Activity[]>({ method: "recentActivity" }),
    login: () => request<string>({ method: "login" }),
    logout: () => request<void>({ method: "logout" }),
    setSettings: (settings: Settings) => request<void>({ method: "setSettings", settings }),
    resolveDeletions: (approve: boolean) => request<void>({ method: "resolveDeletions", approve }),

    onEvent: (callback: (event: DaemonEvent) => void): Promise<UnlistenFn> =>
        listen<DaemonEvent>("daemon-event", ({ payload }) => callback(payload)),
    onConnection: (callback: (connected: boolean) => void): Promise<UnlistenFn> =>
        listen<boolean>("daemon-connection", ({ payload }) => callback(payload)),
};
