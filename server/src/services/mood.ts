// 情绪球核心：把「今天」压成 valence/arousal/kind，再选一句它想说的话。
// 原则：数字只进明细，不进文案；文案先规则、后 AI；任何外部依赖失败都静默降级。

import { db, getSetting, now, setSetting } from '../db.js';
import { solarSnapshot, type SolarSnapshot } from './solar.js';
import { getLocation, getWeather, type Location, type WeatherNow } from './weather.js';

export type MoodKind = 'fresh' | 'calm' | 'busy' | 'heavy' | 'cozy' | 'lit' | 'low' | 'sleepy';
export type MoodTone = '温和' | '中性' | '冷淡' | '毒舌';
export type MoodCharacter = 'ball' | 'nimbo' | 'twinkle' | 'yoona';
export type PulseEvent = 'tick' | 'capture' | 'snooze' | 'delete' | 'remind' | 'idle';

export type MoodSignals = {
  date: string;
  weekday: number;
  hour: number;
  minuteOfDay: number;
  weekend: boolean;
  night: boolean;
  open: number;
  done: number;
  doneRatio: number;
  overdue: number;
  urgent: number;
  events: number;
  ongoing: boolean;
  nextInMin: number | null;
  backToBack: number;
  freeBlockMin: number;
  reminders: number;
  nextReminderInMin: number | null;
  fragmentsToday: number;
  streak: number;
  gapHours: number;
  stagnant: number;
  empty: boolean;
};

export type MoodConfig = { enabled: boolean; tone: MoodTone; ai: boolean; whisper: boolean; character: MoodCharacter; name: string };

export const CHARACTER_NAMES: Record<MoodCharacter, string> = {
  ball: '球球',
  nimbo: '云宝',
  twinkle: '亮亮',
  yoona: '小精灵',
};

export function assistantName(config: Pick<MoodConfig, 'character' | 'name'>): string {
  return config.name.trim() || CHARACTER_NAMES[config.character];
}

export type FaceSpec = { eyesPath: string; mouthPath: string; pupil: boolean };

export type MoodPayload = {
  ok: true;
  at: string;
  dayKey: string;
  kind: MoodKind;
  label: string;
  valence: number;
  arousal: number;
  quiet: boolean;
  line: string;
  lineId: string;
  rare: string | null;
  tone: MoodTone;
  whisper: boolean;
  ai: boolean;
  location: Location | null;
  weather: WeatherNow | null;
  solar: SolarSnapshot;
  signals: MoodSignals;
  palette: { h: number; s: number; l: number; glow: number; rim: number; dim: number };
  motion: { breathSec: number; filmSec: number };
  face: FaceSpec;
  /** 耳语词池：前端本地取，避免每勾一项都去问接口 */
  whispers: Record<PulseEvent, string[]>;
};

/* ---------------- 心情视觉规格 ---------------- */

export const KIND_ZH: Record<MoodKind, string> = {
  fresh: '清闲', calm: '平稳', busy: '忙碌', heavy: '待处理',
  cozy: '舒适', lit: '有进展', low: '待调整', sleepy: '休息时段',
};

/** 五官：眼睛是两条弧线（不是圆点），情绪靠弧度与间距表达 */
export const EYES = {
  wide: 'M32 46 Q38 38 44 46',
  calm: 'M32 45 Q38 41 44 45',
  narrow: 'M32 45 Q38 42 44 45',
  brow: 'M31 44 Q38 47 45 44',
  soft: 'M32 45 Q38 44 44 45',
  happy: 'M32 46 Q38 39 44 46',
  drop: 'M32 47 Q38 50 44 47',
  shut: 'M32 46 Q38 49 44 46',
} as const;

export const MOUTHS = {
  softUp: 'M42 62 Q50 68 58 62',
  flat: 'M43 63 L57 63',
  tight: 'M43 64 Q50 62 57 64',
  down: 'M42 66 Q50 60 58 66',
  smallUp: 'M44 62 Q50 66 56 62',
  openUp: 'M41 60 Q50 70 59 60',
  none: '',
  yawn: 'M46 62 Q50 68 54 62',
} as const;

