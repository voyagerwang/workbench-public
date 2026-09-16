// 设置页 · 连上你的飞书 / 钉钉
// 飞书：走官方 CLI（lark-cli）的一键授权——装工具 → 建应用 → 浏览器里点确认，全程不用填 App ID / Secret。
// 钉钉：贴一次钉钉 AI 能力中心给的 MCP 地址即可；可以连多个（日历、待办、文档…各一个），在下面统一管理和删除。
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clipboard, ExternalLink, Feather, KeyRound, Loader2, MessageSquare, Pencil, RefreshCw, Save, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent } from '@/ui/dialog';
import { api, qk } from '@/lib/api';
import type { KnowledgeAuthorizationJob, KnowledgeProvider } from '@/types';
import { Button } from '@/ui/button';
import { Card, CardBody } from '@/ui/card';
import { Input } from '@/ui/form';
import { cn } from '@/lib/utils';

type Status = NonNullable<Awaited<ReturnType<typeof api.knowledgeConnectors>>>;
type Cli = NonNullable<NonNullable<Status['cli']>[KnowledgeProvider]>;
type McpServer = Status['servers'][number];

const emptyCli = { command: null, available: false, authenticated: null, appConfigured: null, detectedAs: null, error: null, detail: null } as Cli;

const DINGTALK_HUB = 'https://aihub.dingtalk.com/#/mcp-market/mcp';
const STEPS = [
  { key: 'install', label: '装工具' },
  { key: 'app', label: '建应用' },
  { key: 'login', label: '点确认' },
] as const;
const STEPS_DINGTALK = [
  { key: 'install', label: '装工具' },
  { key: 'login', label: '扫码授权' },
] as const;

/** 授权前的就地说明：不叠加弹窗，用户确认后才真正发起系统/平台授权 */
function PermissionNotice({ title, description, actionLabel, onCancel, onConfirm }: {
  title: string;
  description: string;
  actionLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <div className="mt-2 rounded-xl border border-accent/25 bg-accent-dim/45 px-3 py-2.5">
    <p className="text-xs font-medium text-ink">{title}</p>
    <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{description}</p>
    <div className="mt-2 flex justify-end gap-2">
      <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
      <Button size="sm" onClick={onConfirm}>{actionLabel}</Button>
    </div>
  </div>;
}

function stepIndex(stage?: string): number {
  if (stage === 'detect' || stage === 'install') return 0;
  if (stage === 'app') return 1;
  if (stage === 'login' || stage === 'verify') return 2;
  return -1;
}

/** 从粘贴的内容里挑出链接：能力中心可能给纯 URL，也可能给一段 JSON 配置（钉钉的 JSON 里 URL 常被反引号包着，要去掉） */
function extractUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  const fromJson = value.match(/"(?:url|uri|serverUri|mcpUri)"\s*:\s*"([^"]+)"/i)?.[1];
  const plain = fromJson ?? (/^https?:\/\//i.test(value) ? value.split(/[\s"'，,、]/)[0] : value);
  // 去掉包裹用的反引号 / 引号 / 空白——带着它们请求必挂
  return plain.replace(/^[`'"\s]+/, '').replace(/[`'"\s]+$/, '');
}

/** 从粘贴的配置 JSON 里顺手读出能力名（钉钉配置是 {"mcpServers": {"dingtalk-calendar": {...}}} 这种） */
function extractNameFromPaste(raw: string): string | null {
  const value = raw.trim();
  if (!value.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const servers = parsed.mcpServers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      const key = Object.keys(servers)[0];
      if (key) return key.replace(/[-_]+/g, ' ').trim();
    }
    return typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null;
  } catch {
    return null;
  }
}

function useAuthJob(id: string | null) {
  return useQuery({
    queryKey: ['knowledge', 'authorization', id],
    queryFn: () => api.knowledgeAuthorizationJob(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.status === 'waiting' ? 1200 : false),
  });
}

export function DocumentAccessCard() {
  const { data: status, isPending } = useQuery({
    queryKey: qk.knowledgeConnectors,
    queryFn: api.knowledgeConnectors,
  });
  const isProviderOn = (provider: KnowledgeProvider) => {
    const cli = status?.cli?.[provider];
    // 旧版后台可能把 selections 存成单个字符串，归一成数组再遍历
    const raw = status?.selections?.[provider];
    const bound = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return Boolean(cli?.authenticated || bound.some((name) => status?.servers?.some((item) => item.name === name && item.enabled)));
  };

  // 按平台一张卡：微信在 ClawbotCard（对话入口），这里管飞书 / 钉钉的文档权限 + MCP 管理
  return <div id="document-access" className="scroll-mt-5 space-y-4">
    {status && !status.cli && (
        <div role="alert" className="rounded-xl border border-warn/25 bg-warn/10 p-3 text-xs leading-relaxed text-ink-2">
          <p className="font-medium text-warn">后台还在跑旧版本</p>
          <p className="mt-1">页面能用，但一键授权要重启一次工作台后台才会生效。你在页面上不会丢数据：菜单栏里的工作台退出再打开即可。</p>
        </div>
    )}
    {isPending ? (
      <div className="flex items-center gap-2 py-8 text-xs text-ink-3"><Loader2 className="size-4 animate-spin" />正在看你机器上的连接情况…</div>
    ) : (
      <>
        <Card>
          <CardBody className="p-5">
            <FeishuAccess status={status!} connected={isProviderOn('feishu')} />
          </CardBody>
        </Card>
        <Card>
          <CardBody className="p-5">
            <DingtalkAccess status={status!} connected={isProviderOn('dingtalk')} />
          </CardBody>
        </Card>
      </>
    )}
  </div>;
}

/** 平台图标框：三张平台卡统一用这个样式，别再各画各的 */
export function PlatformIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-accent/25 bg-accent-dim">
      <Icon className="size-3.5 text-accent" />
    </span>
  );
}

