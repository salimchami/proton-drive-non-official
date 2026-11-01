import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { CryptoProxy, updateServerTime } from "@protontech/crypto";
import { Api as CryptoApi } from "@protontech/crypto/proxy/endpoint/api.ts";
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from "@protontech/crypto/srp";
import {
    MemoryCache,
    OpenPGPCryptoWithCryptoProxy,
    ProtonDriveClient,
    type ProtonDriveHTTPClientBlobRequest,
    type ProtonDriveHTTPClientJsonRequest,
    VERSION as SDK_VERSION,
} from "@protontech/drive-sdk";
import type { AfterResponseHook } from "ky";

import { ACCOUNT_URL, API_BASE_URL, APP_VERSION, AUTH_CLIENT_ID, appDir, CLIENT_UID_PREFIX } from "../config.ts";
import { ApiClient, initAccount, type Logger } from "../vendor/proton-account/index.ts";
import { Credentials } from "./credentials.ts";

export type Drive = Awaited<ReturnType<typeof initDrive>>;

/**
 * Wires the account module and the Drive SDK, mirroring the official CLI (cli/src/init.ts upstream).
 * A Drive client keeps the first account's "My files" share for its lifetime (SharesManager.myFilesIds),
 * so `createSdk` returns a new client, with new caches, for each signed-in session.
 */
export async function initDrive(logger: Logger) {
    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());

    const credentials = new Credentials(logger);
    const apiClient = new ApiClient({
        baseUrl: API_BASE_URL,
        appVersion: APP_VERSION,
        credentials,
        logger,
        headers: { "x-pm-drive-sdk-version": SDK_VERSION },
        afterResponseHooks: [serverTimeHook],
    });
    const { auth, srp, addresses } = await initAccount({
        authClientId: AUTH_CLIENT_ID,
        apiClient,
        credentials,
        cryptoProxy: CryptoProxy,
        srpApi: { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp },
        logger,
        accountUrl: ACCOUNT_URL,
    });

    const config = { baseUrl: API_BASE_URL, clientUid: await clientUid() };
    const createSdk = () =>
        new ProtonDriveClient({
            config,
            httpClient: {
                fetchJson: (options: ProtonDriveHTTPClientJsonRequest) =>
                    apiClient.authenticatedRequest(options.url, {
                        method: options.method,
                        ...(options.json !== undefined ? { json: options.json } : {}),
                        ...(options.body !== undefined && options.json === undefined ? { body: options.body } : {}),
                        headers: options.headers,
                        timeout: options.timeoutMs,
                        signal: options.signal,
                        throwHttpErrors: false,
                    }),
                fetchBlob: (options: ProtonDriveHTTPClientBlobRequest) =>
                    apiClient.authenticatedRequest(options.url, {
                        method: options.method,
                        body: options.body,
                        headers: options.headers,
                        timeout: options.timeoutMs,
                        signal: options.signal,
                        throwHttpErrors: false,
                    }),
            },
            entitiesCache: new MemoryCache(),
            cryptoCache: new MemoryCache(),
            account: addresses,
            openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
            srpModule: srp,
        });

    return { auth, createSdk };
}

/** Keeps crypto timestamps on server time, so keys and signatures are not rejected for clock skew. */
const serverTimeHook: AfterResponseHook = (_request, _options, response) => {
    const header = response.headers.get("x-pm-date") ?? response.headers.get("date");
    const serverTime = header ? new Date(header) : undefined;
    if (serverTime && !Number.isNaN(serverTime.getTime())) {
        updateServerTime(serverTime);
    }
};

/** Stable per-installation identifier sent to the API, generated on first run. */
async function clientUid(): Promise<string> {
    const file = path.join(appDir(), "clientUid.json");
    try {
        const { clientUid } = JSON.parse(await readFile(file, "utf8")) as { clientUid?: unknown };
        if (typeof clientUid === "string" && clientUid.startsWith(`${CLIENT_UID_PREFIX}-`)) {
            return clientUid;
        }
    } catch (error) {
        // A missing or corrupt file is replaced by a new UID; any other I/O error is real.
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
    const generated = `${CLIENT_UID_PREFIX}-${randomUUID()}`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ clientUid: generated }, null, 2)}\n`);
    return generated;
}
