/* The refresh status names a failed Python step by its error, not by the
 * middle of its traceback: the status keeps 300 characters of the message,
 * and with the traceback's tail first those were pathlib's own frames while
 * the exception sat past the cut (28 Sep 2026: every refresh's build failed
 * with "File name too long" and the tooltip showed only "return io.open(").
 *
 *   node tests/py_failure.mjs
 */
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pyFailure } = require("../server/sheets.js");

const error = "OSError: [Errno 36] File name too long: '/var/data/app/derived/" + "andy_warhol_brillo_box_".repeat(16) + ".json'";
const tb = [
  "Traceback (most recent call last):",
  '  File "/opt/render/project/src/etl/build.py", line 6120, in <module>',
  "    main()",
  '  File "/opt/render/project/src/etl/build.py", line 6012, in main',
  "    (DERIVED / f\"{rec['id']}.json\").write_text(json.dumps(snap, indent=1))",
  '  File "/opt/render/project/python/Python-3.14.3/lib/python3.14/pathlib/__init__.py", line 1059, in write_text',
  "    with self.open(mode='w', encoding=encoding, errors=errors, newline=newline) as f:",
  "         ~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^",
  '  File "/opt/render/project/python/Python-3.14.3/lib/python3.14/pathlib/__init__.py", line 771, in open',
  "    return io.open(self, mode, buffering, encoding, errors, newline)",
  "           ~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^",
  error,
  "",
].join("\n");

const msg = pyFailure("build.py", tb, "Command failed");
assert.ok(msg.startsWith(`build.py failed: ${error} (etl/build.py:6012 in main) | `), msg.slice(0, 200));
// the 300 characters the status keeps say what failed
assert.ok(msg.slice(0, 300).includes("File name too long"), msg.slice(0, 300));
// the traceback's tail follows, for anyone who wants the rest
assert.ok(msg.endsWith(tb.trimEnd().slice(-800)), "the tail of the traceback follows the error");

// a script that died without a traceback (killed on the timeout): the runner's own message
assert.strictEqual(pyFailure("build.py", "", "spawn ETIMEDOUT"), "build.py failed: spawn ETIMEDOUT");
assert.strictEqual(pyFailure("build.py", "   \n", undefined), "build.py failed: no output");

// stderr that is not a traceback at all (a warning, then a plain exit): its last line leads
assert.ok(pyFailure("pull_airtable.py", "airtable: 401 from the API\n", "exit 1")
  .startsWith("pull_airtable.py failed: airtable: 401 from the API | "));

console.log("py failure message: ok");
