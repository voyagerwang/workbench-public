/**
 * [INPUT]: 可信项目根目录和明确允许的来源清单
 * [OUTPUT]: 限量来源快照、独立文件哈希和整体证据指纹
 * [POS]: 小任务验收证据采集，不递归扫描、不接受模型自行扩大文件范围
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import {realpathSync,openSync,readSync,fstatSync,closeSync,constants} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
export type SourceEvidence={digest:string;sources:ReadonlyArray<{id:string;path:string;sha256:string;text:string}>};
export function evidenceCollector(config:{projectRoot:string;paths:readonly string[];maxBytes?:number}){
 const root=realpathSync(config.projectRoot),paths=[...config.paths],maxBytes=config.maxBytes??10000;
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||paths.length<1||paths.length>8||new Set(paths).size!==paths.length)throw new Error('invalid_evidence_manifest');
 return ():SourceEvidence=>{
  let remaining=maxBytes;const seen=new Set<string>();
  const sources=paths.map((name,index)=>{
   if(typeof name!=='string'||isAbsolute(name))throw new Error('invalid_evidence_path');
   const path=realpathSync(resolve(root,name)),label=relative(root,path);
   if(!label||label==='..'||label.startsWith('../')||isAbsolute(label)||seen.has(path))throw new Error('evidence_path_outside_or_duplicate');seen.add(path);
   const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{
    if(!fstatSync(fd).isFile())throw new Error('evidence_not_file');
    const buf=Buffer.alloc(remaining+1);let size=0;
    while(size<buf.length){const n=readSync(fd,buf,size,buf.length-size,null);if(!n)break;size+=n;}
    if(size>remaining)throw new Error('evidence_budget_exceeded');remaining-=size;
    const bytes=buf.subarray(0,size),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    return Object.freeze({id:`S${index+1}`,path:label,sha256:createHash('sha256').update(bytes).digest('hex'),text});
   }finally{closeSync(fd);}
  });
  return Object.freeze({digest:createHash('sha256').update(JSON.stringify(sources)).digest('hex'),sources:Object.freeze(sources)});
 };
}
