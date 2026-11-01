import assert from "node:assert/strict";
import { test } from "node:test";

import { type PathState, reconcile, type SyncAction } from "./reconcile.ts";

const cases: [PathState, SyncAction][] = [
    [{ inBase: true, local: "unchanged", remote: "unchanged", sameContent: true }, "none"],
    [{ inBase: true, local: "changed", remote: "unchanged", sameContent: false }, "upload"],
    [{ inBase: true, local: "unchanged", remote: "changed", sameContent: false }, "download"],
    [{ inBase: true, local: "changed", remote: "changed", sameContent: false }, "conflict"],
    [{ inBase: true, local: "changed", remote: "changed", sameContent: true }, "adoptBoth"],
    [{ inBase: true, local: "absent", remote: "unchanged", sameContent: false }, "deleteRemote"],
    [{ inBase: true, local: "unchanged", remote: "absent", sameContent: false }, "deleteLocal"],
    [{ inBase: true, local: "absent", remote: "changed", sameContent: false }, "download"],
    [{ inBase: true, local: "changed", remote: "absent", sameContent: false }, "upload"],
    [{ inBase: true, local: "absent", remote: "absent", sameContent: false }, "adoptBoth"],
    [{ inBase: false, local: "changed", remote: "absent", sameContent: false }, "upload"],
    [{ inBase: false, local: "absent", remote: "changed", sameContent: false }, "download"],
    [{ inBase: false, local: "changed", remote: "changed", sameContent: true }, "adoptBoth"],
    [{ inBase: false, local: "changed", remote: "changed", sameContent: false }, "conflict"],
    [{ inBase: false, local: "absent", remote: "absent", sameContent: false }, "none"],
];

test("every three-way state maps to its action; an edit is never lost to a deletion", () => {
    for (const [state, expected] of cases) {
        assert.equal(reconcile(state), expected, JSON.stringify(state));
    }
});