const KIND_BASE: Record<MoodKind, { h: number; s: number; l: number; breath: number; glow: number; rim: number; dim: number; eyes: keyof typeof EYES; mouth: keyof typeof MOUTHS }> = {
  fresh:  { h: 188, s: 74, l: 62, breath: 5.5, glow: 0.62, rim: 0.34, dim: 0,    eyes: 'wide',   mouth: 'softUp' },
  calm:   { h: 258, s: 62, l: 60, breath: 6.5, glow: 0.46, rim: 0.24, dim: 0,    eyes: 'calm',   mouth: 'flat' },
  busy:   { h: 22,  s: 88, l: 60, breath: 3.2, glow: 0.86, rim: 0.5,  dim: 0,    eyes: 'narrow', mouth: 'tight' },
  heavy:  { h: 224, s: 24, l: 48, breath: 8.0, glow: 0.3,  rim: 0.14, dim: 0.12, eyes: 'brow',   mouth: 'down' },
  cozy:   { h: 268, s: 52, l: 58, breath: 7.0, glow: 0.5,  rim: 0.3,  dim: 0,    eyes: 'soft',   mouth: 'smallUp' },
  lit:    { h: 44,  s: 92, l: 62, breath: 4.5, glow: 1.0,  rim: 0.6,  dim: 0,    eyes: 'happy',  mouth: 'openUp' },
  low:    { h: 196, s: 30, l: 42, breath: 9.0, glow: 0.2,  rim: 0.1,  dim: 0.2,  eyes: 'drop',   mouth: 'none' },
  sleepy: { h: 232, s: 44, l: 50, breath: 7.5, glow: 0.34, rim: 0.18, dim: 0.08, eyes: 'shut',   mouth: 'yawn' },
};

/* ---------------- 文案池（每个 kind × 四种语气） ---------------- */

type Line = { id: string; w: string; n: string; c: string; s: string };

