# コントリビューション

開発用ツール、バージョン、プラットフォームの準備は、[インストール](../user/installation.md)を唯一の利用者向け説明とします。`fzfz/booruflow` をフォークし、自分のフォークを複製します。リポジトリに移動し、`npm ci`、`node scripts/runtime-data.mjs init --root "$PWD"` の順に実行します。`.env` が存在しない場合は `.env.example` をコピーし、開発専用のポートを選択して、[設定](../user/configuration.md)に記載された Embedding と Reranker の 6 変数をすべて入力します。既存の `NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY` は保持します。macOS では `bash bin/macos/check.sh` と `bash bin/macos/start.sh`、Windows では `bin\windows\check.bat` と `bin\windows\start.bat` を実行します。検査が成功して管理ホームが開いたらアプリケーションを停止し、目的を表す短い名前のブランチを作ります。Windows の初期化では `"$PWD"` を絶対パスに替え、例えば `node scripts\runtime-data.mjs init --root "C:\path\to\booruflow"` とします。

PR は 1 問題に限定します。小修正は直接 PR、HTTP、DB、設定契約、製品動作の変更は先に Issue で目標を決めます。機械契約、実装、正常/異常/境界テスト、文書の順に同期します。

影響を受けるテストと `npm test` を実行します。詳細は[テスト](../development/testing.md)を参照してください。`docs/locales.json` に従い、利用者向け動作の変更では四言語の文書を同じコマンド、引数、項目、既定値で更新し、各翻訳を読んで内容が揃っていることを確認します。

[PR 規範](pull-requests.md)に問題、最終動作、範囲、Issue、結果を記載します。支援は[サポート](support.md)を使います。貢献物は [MIT License](../../../LICENSE) の対象です。
