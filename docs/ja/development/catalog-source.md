# Catalog / Source

アプリケーションの稼働中、内部 API は `NOOBAI_INTERNAL_PORT` のループバックアドレスだけで提供されます。Catalog は、ベースモデル、生成モデル、LoRA、作品、キャラクター、画風、Prompt Tag、アーティストプロンプト列、ComfyUI インスタンス、ComfyUI テンプレートの 10 種類を検索または取得します。Source は安定した ID を使って、完全な ComfyUI 接続情報またはテンプレート一式を取得します。操作前にディスカバリー情報を読みます。

```bash
node scripts/imagegen-semantic-query.mjs --port 18083 --discovery-json
node scripts/imagegen-semantic-query.mjs --port 18083 --path /internal/semantic/characters --mode search --query frieren --page 1 --page_size 20
node scripts/imagegen-semantic-query.mjs --port 18083 --path /internal/semantic/characters --mode lookup --id 12
node scripts/imagegen-comfyui-source-read.mjs --port 18083 --discovery-json
node scripts/imagegen-comfyui-source-read.mjs --port 18083 instance --id 31
node scripts/imagegen-comfyui-source-read.mjs --port 18083 template-bundle --id 7
```

検索では、ディスカバリー情報に定義された `query`、`page`、`page_size` とリソース固有の絞り込み条件を使います。個別取得では安定した `id` を使います。成功時は標準出力に JSON を書き出します。引数、接続、タイムアウト、HTTP、契約に関するエラーが発生した場合は 0 以外の終了コードを返します。終了コードと標準エラーを保存し、アプリケーションの状態、内部ポート、ディスカバリーのレスポンスを確認します。完全な HTTP パスとフィールドは `schema/api/openapi.yaml` と稼働中のディスカバリー情報を参照します。