export const POOL: Record<MoodKind, Line[]> = {
  fresh: [
    { id: 'f1', w: '新的一天，还没有固定的形状', n: '早晨总比答案先到一步', c: '今天刚刚开始', s: '太阳照常上线，世界也一样' },
    { id: 'f2', w: '空白不是缺少，是一种余地', n: '留一点空白，事情会自己显形', c: '空白也有用途', s: '不是每一格都需要立刻填满' },
    { id: 'f3', w: '风还没决定今天往哪边吹', n: '今天的风看起来没有急事', c: '风还在选择方向', s: '风都没着急，可以先看看' },
    { id: 'f4', w: '一天的开头，适合留给不重要的事', n: '开头的那格空白，谁也没写过', c: '一天刚开始，什么都来得及', s: '世界刚开机，还没加载完' },
    { id: 'f5', w: '露水也是连夜赶来的，只是没人问', n: '清晨的凉是夜里慢慢攒下的', c: '早晨的凉，是夜的余额', s: '露水起得比谁都早，也没喊累' },
    { id: 'f6', w: '光刚到，影子还没站稳', n: '太阳刚上来，影子还很短', c: '光刚铺开，路还很长', s: '太阳已经上线，影子还在路上' },
  ],
  calm: [
    { id: 'c1', w: '平静不是停下，只是少了噪音', n: '普通的一天也有自己的纹理', c: '今天没有太多噪音', s: '安静的时候，细节会自己出现' },
    { id: 'c2', w: '有些答案适合晚一点出现', n: '没想明白的事，也可以先放着', c: '答案不用总是立刻出现', s: '想不通时，时间偶尔比人聪明' },
    { id: 'c3', w: '窗外没有剧情，也挺耐看', n: '今天的天空很擅长保持普通', c: '天空今天很普通', s: '没有大事发生，也是一种消息' },
    { id: 'c4', w: '不动声色的日子，走得最远', n: '平稳的日子没有台词', c: '没有剧情的一天，也算完整', s: '今天毫无新闻，这很难得' },
    { id: 'c5', w: '水面平了，才照得见天', n: '安静下来，反光就出现了', c: '平静也是一种透明', s: '水不折腾自己，才照得见云' },
    { id: 'c6', w: '钟摆左右走，其实一直在原地', n: '摆来摆去，也是钟表的正事', c: '钟摆只是在自己的范围里往来', s: '钟摆荡了半天，也没离开表盘' },
  ],
  busy: [
    { id: 'b1', w: '钟表很忙，但每次也只走一格', n: '时间走得快，云倒是不着急', c: '钟表只会一格一格走', s: '再快的钟，也不能一次走两格' },
    { id: 'b2', w: '声音多的时候，安静会更清楚', n: '热闹只是声音比较多', c: '今天的空气有点热闹', s: '世界很吵，窗外倒是照常' },
    { id: 'b3', w: '云层挤在一起，也没有排队', n: '云很多，但天空没有变小', c: '云层今天有点拥挤', s: '云都挤成一团了，还挺自在' },
    { id: 'b4', w: '我先安静待着，需要时叫我', n: '我在这里，不打断你', c: '我先保持安静', s: '先不添声音，需要时叫我' },
    { id: 'b5', w: '风穿过很多地方，从不停下解释', n: '风也在赶路，但看起来很轻', c: '风经过一切，不带行李', s: '风忙成这样，也没听说它累' },
    { id: 'b6', w: '针脚密了，布反而更软', n: '细的部分撑起整块布', c: '密的地方，往往是承重的地方', s: '线走得再密，也要一针一针来' },
    { id: 'b7', w: '候鸟不赶时间，只认方向', n: '飞得远的东西，都不慌', c: '方向对了，快慢是小事', s: '鸟都没赶时间，急什么' },
  ],
  heavy: [
    { id: 'h1', w: '复杂的东西，也由简单部分组成', n: '看不清全貌时，先看一小块', c: '复杂不等于没有入口', s: '再乱的线，也总有一个线头' },
    { id: 'h2', w: '阴影只是光暂时没照到那里', n: '光线换个方向，样子就不同了', c: '光线正在换方向', s: '影子看着大，来源通常很小' },
    { id: 'h3', w: '天气会变，想法也会', n: '暂时没有答案，不代表没有答案', c: '变化本来就是常态', s: '世界最稳定的部分，就是会变化' },
    { id: 'h4', w: '线头露在外面的，都收得回去', n: '乱的部分，往往有一个入口', c: '再绕的线也有头', s: '毛线球再乱，也是一根线' },
    { id: 'h5', w: '石头沉底，水照样往前走', n: '重的沉下去，轻的继续流', c: '河底有石头，河水照样流', s: '石头挡得住水一秒，挡不住一天' },
    { id: 'h6', w: '夜色最重的时候，灯最亮', n: '暗的地方，光才显得具体', c: '黑到深处，灯就有了形状', s: '天黑透之前，总有一盏灯' },
  ],
  cozy: [
    { id: 'z1', w: '阴天把世界的音量调低了一点', n: '云层替天空加了一层柔光', c: '今天的光线很安静', s: '天空把亮度调低了，但没关机' },
    { id: 'z2', w: '雨声像天气写的白噪音', n: '雨把远处的声音都磨圆了', c: '雨声正在重复自己', s: '下雨是天空最长的一段循环播放' },
    { id: 'z3', w: '舒服的天气，适合发一会儿呆', n: '温度刚好时，空气很容易被忽略', c: '今天的温度刚刚好', s: '天气没什么意见，这很好' },
    { id: 'z4', w: '毯子的作用，是把时间裹慢一点', n: '暖的东西都擅长拖时间', c: '暖是时间的慢放', s: '毯子一盖，世界降到慢速档' },
    { id: 'z5', w: '茶凉之前，正好够想一件事', n: '热饮有自己的时间表', c: '杯子暖着，节奏就可以慢', s: '茶不催人，它自己也在慢慢凉' },
    { id: 'z6', w: '窗外的雨声，是屋子的一部分', n: '雨在外面，安静在里面', c: '雨声反而把屋子关得更紧', s: '下雨天，屋子会变大' },
  ],
  lit: [
    { id: 'l1', w: '光落下来的时候，从不解释自己', n: '今天的光线很有主见', c: '今天的光很亮', s: '太阳按时上线，也不写更新说明' },
    { id: 'l2', w: '有些好消息，只是事情发生了', n: '变化已经发生，声音反而不大', c: '今天有一点新变化', s: '世界更新时，通常没有进度条' },
    { id: 'l3', w: '笑意和光一样，不需要理由', n: '偶尔高兴，不必先写说明', c: '今天可以轻松一点', s: '好心情不需要提交申请' },
    { id: 'l4', w: '东西亮起来，是因为被擦过了', n: '亮的部分都有来历', c: '光泽是被时间磨出来的', s: '亮，通常不是天上掉下来的' },
    { id: 'l5', w: '种子发芽前，土面毫无动静', n: '变化常从看不见的地方开始', c: '动静小，不代表没在长', s: '地面平静，地下热闹' },
    { id: 'l6', w: '开灯只是按钮，亮是整个房间的事', n: '一处亮了，四周也跟着清楚', c: '光一到，边界就变软', s: '一盏灯亮了，整个房间都沾光' },
  ],
  low: [
    { id: 'w1', w: '钟表只负责走，不负责催人', n: '时间经过这里，没有留下评语', c: '时间没有在催谁', s: '钟表意见很多，可惜它不会说话' },
    { id: 'w2', w: '暂时安静，也是一种状态', n: '没有发生什么，也不算浪费', c: '今天安静了一会儿', s: '世界偶尔也会停在加载画面' },
    { id: 'w3', w: '慢和停下，其实是两回事', n: '速度变慢，方向依然可以存在', c: '慢一点也还是在经过', s: '进度条不动时，也可能在后台运行' },
    { id: 'w4', w: '潮水退下去，是为了再上来', n: '退潮也是海的一部分', c: '退回去的水，带走了泥沙', s: '海退一步，是换口气，不是认输' },
    { id: 'w5', w: '电池低电量，也还够走到充电的地方', n: '电量低的时候，灯先暗下来', c: '省电模式也是一种续航', s: '低电量的灯，反而更省电' },
    { id: 'w6', w: '云散之前，天空看起来毫无进展', n: '雾散是一个缓慢的过程', c: '散开之前，都像停着', s: '雾不着急，它知道自己会散' },
  ],
  sleepy: [
    { id: 's1', w: '夜晚把白天的边缘藏起来了', n: '夜里很多东西只剩下轮廓', c: '夜色已经很深了', s: '夜色是世界自带的深色模式' },
    { id: 's2', w: '天还没亮，城市已经有了声音', n: '清晨是夜晚慢慢退出的过程', c: '天还没有完全亮', s: '太阳还在登录，稍等一下' },
    { id: 's3', w: '梦大概是大脑的离线模式', n: '睡眠像一次不显示进度的更新', c: '夜晚适合减少一点声音', s: '该休息时，连月亮都只开省电模式' },
    { id: 's4', w: '灯一盏一盏灭，夜一层一层深', n: '城市在关灯，按自己的顺序', c: '夜是逐块熄灭的画', s: '灯先睡，夜慢慢接管' },
    { id: 's5', w: '枕头只接住梦，不接别的事', n: '夜里的脑袋只负责做梦', c: '梦是大脑的私人影院', s: '枕头很忙，装了一晚上的梦' },
    { id: 's6', w: '星星亮了一夜，没人给它充电', n: '星星是免费亮着的灯', c: '有的灯，从来不插电', s: '星星通宵营业，也不喊累' },
  ],
};

