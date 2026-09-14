# 設定

既定値は `config/defaults.json` と `config/vector/models.json`、環境ごとの上書きは `.env`、スクリプトの調整値はコマンド引数から読みます。優先順位はコマンド引数、環境変数、構造化された既定値です。

プラットフォーム用インストーラーは、インストール先に `.env` と固有の `NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY` を生成します。その `.env` を編集し、既存の鍵を保持してください。ソースコードから準備する場合に限り、`.env` が存在しなければ `.env.example` を `.env` にコピーします。`NOOBAI_PUBLIC_PORT` は既定 `18082` で、公開リスナーは現在 `0.0.0.0` です。`NOOBAI_INTERNAL_PORT` は既定 `18083` で、Catalog/Source は `127.0.0.1` のみです。各インストールで未使用ポートを選びます。`NOOBAI_LOG_LEVEL`、`NOOBAI_LOG_DIRECTORY`、`NOOBAI_LOG_MAX_FILE_BYTES`、`NOOBAI_LOG_MAX_ARCHIVES` は、`data/` を基準とするログのレベル、場所、サイズ、世代数を制御します。

意味検索とデータインポートには、`NOOBAI_EMBEDDING_BASE_URL`、`NOOBAI_EMBEDDING_API_KEY`、`NOOBAI_EMBEDDING_MODEL`、`NOOBAI_RERANKER_BASE_URL`、`NOOBAI_RERANKER_API_KEY`、`NOOBAI_RERANKER_MODEL` の 6 項目が必要です。2 つのサービスには、それぞれ異なる URL と認証情報を設定できます。

クライアントは各 `BASE_URL` 末尾のスラッシュを除き、Embedding には `/embeddings`、Reranker には `/rerank` を追加します。どちらも JSON の `POST` で、`Content-Type: application/json`、`Authorization: Bearer <API_KEY>`、`config/vector/models.json` の `request_timeout_ms` を使います。Embedding の本文は `{"model":"<EMBEDDING_MODEL>","input":["..."]}` です。応答の `data` は入力と同数で、各項目は 0 から連続する整数 `index` と 1,024 次元の数値配列 `embedding` を持つ必要があります。Reranker の本文は `{"model":"<RERANKER_MODEL>","query":"...","documents":["..."]}` です。応答の `results` は候補と同数で、各項目は重複せず範囲内の整数 `index` と有限数値 `relevance_score` を持つ必要があります。アプリケーションはこの実装済みプロトコルを受け入れます。

実際の資格情報は、それが属するインストール環境の `.env` に保存します。変更後は停止して再起動し、`check.bat` または `bash check.sh` を実行します。検査の成功と状態表示の期待するアドレスで反映を確認します。
