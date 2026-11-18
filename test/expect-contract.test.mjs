// #188 (upstream 1.1.83): a replacement may declare how many times its pattern is
// expected to appear. More or fewer hits means the host changed underneath us, so
// the whole replacement is refused instead of silently rewriting every copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALL_PATCHES, applyPatches, applyReplacementsToText, patchDrift, patchStatusDetail, targetFiles } from "../lib/core.js";
import { asLf, patchReplacements } from "../lib/core/shared.mjs";

const patchWith = (...replacements) => ({ id: 999, file: ["x"], replacements });

test("literal pattern: exact hit count is required", () => {
  const p = patchWith({ pattern: "AAA", replace: "B", expect: 1 });
  assert.equal(applyReplacementsToText("xAAAz", p).text, "xBz");

  const twice = applyReplacementsToText("xAAAyAAAz", p);
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.hitMismatch, { patch_id: 999, expected: 1, actual: 2, file: "" });

  const none = applyReplacementsToText("nothing here", p);
  assert.equal(none.changed, false);
  assert.equal(none.hitMismatch.actual, 0, "zero hits is a mismatch too, not a quiet skip");
});

test("regexp pattern enforces the same contract", () => {
  const p = patchWith({ pattern: /AAA/g, replace: "B", expect: 2 });
  assert.equal(applyReplacementsToText("AAA-AAA", p).text, "B-B");
  const one = applyReplacementsToText("AAA-AAA-AAA", p);
  assert.equal(one.changed, false);
  assert.equal(one.hitMismatch.actual, 3);
});

test("without expect the old replace-all behaviour is unchanged", () => {
  const p = patchWith({ pattern: "AAA", replace: "B" });
  assert.equal(applyReplacementsToText("AAA-AAA", p).text, "B-B");
});

test("a duplicate anchor leaves its whole file intact and remains visible beside a successful target", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "purge-anchor-count-"));
  const home = path.join(root, "home");
  const ai = path.join(root, "node_modules", "@deepseek-ai");
  const bash = path.join(ai, "dsh-tool-bash", "lib", "index.js");
  const pwsh = path.join(ai, "dsh-tool-pwsh", "lib", "index.js");
  const repeated = "old header\r\nold label\r\nold label\r\n";
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(home, "profiles", "desktop"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "desktop", "package.json"), "{}");
  for (const [file, source] of [[bash, "old header\nold label\n"], [pwsh, repeated]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  const p = {
    ...patchWith(
      { pattern: "old header\n", replace: "new header\n" },
      { pattern: "old label\n", replace: "new label\n" },
      { pattern: "retired layout", replace: "new label" },
    ),
    file: ["tool-bash", "tool-pwsh"],
    markers: ["new label"],
    optional: true,
    requireUniqueAnchors: true,
  };
  const options = { dshHome: home, surface: "desktop" };
  const [result] = await applyPatches(ai, [p], options);
  assert.equal(fs.readFileSync(bash, "utf8"), "new header\nnew label\n");
  assert.equal(fs.readFileSync(pwsh, "utf8"), repeated);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "duplicate_anchor");
  assert.deepEqual(result.files, [{ path: pwsh, index: 1, hits: 2 }]);

  const report = await patchStatusDetail(ai, [p], options);
  assert.equal(report.status[p.id], "partial");
  const drift = await patchDrift(ai, [p], options);
  assert.equal(drift.optionalDrift[0].reason, "duplicate_anchor");
  assert.deepEqual(drift.optionalDrift[0].files, [
    { key: "tool-pwsh", path: pwsh, status: "drifted", reason: "duplicate_anchor", index: 1, hits: 2 },
  ]);
});

test("real host: duplicate literal anchors are declared or rejected before writing", t => {
  const ai = process.env.PURGE_TEST_HOST
    || "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai";
  if (!fs.existsSync(ai)) return t.skip("host not available");
  let files;
  try {
    files = targetFiles(ai, process.env.DSH_HOME || path.join(process.env.HOME || "", ".dsh"));
  } catch {
    return;
  }
  const offenders = [];
  for (const p of ALL_PATCHES) {
    for (const key of Array.isArray(p.file) ? p.file : [p.file]) {
      for (const fp of files[key] || []) {
        const pristine = `${fp}.dshpurge.bak`;
        const file = fs.existsSync(pristine) ? pristine : fp;
        let text;
        try {
          text = fs.readFileSync(file, "utf8");
        } catch {
          continue;
        }
        const source = asLf(text);
        const label = `#${p.id} ${path.relative(ai, fp)}`;
        let guardedDuplicate = false;
        for (const rep of patchReplacements(p)) {
          if (!rep.pattern || rep.pattern instanceof RegExp) continue;
          const n = source.split(asLf(rep.pattern)).length - 1;
          // 这个锚点在原始宿主里就该出现多次（成对文案），不是漂移。
          if (p.multiHit) continue;
          // 声明了 expect 的锚点允许重复出现，只要数量被钉死（应用时会校验）。
          if (typeof rep.expect === "number") {
            if (n !== rep.expect) {
              offenders.push(`${label} hits=${n} expected=${rep.expect}`);
            }
            continue;
          }
          if (n <= 1) continue;
          if (p.requireUniqueAnchors) guardedDuplicate = true;
          else offenders.push(`${label} hits=${n}`);
        }
        if (guardedDuplicate) {
          const result = applyReplacementsToText(text, p, fp);
          if (!result.duplicateAnchor || result.changed || result.text !== text) {
            offenders.push(`${label} did not reject a duplicate anchor`);
          }
        }
      }
    }
  }
  assert.deepEqual(offenders, [], "unexpected anchor counts or unsafe replacement of duplicates");
});
