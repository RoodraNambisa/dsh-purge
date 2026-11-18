import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SOURCE_REPO, UPSTREAM_REPO, archiveZipUrl, archiveTarballUrl } from "../lib/update-net.js";
import { REPOSITORY } from "../lib/community.js";

test("update sources point at this repository", () => {
  assert.equal(SOURCE_REPO, "RoodraNambisa/dsh-purge");
  assert.equal(UPSTREAM_REPO, SOURCE_REPO);
  assert.equal(REPOSITORY, SOURCE_REPO);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const repo = `https://github.com/${SOURCE_REPO}`;
  assert.equal(pkg.repository.url, `git+${repo}.git`);
  assert.equal(pkg.dsh.install.git, `${repo}.git`);
});

test("source archives download from the fork", () => {
  for (const url of [archiveZipUrl("v1.6.36"), archiveTarballUrl("v1.6.36")]) {
    assert.match(url, /^https:\/\/codeload\.github\.com\/RoodraNambisa\/dsh-purge\//);
  }
});
