import assert from "node:assert/strict";
import * as Q from "../lib/db.mjs";
const db = Q.openDb(":memory:");
Q.enqueue(db, [{ id: "a", url: "u", kind: "photo", label: "" }]);
for (let i = 0; i < 2; i++) { Q.claim(db, "w", 3); Q.requeue(db, "a", "x"); }
assert.equal(Q.claim(db, "w", 3).attempts, 3);          // third attempt claimed, then crash
assert.equal(Q.releaseStale(db, 0), 1);
assert.ok(Q.claim(db, "w", 3), "interrupted last attempt must be claimable again");
Q.finish(db, "a", "done", { description: "[ai] x" });
assert.equal(Q.requeueOurs(db, "[ai]"), 1);
Q.enqueue(db, [{ id: "b", url: "u", kind: "photo", label: "" }]);
Q.finish(db, "b", "skipped", { description: "my own note" });
assert.equal(Q.requeueOurs(db, "[ai]"), 0);              // already queued + user note untouched
console.log("db tests ok");
