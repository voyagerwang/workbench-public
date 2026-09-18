// 设置页 · 微信 ClawBot（OpenClaw）绑定卡片
// 扫码绑定 / 状态展示 / 一键解绑
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { Smartphone, Unlink, QrCode, RefreshCw } from 'lucide-react';
import { PlatformIcon } from './DocumentAccessCard';
import { toast } from 'sonner';
import { api, qk, type ClawbotQr } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Card, CardBody, CardHeader, CardTitle } from '@/ui/card';
import { Button } from '@/ui/button';
import { Dialog, DialogContent } from '@/ui/dialog';

export function ClawbotCard() {
  const qc = useQueryClient();
  const { data: status } = useQuery({
    queryKey: qk.clawbot,
    queryFn: api.clawbotStatus,
    refetchInterval: 30_000,
  });

  const [qrOpen, setQrOpen] = useState(false);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  // 5 秒内没点第二次就取消确认，防误触
  useEffect(() => {
    if (!confirmUnbind) return;
    const t = setTimeout(() => setConfirmUnbind(false), 5_000);
    return () => clearTimeout(t);
  }, [confirmUnbind]);

  const bindMut = useMutation({
    mutationFn: api.clawbotBind,
    onSuccess: () => {
      setQrOpen(true);
      qc.invalidateQueries({ queryKey: qk.clawbot });
    },
    onError: (e) => toast.error('发起绑定失败', { description: e.message }),
  });

  const unbindMut = useMutation({
    mutationFn: api.clawbotUnbind,
    onSuccess: (r) => {
      if (r.ok) toast.success('已解绑微信 ClawBot');
      else toast.error('解绑未完全生效，可重试');
      setConfirmUnbind(false);
      qc.invalidateQueries({ queryKey: qk.clawbot });
    },
    onError: (e) => toast.error('解绑失败', { description: e.message }),
  });

  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  const setWeixin = useMutation({
    mutationFn: (v: boolean) => api.saveSettings({ notify: { weixinEnabled: v } }),
    onSuccess: (saved) => { qc.setQueryData(qk.settings, saved); return qc.invalidateQueries({ queryKey: qk.settings }); },
    onError: (e) => toast.error('保存失败', { description: e.message }),
  });

  const badge = !status?.installed
    ? { text: '未装 OpenClaw', cls: 'border-line text-ink-3' }
    : status.running
      ? { text: '已绑定 · 在线', cls: 'border-ok/25 bg-ok/10 text-ok' }
      : status.bound
        ? { text: '已绑定', cls: 'border-ok/25 bg-ok/10 text-ok' }
        : { text: '未绑定', cls: 'border-line text-ink-3' };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <PlatformIcon icon={Smartphone} />
          <span className="text-sm font-semibold text-ink">微信 · ClawBot 对话</span>
        </CardTitle>
        <span className={cn('rounded-full border px-2 py-px text-[10px]', badge.cls)}>{badge.text}</span>
      </CardHeader>
      <CardBody className="space-y-4 p-5">
        <p className="text-xs leading-relaxed text-ink-3">
          微信这里只是通讯入口。消息会原样交给工作台助手，由同一个模型、人格、记忆和工具统一处理，
          再把结果回传微信；不会额外运行一套 OpenClaw 助手。需保持 Mac 开机运行；首次使用需先在本机安装 OpenClaw 并完成初始化。
        </p>
        {status?.bound && status.account && (
          <p className="text-xs text-ink-4">当前绑定账号：{status.account}</p>
        )}
        <label className={cn(
          'flex h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs transition-colors',
          status?.bound
            ? (settings?.notify?.weixinEnabled !== false ? 'border-accent/40 bg-accent-dim text-ink' : 'border-line text-ink-3 hover:border-line-strong')
            : 'cursor-not-allowed border-line text-ink-4',
        )}>
          <input
            type="checkbox"
            checked={status?.bound ? settings?.notify?.weixinEnabled !== false : false}
            disabled={!status?.bound || setWeixin.isPending}
            onChange={(e) => setWeixin.mutate(e.target.checked)}
            className="size-3.5 accent-[var(--color-accent)]"
          />
          提醒推送到微信
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {!status?.bound && (
            <Button variant="primary" size="sm" onClick={() => bindMut.mutate()} disabled={bindMut.isPending}>
              <QrCode /> {bindMut.isPending ? '正在生成二维码…' : '扫码绑定微信'}
            </Button>
          )}
          {status?.bound && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (confirmUnbind) unbindMut.mutate();
                else setConfirmUnbind(true);
              }}
              disabled={unbindMut.isPending}
              className={confirmUnbind ? 'border-danger/50 text-danger' : ''}
            >
              <Unlink /> {unbindMut.isPending ? '解绑中…' : confirmUnbind ? '再点一次确认解绑' : '解绑'}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => qc.invalidateQueries({ queryKey: qk.clawbot })}>
            <RefreshCw /> 刷新状态
          </Button>
        </div>
        {status?.installed === false && (
          <div className="rounded-lg border border-warn/25 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
            未检测到 OpenClaw。终端执行 <code className="font-mono">npm install -g openclaw@latest</code> 安装后再来绑定。
          </div>
        )}
      </CardBody>

      <BindQrDialog open={qrOpen} onClose={() => setQrOpen(false)} onBound={() => {
        setQrOpen(false);
        qc.invalidateQueries({ queryKey: qk.clawbot });
      }} />
    </Card>
  );
}

