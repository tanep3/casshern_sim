# 保守メモ（リリース手順）

## バージョン規則（最重要）

**バージョンの正は GitHub のタグ `vX.Y.Z`。**
`frontend/package.json` の `appVersion` は、タグから `v` を除いたものと**必ず一致**させる。

ビルド時、Vite が `appVersion` を成果物へ刻印する：

- `index.html` の `%APP_VERSION%` を置換（設定パネル下部の表示）
- `dist/version.json` に `{"version": "X.Y.Z"}` を発行

タグより先に appVersion を上げ忘れると、公開されたサイトが古いバージョンを名乗り、
デプロイされたかどうか判別できなくなる。順序を守ること。

## リリース手順

1. `frontend/package.json` の `appVersion` を次のタグに合わせて上げる
2. ビルドして刻印を確認する（`frontend/dist/index.html` に `vX.Y.Z` 表示、
   `frontend/dist/version.json` の中身、`%APP_VERSION%` が残っていないこと）
3. 変更を main へ push する
4. GitHub Releases → Draft a new release → タグ `vX.Y.Z` を新規作成して Publish
   （タグの push で Pages ワークフローが起動し、タグのコミットからビルド・公開される）
5. 公開先 https://tanep3.github.io/casshern_sim/ を開き、設定パネル下部の
   バージョン表示と `version.json` が新しいことを確認する

## 初回だけの設定（GitHub 側）

1. Settings → Pages → Source を **GitHub Actions** にする
2. Settings → Environments → github-pages → Deployment branches and tags を
   **Selected branches and tags** にし、タグのルール `v*` を追加する
   （これを忘れるとタグからのデプロイが保護ルールで拒否される）
3. `.github/workflows/pages.yml` をリポジトリへ配置する

## 備考

- 資産パスは相対（`frontend/vite.config.ts` の `base: './'`）。Pages のサブパス
  `/casshern_sim/` でも、ローカルのドメイン直下でも動くようにするため。
  絶対パスに戻さないこと。
- キャシャーン AI の挙動確認は Pages 上の実機（PC Chrome / WebGPU）で行う。
