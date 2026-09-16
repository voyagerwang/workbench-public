/**
 * [INPUT]: 工作台页面、设置查询和文档离开守卫
 * [OUTPUT]: 应用路由及全局主题/快捷键接线
 * [POS]: 路由级编排，全页文档与业务列表共享详情实现
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qk } from '@/lib/api';
import { GLOBAL_SEARCH_ENABLED } from '@/lib/search';
import { AppShell } from '@/components/AppShell';
import { useUi, matchShortcut } from '@/store/ui';
import { useTheme } from '@/store/theme';
import { TodayView } from '@/views/TodayView';
import { CalendarView } from '@/views/CalendarView';
import { ProjectsView } from '@/views/ProjectsView';
import { ProjectDetail } from '@/views/ProjectDetail';
import { AIResourcesLayout, PromptsView, SkillsView } from '@/views/AIResourcesView';
import { KnowledgeArchivesView, KnowledgeLayout } from '@/views/KnowledgeView';
import { KnowledgePoolView } from '@/views/KnowledgePoolView';
import { KnowledgeDocumentView } from '@/views/KnowledgeDocumentView';
import { KnowledgeTopicDetailView, KnowledgeTopicsListView, KnowledgeTopicDocumentView } from '@/views/KnowledgeTopicsView';
import { RemindersView } from '@/views/RemindersView';
import { ReviewView } from '@/views/ReviewView';
import { SettingsView } from '@/views/SettingsView';
import { TrashView } from '@/views/TrashView';
import { DocumentView } from '@/views/DocumentView';
import { DocumentNavigationGuard } from '@/components/document/navigation';
import { NotesView } from '@/views/NotesView';
import { AssistantView } from '@/views/AssistantView';

export default function App() {
  const togglePalette = useUi((s) => s.togglePalette);
  const paletteShortcut = useUi((s) => s.paletteShortcut);

  // 全局搜索快捷键：默认 ⌘K，设置页可改绑（settings 加载后写进 ui store）
  // GLOBAL_SEARCH_ENABLED=false 时功能整体下线，不注册快捷键
  useEffect(() => {
    if (!GLOBAL_SEARCH_ENABLED) return;
    const onKey = (e: KeyboardEvent) => {
      if (matchShortcut(e, paletteShortcut)) {
        e.preventDefault();
        togglePalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePalette, paletteShortcut]);

  // 应用外观（强调色 + 主题模式）
  const initTheme = useTheme((s) => s.init);
  useEffect(() => { initTheme(); }, [initTheme]);

  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  useEffect(() => {
    if (settings?.general?.accent) {
      document.documentElement.dataset.accent = settings.general.accent;
    }
    // 以服务端设置为准校正主题模式（localStorage 丢失时恢复）
    const t = settings?.general?.theme;
    if ((t === 'auto' || t === 'light' || t === 'dark') && useTheme.getState().mode !== t) {
      useTheme.getState().setMode(t);
    }
    // 全局搜索快捷键 + 品牌名称（浏览器标签标题）
    if (settings?.general?.shortcut) useUi.getState().setPaletteShortcut(settings.general.shortcut);
    document.title = settings?.general?.appName ? `${settings.general.appName} · 工作台` : 'YZ 工作台';
  }, [settings]);

  return (
    <>
    <DocumentNavigationGuard />
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<TodayView />} />
        <Route path="/calendar" element={<CalendarView />} />
        <Route path="/inbox" element={<Navigate to="/" replace />} />
        <Route path="/projects" element={<ProjectsView />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/notes" element={<NotesView />} />
        <Route path="/documents/:kind/:id" element={<DocumentView />} />
        {/* 提示词与 Skill 是工具资产，已从知识库拆出独立导航；旧链接保留重定向 */}
        <Route path="/ai-resources" element={<AIResourcesLayout />}>
          <Route index element={<Navigate to="skills" replace />} />
          <Route path="prompts" element={<PromptsView />} />
        <Route path="skills" element={<SkillsView />} />
        </Route>
        <Route path="/knowledge" element={<KnowledgeLayout />}>
          {/* 阶段 1.5：资料池是默认页（3.1），主题第二，存档导入第三 */}
          <Route index element={<Navigate to="pool" replace />} />
          <Route path="pool" element={<KnowledgePoolView />} />
          <Route path="documents/:sourceKey" element={<KnowledgeDocumentView />} />
          <Route path="topics" element={<KnowledgeTopicsListView />} />
          <Route path="topics/:topicId" element={<KnowledgeTopicDetailView />} />
          <Route path="topics/:topicId/documents/:sourceKey" element={<KnowledgeTopicDocumentView />} />
          <Route path="notes" element={<LegacyKnowledgeNotesRedirect />} />
          <Route path="archives" element={<KnowledgeArchivesView />} />
          <Route path="prompts" element={<Navigate to="/ai-resources/prompts" replace />} />
          <Route path="skills" element={<Navigate to="/ai-resources/skills" replace />} />
        </Route>
        <Route path="/reminders" element={<RemindersView />} />
        <Route path="/review" element={<ReviewView />} />
        <Route path="/trash" element={<TrashView />} />
        <Route path="/settings" element={<SettingsView />} />
        <Route path="/assistant" element={<AssistantView />} />
      </Route>
    </Routes>
    </>
  );
}

function LegacyKnowledgeNotesRedirect() {
  const location = useLocation();
  return <Navigate to={`/notes${location.search}`} replace />;
}