/** 稀有句：一天最多一条，命中即压掉常规文案 */
export const RARE: Record<string, string> = {
  midnight: '午夜过后，日期比人先翻了一页',
  early: '天还没全亮，颜色已经先到了',
  blank: '空白的一天，也是一种完整形状',
  absent: '隔了一阵再见，光线已经换了方向',
  sunset: '晚霞很短，所以每次都像限时供应',
  sunrise: '第一束光，总比闹钟更自然',
  storm: '雷声很大，其实只是空气在震动',
  heat: '今天的太阳似乎忘了调低功率',
  cold: '冷空气把远处的轮廓变清楚了',
  snow: '雪把世界临时改成了留白模式',
  streak: '重复久了，也会长出自己的节奏',
  restreak: '每天经过同一处，也会看见不同的光',
};

/** 耳语：回应动作用的短语气词，不占主文案 */
export const WHISPER: Record<PulseEvent, string[]> = {
  tick: ['已完成', '进度已更新', '收到'],
  capture: ['已记录', '收到', '已保存'],
  snooze: ['已顺延', '时间已更新', '已调整'],
  delete: [],
  remind: ['提醒已设置', '到点提醒你'],
  idle: ['我在', '今天的云挺有想法', '刚刚有一束光路过', '世界正在后台运行'],
};

/* ---------------- 信号采集 ---------------- */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const pad = (n: number) => String(n).padStart(2, '0');

