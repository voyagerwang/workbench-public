/**
 * [INPUT]: React 根节点、数据路由与查询客户端
 * [OUTPUT]: 工作台启动、错误边界、嵌入式内存路由
 * [POS]: 应用装配入口，数据路由为文档离开守卫提供支持
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { StrictMode, Component } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import App from './App';
import { useTheme } from '@/store/theme';
import './globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
  },
});

/** 兜底错误边界：避免局部异常导致整页白屏 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center p-8">
          <div className="card max-w-md space-y-3 p-6 text-center">
            <p className="text-lg font-semibold">页面出错了</p>
            <p className="font-mono text-xs leading-relaxed text-ink-3">{this.state.error.message}</p>
            <button
              onClick={() => location.reload()}
              className="mx-auto block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink"
            >
              重新加载
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** 跟随主题的 Toaster */
function ThemedToaster() {
  const resolved = useTheme((s) => s.resolved);
  return (
    <Toaster
      theme={resolved}
      position="top-center"
      toastOptions={{
        style: {
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-line-strong)',
          color: 'var(--color-ink)',
          borderRadius: '12px',
        },
      }}
    />
  );
}

// 数据路由支持文档保存阻塞；嵌入宿主继续使用内存地址。
const routes = [{ path: '*', element: <App /> }];
const embedded = window.name === 'yz-workbench-frame-host' || window.name.startsWith('yz-workbench-frame-');
const router = embedded ? createMemoryRouter(routes, { initialEntries: ['/'] }) : createBrowserRouter(routes);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <ThemedToaster />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
