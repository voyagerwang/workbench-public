/**
 * [INPUT]: Vite/React/Tailwind 与固定版本 PDF.js 静态资源
 * [OUTPUT]: 开发代理与生产构建，PDF 字体/CMap/WASM 随应用本地分发
 * [POS]: 构建边界；文件预览不依赖公共 CDN，开发与生产共用资源路径
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync, existsSync, createReadStream } from 'node:fs';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const r = (p: string) => new URL(p, import.meta.url).pathname;
const pdfRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const assetKinds = ['cmaps', 'standard_fonts', 'wasm'];

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'local-pdf-assets',
    generateBundle() {
      for (const kind of assetKinds) for (const file of readdirSync(join(pdfRoot, kind))) {
        this.emitFile({ type: 'asset', fileName: `pdf-assets/${kind}/${file}`, source: readFileSync(join(pdfRoot, kind, file)) });
      }
    },
    configureServer(server) {
      server.middlewares.use('/pdf-assets', (req, res, next) => {
        const match = /^\/(cmaps|standard_fonts|wasm)\/([a-zA-Z0-9_.-]+)$/.exec((req.url || '').split('?')[0]);
        if (!match) return next();
        const path = join(pdfRoot, match[1], match[2]);
        if (!existsSync(path)) return next();
        res.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        createReadStream(path).pipe(res);
      });
    },
  }],
  resolve: { alias: { '@': r('./src') } },
  server: {
    host: '127.0.0.1', // 开发服务仅本机可访问
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
