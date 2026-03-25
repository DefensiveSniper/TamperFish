/// <reference types="node" />

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 每个入口单独构建（ENTRY 环境变量指定）
// IIFE 格式 + inlineDynamicImports 确保每个产物完全自包含
const ENTRIES: Record<string, string> = {
  content_script: '',
  background: '',
  popup: '',
};

const currentDir = dirname(fileURLToPath(import.meta.url));

ENTRIES.content_script = resolve(currentDir, 'src/content_script/index.ts');
ENTRIES.background = resolve(currentDir, 'src/background/index.ts');
ENTRIES.popup = resolve(currentDir, 'src/popup/index.ts');

const entry = process.env['ENTRY'] ?? 'content_script';

export default defineConfig({
  build: {
    outDir: 'dist',
    // 只有第一个入口清空 dist/，后续追加
    emptyOutDir: entry === 'content_script',
    target: 'chrome114',
    lib: {
      entry: ENTRIES[entry],
      formats: ['iife'],
      name: 'TamperFish',
      fileName: () => `${entry}.js`,
    },
    rollupOptions: {
      output: {
        // 单入口时才可以设置 inlineDynamicImports
        inlineDynamicImports: true,
      },
    },
  },
});
