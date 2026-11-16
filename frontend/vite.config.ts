import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

// バージョンの正は GitHub のタグ vX.Y.Z。package.json の appVersion を
// タグから 'v' を除いたものと必ず一致させる（docs/maintenance.md 参照）。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const appVersion: string = pkg.appVersion;

// ビルド成果物へバージョンを刻印する:
// - index.html 内の %APP_VERSION% を置換（画面表示用）
// - dist/version.json を発行（デプロイ確認用）
function versionStamp(): Plugin {
  return {
    name: 'version-stamp',
    transformIndexHtml(html) {
      return html.replaceAll('%APP_VERSION%', appVersion);
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version: appVersion }) + '\n',
      });
    },
  };
}

export default defineConfig({
  // GitHub Pages 等のサブパス配信（/casshern_sim/）でも動くよう、資産パスは相対にする
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    wasm(),
    topLevelAwait(),
    versionStamp()
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
