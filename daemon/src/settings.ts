import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface Settings {
    /** Absolute path of the local folder kept in sync. */
    localRoot: string;
    /** Folder in "My files" kept in sync, as a slash-separated path; "/" for the whole of "My files". */
    remotePath: string;
}

export function settingsFile(): string {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
    return path.join(xdgConfig, "drive-sync", "config.json");
}

/** Undefined when no settings file exists yet. */
export async function loadSettings(): Promise<Settings | undefined> {
    const file = settingsFile();
    let text;
    try {
        text = await readFile(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
    return validateSettings(JSON.parse(text) as Partial<Settings>, file);
}

export async function saveSettings(settings: Settings): Promise<void> {
    const file = settingsFile();
    validateSettings(settings, file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function validateSettings(raw: Partial<Settings>, file: string): Settings {
    if (typeof raw.localRoot !== "string" || !path.isAbsolute(raw.localRoot)) {
        throw new Error(`${file}: "localRoot" must be an absolute path`);
    }
    if (typeof raw.remotePath !== "string" || !raw.remotePath.startsWith("/")) {
        throw new Error(`${file}: "remotePath" must start with "/"`);
    }
    return { localRoot: raw.localRoot, remotePath: raw.remotePath };
}
