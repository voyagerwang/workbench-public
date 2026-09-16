import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, CloudOff, Laptop, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import { Button } from '@/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/ui/card';
import { cn } from '@/lib/utils';

export function SyncSettingsCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: qk.sync,
    queryFn: api.syncStatus,
    refetchInterval: 5_000,
  });
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: qk.sync });
    qc.invalidateQueries({ queryKey: qk.tasks });
    qc.invalidateQueries({ queryKey: qk.projects });
    qc.invalidateQueries({ queryKey: qk.fragments });
    qc.invalidateQueries({ queryKey: ['notes'] });
    qc.invalidateQueries({ queryKey: qk.reminders });
    qc.invalidateQueries({ queryKey: qk.knowledge });
    qc.invalidateQueries({ queryKey: qk.prompts });
  };
  const initMut = useMutation({
    mutationFn: api.initializeSync,
    onSuccess: ({ mode, result }) => {
      toast.success(mode === 'join'
        ? `已加入云端工作台，拉取 ${result.pulled} 条数据`
        : `云端同步已启用，上传 ${result.pushed} 条数据`);
      refreshAll();
    },
    onError: (error) => toast.error(error.message),
  });
  const syncMut = useMutation({
    mutationFn: api.syncNow,
    onSuccess: (result) => {
      toast.success(`同步完成：上传 ${result.pushed}、拉取 ${result.pulled}、附件 ${result.files}`);
      refreshAll();
    },
    onError: (error) => toast.error(error.message),
  });

  const busy = initMut.isPending || syncMut.isPending || data?.running;
  const last = data?.lastSuccessAt ? new Date(data.lastSuccessAt).toLocaleString('zh-CN', { hour12: false }) : '尚未同步';
  const status = isLoading
    ? '检查中'
    : !data?.configured
      ? '未配置'
      : !data.initialized
        ? '待初始化'
        : data.running
          ? '同步中'
          : data.lastError
            ? '同步异常'
            : '已启用';
  const healthy = Boolean(data?.configured && data.initialized && !data.lastError);

  return (
    <Card>
      <CardHeader>
        <CardTitle><Cloud className="size-4 text-accent" /> 双设备云同步</CardTitle>
        <span className={cn(
          'rounded-full border px-2 py-px text-[10px]',
          healthy ? 'border-ok/25 bg-ok/10 text-ok' : data?.lastError ? 'border-warn/25 bg-warn/10 text-warn' : 'border-line bg-surface-2 text-ink-3',
        )}>
          {status}
        </span>
      </CardHeader>
      <CardBody className="space-y-4 p-5">
        {!data?.configured ? (
          <div className="flex items-start gap-3 rounded-xl border border-line bg-surface-1 p-3">
            <CloudOff className="mt-0.5 size-4 shrink-0 text-ink-4" />
            <div className="text-xs leading-relaxed text-ink-3">
              <p className="font-medium text-ink-2">先配置 Supabase 项目</p>
              <p className="mt-1">复制 <code className="rounded bg-surface-2 px-1">.env.example</code> 为 <code className="rounded bg-surface-2 px-1">.env</code>，填写项目 URL、Secret Key 和两台电脑共用的 Workspace UUID，然后重启工作台。</p>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <div className="rounded-xl border border-line bg-surface-1 px-3 py-2.5">
                <p className="text-ink-4">当前设备</p>
                <p className="mt-1 flex items-center gap-1.5 font-medium text-ink-2"><Laptop className="size-3.5" />{data.deviceName}</p>
              </div>
              <div className="rounded-xl border border-line bg-surface-1 px-3 py-2.5">
                <p className="text-ink-4">上次成功</p>
                <p className="mt-1 font-medium text-ink-2">{last}</p>
              </div>
            </div>
            {data.lastError
              ? <p className="rounded-lg border border-warn/25 bg-warn/5 px-3 py-2 text-xs text-warn">{data.lastError}</p>
              : null}
            {!data.initialized ? (
              <div className="space-y-3">
                <p className="text-xs leading-relaxed text-ink-3">第一台已有完整数据的电脑选择“上传本机数据”；第二台电脑选择“加入云端工作台”。加入操作会替换第二台当前的任务、笔记等同步数据。</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => initMut.mutate('seed')} disabled={busy}>上传本机数据</Button>
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => {
                    if (window.confirm('确定用云端数据替换这台电脑当前的任务、笔记、提醒和知识存档吗？')) initMut.mutate('join');
                  }}>加入云端工作台</Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-ink-3">待上传 {data.pendingRows} 条 · 附件 {data.pendingFiles} 个</p>
                <Button variant="secondary" size="sm" onClick={() => syncMut.mutate()} disabled={busy}>
                  <RefreshCw className={cn(busy && 'animate-spin')} /> 立即同步
                </Button>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
