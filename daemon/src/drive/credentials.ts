import { spawn } from "node:child_process";

import type { Logger, SessionCredentials, SessionInfo } from "../vendor/proton-account/index.ts";

interface StoredSession {
    userKeyPassword: string;
    session: SessionInfo;
    telemetryEnabled?: boolean;
}

const SECRET_ATTRIBUTES = ["service", "drive-sync", "account", "auth-session"];

/** Session state persisted in the Secret Service (GNOME Keyring, KWallet) through libsecret's `secret-tool`. */
export class Credentials implements SessionCredentials {
    private userKeyPassword?: string;
    private sessionInfo?: SessionInfo;
    private telemetryEnabled?: boolean;

    private readonly sessionInfoChangedCallbacks = new Set<() => void>();

    constructor(private readonly logger: Logger) {}

    get uid(): string | undefined {
        return this.sessionInfo?.uid;
    }

    get accessToken(): string | undefined {
        return this.sessionInfo?.accessToken;
    }

    get refreshToken(): string | undefined {
        return this.sessionInfo?.refreshToken;
    }

    on(_: "sessionInfoChanged", callback: () => void): void {
        this.sessionInfoChangedCallbacks.add(callback);
    }

    isLoggedIn(): boolean {
        return !!this.userKeyPassword && !!this.sessionInfo;
    }

    isTelemetryEnabled(): boolean {
        return this.isLoggedIn() && (this.telemetryEnabled ?? false);
    }

    getUserKeyPassword(): string | undefined {
        return this.userKeyPassword;
    }

    async load(): Promise<void> {
        const raw = await secretTool(["lookup", ...SECRET_ATTRIBUTES]);
        const stored = raw ? parseStoredSession(raw) : undefined;
        if (!stored) {
            this.logger.debug("No session loaded");
            return;
        }
        this.userKeyPassword = stored.userKeyPassword;
        this.sessionInfo = stored.session;
        this.telemetryEnabled = stored.telemetryEnabled;
        this.notifySessionInfoChanged();
    }

    async setUserKeyPassword(userKeyPassword: string): Promise<void> {
        this.userKeyPassword = userKeyPassword;
        await this.persist();
        this.notifySessionInfoChanged();
    }

    async setSessionInfo(info: SessionInfo): Promise<void> {
        this.sessionInfo = info;
        await this.persist();
        this.notifySessionInfoChanged();
    }

    async setTelemetryEnabled(enabled: boolean): Promise<void> {
        this.telemetryEnabled = enabled;
        await this.persist();
    }

    async signOut(): Promise<void> {
        this.userKeyPassword = undefined;
        this.sessionInfo = undefined;
        this.telemetryEnabled = undefined;
        await secretTool(["clear", ...SECRET_ATTRIBUTES]);
        this.notifySessionInfoChanged();
    }

    private async persist(): Promise<void> {
        if (!this.userKeyPassword || !this.sessionInfo) {
            return;
        }
        const stored: StoredSession = {
            userKeyPassword: this.userKeyPassword,
            session: this.sessionInfo,
            telemetryEnabled: this.telemetryEnabled,
        };
        await secretTool(["store", "--label=drive-sync session", ...SECRET_ATTRIBUTES], JSON.stringify(stored));
    }

    private notifySessionInfoChanged(): void {
        this.sessionInfoChangedCallbacks.forEach((callback) => callback());
    }
}

function parseStoredSession(raw: string): StoredSession | undefined {
    try {
        const stored = JSON.parse(raw) as Partial<StoredSession>;
        if (
            typeof stored.userKeyPassword !== "string" ||
            typeof stored.session?.uid !== "string" ||
            typeof stored.session.accessToken !== "string"
        ) {
            return undefined;
        }
        return stored as StoredSession;
    } catch {
        return undefined;
    }
}

/**
 * Runs `secret-tool`; secrets only travel through stdin/stdout, never argv.
 * Resolves to stdout, or undefined when `lookup` finds nothing (exit code 1, empty output).
 */
function secretTool(args: string[], input?: string): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        const child = spawn("secret-tool", args, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.on("error", (error) =>
            reject(new Error("secret-tool is required (package libsecret-tools)", { cause: error })),
        );
        child.on("close", (code) => {
            if (code === 0) {
                resolve(stdout);
            } else if (code === 1 && stdout === "" && stderr === "") {
                resolve(undefined);
            } else {
                reject(new Error(`secret-tool ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
            }
        });
        child.stdin.end(input);
    });
}