/** 扫码弹窗：轮询二维码与绑定结果；二维码过期自动提示重新生成 */
function BindQrDialog({ open, onClose, onBound }: { open: boolean; onClose: () => void; onBound: () => void }) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'expired' | 'bound'>('loading');
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const lastUrlRef = useRef<string | null>(null);
  const boundRef = useRef(false);

  // 轮询：alive 时拿最新二维码；进程退出后看是否绑定成功
  useEffect(() => {
    if (!open) return;
    let stop = false;
    const poll = async () => {
      try {
        const r: ClawbotQr = await api.clawbotQr();
        if (stop) return;
        if (r.bound) {
          if (!boundRef.current) {
            boundRef.current = true;
            setState('bound');
            toast.success('微信绑定成功');
            setTimeout(onBound, 900);
          }
          return;
        }
        if (r.alive && r.qrUrl) {
          setState('ready');
          setQrUrl(r.qrUrl);
          if (lastUrlRef.current !== r.qrUrl) {
            lastUrlRef.current = r.qrUrl;
            setQrDataUrl(await QRCode.toDataURL(r.qrUrl, { width: 240, margin: 1 }));
          }
        } else if (!r.alive) {
          setState('expired');
        } else {
          setState('loading');
        }
      } catch {
        if (!stop) setState('loading');
      }
    };
    poll();
    const timer = setInterval(poll, 2_000);
    return () => { stop = true; clearInterval(timer); };
  }, [open, onBound]);

  const regenerate = async () => {
    setState('loading');
    lastUrlRef.current = null;
    await api.clawbotBind();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { void api.clawbotCancel(); onClose(); } }}>
      <DialogContent title="扫码绑定微信 ClawBot" className="max-w-sm">
        <div className="p-6">
          <div className="flex flex-col items-center gap-4">
            {state === 'bound' && (
              <>
                <div className="flex size-16 items-center justify-center rounded-full bg-ok/15 text-3xl">✓</div>
                <p className="text-sm font-medium text-ok">绑定成功</p>
              </>
            )}
            {state !== 'bound' && qrDataUrl && state !== 'loading' && (
              <div className={cn('rounded-xl border border-line bg-white p-3', state === 'expired' && 'opacity-40')}>
                <img src={qrDataUrl} alt="微信登录二维码" className="size-[240px]" />
              </div>
            )}
            {state !== 'bound' && state === 'loading' && (
              <div className="flex size-[264px] items-center justify-center rounded-xl border border-line text-sm text-ink-3">
                正在生成二维码…
              </div>
            )}
            {state === 'ready' && (
              <p className="text-center text-xs leading-relaxed text-ink-3">
                用手机微信「扫一扫」扫描二维码，扫码后在手机上确认授权。<br />
                二维码几分钟内有效，过期会自动提示。
              </p>
            )}
            {state === 'expired' && (
              <div className="space-y-2 text-center">
                <p className="text-xs text-ink-3">二维码已过期</p>
                <Button size="sm" variant="primary" onClick={regenerate}><RefreshCw /> 重新生成</Button>
              </div>
            )}
            {qrUrl && state === 'ready' && (
              <a href={qrUrl} target="_blank" rel="noreferrer" className="break-all text-center text-[10px] text-ink-4 hover:text-accent">
                无法扫码？在手机微信中打开此链接
              </a>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