function StatusPill({ state }: { state: 'on' | 'waiting' | 'off' }) {
  const meta = state === 'on'
    ? { label: '已连上', tone: 'border-ok/25 bg-ok/10 text-ok' }
    : state === 'waiting'
      ? { label: '等你在网页里确认', tone: 'border-accent/30 bg-accent-dim text-ink' }
      : { label: '还没连', tone: 'border-line text-ink-4' };
  return <span className={cn('rounded-full border px-1.5 py-px text-[10px]', meta.tone)}>{meta.label}</span>;
}

function JobProgress({ job }: { job: KnowledgeAuthorizationJob | null }) {
  if (!job) return null;
  const dingtalk = job.provider === 'dingtalk'; // dws 没有「建应用」步，两步走
  const flow = dingtalk ? STEPS_DINGTALK : STEPS;
  let active = stepIndex(job.stage);
  if (dingtalk && active > 0) active -= 1;
  return <div className={cn('mt-3 rounded-lg border px-3 py-2.5 text-xs leading-relaxed', job.status === 'failed' ? 'border-danger/25 bg-danger/5' : 'border-accent/25 bg-accent-dim')}>
    {job.status === 'waiting' && (
      <>
        <div className="flex flex-wrap items-center gap-2">
          {flow.map((step, index) => (
            <span key={step.key} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-px text-[10px]', index < active ? 'border-ok/30 text-ok' : index === active ? 'border-accent/40 text-ink' : 'border-line text-ink-4')}>
              {index < active ? <Check className="size-3" /> : index === active ? <Loader2 className="size-3 animate-spin" /> : <span className="size-1 rounded-full bg-current" />}
              {step.label}
            </span>
          ))}
        </div>
        <p className="mt-2 text-ink-2">{job.message ?? '正在处理…'}</p>
        {job.authorizationUrl && (
          <a href={job.authorizationUrl} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-accent hover:underline">
            没看到浏览器？点这里打开 <ExternalLink className="size-3" />
          </a>
        )}
      </>
    )}
    {job.status === 'authorized' && <p className="font-medium text-ok">连上了，现在可以直接贴私有文档链接。</p>}
    {job.status === 'failed' && (
      <>
        <p className="font-medium text-danger">这步没走完</p>
        <p className="mt-1 break-words text-ink-3">{job.error}</p>
      </>
    )}
  </div>;
}