function localStamp(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 连续天数：从今天（或昨天）往前，每天都有至少一项完成 */
function completionStreak(today: string): number {
  const rows = db.prepare(
    `SELECT DISTINCT substr(completed_at,1,10) d FROM tasks
     WHERE status='done' AND deleted_at IS NULL AND completed_at >= date('now','localtime','-30 day')`,
  ).all() as Array<{ d: string }>;
  const set = new Set(rows.map((r) => r.d));
  let n = 0;
  const cursor = new Date();
  if (!set.has(today)) cursor.setDate(cursor.getDate() - 1); // 今天还没做完，不算断
  for (let i = 0; i < 30; i++) {
    const key = localStamp(cursor).slice(0, 10);
    if (!set.has(key)) break;
    n++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return n;
}

export function readConfig(): MoodConfig {
  const m = getSetting<Partial<MoodConfig>>('mood') ?? {};
  const tones: MoodTone[] = ['温和', '中性', '冷淡', '毒舌'];
  const characters: MoodCharacter[] = ['ball', 'nimbo', 'twinkle'];
  return {
    enabled: m.enabled !== false,
    tone: tones.includes(m.tone as MoodTone) ? (m.tone as MoodTone) : '温和',
    ai: m.ai !== false,
    whisper: m.whisper !== false,
    character: characters.includes(m.character as MoodCharacter) ? (m.character as MoodCharacter) : 'ball',
    name: m.character === 'yoona' ? '' : typeof m.name === 'string' ? m.name.trim().slice(0, 20) : '',
  };
}

type MoodState = {
  lastSeenAt?: string;
  firstSeenAt?: string;
  gapHours?: number;
  /** 最近用过的文案 id（防重复） */
  lines?: string[];
  /** 说过的话（带日期，最新在前，留 30 条）：AI 润色的「别重复」与「接得上」素材 */
  history?: Array<{ d: string; text: string }>;
  /** 本时段已定的那句：刷新不改口（天气码参与 key，天况变了就重选） */
  plan?: { dayKey: string; bucket: number; kind: MoodKind; id: string; text: string; rare: string | null; wcode?: number | null };
  /** 今天是否已经用过稀有句（一天最多一条） */
  rareDay?: string;
  rareId?: string;
};

function readState(): MoodState {
  return getSetting<MoodState>('mood_state') ?? {};
}

/** 页面挂载时调用：先算出「隔了多久没来」，再刷新在场时间。从没记过时返回 0（不把初次使用当成久别重逢）。 */
export function markSeen(): number {
  const st = readState();
  const stamp = now();
  let gapHours = 0;
  if (st.lastSeenAt) {
    const prev = new Date(st.lastSeenAt).getTime();
    if (Number.isFinite(prev)) gapHours = Math.max(0, Math.round(((Date.now() - prev) / 3600000) * 10) / 10);
  }
  setSetting('mood_state', { ...st, firstSeenAt: st.firstSeenAt ?? stamp, lastSeenAt: stamp, gapHours });
  return gapHours;
}

export function collectSignals(gapHours: number): MoodSignals {
  const cappedGap = Math.min(Math.max(0, gapHours || 0), 24 * 30);
  const d = new Date();
  const today = localStamp(d).slice(0, 10);
  const stamp = localStamp(d);
  const minuteOfDay = d.getHours() * 60 + d.getMinutes();
  const weekend = d.getDay() === 0 || d.getDay() === 6;

  const taskRows = db.prepare(
    `SELECT id, status, priority, planned_date FROM tasks
     WHERE deleted_at IS NULL AND (planned_date = ? OR (planned_date IS NULL AND substr(due_at,1,10) = ?))`,
  ).all(today, today) as Array<{ id: number; status: string; priority: number; planned_date: string | null }>;
  const done = taskRows.filter((t) => t.status === 'done').length;
  const open = taskRows.length - done;
  const overdue = (db.prepare(
    `SELECT COUNT(*) n FROM tasks WHERE deleted_at IS NULL AND status != 'done'
     AND planned_date IS NOT NULL AND planned_date < ?`,
  ).get(today) as { n: number }).n;
  const urgent = taskRows.filter((t) => t.status !== 'done' && t.priority >= 1).length;

  const eventRows = db.prepare(
    `SELECT title, start_at, end_at, is_all_day FROM events
     WHERE substr(start_at,1,10) = ? AND start_at <= ? ORDER BY start_at`,
  ).all(today, `${today}T23:59:59`) as Array<{ title: string; start_at: string; end_at: string | null; is_all_day: number }>;

  let ongoing = false;
  let nextInMin: number | null = null;
  for (const e of eventRows) {
    if (e.is_all_day) continue;
    const end = e.end_at && e.end_at > e.start_at ? e.end_at : `${e.start_at.slice(0, 11)}23:59:59`;
    if (e.start_at <= stamp && end >= stamp) ongoing = true;
    if (e.start_at > stamp) {
      const mins = Math.round((new Date(e.start_at).getTime() - d.getTime()) / 60000);
      nextInMin = nextInMin == null ? mins : Math.min(nextInMin, mins);
    }
  }
  // 连续场次：往后看，间隔 ≤15 分钟视为连着
  const ahead = eventRows.filter((e) => !e.is_all_day && e.start_at > stamp);
  let backToBack = ongoing ? 1 : 0;
  let run = 0;
  let prevEnd: string | null = null;
  for (const e of ahead) {
    if (prevEnd) {
      const gapMin = (new Date(e.start_at).getTime() - new Date(prevEnd).getTime()) / 60000;
      if (gapMin > 15) run = 0;
    }
    run++;
    backToBack = Math.max(backToBack, run);
    prevEnd = e.end_at && e.end_at > e.start_at ? e.end_at : `${e.start_at.slice(0, 11)}23:59:59`;
  }
  // 今天还剩多长一段完整时间（下一场之前）
  const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 22, 0, 0);
  const cutoff = Math.min(+dayEnd, nextInMin == null ? +dayEnd : d.getTime() + nextInMin * 60000);
  const freeBlockMin = ongoing ? 0 : Math.max(0, Math.round((cutoff - d.getTime()) / 60000));

  const rem = db.prepare(
    `SELECT COUNT(*) n, MIN(trigger_at) next FROM reminders
     WHERE status='pending' AND deleted_at IS NULL AND trigger_at >= ?`,
  ).get(stamp) as { n: number; next: string | null };
  const fragmentsToday = (db.prepare(
    `SELECT COUNT(*) n FROM fragments WHERE deleted_at IS NULL AND substr(created_at,1,10) = ?`,
  ).get(today) as { n: number }).n;
  // 停滞项目数：只参与心情打分（球面的「气色」），不再进文案
  const stagnant = (db.prepare(
    `SELECT COUNT(*) n FROM projects p
     WHERE p.status='active' AND p.deleted_at IS NULL
       AND (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.deleted_at IS NULL AND t.status!='done') > 0
       AND (SELECT MAX(substr(completed_at,1,10)) FROM tasks t WHERE t.project_id=p.id AND t.deleted_at IS NULL) IS NOT NULL
       AND (SELECT MAX(substr(completed_at,1,10)) FROM tasks t WHERE t.project_id=p.id AND t.deleted_at IS NULL)
           < date('now','localtime','-7 day')`,
  ).get() as { n: number }).n;

  return {
    date: today,
    weekday: d.getDay(),
    hour: d.getHours(),
    minuteOfDay,
    weekend,
    night: d.getHours() < 5 || d.getHours() >= 23,
    open,
    done,
    doneRatio: taskRows.length ? done / taskRows.length : 0,
    overdue,
    urgent,
    events: eventRows.length,
    ongoing,
    nextInMin,
    backToBack,
    freeBlockMin,
    reminders: rem.n,
    nextReminderInMin: rem.next ? Math.round((new Date(rem.next).getTime() - d.getTime()) / 60000) : null,
    fragmentsToday,
    streak: completionStreak(today),
    gapHours: cappedGap,
    stagnant,
    empty: taskRows.length === 0 && eventRows.length === 0,
  };
}

/* ---------------- 打分与归类 ---------------- */

export function deriveMood(S: MoodSignals, weather: WeatherNow | null, daylight: number) {
  let v = 0;
  let a = 0;
  if (weather) v += weather.valence;
  v += daylight > 0.7 ? 0.1 : daylight < 0.25 ? -0.14 : 0;
  if (S.weekend) v += 0.12;
  v -= Math.min(0.5, S.overdue * 0.17);
  v += S.doneRatio >= 0.6 ? 0.3 : S.doneRatio >= 0.3 ? 0.1 : 0;
  if (S.backToBack >= 2) v -= 0.26;
  if (S.stagnant > 0) v -= Math.min(0.18, S.stagnant * 0.06);
  if (S.empty) v += 0.06;
  v += S.gapHours > 72 ? -0.16 : S.gapHours > 6 ? -0.04 : 0.04;

  a += Math.min(0.45, S.open * 0.07);
  if (S.nextInMin != null) a += clamp01((60 - S.nextInMin) / 60) * 0.42;
  a += S.urgent * 0.06;
  if (S.night) a -= 0.35;
  if (S.hour >= 22) a -= 0.24;
  else if (S.hour < 6) a -= 0.3;
  if (weather?.heat) a += 0.18;
  if (weather?.storm) a += 0.14;
  if (S.streak >= 4) a += 0.1;
  a = clamp01(a);
  v = clamp(v, -1, 1);

  let kind: MoodKind;
  if (S.night) kind = 'sleepy';
  else if (S.overdue >= 2 || v < -0.42) kind = 'heavy';
  else if ((S.nextInMin != null && S.nextInMin <= 60) || S.backToBack >= 2 || (a > 0.62 && v < 0.05)) kind = 'busy';
  else if (S.doneRatio >= 0.6 && S.open <= 3) kind = 'lit';
  else if ((weather && weather.rain > 0.5) || (weather && weather.cloud > 0.5) || (weather && weather.cold)) kind = 'cozy';
  else if (S.hour < 11 && !S.overdue && S.open + S.events <= 3) kind = 'fresh';
  else if (v < -0.16) kind = 'low';
  else kind = 'calm';

  return { kind, valence: Math.round(v * 100) / 100, arousal: Math.round(a * 100) / 100 };
}

/* ---------------- 文案选择 ---------------- */

const TONE_KEY: Record<MoodTone, 'w' | 'n' | 'c' | 's'> = { 温和: 'w', 中性: 'n', 冷淡: 'c', 毒舌: 's' };

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rareEvent(S: MoodSignals, weather: WeatherNow | null, solar: SolarSnapshot): string | null {
  if (S.hour < 5 && S.open > 0) return 'midnight';
  if (S.hour >= 5 && S.hour < 7 && S.open + S.events === 0) return 'early';
  if (S.empty) return 'blank';
  if (S.gapHours > 72) return 'absent';
  if (weather?.storm) return 'storm';
  if (weather?.heat) return 'heat';
  if (weather?.cold && weather.tempMin <= 0) return 'cold';
  if (weather?.snow) return 'snow';
  if (S.streak >= 7) return 'streak';
  if (solar.minutesToSunEvent != null && solar.minutesToSunEvent >= -5 && solar.minutesToSunEvent <= 12) {
    return solar.sunEventKind === 'rise' ? 'sunrise' : 'sunset';
  }
  // 节气日：一天最多一条，和其它稀有句同优先级链
  if (solar.termToday) return `term:${solar.termToday}`;
  if (S.streak >= 4 && S.streak <= 6) return 'restreak';
  return null;
}

/** 情境句已下线：工作信息只进心情球的「气色」，不再从它嘴里说出（催办由通知通道承担） */

/** 节气句：一个节气一句（配合 rareEvent 的 term 命中，一天最多一条） */
export const TERM_LINES: Record<string, string> = {
  立春: '春天的第一页总是写得比较轻',
  雨水: '雨开始替冬天收尾了',
  惊蛰: '土地里也有闹钟，只是响得慢',
  春分: '昼夜各拿一半，谁也不多占',
  清明: '雨把天空洗成旧照片的颜色',
  谷雨: '雨落进土里，就成了存货',
  立夏: '夏天上任，先从拉长白天开始',
  小满: '将满未满，是最好的刻度',
  芒种: '忙碌是有季节的，人也是',
  夏至: '今天白天最长，夜在最短处休息',
  小暑: '热还没拿出全部实力',
  大暑: '一年里太阳最认真的一天',
  立秋: '秋天上任，先从凉爽的早晨开始',
  处暑: '暑气在办交接，一天退一点',
  白露: '夜里凉下来的部分，先凝成了露',
  秋分: '昼夜又平分了一次，像重新对表',
  寒露: '露水替秋天报了实际的温度',
  霜降: '清晨的草地上铺了一层细盐',
  立冬: '冬天上任，先收紧了天光',
  小雪: '雪的名字先到了，雪还在路上',
  大雪: '天空开始练习留白',
  冬至: '夜最长的一天，过后每天都亮一点',
  小寒: '冷到了认真工作的时段',
  大寒: '一年里最冷的部分，也是最后的部分',
};

/** 规则模板：按「天 + 半天时段 + kind + 天气码」定一句，锁存期内刷新不变；三天内不重复同一句 */
function resolveLine(
  kind: MoodKind, tone: MoodTone, dayKey: string, hour: number, rareId: string | null, st: MoodState, rotate = false,
  wcode: number | null = null,
): { id: string; text: string; rare: string | null } {
  const bucket = hour < 12 ? 0 : 1; // 半天一个时段：哲理句不需要频繁换，说得越少越有分量
  const plan = st.plan;
  const planMatches = plan && plan.dayKey === dayKey && plan.bucket === bucket && plan.kind === kind
    && plan.rare === (rareId ?? null) && (plan.wcode ?? null) === wcode;
  if (planMatches && !rotate) return { id: plan!.id, text: plan!.text, rare: plan!.rare };
  const used = st.lines ?? [];
  const save = (id: string, text: string, rare: string | null) => {
    // 记忆：说过的话落进 history（去重、最新在前、留 30 条），给 AI 润色当「别重复」与「接得上」的素材
    const history = [{ d: dayKey, text }, ...(st.history ?? []).filter((h) => h.text !== text)].slice(0, 30);
    setSetting('mood_state', {
      ...st,
      history,
      lines: [...used.filter((x) => x !== id), id].slice(-12),
      plan: { dayKey, bucket, kind, id, text, rare, wcode },
    });
    return { id, text, rare };
  };
  if (rareId) {
    const text = rareId.startsWith('term:') ? TERM_LINES[rareId.slice(5)] ?? RARE.sunrise : RARE[rareId];
    return save(rareId, text, rareId);
  }
  const pool = POOL[kind];
  const seed = hash(`${dayKey}|${kind}|${bucket}|${wcode ?? 'x'}`);
  // 「换个说法」= 顺着当前这句往后挪一条；否则按时段种子挑一句最近没用过的
  const at = planMatches && rotate ? pool.findIndex((l) => l.id === plan!.id) : -1;
  let chosen: Line = at >= 0 ? pool[(at + 1) % pool.length] : pool[seed % pool.length];
  if (at < 0) {
    // 深夜偏好更短更轻的句子，像自言自语
    const shortNight = hour >= 23 || hour < 5;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[(seed + i * 7) % pool.length];
      const text = cand[TONE_KEY[tone]] || cand.n;
      if (shortNight && text.length > 12) continue;
      if (!used.slice(0, 8).includes(cand.id)) { chosen = cand; break; }
    }
  }
  return save(chosen.id, chosen[TONE_KEY[tone]] || chosen.n, null);
}

