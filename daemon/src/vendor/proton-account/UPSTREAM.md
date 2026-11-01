Copied from https://github.com/ProtonDriveApps/sdk, directory `incubating/account/js/src`
(commit 8a44654aece1609f0f7218be51c205103945abd8), test files excluded. MIT, see LICENSE.md.
The module is not published on npm. Do not edit these files; re-copy them from upstream.

Local modification to re-apply after a re-copy:
- `addresses.ts`, user key import error: logs only `userKey.ID` instead of the whole key JSON,
  which contains `RecoverySecret` and the encrypted private key.
