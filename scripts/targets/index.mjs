import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as claude from "./claude-code.mjs";
import * as codex from "./codex.mjs";
import * as dsh from "./dsh.mjs";
import * as agy from "./antigravity.mjs";
import { cleanupRuntime, guardPath, manageFiles, read, serverCommands, syncSharedRuntime } from "./shared.mjs";
import { RUNTIME_FILES, DEVTOOLS_FILES, FILES_TO_COPY, checkNodeAndSqlite, verifyMcpServer } from "../install.mjs";
export async function runTargets(src, argv, home=os.homedir()) {
  const args=[...argv], at=args.indexOf("--target");
  const names=at<0?["agy"]:String(args.splice(at,2)[1]).split(",");
  const profileAt=args.indexOf("--profile");
  const profile=profileAt<0?undefined:String(args.splice(profileAt,2)[1] ?? "");
  const mcpOnlyAt=args.indexOf("--mcp-only");
  const mcpOnly=mcpOnlyAt<0?undefined:(args.splice(mcpOnlyAt,1),true);
  const adapters={claude,codex,dsh};
  const targets=new Set(names.flatMap(name=>name==="all"?["agy",...Object.keys(adapters).filter(k=>adapters[k].detect(home))]:[name]));
  const action=args[0];
  for(const name of targets) {
    if(name!=="agy" && !Object.hasOwn(adapters,name)) throw Error("Unknown host: "+name);
    if(name!=="agy" && !["install","uninstall","doctor","status"].includes(action)) throw Error("Unsupported "+action+" for "+name);
  }
  if (action !== "uninstall" && [...targets].some(name => name !== "agy")) await checkNodeAndSqlite();
  const modifyingShared = [...targets].some(name => name !== "agy") && ["install","uninstall"].includes(action);
  const lock = path.join(home,".agy-dart","targets.lock");
  let fd;
  try {
    if (modifyingShared) {
      guardPath(lock);
      fs.mkdirSync(path.dirname(lock),{recursive:true});
      fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd,String(process.pid));
    }
    for(const name of targets) {
    if(name==="agy"){agy.run(src,args);continue;}
    const runtime=path.join(home,".agy-dart/runtime");
    const specs=adapters[name].specs(home,src,runtime,{profile,mcpOnly});
    if(action==="install") {
      const withDevtools = args.includes("--with-devtools");
      syncSharedRuntime(src,home,withDevtools?FILES_TO_COPY:RUNTIME_FILES,{preserveFiles:withDevtools?[]:DEVTOOLS_FILES});
      manageFiles(home,name,specs,action);
    } else if(action==="uninstall") {
      manageFiles(home,name,specs,action);
      cleanupRuntime(home);
    } else {
      for(const spec of specs) {
        const raw=read(spec.file);
        if(raw === null || !spec.verify(raw)) throw Error("Invalid installation: " + spec.file);
      }
      const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"agy-doctor-"));
      try {
        for(const entry of Object.values(serverCommands(runtime))) await verifyMcpServer(entry.args[0],{AGY_DART_DB_PATH:path.join(tmp,"check.db")});
      } finally {fs.rmSync(tmp,{recursive:true,force:true});}
      console.log(name+" OK");
    }
  }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }
}
