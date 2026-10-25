import {DatabaseSync} from "node:sqlite";
import {mkdirSync} from "node:fs";
import {isAbsolute,join,resolve} from "node:path";
import {initializeSchema} from "./schema.mjs";
/** P1 still requires a process-level writer lock; this is not yet a production entrypoint. */
export function openMainDatabase(dataDir){
 if(typeof dataDir!=="string"||!isAbsolute(dataDir))throw Error("absolute_data_dir_required");
 const root=resolve(dataDir);
 mkdirSync(join(root,"db"),{recursive:true,mode:0o700});
 const db=new DatabaseSync(join(root,"db","atelier.sqlite"));
 try{
  db.exec("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;");
  initializeSchema(db);return db;
 }catch(e){db.close();throw e}
}
