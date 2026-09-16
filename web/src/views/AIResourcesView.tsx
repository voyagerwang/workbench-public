/**
 * [INPUT]: 依赖提示词 API、React Query、对话运行入口和资源库 UI 原语
 * [OUTPUT]: 提供 AI 资源库布局、Skill 管理与提示词编辑器
 * [POS]: AI 资源库页面；Skill 由任务自动提炼入库，本页只做管理；提示词编辑器负责草稿防抖自动保存与资源操作
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Circle, Copy, CopyCheck, ExternalLink, FileCode2, FileText, Library, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import type { PromptItem, SkillSummary } from '@/types';
import { notifyDeleted } from '@/lib/trash';
import { cn, relTime } from '@/lib/utils';
import { SectionTabs } from '@/components/SectionTabs';
import { Button } from '@/ui/button';
import { Field, Input, Select } from '@/ui/form';
import { EmptyState } from '@/ui/primitives';
import { Dialog } from '@/ui/dialog';

function skillOrigin(skill: SkillSummary) {
  if (skill.source === 'claude') return 'Claude';
  if (skill.source === 'plugin') return 'Codex · 插件';
  if (skill.source === 'shared') return '跨工具共享';
  if (skill.path.includes('/.system/')) return 'Codex · 内置';
  return 'Codex · 个人';
}

function sourceLabel(source: string) {
  if (source === 'assistant') return '助手';
  if (source === 'claude-code') return 'Claude Code';
  if (source === 'workspace') return '工作台';
  return source;
}

const AI_RESOURCE_TABS = [
  { to: '/ai-resources/prompts', label: '提示词' },
  { to: '/ai-resources/skills', label: 'Skill 管理' },
];

/**
 * 提示词与 Skill 是「工具资产」，不是业务知识。
 *
 * 以前它们挂在 /knowledge 下，而且 /knowledge 的默认落地页还是提示词 ——
 * 点「知识库」先看到一堆 Skill，产品边界是糊的。这里拆成独立的一级导航。
 */
export function AIResourcesLayout() {
  return <div>
    <div className="mb-5 flex flex-wrap items-center gap-3"><h1 className="text-2xl font-semibold tracking-tight">AI 资源库</h1><SectionTabs items={AI_RESOURCE_TABS} /></div>
    <Outlet />
  </div>;
}

