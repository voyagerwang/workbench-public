/** 事件驱动的有界调度与通知合并；单条完成不等待其他会话。 */
export function createExecutionCoordinator(deps:{lanes:Array<{limit:()=>number;tick:()=>Promise<unknown>}>;deliver:()=>Promise<void>;onError:(error:unknown)=>void}) {
  let notifying=false;let pending=false;
  const wake=()=>{for(const lane of deps.lanes)for(let i=0;i<lane.limit();i++)void lane.tick().catch(deps.onError);};
  const notify=async()=>{
    pending=true;if(notifying)return;notifying=true;
    try{while(pending){pending=false;await deps.deliver();}}
    catch(error){deps.onError(error);}
    finally{notifying=false;}
  };
  return {wake,notify,settled:()=>{wake();void notify();}};
}
