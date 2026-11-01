import type { ProtonDriveClient } from "@protontech/drive-sdk";

import type { Activity, DaemonEvent, Progress, Settings, Status } from "./ipc/protocol.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import { SyncEngine } from "./sync/engine.ts";
import { LocalRootMissingError } from "./sync/guard.ts";
import type { StateDb } from "./sync/state.ts";
import type { Auth, Logger } from "./vendor/proton-account/index.ts";

const ACTIVITY_LIMIT = 200;
/** How often a missing local folder (unmounted disk, renamed folder) is checked again. */
const LOCAL_ROOT_RETRY_MS = 30_000;
/** Progress is pushed to the UI at most this often: transfers report every block. */
const PROGRESS_INTERVAL_MS = 500;

/** Long-running daemon: owns the session, the settings and the sync engine, and reports to the UI. */
export class DaemonService {
    private status: Status = { state: "signedOut" };
    private settings?: Settings;
    private readonly activity: Activity[] = [];
    private readonly listeners = new Set<(event: DaemonEvent) => void>();
    /** The Drive client of the signed-in session; a client cannot be reused across accounts. */
    private sdk?: ProtonDriveClient;
    private engine?: SyncEngine;
    private engineRun?: AbortController;
    private retryTimer?: NodeJS.Timeout;
    private outdated = false;
    private progress?: Progress;
    private progressTimer?: NodeJS.Timeout;
    private loginRun?: AbortController;

    constructor(
        private readonly auth: Auth,
        private readonly createSdk: () => ProtonDriveClient,
        private readonly state: StateDb,
        private readonly logger: Logger,
    ) {}

    async start(): Promise<void> {
        this.settings = await loadSettings();
        void this.restartEngine();
    }

    stop(): void {
        clearTimeout(this.retryTimer);
        clearTimeout(this.progressTimer);
        this.engineRun?.abort();
        this.loginRun?.abort();
    }

    subscribe(listener: (event: DaemonEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    getStatus(): Status {
        return this.status;
    }

    /** True once a newer daemon was installed: the UI restarts the service when it is not busy. */
    isOutdated(): boolean {
        return this.outdated;
    }

    markOutdated(): void {
        if (!this.outdated) {
            this.outdated = true;
            this.logger.info("A newer daemon was installed");
            this.emit({ event: "outdated" });
        }
    }

    recentActivity(): Activity[] {
        return [...this.activity];
    }

    /** Starts the web sign-in and resolves with the URL to open; completion is reported by a status event. */
    login(): Promise<string> {
        if (this.status.state === "signingIn" && this.status.signInUrl) {
            return Promise.resolve(this.status.signInUrl);
        }
        this.loginRun = new AbortController();
        this.sdk = undefined;
        const { promise, resolve, reject } = Promise.withResolvers<string>();
        this.auth
            .authViaWeb((signInUrl) => {
                this.setStatus({ state: "signingIn", signInUrl });
                resolve(signInUrl);
            }, this.loginRun.signal)
            .then(() => void this.restartEngine())
            .catch((error: unknown) => {
                reject(error);
                this.logger.error("Sign-in failed", error);
                this.setStatus({ state: "signedOut", error: errorMessage(error) });
            });
        return promise;
    }

    async logout(): Promise<void> {
        clearTimeout(this.retryTimer);
        this.engineRun?.abort();
        await this.auth.logout();
        this.sdk = undefined;
        // The base describes this account's Drive; another account must start from scratch.
        this.state.reset();
        this.setStatus({ state: "signedOut" });
    }

    async setSettings(settings: Settings): Promise<void> {
        await saveSettings(settings);
        if (this.settings?.localRoot !== settings.localRoot || this.settings.remotePath !== settings.remotePath) {
            this.engineRun?.abort();
            this.state.reset();
        }
        this.settings = settings;
        // The initial sync can take long: progress is reported through status events.
        void this.restartEngine();
    }

    /** Answers a held plan: approve trashes the files, otherwise they are restored from the other side. */
    async resolveDeletions(approve: boolean): Promise<void> {
        if (this.status.state !== "awaitingApproval" || !this.engine) {
            throw new Error("No deletion is waiting for approval");
        }
        await this.engine.resolveHeldDeletions(approve);
    }

    private async restartEngine(): Promise<void> {
        clearTimeout(this.retryTimer);
        this.reportProgress(undefined);
        this.engineRun?.abort();
        if (!this.auth.isLoggedIn()) {
            this.setStatus({ state: "signedOut" });
            return;
        }
        if (!this.settings) {
            this.setStatus({ state: "needsSettings" });
            return;
        }
        const run = new AbortController();
        this.engineRun = run;
        const settings = this.settings;
        this.setStatus({ state: "starting", settings });

        this.sdk ??= this.createSdk();
        const engine = new SyncEngine(this.sdk, settings, this.state, this.logger, {
            dryRun: false,
            onPlan: (actions) => this.logger.info(`Planned ${actions.length} action(s)`),
            onBusy: (busy) => {
                if (!run.signal.aborted) {
                    this.setStatus({ state: busy ? "syncing" : "idle", settings });
                }
            },
            onProgress: (progress) => {
                if (!run.signal.aborted) {
                    this.reportProgress(progress);
                }
            },
            onDeletionsHeld: (held) => {
                if (!run.signal.aborted) {
                    this.setStatus(
                        held ? { state: "awaitingApproval", settings, heldDeletions: held } : { state: "idle", settings },
                    );
                }
            },
            onLocalRootMissing: (error) => {
                if (!run.signal.aborted) {
                    run.abort();
                    this.engineFailed(error);
                }
            },
            onResult: (action, path, error) =>
                this.addActivity({
                    time: new Date().toISOString(),
                    action,
                    path,
                    ...(error !== undefined && { error: errorMessage(error) }),
                }),
        });
        this.engine = engine;
        try {
            await engine.start(run.signal);
            if (!run.signal.aborted && this.status.state === "starting") {
                this.setStatus({ state: "idle", settings });
            }
        } catch (error) {
            if (!run.signal.aborted) {
                this.engineFailed(error);
            }
        }
    }

    private engineFailed(error: unknown): void {
        this.logger.error("Sync engine stopped", error);
        this.setStatus({ state: "error", ...(this.settings && { settings: this.settings }), error: errorMessage(error) });
        if (error instanceof LocalRootMissingError) {
            this.retryTimer = setTimeout(() => void this.restartEngine(), LOCAL_ROOT_RETRY_MS);
        }
    }

    private setStatus(status: Status): void {
        const { progress: _previous, ...rest } = status;
        this.status = this.progress ? { ...rest, progress: this.progress } : rest;
        this.emit({ event: "status", status: this.status });
    }

    /** Keeps the latest progress and pushes it with the status, throttled; a cleared progress goes out at once. */
    private reportProgress(progress: Progress | undefined): void {
        this.progress = progress;
        if (!progress) {
            clearTimeout(this.progressTimer);
            this.progressTimer = undefined;
            this.setStatus(this.status);
        } else if (!this.progressTimer) {
            this.progressTimer = setTimeout(() => {
                this.progressTimer = undefined;
                this.setStatus(this.status);
            }, PROGRESS_INTERVAL_MS);
        }
    }

    private addActivity(activity: Activity): void {
        this.activity.unshift(activity);
        this.activity.splice(ACTIVITY_LIMIT);
        this.emit({ event: "activity", activity });
    }

    private emit(event: DaemonEvent): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
