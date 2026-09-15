# スクリプトの配置と保守コマンド

## 使用するバージョンのパスを選ぶ

現在のソースでは、Windows の利用者向けコマンドを `bin/windows/`、macOS のコマンドを `bin/macos/` に配置しています。インストール先のルートから `bin\windows\start.bat` または `bash bin/macos/start.sh` を実行します。他の操作も同じディレクトリの対応するファイルを使用します。引数は[日常運用](../user/operations.md)、[更新と復旧](../user/update-recovery.md)、[データ移行](../user/data-transfer.md)を参照してください。

公開済みの v0.88.0 では、これらのコマンドはルートにあります。インストールガイドと利用者ガイドのルート直下のコマンドは、この Release 用です。現在のソースでは、スクリプトのパスを上記のプラットフォーム別ディレクトリに置き換えます。Release の添付ファイル名は引き続き `install.bat` と `install.sh` です。インストール先の選択方法は[インストール](../user/installation.md)を参照してください。

インストールには対象 Release の添付インストーラーを使用します。現在のソース内のインストーラーは `bin/` 配置用です。v0.88.0 をインストールする場合は、そのバージョンの元の添付ファイルを使用してください。

## 保持するスクリプトの用途

| 配置 | 用途 |
| --- | --- |
| `scripts/runtime-data.mjs` | 初期化、更新、エクスポート、パッケージ検証、インポートの内部入口。 |
| `scripts/start-local-app.mjs` | アプリケーションの起動と正常終了。 |
| `scripts/prod-backup.mjs`、`scripts/prod-restore.mjs` | データベース、メディア、設定のバックアップと復元。 |
| `scripts/platform/` | 利用者向けのネイティブスクリプトが呼び出す共通実装。 |
| `scripts/catalog/` | Catalog 検索、ComfyUI ソースの読み取り、CLI のインストール。 |
| `scripts/maintenance/` | 6 種類のリソースのベクトル再構築。 |
| `scripts/testing/` | テスト実行、契約検査、隔離テストアプリ、OS 間のデータ交換検証。 |
| `scripts/docs/capture-screenshots.mjs` | 隔離したサンプルデータからドキュメント画像を生成。 |
| `scripts/release/tag.mjs` | 管理者が `npm run release:tag -- vX.Y.Z` で公開タグを作成して送信。 |
| `scripts/release/check-job-results.mjs`、`preflight.mjs`、`publish.mjs`、`release-context.mjs` | GitHub Actions が使うジョブ結果検査、公開前検査、公開の入口、共通の公開検証。実行条件は [CI/CD ゲート](ci-cd.md)を参照。 |

開発時の検査は[テスト](testing.md)、検索コマンドは[Catalog/Source](catalog-source.md)、公開手順は[リリース](releases.md)を参照してください。

## ベクトルを再構築する

検索ベクトルを再生成する場合、管理者はアプリを停止してバックアップを作成し、[モデル設定](../user/configuration.md)を確認してから、インストール先のルートで必要なコマンドを実行します。

```bash
node scripts/maintenance/rebuild-work-vectors.mjs --database data/app.sqlite --media-root data/media
```

ファイル名の `work` を `character`、`style`、`prompt-term`、`generation-lora`、`artist-prompt-string` に置き換えると、対応するリソースを処理できます。`--reset` を省略し、モデル名が変わっていない場合、コマンドは長さが有効な既存ベクトルを再利用し、欠落または不一致の KNN レコードを修復します。ベクトルが欠落している場合や長さが無効な場合はモデルを呼び出します。リソース内容を強制的に再ベクトル化するには `--reset` を使います。`--reset` を指定した場合、またはモデル名が変わった場合は、その種類の既存ベクトルと KNN レコードを先に削除してから、1 件ずつ再構築します。途中で失敗しても完了済みのレコードは残るため、実行前にバックアップを確認してください。出力の `failures` と終了コードを確認し、報告された問題を解決してからアプリを起動して検索を検証します。データパッケージのインポートは同期的にベクトルを作成します。その操作は[データ移行](../user/data-transfer.md)に従ってください。
