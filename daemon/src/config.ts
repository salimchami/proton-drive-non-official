import { homedir } from "node:os";
import path from "node:path";

import packageJson from "../package.json" with { type: "json" };

const APP_DIR_NAME = "drive-sync";

/**
 * Third-party identification required by the SDK usage guidelines:
 * `external-drive-{name}@{semver}-{channel}`, with the `external-drive` auth client.
 */
export const APP_VERSION = `external-drive-drive_sync@${packageJson.version}-alpha`;
export const AUTH_CLIENT_ID = "external-drive";
export const CLIENT_UID_PREFIX = "drive_sync";

export const API_BASE_URL = "drive-api.proton.me";
export const ACCOUNT_URL = "account.proton.me";

/** Shown wherever the user is asked to sign in, as the SDK usage guidelines require. */
export const THIRD_PARTY_NOTICE = "This is a third-party application not officially supported by Proton.";

/** Persistent state directory: client UID, sync database. */
export function appDir(): string {
    const xdgData = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
    return path.join(xdgData, APP_DIR_NAME);
}