function Advanced({ title, children }: { title: string; children: React.ReactNode }) {
  return <details className="mt-3 border-t border-line pt-3">
    <summary className="cursor-pointer select-none text-[11px] text-ink-3 hover:text-ink-2">{title}</summary>
    <div className="mt-2 space-y-2">{children}</div>
  </details>;
}

function FeishuAccess({ status, connected }: { status: Status; connected: boolean }) {
  const qc = useQueryClient();
  const cli = status.cli?.feishu ?? emptyCli;
  const cliSupported = Boolean(status.cli);
  const [jobId, setJobId] = useState<string | null>(null);
  const [path, setPath] = useState(cli.command ?? '');
  const [authorizationNotice, setAuthorizationNotice] = useState(false);
  const [loginNotice, setLoginNotice] = useState(false);
  const { data: job } = useAuthJob(jobId);

  useEffect(() => {
    if (!job || job.status === 'waiting') return;
    qc.invalidateQueries({ queryKey: qk.knowledgeConnectors });
    if (job.status === 'authorized') toast.success('飞书已连上');
  }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const oneClick = useMutation({
    mutationFn: () => api.oneClickKnowledgeCli('feishu'),
    onSuccess: (value) => setJobId(value.id),
    onError: (error) => toast.error('一键连飞书没跑起来', { description: (error as Error).message }),
  });
  const loginOnly = useMutation({
    mutationFn: () => api.authorizeKnowledgeCli('feishu', path.trim() || undefined),
    onSuccess: (value) => setJobId(value.id),
    onError: (error) => toast.error((error as Error).message),
  });
  const savePath = useMutation({
    mutationFn: () => api.configureKnowledgeCli('feishu', path.trim()),
    onSuccess: () => { toast.success('已记住这个路径'); qc.invalidateQueries({ queryKey: qk.knowledgeConnectors }); },
    onError: (error) => toast.error((error as Error).message),
  });
  const test = useMutation({
    mutationFn: () => api.searchRemoteKnowledge({ provider: 'feishu', query: '', limit: 3 }),
    onSuccess: () => toast.success('飞书能读到了', { description: '已列出你最近可访问的文档' }),
    onError: (error) => toast.error('读取没成功', { description: (error as Error).message }),
  });

  const waiting = job?.status === 'waiting';
  const boundMcp = (status.selections.feishu ?? []).length;
  return <div>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-2.5">
        <PlatformIcon icon={Feather} />
        <div>
          <p className="text-sm font-semibold text-ink">飞书 · 文档与知识库</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">授权后可读飞书文档，也可让助手通过已授权的飞书 CLI 发消息。</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <StatusPill state={connected ? 'on' : waiting ? 'waiting' : 'off'} />
        <Button size="sm" variant="secondary" onClick={() => test.mutate()} disabled={test.isPending || (!connected && !boundMcp)}>
          {test.isPending ? <Loader2 className="animate-spin" /> : <Search />}测试读取
        </Button>
      </div>
    </div>

    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button size="sm" variant="primary" onClick={() => setAuthorizationNotice(true)} disabled={oneClick.isPending || waiting}>
        {oneClick.isPending || waiting ? <Loader2 className="animate-spin" /> : <ShieldCheck className="size-3.5" />}
        {connected ? '重新授权' : '授权飞书'}
      </Button>
      <span className="text-[11px] leading-relaxed text-ink-4">
        {cli.available
          ? connected ? `已授权${cli.detail ? ` · ${cli.detail.slice(0, 60)}` : ''}` : '本机已有飞书工具，点一下就完成授权'
          : '第一次会顺手装上飞书官方命令行工具（约 20 秒，需要联网）'}
      </span>
    </div>

    {authorizationNotice && (
      <PermissionNotice
        title="连接飞书前确认"
        description="用途：读取你主动添加或搜索的飞书文档与知识库。授权范围由飞书确认页展示，工作台不会申请通讯录、麦克风、摄像头或位置权限；稍后可在飞书中撤销。继续后才会安装/调用官方工具并打开飞书授权页。"
        actionLabel="继续去飞书授权"
        onCancel={() => setAuthorizationNotice(false)}
        onConfirm={() => { setAuthorizationNotice(false); oneClick.mutate(); }}
      />
    )}

    <JobProgress job={job ?? null} />

    {!connected && !job && cli.available && cli.error && (
      <p className="mt-2 text-[11px] leading-relaxed text-ink-4">CLI 报的是：{cli.error.slice(0, 240)}</p>
    )}
    {boundMcp > 0 && (
      <p className="mt-2 text-[11px] text-ink-4">另外还绑了 {boundMcp} 个 MCP 通道一起用（在钉钉卡下方能看到）。</p>
    )}

    <Advanced title="我自己弄（换台机器 / 填 CLI 路径 / 只重新登录）">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input value={path} onChange={(event) => setPath(event.target.value)} placeholder="lark-cli，或 CLI 的绝对路径" className="min-w-0 flex-1 font-mono text-xs" />
        <Button size="sm" variant="secondary" onClick={() => savePath.mutate()} disabled={!cliSupported || !path.trim() || savePath.isPending}>
          <RefreshCw className="size-3.5" />检测并保存
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setLoginNotice(true)} disabled={!cliSupported || !cli.available || loginOnly.isPending}>
          <KeyRound className="size-3.5" />只重新登录
        </Button>
      </div>
      {loginNotice && (
        <PermissionNotice
          title="重新登录前确认"
          description="用途：刷新飞书文档访问凭证，只调用你已经安装的飞书官方工具。继续后才会打开飞书登录/授权页；不会申请麦克风、摄像头、位置或通讯录权限。"
          actionLabel="继续重新登录"
          onCancel={() => setLoginNotice(false)}
          onConfirm={() => { setLoginNotice(false); loginOnly.mutate(); }}
        />
      )}
      <p className="text-[11px] leading-relaxed text-ink-4">
        装的是 npm 包 <code className="font-mono">@larksuite/cli</code>；不想让工作台自己跑安装命令的话，在终端执行{' '}
        <code className="select-all rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink">npx -y @larksuite/cli@latest install</code>{' '}
        再回来点「检测并保存」。
      </p>
    </Advanced>
  </div>;
}

