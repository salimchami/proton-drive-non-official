// Fetches the official Node.js runtime shipped in the package: distributions such as Ubuntu 24.04
// only provide Node 18, and Node 22 single executable applications accept CommonJS only, while the
// daemon bundle relies on top-level await. The version and checksums are pinned from
// https://nodejs.org/dist/v22.23.3/SHASUMS256.txt.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const VERSION = "v22.23.3";
const SHA256 = {
    x64: "df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de",
    arm64: "a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f",
};

const arch = process.arch;
if (!(arch in SHA256)) {
    throw new Error(`No pinned Node.js runtime for architecture ${arch}`);
}

const name = `node-${VERSION}-linux-${arch}`;
const outDir = path.join(import.meta.dirname, "build", "node");

const response = await fetch(`https://nodejs.org/dist/${VERSION}/${name}.tar.xz`);
if (!response.ok) {
    throw new Error(`Downloading ${name} failed: HTTP ${response.status}`);
}
const archive = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(archive).digest("hex");
if (digest !== SHA256[arch]) {
    throw new Error(`Checksum mismatch for ${name}.tar.xz: got ${digest}`);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const archivePath = path.join(outDir, `${name}.tar.xz`);
await writeFile(archivePath, archive);
// Only the binary and its license are shipped; npm, headers and docs stay out of the package.
await promisify(execFile)("tar", [
    "-xJf", archivePath, "-C", outDir, "--strip-components=1",
    `${name}/bin/node`, `${name}/LICENSE`,
]);
await rm(archivePath);
console.log(`Node.js ${VERSION} (${arch}) ready in ${outDir}`);
