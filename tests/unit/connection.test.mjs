import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, normalizeServerUrl } from "../../dist/bc/connection.js";

test("redact removes Basic auth tokens and password fields", () => {
  // Note: rule 2 redacts the "Basic <token>" span first, then rule 4's
  // header-collapse re-matches "Authorization: Basic" and redacts again —
  // so the literal word "Basic" does not survive either. Asserting the
  // exact (pre-existing, unchanged-by-this-move) output.
  assert.equal(
    redact("Authorization: Basic YWJjOjEyMw=="),
    "Authorization: [redacted] [redacted]",
  );
  assert.doesNotMatch(redact("Authorization: Basic YWJjOjEyMw=="), /YWJjOjEyMw==/);
  assert.equal(redact('{"password":"hunter2"}'), '{"password":"[redacted]"}');
});

test("normalizeServerUrl adds https and applies the port", () => {
  const u = normalizeServerUrl("bc.local", 7049);
  assert.equal(u.protocol, "https:");
  assert.equal(u.port, "7049");
});

test("runPasswordCommand returns stdout without the trailing newline", async () => {
  const { runPasswordCommand } = await import("../../dist/bc/connection.js");
  const pwd = runPasswordCommand([process.execPath, "-e", "process.stdout.write('s3cret\\n')"]);
  assert.equal(pwd, "s3cret");
});

test("runPasswordCommand surfaces the stderr hint but never stdout", async () => {
  const { runPasswordCommand } = await import("../../dist/bc/connection.js");
  assert.throws(
    () =>
      runPasswordCommand([
        process.execPath,
        "-e",
        "process.stdout.write('leaked'); process.stderr.write('pass store locked - run: secret.sh unlock\\n'); process.exit(1)",
      ]),
    (err) => {
      assert.match(err.message, /secret\.sh unlock/);
      assert.doesNotMatch(err.message, /leaked/);
      return true;
    },
  );
});

test("runPasswordCommand rejects a non-array command and an empty password", async () => {
  const { runPasswordCommand } = await import("../../dist/bc/connection.js");
  assert.throws(() => runPasswordCommand("secret.sh get -n X"), /non-empty array of strings/);
  assert.throws(() => runPasswordCommand([process.execPath, "-e", "0"]), /empty password/);
});
