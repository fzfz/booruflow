# 更新と復旧

本文のルート直下のコマンドは公開済み v0.88.0 用です。現在のソースの `bin/` パスは次を参照してください： [スクリプトの配置と保守コマンド](../development/scripts.md).

状態を確認して停止し、`update.bat --tag vX.Y.Z` または `bash update.sh --tag vX.Y.Z` で対象のリリースタグを指定します。Git、ローカル変更、更新方向、データベースのバージョン、停止状態を確認した後、バックアップ、タグの取得、チェックアウト、`npm ci`、データベースの更新、一時的な稼働確認を順に実行します。成功後の起動は利用者が行います。

ローカル変更、ダウングレード、未知のデータベースバージョン、Git 以外のインストールは書き込み前に停止します。更新に失敗した場合は、バックアップと旧バージョンの識別情報が残ります。更新結果に表示された直下のバックアップディレクトリを、`restore.bat --backup data/recovery/<backup-directory>` または `bash restore.sh --backup data/recovery/<backup-directory>` に渡します。引数は `data/recovery/` の直下にある 1 つのディレクトリ名でなければなりません。復元は対応するコード、データベース、メディア、設定を戻します。その後、検査、起動、バージョン、リソースを確認します。

## 新しい v0.88.0 へデータを移す

データパッケージは同じバージョン間のエクスポートとインポートに対応します。v0.88.0 から別の v0.88.0 へ移す場合、移行元を停止して `data-export` と `data-pack` を実行します。両方のモデルサービスを設定した移行先を停止したまま、空のデータベースに対して `data-import --check` と `data-import --apply` を実行し、起動後にリソースを確認します。完全な引数は[データ移行](data-transfer.md)を参照してください。

v0.87.0 には、新しいリポジトリの運用スクリプトも `v0.88.0` タグもありません。旧インストール環境で従来使用していた方法によりアプリケーションを停止し、プロセスと待受ポートが終了したことを確認します。次の例では、移行元を `/path/to/booruflow-v087`、完全なバックアップを `/path/to/booruflow-v087-backup`、新しい公開リポジトリから複製する分離済みのエクスポート環境を `/path/to/booruflow-v088-export-copy` とします。完全なバックアップと分離済みのエクスポート環境には、存在しないパスまたは空のディレクトリを指定します。`/path/to/booruflow-v088-target` は、別途インストール済みで業務データベースが空の v0.88.0 移行先を表し、この 2 つのコピー先には含まれません。

```bash
ditto "/path/to/booruflow-v087" "/path/to/booruflow-v087-backup"
git clone --branch v0.88.0 --depth 1 https://github.com/fzfz/booruflow.git "/path/to/booruflow-v088-export-copy"
ditto "/path/to/booruflow-v087-backup/data" "/path/to/booruflow-v088-export-copy/data"
cp "/path/to/booruflow-v087-backup/.env" "/path/to/booruflow-v088-export-copy/.env"
```

分離したディレクトリでは、コピー済みのデータベースを保持します。新しい `.env.example` とコピー済みの `.env` を比較し、旧設定で利用者が指定した値を新しい変数へ転記し、Embedding と Reranker の 6 項目をすべて設定します。コピーした `NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY` とその他の認証情報を保持します。`npm ci` の後に `runtime-data.mjs migrate` を直接実行し、このデータベースを更新します。

別途、[インストール](installation.md)に従って v0.88.0 のインストーラーで `/path/to/booruflow-v088-target` を作成し、[設定](configuration.md)に従って移行先の Embedding と Reranker の 6 項目を設定します。移行先のアプリケーションを停止したままにし、業務、関連、画像、ベクトル、KNN の各テーブルが空であることを確認します。その後、次の順序で移行、エクスポート、パッケージ作成、インポートを実行します。

```bash
npm --prefix "/path/to/booruflow-v088-export-copy" ci
node "/path/to/booruflow-v088-export-copy/scripts/runtime-data.mjs" migrate --root "/path/to/booruflow-v088-export-copy"
bash "/path/to/booruflow-v088-export-copy/data-export.sh" --output "/path/to/v088-export"
bash "/path/to/booruflow-v088-export-copy/data-pack.sh" --input "/path/to/v088-export" --output "/path/to/v088-data.tar.gz"
bash "/path/to/booruflow-v088-target/data-import.sh" --input "/path/to/v088-data.tar.gz" --check
bash "/path/to/booruflow-v088-target/data-import.sh" --input "/path/to/v088-data.tar.gz" --apply
```

移行コマンドは、分離したデータベースを移行 039 から 040 へ更新します。Windows でも旧インストール環境で従来使用していた方法により停止し、プロセスの終了を確認します。コマンドプロンプトで次を実行し、完全なバックアップと分離済みのエクスポート環境が存在しないパスまたは空のディレクトリであることを確認します。

```bat
robocopy "C:\path\to\booruflow-v087" "C:\path\to\booruflow-v087-backup" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1
git clone --branch v0.88.0 --depth 1 https://github.com/fzfz/booruflow.git "C:\path\to\booruflow-v088-export-copy"
robocopy "C:\path\to\booruflow-v087-backup\data" "C:\path\to\booruflow-v088-export-copy\data" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1
copy /Y "C:\path\to\booruflow-v087-backup\.env" "C:\path\to\booruflow-v088-export-copy\.env"
```

各 `robocopy` の終了コードが 0–7 であることを確認します。8 以上はコピーの失敗を表すため、作業を停止します。分離したディレクトリではコピー済みのデータベースを保持します。新しい `.env.example` に合わせて旧環境の利用者設定を分離した `.env` へ転記し、モデルサービスの 6 変数をすべて設定し、暗号鍵と認証情報を保持します。`npm ci` の後に `runtime-data.mjs migrate` を直接実行し、続いて次のコマンドを実行します。

```bat
call npm --prefix "C:\path\to\booruflow-v088-export-copy" ci
node "C:\path\to\booruflow-v088-export-copy\scripts\runtime-data.mjs" migrate --root "C:\path\to\booruflow-v088-export-copy"
call "C:\path\to\booruflow-v088-export-copy\data-export.bat" --output "C:\path\to\v088-export"
call "C:\path\to\booruflow-v088-export-copy\data-pack.bat" --input "C:\path\to\v088-export" --output "C:\path\to\v088-data.tar.gz"
call "C:\path\to\booruflow-v088-target\data-import.bat" --input "C:\path\to\v088-data.tar.gz" --check
call "C:\path\to\booruflow-v088-target\data-import.bat" --input "C:\path\to\v088-data.tar.gz" --apply
```

移行先に業務データがある場合は、新しい空のインストール環境を作成します。コピー、依存関係の導入、移行、エクスポートのいずれかに失敗したら後続処理を停止し、完全なバックアップを保持したまま分離用ディレクトリを作り直します。元のインストールディレクトリは変更せずに保持します。