function DingtalkAccess({ status, connected }: { status: Status; connected: boolean }) {
  const qc = useQueryClient();
  const cli = status.cli?.dingtalk ?? emptyCli;
  const [url, setUrl] = useState('');
  const [autoName, setAutoName] = useState(''); // 从配置 JSON 里读到的能力名（如「钉钉日历」）
  const [pendingSave, setPendingSave] = useState<string | null>(null); // 名字读不到时，弹窗让用户起名
  const [pendingName, setPendingName] = useState('');
  const [confirmName, setConfirmName] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [authorizationNotice, setAuthorizationNotice] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState(false);
  const { data: job } = useAuthJob(jobId);

  const refresh = () => qc.invalidateQueries({ queryKey: qk.knowledgeConnectors });
  useEffect(() => {
    if (!job || job.status === 'waiting') return;
    refresh();
    if (job.status === 'authorized') toast.success('钉钉已连上');
  }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const oneClick = useMutation({
    mutationFn: () => api.oneClickKnowledgeCli('dingtalk'),
    onSuccess: (value) => setJobId(value.id),
    onError: (error) => toast.error('授权没跑起来', { description: (error as Error).message }),
  });
  const probe = useMutation({
    mutationFn: () => api.searchRemoteKnowledge({ provider: 'dingtalk', query: '', limit: 3 }),
    onSuccess: () => toast.success('钉钉能读到了', { description: '已列出你最近可访问的内容' }),
    onError: (error) => toast.error('连接通了，但读取没成功', { description: (error as Error).message }),
  });
  const save = useMutation({
    mutationFn: (target: { url: string; name: string; note: string }) =>
      api.configureKnowledgeMcp({ provider: 'dingtalk', ...target, url: target.url, note: target.note || undefined }),
    onSuccess: (_value, target) => {
      setUrl('');
      setAutoName('');
      refresh();
      probe.mutate();
      toast.success(target.note ? `已连上「${target.note}」` : '已连上这个 MCP', { description: '下面列表里能看、能改名、能删' });
    },
    onError: (error) => toast.error('这个地址没存进去', { description: (error as Error).message }),
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.deleteKnowledgeMcp(name),
    onSuccess: (_data, name) => {
      setConfirmName(null);
      refresh();
      toast.success(`「${name}」已删除`, { description: 'Codex 里那条配置也一起清掉了' });
    },
    onError: (error) => toast.error('删除失败', { description: (error as Error).message }),
  });
  const rename = useMutation({
    mutationFn: ({ name, note }: { name: string; note: string }) => api.renameMcp(name, note),
    onSuccess: () => { refresh(); toast.success('名字改好了'); },
    onError: (error) => toast.error('没改成功', { description: (error as Error).message }),
  });

  const paste = async () => {
    try {
      const raw = await navigator.clipboard.readText();
      const found = extractUrl(raw);
      if (!found) {
        toast.info('剪贴板里还没有链接，去钉钉页面点「复制」再回来');
        return;
      }
      setUrl(found);
      // 名字就在配置 JSON 的第一个字段里（如「钉钉日历」），直接读出来
      setAutoName(extractNameFromPaste(raw) ?? '');
    } catch {
      toast.error('浏览器不让读剪贴板', { description: '在输入框里按 ⌘V 粘一下就行' });
    }
  };
  const doSave = (target: string, name: string) =>
    save.mutate({ url: target, name: `dingtalk_${Math.random().toString(36).slice(2, 8)}`, note: name.trim() });
  const submit = () => {
    const target = extractUrl(url);
    if (!/^https?:\/\//i.test(target)) {
      toast.error('看起来还不是链接', { description: '要以 http:// 或 https:// 开头，整段 JSON 也没关系，我会把链接挑出来' });
      return;
    }
    // 名字能从配置 JSON 读到就直接存；读不到再弹窗让你起一个，不让列表里出现认不出的名字
    const name = autoName.trim();
    if (name) doSave(target, name);
    else { setPendingSave(target); setPendingName(''); }
  };
  const waiting = job?.status === 'waiting';
  const listed = status.servers.filter((server) => (status.selections.dingtalk ?? []).includes(server.name) || server.suggestedFor === 'dingtalk');

  return <div>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-2.5">
        <PlatformIcon icon={MessageSquare} />
        <div>
          <p className="text-sm font-semibold text-ink">钉钉 · 文档 / 日历 / 待办</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">不需要开发者权限。一个能力一条 MCP，配置和结果都在这张卡里。</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <StatusPill state={connected ? 'on' : waiting ? 'waiting' : 'off'} />
        <Button size="sm" variant="secondary" onClick={() => probe.mutate()} disabled={probe.isPending || !connected}>
          {probe.isPending ? <Loader2 className="animate-spin" /> : <Search />}测试读取
        </Button>
      </div>
    </div>

    {/* ① 授权：dws 没装就自动装，装完拉起扫码 */}
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button size="sm" variant="primary" onClick={() => setAuthorizationNotice(true)} disabled={oneClick.isPending || waiting}>
        {oneClick.isPending || waiting ? <Loader2 className="animate-spin" /> : <ShieldCheck className="size-3.5" />}
        {connected ? '重新授权' : '授权钉钉'}
      </Button>
      <span className="text-[11px] leading-relaxed text-ink-4">
        {cli.available
          ? connected ? `已授权${cli.detail ? ` · ${cli.detail.slice(0, 60)}` : ''}` : '本机已有 dws，点一下在浏览器里扫码授权'
          : '第一次会自动安装钉钉官方命令行工具 dws（约 1 分钟，需要联网），然后扫码授权'}
      </span>
    </div>

    {authorizationNotice && (
      <PermissionNotice
        title="连接钉钉前确认"
        description="用途：读取你主动连接的钉钉文档、日历或待办能力。实际范围由钉钉授权页展示，工作台不会额外申请通讯录、麦克风、摄像头或位置权限；稍后可在钉钉中撤销。继续后才会安装/调用官方工具并打开扫码授权页。"
        actionLabel="继续去钉钉授权"
        onCancel={() => setAuthorizationNotice(false)}
        onConfirm={() => { setAuthorizationNotice(false); oneClick.mutate(); }}
      />
    )}

    <JobProgress job={job ? { ...job, stage: job.connectorType === 'mcp' ? 'mcp' : job.stage } : null} />

    {/* ② 配置：贴地址，名字自动从配置 JSON 里读 */}
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex size-4 items-center justify-center rounded-full bg-accent-dim text-[10px] font-semibold text-ink">1</span>
        <p className="text-xs text-ink-2">在钉钉「AI 能力中心」里挑能力（如钉钉日历），点「获取 MCP Server 配置」复制。</p>
        <Button size="sm" variant="secondary" onClick={() => window.open(DINGTALK_HUB, '_blank', 'noopener')}>
          <ExternalLink className="size-3.5" />打开钉钉页面
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex size-4 items-center justify-center rounded-full bg-accent-dim text-[10px] font-semibold text-ink">2</span>
        <Input
          value={url}
          onChange={(event) => { setUrl(event.target.value); setAutoName(''); }}
          onPaste={(event) => {
            const raw = event.clipboardData.getData('text');
            const found = extractUrl(raw);
            if (found) {
              event.preventDefault();
              setUrl(found);
              setAutoName(extractNameFromPaste(raw) ?? '');
            }
          }}
          placeholder="粘贴 MCP 地址或 JSON"
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button size="sm" variant="ghost" onClick={() => setClipboardNotice(true)}><Clipboard className="size-3.5" />读剪贴板</Button>
        <Button size="sm" variant="primary" onClick={submit} disabled={!url.trim() || save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" /> : <Check className="size-3.5" />}保存并连接
        </Button>
      </div>
      {clipboardNotice && (
        <PermissionNotice
          title="读取剪贴板前确认"
          description="只读取这一次的当前剪贴板文本，用来提取 MCP 地址和名称；不会后台持续读取，也不会保存剪贴板原文。你也可以取消后直接在输入框按 ⌘V，不需要授权。"
          actionLabel="读取这一次"
          onCancel={() => setClipboardNotice(false)}
          onConfirm={() => { setClipboardNotice(false); void paste(); }}
        />
      )}
      {autoName.trim() && <p className="text-[11px] text-ok">已从配置里读到名字：{autoName.trim()}</p>}
      <p className="text-[11px] leading-relaxed text-ink-4">
        地址里带着你的访问凭证，别转发给别人；工作台只把它写进本机 <code className="font-mono">data/workbench.db</code>，页面不再回显明文。
      </p>
    </div>

    {/* ③ 结果：配置好的 MCP 就展示在这里，配置和结果放一起 */}
    <div className="mt-4 border-t border-line pt-3">
      <p className="text-xs font-semibold text-ink">已配置的 MCP <span className="ml-1 text-[11px] font-normal text-ink-4">{listed.length} 条</span></p>
      {!listed.length ? (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-4">还没有配置过。按上面两步贴一次地址就会出现在这里。</p>
      ) : (
        <ul className="mt-2.5 space-y-2">
          {listed.map((server) => (
            <DingtalkMcpRow
              key={server.name}
              server={server}
              busy={remove.isPending || rename.isPending}
              confirming={confirmName === server.name}
              onAsk={() => setConfirmName(server.name)}
              onCancel={() => setConfirmName(null)}
              onDelete={() => remove.mutate(server.name)}
              onRename={(note) => rename.mutate({ name: server.name, note })}
            />
          ))}
        </ul>
      )}
    </div>

    {/* dws 检测到了就亮出来，没装就整块不出现 */}
    {cli.available && (
      <Advanced title="我这里装了钉钉官方命令行工具（dws）">
        <p className="text-[11px] leading-relaxed text-ink-4">
          已检测到 <code className="font-mono">{cli.command}</code>{cli.detail ? ` · ${cli.detail.slice(0, 80)}` : ''}。上面的「重新授权」用的就是它。
        </p>
      </Advanced>
    )}

    {/* 名字读不到时的起名弹窗 */}
    <Dialog open={pendingSave !== null} onOpenChange={(open) => { if (!open) setPendingSave(null); }}>
      <DialogContent title="给这个连接起个名字" className="max-w-md">
        <div className="space-y-3 p-5">
          <p className="text-xs leading-relaxed text-ink-3">未读到名称，起一个好认的名字。</p>
          <Input
            value={pendingName}
            autoFocus
            maxLength={40}
            onChange={(event) => setPendingName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && pendingName.trim()) { doSave(pendingSave!, pendingName); setPendingSave(null); }
            }}
            placeholder="例如：钉钉日历、部门周报"
          />
          <p className="truncate font-mono text-[10px] text-ink-4">{pendingSave}</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setPendingSave(null)}>取消</Button>
            <Button size="sm" onClick={() => { if (pendingName.trim()) { doSave(pendingSave!, pendingName); setPendingSave(null); } }}>
              {save.isPending ? <Loader2 className="animate-spin" /> : <Check className="size-3.5" />}保存并连接
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}