/* ---------------- 对外主入口 ---------------- */

export type MoodOptions = { seen?: boolean; refresh?: boolean; forceKind?: MoodKind; rotate?: boolean };

export async function getMoodPayload(opts: MoodOptions = {}): Promise<MoodPayload> {
  const cfg = readConfig();
  const gapHours = opts.seen ? markSeen() : readState().gapHours ?? 0;
  const signals = collectSignals(gapHours);
  const loc = getLocation();
  const weather = await getWeather(opts.refresh === true);
  const date = new Date();
  const solar = solarSnapshot(date, loc?.lat, loc?.lon);
  const scored = deriveMood(signals, weather, solar.daylight);
  const kind = opts.forceKind ?? scored.kind;
  const state = readState();

  // 稀有句：一天最多一条，命中即压掉常规文案
  const rareId = rareEvent(signals, weather, solar);
  const rareAllowed = rareId && state.rareDay !== signals.date ? rareId : null;
  // 天气码参与锁存 key：天况变了（雨→晴、雷→毛毛雨），句子跟着换，避免「嘴上打雷、头顶毛毛雨」
  const base = resolveLine(kind, cfg.tone, signals.date, signals.hour, rareAllowed, state, opts.rotate === true, weather?.code ?? null);

  // 心情轨迹落库：每天一行，回顾页以后画「本周心情」条带用（记真实打分，不吃强制 kind）
  db.prepare(
    `INSERT INTO mood_log (day, kind, valence, arousal, done, total, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       kind = excluded.kind, valence = excluded.valence, arousal = excluded.arousal,
       done = excluded.done, total = excluded.total, updated_at = excluded.updated_at`,
  ).run(signals.date, scored.kind, scored.valence, scored.arousal, signals.done, signals.done + signals.open, now(), now());

  // 气色由环境给：太阳高度角压低角度时偏暖，云层压饱和，雨天偏冷
  const alt = solar.altitudeDeg;
  const sunWarm = alt == null ? 0 : (1 - clamp01((alt + 4) / 26)) * 16;
  const b = KIND_BASE[kind];
  const h = b.h + (solar.daylight > 0.2 ? sunWarm : 0) + (weather ? -6 * weather.rain : 0);
  const s = Math.max(8, b.s - (weather ? weather.cloud * 12 : 0) - (weather?.heat ? 8 : 0));
  const l = Math.max(24, Math.min(78, b.l + (solar.daylight - 0.6) * 12 - (weather ? weather.cloud * 6 : 0)));

  return {
    ok: true,
    at: now(),
    dayKey: signals.date,
    kind,
    label: KIND_ZH[kind],
    valence: kind === scored.kind ? scored.valence : 0,
    arousal: kind === scored.kind ? scored.arousal : 0.5,
    quiet: signals.ongoing,
    line: base.text,
    lineId: base.id,
    rare: base.rare,
    tone: cfg.tone,
    whisper: cfg.whisper,
    ai: cfg.ai,
    location: loc,
    weather,
    solar,
    signals,
    palette: {
      h: Math.round(h),
      s: Math.round(s),
      l: Math.round(l),
      glow: +(b.glow * (0.72 + solar.daylight * 0.5)).toFixed(3),
      rim: b.rim,
      dim: +(b.dim + (weather ? weather.cloud * 0.1 : 0)).toFixed(3),
    },
    motion: {
      breathSec: +(b.breath * (1 - (kind === 'busy' ? 0.1 : 0) - clamp01(scored.arousal) * 0.25)).toFixed(2),
      filmSec: Math.round(17 - scored.arousal * 6),
    },
    face: { eyesPath: EYES[b.eyes], mouthPath: MOUTHS[b.mouth], pupil: b.eyes === 'wide' },
    whispers: WHISPER,
  };
}

export function moodWhisper(event: PulseEvent): string {
  const pool = WHISPER[event] ?? [];
  if (!pool.length) return '';
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 最近说过的话（新→旧）：AI 润色注入「别重复、要接得上」 */
export function recentMoodLines(limit = 8): string[] {
  return (readState().history ?? []).slice(0, limit).map((h) => h.text);
}
