/** [INPUT]: 受保护的本地 UI 请求 [OUTPUT]: 内容任务 Skill 自动提炼的状态与重试 [POS]: Skill 自动入库薄路由 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contentTaskDraft,retryContentTaskSkillDraft } from '../services/skill-capture.js';
export default async function skillCaptureRoutes(app:FastifyInstance){
 app.addHook('preHandler',async(req)=>{
  const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip);
  if(!local&&!process.env.ACCESS_TOKEN)throw app.httpErrors.forbidden('Skill 入库状态仅允许本机访问；远程请配置访问令牌');
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.origin){
   let allowed=false;try{const o=new URL(req.headers.origin);allowed=['http:','https:'].includes(o.protocol)&&o.host===req.headers.host;}catch{}
   if(!allowed)throw app.httpErrors.forbidden('请从工作台页面执行此操作，不接受跨站请求');
  }
 });
 app.get('/api/skill-capture/content-tasks/:taskId',(req)=>contentTaskDraft(z.object({taskId:z.string().min(1).max(200)}).parse(req.params).taskId));
 app.post('/api/skill-capture/content-tasks/:taskId/retry',async(req)=>retryContentTaskSkillDraft(z.object({taskId:z.string().min(1).max(200)}).parse(req.params).taskId));
}
