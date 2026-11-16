import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  // GitHub Pages 等のサブパス配信（/casshern_sim/）でも動くよう、資産パスは相対にする
  base: './',
  plugins: [
    wasm(),
    topLevelAwait()
  ],
  server: {
    fs: {
      // Allow serving files from one level up to the project root
      allow: ['..']
    }
  },
  optimizeDeps: {
    exclude: ['casshern_sim']
  }
});