export function SkillsView() {
  const navigate = useNavigate();
  const [skillParams] = useSearchParams();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'usage' | 'recent' | 'name'>('usage');
  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(()=>{const id=skillParams.get('skill');if(id)setActiveId(id);},[skillParams]);
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [duplicates, setDuplicates] = useState<{ exact: SkillSummary[][]; possible: SkillSummary[][] } | null>(null);
  const { data: skills = [], isPending } = useQuery({ queryKey: qk.skills, queryFn: api.skills });
  const { data: detail } = useQuery({ queryKey: [...qk.skills, activeId], queryFn: () => api.skill(activeId!), enabled: Boolean(activeId) });
  useEffect(() => { if (detail) { setContent(detail.content); setEditing(false); } }, [detail]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = q ? skills.filter((skill) => `${skill.name} ${skill.description} ${skill.path}`.toLowerCase().includes(q)) : skills;
    return [...matches].sort((a, b) => {
      if (sortBy === 'usage') return b.usageCount - a.usageCount || a.name.localeCompare(b.name, 'zh-CN');
      if (sortBy === 'recent') return (b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0) - (a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0) || a.name.localeCompare(b.name, 'zh-CN');
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }, [skills, search, sortBy]);

  const scan = useMutation({
    mutationFn: api.scanSkills,
    onSuccess: (result) => { qc.setQueryData(qk.skills, result.skills); toast.success(`扫描完成，共发现 ${result.skills.length} 个 Skill`); },
    onError: (error) => toast.error((error as Error).message),
  });
  const checkDuplicates = useMutation({
    mutationFn: api.skillDuplicates,
    onSuccess: (result) => {
      setDuplicates(result);
      const count = result.exact.length + result.possible.length;
      toast[count ? 'warning' : 'success'](count ? `发现 ${count} 组重复或疑似重复` : '没有发现重复 Skill');
    },
  });
  const save = useMutation({
    mutationFn: () => api.updateSkill(activeId!, content),
    onSuccess: (result) => { qc.invalidateQueries({ queryKey: qk.skills }); qc.setQueryData([...qk.skills, activeId], result); setEditing(false); toast.success('Skill 已保存'); },
    onError: (error) => toast.error((error as Error).message),
  });
  const remove = useMutation({
    mutationFn: (target: { id: string; name: string }) => api.deleteSkill(target.id),
    onSuccess: (result, target) => {
      setActiveId(null);
      notifyDeleted(qc, 'skills', result.trashId, target.name);
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const closeDetail = () => {
    if (editing && detail && content !== detail.content && !window.confirm('有尚未保存的修改，确定关闭吗？')) return;
    setActiveId(null);
  };

  return (
    <ResourcePage subtitle="本机方法资产 · 可查看、编辑或挂载到助手使用" actions={(
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => checkDuplicates.mutate()} disabled={checkDuplicates.isPending}><CopyCheck />检测重复</Button>
        <Button size="sm" onClick={() => scan.mutate()} disabled={scan.isPending}><RefreshCw className={cn(scan.isPending && 'animate-spin')} />扫描本机 Skill</Button>
      </div>
    )}>
      {duplicates && (duplicates.exact.length > 0 || duplicates.possible.length > 0) && (
        <div className="mb-4 rounded-xl border border-warn/25 bg-warn/10 p-3 text-xs text-ink-2">
          <div className="flex items-center justify-between"><span className="font-medium text-ink">重复检测结果</span><button onClick={() => setDuplicates(null)} className="text-ink-4 hover:text-ink">关闭</button></div>
          {[...duplicates.exact.map((group) => ({ kind: '完全重复', group })), ...duplicates.possible.map((group) => ({ kind: '名称相近', group }))].map(({ kind, group }, index) => (
            <p key={`${kind}-${index}`} className="mt-1.5"><span className="text-warn">{kind}</span> · {group.map((item) => item.name).join(' / ')}</p>
          ))}
        </div>
      )}
      <div className="min-h-[480px]">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[240px] max-w-xl flex-1"><Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-4" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 Skill 名称、说明或路径…" className="h-9 pl-9 text-xs" /></div>
          <Select aria-label="Skill 排序" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)} className="h-9 w-[128px] py-0 text-xs">
            <option value="usage">常用优先</option>
            <option value="recent">最近使用</option>
            <option value="name">按名称</option>
          </Select>
          <p className="text-xs text-ink-4">{isPending ? '正在读取…' : `${filtered.length} / ${skills.length} 个 Skill`}</p>
        </div>
        <div className="grid max-h-[calc(100vh-17rem)] min-h-[410px] grid-cols-1 content-start gap-3 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-3">
          {filtered.length ? filtered.map((skill) => (
            <button key={skill.id} onClick={() => setActiveId(skill.id)} className="card group flex min-h-[158px] flex-col overflow-hidden text-left transition-all hover:-translate-y-0.5 hover:border-line-strong hover:bg-surface-2">
              <span className="flex flex-1 flex-col px-4 pb-3 pt-4">
                <span className="flex items-center gap-2"><Circle className="size-3 fill-ok text-ok" /><span className="min-w-0 flex-1 truncate text-sm font-semibold">{skill.name}</span><span className="flex items-center gap-1 text-[10px] text-ink-4"><FileText className="size-3" />{skill.usageCount}</span></span>
                <span className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-3">{skill.description || '暂无说明'}</span>
                <span className="mt-2"><span className="inline-flex rounded-full bg-accent-dim px-2 py-1 text-[10px] text-accent">{skillOrigin(skill)}</span></span>
              </span>
              <span className="flex min-h-12 items-center justify-between border-t border-line px-4">
                <span className={cn('rounded-full px-2 py-1 text-[10px]', skill.editable ? 'bg-ok/10 text-ok' : 'bg-surface-3 text-ink-3')}>{skill.editable ? '可编辑' : '只读'}</span>
                <span className="text-[10px] text-ink-4">{skill.lastUsedAt ? `最近 ${relTime(skill.lastUsedAt)}` : '暂无调用数据'}</span>
              </span>
            </button>
          )) : <EmptyState icon={<Library />} title="没有找到 Skill" desc={search ? '换个关键词试试' : '点击右上角扫描本机安装目录'} className="col-span-full min-h-[410px]" />}
        </div>
      </div>
      <Dialog open={Boolean(activeId)} onOpenChange={(open) => {
        if (open) return;
        closeDetail();
      }} modal={false}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content className="pop-panel fixed inset-y-0 right-0 z-50 flex w-full max-w-[680px] flex-col overflow-hidden border-l border-line bg-chrome/95 data-[state=open]:animate-[panel-in_.22s_cubic-bezier(.2,.9,.3,1)]">
            <DialogPrimitive.Title className="sr-only">Skill 详情</DialogPrimitive.Title>
            {detail ? <>
              <div className="border-b border-line px-5 pb-5 pt-6 sm:px-8">
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-dim text-accent"><FileCode2 className="size-5" /></div>
                  <div className="min-w-0 flex-1"><h2 className="text-xl font-semibold tracking-tight">{detail.name}</h2><p className="mt-1 line-clamp-2 text-sm leading-relaxed text-ink-3">{detail.description || '暂无说明'}</p></div>
                  <button onClick={() => { sessionStorage.setItem('assistant-skill', JSON.stringify({ id: detail.id, name: detail.name })); navigate('/assistant'); }} className="rounded-md bg-accent px-3 py-1.5 text-xs text-white">在助手中使用</button><button onClick={closeDetail} aria-label="关闭" className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"><X className="size-4" /></button>
                </div>
                <div className="mt-5 grid gap-3 rounded-xl border border-line bg-surface-1/70 p-4 text-xs sm:grid-cols-2">
                  <div><p className="text-[10px] text-ink-4">所属工具</p><p className="mt-1 text-ink-2">{skillOrigin(detail)} · {detail.editable ? '可编辑' : '只读'}</p></div>
                  <div>
                    <p className="text-[10px] text-ink-4">调用统计</p>
                    <p className="mt-1 text-ink-2">{detail.usageCount ? `${detail.usageCount} 次${detail.lastUsedAt ? ` · 最近 ${relTime(detail.lastUsedAt)}` : ''}` : '尚未记录到调用'}</p>
                    {detail.usageCount > 0 && (
                      <p className="mt-0.5 text-[10px] text-ink-4">
                        {detail.bySource?.length
                          ? detail.bySource.map((s) => `${sourceLabel(s.source)} ${s.count} 次`).join(' · ')
                          : '仅统计工作台内调用'}
                      </p>
                    )}
                  </div>
                  <div className="sm:col-span-2"><p className="text-[10px] text-ink-4">文件位置</p><p className="mt-1 break-all font-mono text-[10px] leading-relaxed text-ink-3">{detail.path}</p></div>
                </div>
              </div>
              <div className="flex items-center justify-between border-b border-line px-5 py-3 sm:px-8">
                <div><p className="text-sm font-medium">SKILL.md</p><p className="text-[10px] text-ink-4">{editing ? '正在编辑文件内容' : '完整文件预览'}</p></div>
                <div className="flex items-center gap-2">
                  {detail.editable && editing && <Button variant="ghost" size="sm" onClick={() => { setContent(detail.content); setEditing(false); }}>取消</Button>}
                  {detail.editable && (editing ? <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || content === detail.content}><Save />保存</Button> : <Button size="sm" onClick={() => setEditing(true)}><Pencil />编辑</Button>)}
                  {detail.editable && <Button variant="dangerGhost" size="icon" title="删除 Skill（进回收站，30 天内可恢复）" onClick={() => window.confirm(`确定删除「${detail.name}」吗？目录会先移到本机回收备份，可在回收站恢复。`) && remove.mutate({ id: detail.id, name: detail.name })}><Trash2 /></Button>}
                </div>
              </div>
              {!detail.editable && <div className="border-b border-line bg-surface-2 px-5 py-2.5 text-xs text-ink-3 sm:px-8">内置 Skill 仅查看。</div>}
              <textarea value={content} onChange={(event) => setContent(event.target.value)} readOnly={!editing} spellCheck={false} className={cn('min-h-0 flex-1 resize-none bg-transparent px-5 py-5 font-mono text-xs leading-6 text-ink outline-none sm:px-8', !editing && 'cursor-default text-ink-2')} />
            </> : <div className="flex flex-1 items-center justify-center text-sm text-ink-3">正在读取 Skill…</div>}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </Dialog>
    </ResourcePage>
  );
}

