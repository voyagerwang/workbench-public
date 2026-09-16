import type { MoodCharacter } from '@/types';
import { useMoodUi } from '@/store/mood';
import { useQuery } from '@tanstack/react-query';
import { api, qk } from '@/lib/api';

export const CHARACTER_NAMES: Record<MoodCharacter, string> = {
  ball: '球球',
  nimbo: '云宝',
  twinkle: '亮亮',
  yoona: '小精灵',
};

export function assistantName(mood?: { character?: MoodCharacter; name?: string } | null): string {
  const custom = mood?.name?.trim();
  return custom || CHARACTER_NAMES[mood?.character ?? 'ball'];
}

/** 当前助手的称呼（设置里的角色/自定义名）； MoodHeader 会把快照写进 store，任意组件可直接取。 */
export function useAssistantName(): string {
  const snapshotConfig = useMoodUi((s) => s.snapshot?.config ?? null);
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings, staleTime: 60_000 });
  return assistantName(snapshotConfig ?? settings?.mood);
}
