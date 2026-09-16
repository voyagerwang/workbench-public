import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderKanban, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import type { Project } from '@/types';
import { cn } from '@/lib/utils';
import { Card, CardBody } from '@/ui/card';
import { Button } from '@/ui/button';
import { Input, Textarea } from '@/ui/form';
import { Dialog, DialogContent } from '@/ui/dialog';
import { DomainBadge, EmptyState, Progress, SectionTitle } from '@/ui/primitives';

export function ProjectsView() {
  const [creating, setCreating] = useState(false);
  const { data: projects, isLoading } = useQuery({ queryKey: qk.projects, queryFn: api.projects });

  const byDomain = useMemo(() => ({
    work: (projects ?? []).filter((p) => p.domain === 'work'),
    life: (projects ?? []).filter((p) => p.domain === 'life'),
  }), [projects]);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between px-1">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">项目</h1>
          <p className="mt-0.5 text-sm text-ink-3">工作为主，生活为辅 —— 有截止的事都值得一个项目</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Plus /> 新建项目
        </Button>
      </header>

      {isLoading ? null : (projects ?? []).length === 0 ? (
        <EmptyState
          icon={<FolderKanban />}
          title="还没有项目"
          desc="项目是工作台的主心骨：一个目标、一组清单、一条进度线"
          action={<Button variant="primary" size="sm" onClick={() => setCreating(true)}>创建第一个项目</Button>}
          className="card py-12"
        />
      ) : (
        <>
          <DomainSection title="工作" list={byDomain.work} />
          <DomainSection title="生活" list={byDomain.life} />
        </>
      )}

      <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function DomainSection({ title, list }: { title: string; list: Project[] }) {
  if (list.length === 0) return null;
  return (
    <section className="space-y-3">
      <SectionTitle count={list.length}>{title}</SectionTitle>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {list.map((p) => {
          const total = (p.open_tasks ?? 0) + (p.done_tasks ?? 0);
          const pct = total ? Math.round(((p.done_tasks ?? 0) / total) * 100) : 0;
          // 停滞 = 进行中且有任务，距最近一次完成任务（从未完成过则从建项目起算）已超 14 天；天数实算
          const anchor = p.last_done_at ?? p.created_at;
          const staleDays = anchor ? Math.max(0, Math.floor((Date.now() - new Date(anchor).getTime()) / 864e5)) : 0;
          const stale = p.status === 'active' && total > 0 && staleDays >= 14;
          return (
            <Link key={p.id} to={`/projects/${p.id}`}>
              <Card className="card-hover h-full transition-transform hover:-translate-y-px">
                <CardBody className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate font-medium">{p.name}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {stale && <StaleDot />}
                      <DomainBadge domain={p.domain} />
                    </span>
                  </div>
                  {p.description && <p className="line-clamp-2 text-xs leading-relaxed text-ink-3">{p.description}</p>}
                  <Progress value={pct} />
                  <div className="flex items-center justify-between font-mono text-[11px] text-ink-4 tnum">
                    <span>{p.open_tasks ?? 0} 待办 · {p.done_tasks ?? 0} 完成</span>
                    {p.status !== 'active' ? <StatusTag status={p.status} /> :
                      stale ? <span className="text-warn">{staleDays} 天未推进</span> : pct > 0 ? `${pct}%` : null}
                  </div>
                </CardBody>
              </Card>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

const StaleDot = () => <span className="size-1.5 rounded-full bg-warn shadow-[0_0_6px_var(--color-warn)]" title="停滞中" />;

function StatusTag({ status }: { status: Project['status'] }) {
  const label = { active: '进行中', paused: '已暂停', archived: '已归档', done: '已完成' };
  if (status === 'active') return null;
  return <span className="rounded border border-line px-1 py-px text-[10px]">{label[status]}</span>;
}

function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [domain, setDomain] = useState<'work' | 'life'>('work');
  const [description, setDescription] = useState('');

  const mut = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), domain, description: description.trim() }),
    onSuccess: () => {
      toast.success('项目已创建');
      qc.invalidateQueries({ queryKey: qk.projects });
      setName(''); setDescription('');
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="新建项目">
        <div className="space-y-4 p-5">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && mut.mutate()} placeholder="项目名称" />
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话描述（可选）" />
          <div className="grid grid-cols-2 gap-1.5">
            {(['work', 'life'] as const).map((d) => (
              <button key={d} onClick={() => setDomain(d)}
                className={cn(
                  'rounded-lg border py-2 text-sm transition-all',
                  domain === d ? 'border-accent/50 bg-accent-dim text-ink' : 'border-line text-ink-3 hover:border-line-strong',
                )}>
                {d === 'work' ? '💼 工作' : '🌱 生活'}
              </button>
            ))}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button variant="primary" disabled={!name.trim() || mut.isPending} onClick={() => mut.mutate()}>创建</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 项目详情页见 ProjectDetail.tsx */