export function PromptsView() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'recent' | 'name'>('recent');
  const [activeId, setActiveId] = useState<number | null>(null);
  // 全局搜索深链：/knowledge/prompts?prompt=ID 直接打开对应提示词
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const id = Number(params.get('prompt'));
    if (id) {
      setActiveId(id);
      params.delete('prompt');
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { data: prompts = [] } = useQuery({ queryKey: qk.prompts, queryFn: () => api.prompts() });
  const active = prompts.find((item) => item.id === activeId) ?? null;

  // 所有用户标签（不含来源）用于筛选
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const item of prompts) for (const tag of item.tags) set.add(tag);
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [prompts]);

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    const list = prompts.filter((item) => {
      if (activeTag && !item.tags.includes(activeTag)) return false;
      if (!q) return true;
      return `${item.title} ${item.description} ${item.tags.join(' ')} ${item.content}`.toLowerCase().includes(q);
    });
    return [...list].sort((a, b) =>
      sortBy === 'name' ? a.title.localeCompare(b.title, 'zh-CN') : b.updated_at.localeCompare(a.updated_at),
    );
  }, [prompts, activeTag, q, sortBy]);

  const copyContent = (text: string, label = '正文') => {
    navigator.clipboard.writeText(text).then(() => toast.success(`已复制${label}`), () => toast.error('复制失败'));
  };
  const runInAssistant = (text: string) => {
    sessionStorage.setItem('assistant-draft', text);
    navigate('/assistant');
  };

  const create = useMutation({ mutationFn: () => api.createPrompt({ title: '未命名提示词' }), onSuccess: (item) => { qc.invalidateQueries({ queryKey: qk.prompts }); setActiveId(item.id); } });
  const remove = useMutation({
    mutationFn: (target: { id: number; title: string }) => api.deletePrompt(target.id),
    onSuccess: (_result, target) => { setActiveId(null); notifyDeleted(qc, 'prompts', target.id, target.title); },
    onError: (error) => toast.error((error as Error).message),
  });

  return (
    <ResourcePage subtitle="" actions={<Button size="sm" onClick={() => create.mutate()}><Plus />新建提示词</Button>}>
      <div className="min-h-[480px]">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[240px] max-w-xl flex-1"><Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-4" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索提示词名称、说明、标签或正文…" className="h-9 pl-9 text-xs" /></div>
          <Select aria-label="提示词排序" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)} className="h-9 w-[120px] py-0 text-xs">
            <option value="recent">最近编辑</option>
            <option value="name">按名称</option>
          </Select>
          <p className="text-xs text-ink-4">{filtered.length} 个提示词</p>
        </div>
        {allTags.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button onClick={() => setActiveTag(null)} className={cn('rounded-full px-2.5 py-1 text-[11px] transition-colors', activeTag === null ? 'bg-accent text-white' : 'bg-surface-2 text-ink-3 hover:bg-surface-3')}>全部</button>
            {allTags.map((tag) => (
              <button key={tag} onClick={() => setActiveTag(tag)} className={cn('rounded-full px-2.5 py-1 text-[11px] transition-colors', activeTag === tag ? 'bg-accent text-white' : 'bg-surface-2 text-ink-3 hover:bg-surface-3')}>{tag}</button>
            ))}
          </div>
        )}
        <div className="grid max-h-[calc(100vh-17rem)] min-h-[410px] grid-cols-1 content-start gap-3 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-3">
          {filtered.length ? filtered.map((item) => (
            <div key={item.id} className="card group flex min-h-[158px] flex-col overflow-hidden transition-all hover:-translate-y-0.5 hover:border-line-strong hover:bg-surface-2">
              <button onClick={() => setActiveId(item.id)} className="flex flex-1 flex-col px-4 pb-3 pt-4 text-left">
                <span className="flex items-center gap-2"><Circle className="size-3 fill-accent text-accent" /><span className="min-w-0 flex-1 truncate text-sm font-semibold">{item.title || '未命名提示词'}</span><FileText className="size-3 text-ink-4" /></span>
                <span className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-3">{item.description || item.content || '暂无内容'}</span>
                <span className="mt-2 flex flex-wrap gap-1.5">
                  {item.tags.length ? item.tags.slice(0, 3).map((tag) => <span key={tag} className="rounded-full bg-accent-dim px-2 py-1 text-[10px] text-accent">{tag}</span>) : <span className="rounded-full bg-surface-3 px-2 py-1 text-[10px] text-ink-3">通用</span>}
                  {item.source && <span className="rounded-full bg-surface-3 px-2 py-1 text-[10px] text-ink-4">来自 {item.source}</span>}
                </span>
              </button>
              <span className="flex min-h-12 items-center justify-between border-t border-line px-4">
                <span className="text-[10px] text-ink-4">{item.source ? `来自 ${item.source}` : '自有提示词'}</span>
                <span className="flex items-center gap-1">
                  <button onClick={() => copyContent(item.content)} title="复制正文" className="flex size-7 items-center justify-center rounded-md text-ink-4 transition-colors hover:bg-surface-3 hover:text-ink"><Copy className="size-3.5" /></button>
                  <button onClick={() => runInAssistant(item.content)} title="在助手运行" className="flex size-7 items-center justify-center rounded-md text-ink-4 transition-colors hover:bg-surface-3 hover:text-ink"><ExternalLink className="size-3.5" /></button>
                  <span className="text-[10px] text-ink-4">更新于 {relTime(item.updated_at)}</span>
                </span>
              </span>
            </div>
          )) : <EmptyState icon={<Library />} title="还没有提示词" desc="把常用指令收进自己的提示词库" className="col-span-full min-h-[410px]" />}
        </div>
      </div>
      {active && <PromptEditor key={active.id} prompt={active} onClose={() => setActiveId(null)} onCopy={copyContent} onRun={runInAssistant} onDelete={() => window.confirm(`确定删除「${active.title || '未命名提示词'}」吗？删掉会先进回收站，30 天内可恢复。`) && remove.mutate({ id: active.id, title: active.title || '未命名提示词' })} />}
    </ResourcePage>
  );
}

