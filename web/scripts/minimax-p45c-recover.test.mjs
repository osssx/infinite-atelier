import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const tool=fileURLToPath(new URL("./minimax-p45c-recover.mjs",import.meta.url));
const check=(root)=>spawnSync(process.execPath,[tool],{
  encoding:"utf8",timeout:10000,
  env:{...process.env,ATELIER_MINIMAX_RECOVER_ROOT:root,ATELIER_MINIMAX_LIVE:""}
});
test("P4.5c recovery does not create a new live acceptance when no isolated root is selected",()=>{
  const run=check("");
  assert.notEqual(run.status,0);
  assert.match(run.stderr,/minimax_recovery_root_not_isolated/);
  assert.doesNotMatch(run.stdout,/MINIMAX_P45C_RESTORED|MINIMAX_P45C_RECOVERY_RESULT/);
});
test("P4.5c recovery refuses paths outside isolated acceptance temp directory",()=>{
  const run=check(process.cwd());
  assert.notEqual(run.status,0);
  assert.match(run.stderr,/minimax_recovery_root_not_isolated/);
  assert.doesNotMatch(run.stdout,/MINIMAX_P45C_RESTORED/);
});
test("P4.5c recovery refuses fake isolated root without its original SQLite state",()=>{
  const run=check(join(tmpdir(),"infinite-atelier-minimax-p3c2-does-not-exist"));
  assert.notEqual(run.status,0);
  assert.match(run.stderr,/minimax_recovery_root_not_isolated/);
  assert.doesNotMatch(run.stdout,/MINIMAX_P45C_RESTORED/);
});
