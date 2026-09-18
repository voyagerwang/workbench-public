// 设置页 · 钉钉 / 飞书群机器人推送
// 只需群里加一个「自定义机器人」，把 Webhook 贴进来即可；到点提醒会推到群消息。
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, MessageSquare, Save, Send, Trash2, Wifi } from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Card, CardBody, CardHeader, CardTitle } from '@/ui/card';
import { Button } from '@/ui/button';
import { Field, Input } from '@/ui/form';
import type { NotifyChannelKind, NotifyChannelStatus } from '@/types';

const CHANNELS: Array<{
  key: NotifyChannelKind;
  name: string;
  note: string;
  webhookPlaceholder: string;
  secretLabel: string;
  secretHint: string;
}> = [
  {
    key: 'dingtalk',
    name: '钉钉群机器人',
    note: '群设置 → 智能群助手 → 添加机器人 → 自定义（安全设置选「自定义关键词」时，关键词填成下面的前缀）',
    webhookPlaceholder: 'https://oapi.dingtalk.com/robot/send?access_token=…',
    secretLabel: '加签密钥（可选）',
    secretHint: '安全设置选「加签」时才需要，以 SEC 开头',
  },
  {
    key: 'feishu',
    name: '飞书群机器人',
    note: '群设置 → 群机器人 → 添加机器人 → 自定义机器人（安全设置可只开「自定义关键词」，填成下面的前缀）',
    webhookPlaceholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
    secretLabel: '签名校验密钥（可选）',
    secretHint: '仅在开启「签名校验」时填写',
  },
];

export function NotifyChannelsCard() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  const notify = settings?.notify;

  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) => api.saveSettings({ notify: b }),
    onSuccess: (saved) => { toast.success('已保存'); qc.setQueryData(qk.settings, saved); return qc.invalidateQueries({ queryKey: qk.settings }); },
    onError: (e) => toast.error(e.message),
  });

  const pushReminders = save.isPending && typeof save.variables?.pushReminders === 'boolean'
    ? save.variables.pushReminders : notify?.pushReminders ?? true;

  const enabledCount = CHANNELS.filter((c) => notify?.[c.key]?.enabled).length;

  return (
    <div id="settings-notify-channels" className="scroll-mt-28"><Card>
      <CardHeader>
        <CardTitle><BellRing className="size-4 text-accent" /> 通知渠道配置</CardTitle>
        <span className={cn(
          'rounded-full border px-2 py-px text-[10px]',
          enabledCount ? 'border-ok/25 bg-ok/10 text-ok' : 'border-line text-ink-3',
        )}>
          {enabledCount ? `已启用 ${enabledCount} 个群机器人` : '未启用'}
        </span>
      </CardHeader>
      <CardBody className="space-y-5 p-5">
        <p className="text-xs leading-relaxed text-ink-3">
          钉钉和飞书可同时启用。各渠道保存配置后，在上方选择默认送达方式；微信在下方扫码绑定。
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="消息前缀" hint="同时用作两边的「自定义关键词」，一眼看出是 YZ 工作台发的；改完记得同步群机器人里的关键词">
            <PrefixInput value={notify?.prefix ?? 'YZ工作台'} onSave={(v) => save.mutate({ prefix: v })} />
          </Field>
          <label className={cn(
            'flex h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs transition-colors',
            pushReminders ? 'border-accent/40 bg-accent-dim text-ink' : 'border-line text-ink-3 hover:border-line-strong',
          )}>
            <input
              type="checkbox"
              disabled={save.isPending}
              checked={pushReminders}
              onChange={(e) => save.mutate({ pushReminders: e.target.checked })}
              className="size-3.5 accent-[var(--color-accent)]"
            />
            允许外部提醒推送（含微信）
          </label>
        </div>

        {!pushReminders && <p className="text-xs text-warn">外部提醒推送已暂停，跟随设置和自定义提醒均不会发送到飞书、钉钉或微信。</p>}
        {CHANNELS.map((c) => (
          <ChannelRow
            key={c.key}
            meta={c}
            status={notify?.[c.key]}
            busy={save.isPending}
            onSave={async (b) => { await save.mutateAsync({ [c.key]: b }); }}
          />
        ))}
      </CardBody>
    </Card></div>
  );
}

