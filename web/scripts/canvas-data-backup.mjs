#!/usr/bin/env node
/** OFFLINE maintenance only. Stop dev:backend/dev first; never kill in-flight
 * GPU/model tasks in order to take a backup. Paths must be absolute.
 *
 * node scripts/canvas-data-backup.mjs create  <dataDir> <newBackupDir>
 * node scripts/canvas-data-backup.mjs verify  <existingBackupDir>
 * node scripts/canvas-data-backup.mjs restore <existingBackupDir> <newDataDir>
 */
import {createColdBackup,verifyColdBackup,restoreColdBackup} from "../server/backend/cold-backup.mjs";
import {activateRestoredDataset} from "../server/backend/dataset-activation.mjs";
import {auditColdBlobStore} from "../server/backend/blob-recovery-audit.mjs";

async function main(){
 const [command,...args]=process.argv.slice(2);
 let result;
 if(command==="create"&&args.length===2)
  result=await createColdBackup({dataDir:args[0],backupDir:args[1]});
 else if(command==="verify"&&args.length===1)
  result=await verifyColdBackup({backupDir:args[0]});
 else if(command==="restore"&&args.length===2)
  result=await restoreColdBackup({backupDir:args[0],dataDir:args[1]});
 else if(command==="audit"&&args.length===1)
  result=await auditColdBlobStore({dataDir:args[0]});
 else if(command==="activate"&&args.length===2)
  result=activateRestoredDataset(args[0],{confirmation:args[1]});
 else throw Error("Usage: create <dataDir> <newBackupDir> | verify <backupDir> | restore <backupDir> <newDataDir> | activate <restoredDataDir> ACTIVATE_RESTORED_DATASET | audit <dataDir>. All paths must be absolute.");
 process.stdout.write(JSON.stringify({ok:true,operation:command,...result})+"\n");
 if(command==="audit"&&result.ok===false)process.exitCode=2;
}
main().catch(e=>{
 process.stderr.write("Cold backup refused: "+(e?.code??e?.message??"unknown_error")+"\n");
 process.exitCode=1;
});
