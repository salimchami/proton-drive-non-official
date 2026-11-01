// @protontech/crypto is published as raw TypeScript, which Node refuses to strip inside
// node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and @protontech/drive-sdk uses
// extensionless ESM imports: the daemon and its tests both run as bundles.
import { readdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const common = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    // openpgp exports its lightweight build for browsers only; the official CLI patches
    // @protontech/crypto to the same full "openpgp" entry (config/js/patches upstream).
    alias: { "openpgp/lightweight": "openpgp" },
};

if (process.argv.includes("--tests")) {
    const tests = (await readdir("src", { recursive: true }))
        .filter((file) => file.endsWith(".test.ts"))
        .map((file) => `src/${file}`);
    // The output layout follows the tests' common directory: stale bundles would run twice.
    await rm("dist-test", { recursive: true, force: true });
    await build({ ...common, entryPoints: tests, outdir: "dist-test", outExtension: { ".js": ".mjs" } });
} else {
    await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.mjs" });
}