function PrefixInput({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="flex items-center gap-2">
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="YZ工作台"
        maxLength={30}
        className="h-9 max-w-40 text-sm"
      />
      {text.trim() !== value && (
        <Button size="sm" variant="primary" onClick={() => onSave(text.trim())}><Save /> 保存前缀</Button>
      )}
    </div>
  );
}

function ChannelRow({
  meta, status, busy, onSave,
}: {
  meta: (typeof CHANNELS)[number];
  status?: NotifyChannelStatus;
  busy: boolean;
  onSave: (b: Record<string, unknown>) => Promise<void>;
}) {
  const [webhook, setWebhook] = useState('');
  const [secret, setSecret] = useState('');
  const configured = Boolean(status?.configured);

  const test = useMutation({
    mutationFn: () => api.testNotify({
      channel: meta.key,
      webhook: webhook.trim() || undefined,
      secret: secret.trim() || undefined,
    }),
    onSuccess: () => toast.success(`${meta.name}：已发出，去群里看一眼`),
    onError: (e) => toast.error(`${meta.name} 发送失败`, { description: e.message }),
  });

  const saveThis = async (b: Record<string, unknown>) => {
    try {
      await onSave(b);
      setWebhook('');
      setSecret('');
    } catch { /* 错误由保存 mutation 提示，保留用户输入重试 */ }
  };

  const dirty = Boolean(webhook.trim() || secret.trim());
  // 空字符串在服务端含义是「清除」，所以没填的字段不往载荷里放
  const patch = {
    ...(webhook.trim() ? { webhook: webhook.trim() } : {}),
    ...(secret.trim() ? { secret: secret.trim() } : {}),
  };

  return (
    <div id={`settings-notify-${meta.key}`} className="scroll-mt-28 space-y-3 rounded-xl border border-line bg-surface-2/50 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <MessageSquare className="size-3.5 text-accent" /> {meta.name}
        </p>
        <span className={cn(
          'rounded-full border px-1.5 py-px text-[10px]',
          status?.enabled ? 'border-ok/25 bg-ok/10 text-ok' : configured ? 'border-line text-ink-3' : 'border-line text-ink-4',
        )}>
          {status?.enabled ? '已启用' : configured ? '已保存 · 未启用' : '未配置'}
        </span>
        {status?.hasSecret && <span className="text-[10px] text-ink-4">已带密钥</span>}
      </div>
      <p className="text-[11px] leading-relaxed text-ink-4">{meta.note}</p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1.4fr_1fr]">
        <Input
          aria-label={`${meta.name} Webhook`}
          disabled={busy}
          value={webhook}
          onChange={(e) => setWebhook(e.target.value)}
          placeholder={configured && status?.hint ? `已保存：${status.hint}（粘贴新地址覆盖）` : meta.webhookPlaceholder}
          className="font-mono text-xs"
          autoComplete="off"
        />
        <Input
          type="password"
          aria-label={`${meta.name}密钥`}
          disabled={busy}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={status?.hasSecret ? '••••••••（留空不改）' : meta.secretLabel}
          className="font-mono text-xs"
          autoComplete="off"
        />
      </div>
      <p className="text-[11px] text-ink-4">{meta.secretHint}。留空表示不动已保存的密钥。</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !dirty || (!configured && !webhook.trim())}
          onClick={() => saveThis({ ...patch, enabled: true })}
        >
          <Save /> {configured ? '更新并启用' : '保存并启用'}
        </Button>
        {configured && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => { void saveThis({ enabled: !status?.enabled }); }}
          >
            <BellRing /> {status?.enabled ? '暂停此通道' : '启用此通道'}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={test.isPending || (!webhook.trim() && !configured)}
          onClick={() => test.mutate()}
        >
          <Send /> {test.isPending ? '发送中…' : '测试发送'}
        </Button>
        {configured && (
          <Button
            size="sm"
            variant="dangerGhost"
            disabled={busy}
            onClick={() => saveThis({ webhook: '', secret: '', enabled: false })}
          >
            <Trash2 /> 清除
          </Button>
        )}
        {!configured && !dirty && (
          <span className="inline-flex items-center gap-1 text-[11px] text-ink-4"><Wifi className="size-3" /> 贴上 Webhook 即可</span>
        )}
      </div>
    </div>
  );
}
