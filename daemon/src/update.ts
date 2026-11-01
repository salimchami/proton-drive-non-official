import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const CHECK_DEBOUNCE_MS = 2000;

async function hashCode(codePath: string): Promise<string | undefined> {
    try {
        return createHash("sha256").update(await readFile(codePath)).digest("hex");
    } catch {
        // Missing during a package upgrade: checked again on the next change.
        return undefined;
    }
}

/**
 * Calls `onOutdated` once `codePath`, the bundle this process was started from, no longer matches
 * the running code on disk, as after a package upgrade. The directory is watched because dpkg
 * replaces the file by renaming a new one over it.
 */
export async function watchCodeUpdates(codePath: string, onOutdated: () => void, signal: AbortSignal): Promise<void> {
    const running = await hashCode(codePath);
    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(path.dirname(codePath), (_event, file) => {
        if (file !== path.basename(codePath)) {
            return;
        }
        clearTimeout(timer);
        timer = setTimeout(async () => {
            const current = await hashCode(codePath);
            if (current !== undefined && current !== running) {
                watcher.close();
                onOutdated();
            }
        }, CHECK_DEBOUNCE_MS);
    });
    signal.addEventListener("abort", () => {
        clearTimeout(timer);
        watcher.close();
    });
}