/** 钉钉卡里的单条 MCP：改名、删除；授权是卡级的，不单条发 */
function DingtalkMcpRow({
  server, busy, confirming, onAsk, onCancel, onDelete, onRename,
}: {
  server: McpServer;
  busy: boolean;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onRename: (note: string) => void;
}) {
  const displayName = server.note?.trim() || server.name;
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(server.note ?? '');
  return <li className="rounded-lg border border-line bg-surface px-3 py-2.5">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        {editingNote ? (
          <span className="flex items-center gap-1.5">
            <Input
              value={noteDraft}
              autoFocus
              maxLength={60}
              onChange={(event) => setNoteDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { onRename(noteDraft); setEditingNote(false); }
                if (event.key === 'Escape') setEditingNote(false);
              }}
              placeholder="比如：钉钉日历、部门周报"
              className="h-7 w-56 text-xs"
            />
            <Button size="xsIcon" variant="ghost" title="保存名字" disabled={busy} onClick={() => { onRename(noteDraft); setEditingNote(false); }}><Save className="size-3.5" /></Button>
            <Button size="xsIcon" variant="ghost" title="取消" onClick={() => { setNoteDraft(server.note ?? ''); setEditingNote(false); }}><X className="size-3.5" /></Button>
          </span>
        ) : (
          <p className="truncate text-xs font-medium text-ink">
            {displayName}
            <button
              type="button"
              title={server.note?.trim() ? '改名字' : '还没有名字，点一下补一个'}
              onClick={() => { setNoteDraft(server.note ?? ''); setEditingNote(true); }}
              className={cn('ml-1.5 inline-flex align-middle transition-colors hover:text-accent', server.note?.trim() ? 'text-ink-4' : 'text-accent')}
            >
              <Pencil className="size-3" />
            </button>
            {!server.enabled && <span className="ml-2 rounded-full border border-warn/30 px-1.5 text-[10px] text-warn">已停用</span>}
          </p>
        )}
        <p className="mt-0.5 truncate font-mono text-[10px] text-ink-4">
          {server.note?.trim() ? `${server.name} · ` : ''}{server.urlHint} · {server.authStatus}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {confirming ? (
          <span className="inline-flex items-center gap-1 rounded-lg border border-danger/30 bg-danger/5 px-1.5 py-0.5 text-[10px] text-danger">
            连同 Codex 里的配置一起删？
            <button type="button" className="font-medium underline-offset-2 hover:underline" disabled={busy} onClick={onDelete}>删除</button>
            <button type="button" className="text-ink-3 hover:underline" onClick={onCancel}>取消</button>
          </span>
        ) : (
          <Button size="xsIcon" variant="dangerGhost" title="删除这条 MCP" disabled={busy} onClick={onAsk}><Trash2 className="size-3.5" /></Button>
        )}
      </div>
    </div>
  </li>;
}