function PromptEditor({ prompt, onClose, onCopy, onRun, onDelete }: {
  prompt: PromptItem; onClose: () => void; onCopy: (text: string, label?: string) => void; onRun: (text: string) => void; onDelete: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(prompt);
  const [savedDraft, setSavedDraft] = useState(prompt);
  const save = useMutation({
    mutationFn: (next: PromptItem) => api.updatePrompt(prompt.id, next),
    onSuccess: (_result, next) => { setSavedDraft(next); qc.invalidateQueries({ queryKey: qk.prompts }); },
    onError: (error) => toast.error(`自动保存失败：${(error as Error).message}`),
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);
  useEffect(() => {
    if (!dirty || save.isPending) return;
    const timer = window.setTimeout(() => save.mutate(draft), 700);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, save]);
  const close = () => {
    if (dirty && !save.isPending) save.mutate(draft);
    onClose();
  };
  return <Dialog open onOpenChange={(open) => !open && close()} modal={false}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Content className="pop-panel fixed inset-y-0 right-0 z-50 flex w-full max-w-[680px] flex-col overflow-hidden border-l border-line bg-chrome/95 data-[state=open]:animate-[panel-in_.22s_cubic-bezier(.2,.9,.3,1)]">
        <DialogPrimitive.Title className="sr-only">提示词详情</DialogPrimitive.Title>
        <div className="border-b border-line px-5 pb-5 pt-6 sm:px-8">
          <div className="flex items-start gap-3"><div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-dim text-accent"><FileText className="size-5" /></div><div className="min-w-0 flex-1"><Input autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="提示词标题" className="h-auto border-0 bg-transparent px-0 py-0 text-xl font-semibold tracking-tight" /></div><button onClick={close} aria-label="关闭" className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"><X className="size-4" /></button></div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="用途说明" hint="选填。留空时卡片自动显示正文首行，这行字也会参与搜索匹配">
              <Input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="例如：周报整理、会议纪要、需求评审" />
            </Field>
            <Field label="标签" hint="用逗号分隔，方便分类和搜索（来源集合不会混进来）">
              <Input value={draft.tags.join(', ')} onChange={(event) => setDraft({ ...draft, tags: event.target.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) })} placeholder="工作、写作、编程" />
            </Field>
          </div>
        </div>
        <div className="flex items-center justify-between border-b border-line px-5 py-3 sm:px-8"><div><p className="text-sm font-medium">提示词正文</p></div><div className="flex items-center gap-2"><Button variant="ghost" size="sm" onClick={() => onCopy(draft.content)}><Copy />复制</Button><Button variant="ghost" size="sm" onClick={() => onRun(draft.content)}><ExternalLink />在助手运行</Button><Button variant="dangerGhost" size="icon" onClick={onDelete}><Trash2 /></Button></div></div>
        <textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="输入提示词正文，可使用 {{变量}} 作为占位…" className="min-h-0 flex-1 resize-none bg-transparent px-5 py-5 font-mono text-sm leading-relaxed outline-none sm:px-8" />
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </Dialog>;
}

function ResourcePage({ subtitle, actions, children }: { subtitle: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return <div><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-ink-4">{subtitle}</p>{actions}</div>{children}</div>;
}
