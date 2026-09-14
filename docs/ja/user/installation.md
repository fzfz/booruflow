# インストール

BooruFlow v0.88.0 のネイティブスクリプトは Windows x64 と macOS arm64/x64 を対象にします。Node.js 24.21.0 以上、npm 10.9.3 以上、Git 2.55.0 以上が必要です。インストーラーは `tar` と SQLite ベクトル拡張も確認し、正確な要件は `config/release/release.json` を唯一のソースとします。実際に検証された環境は Release ページに記載されます。

[v0.88.0 Release](https://github.com/fzfz/booruflow/releases/tag/v0.88.0) から `install.bat` または `install.sh` を取得します。Windows は `.bat` を実行し、macOS は次を実行します。

```bash
bash install.sh
```

起動時の作業ディレクトリが既定のインストール先として表示されます。Enter で採用し、別の絶対パスまたは起動ディレクトリ基準の相対パスも入力できます。スクリプトは OS、CPU、書込権限、Node、npm、Git を確認し、選択したタグを clone、`npm ci` を実行、`.env` と ComfyUI 資格情報暗号鍵を作成し、空データベースを初期化します。

Node または Git がない場合、必要バージョン、公式ページ、再実行手順を表示して終了します。インストール後に新しい端末で PATH を確認し、同じスクリプトを再実行してください。既存の BooruFlow には更新スクリプトを使い、無関係なファイルがある場所は避けます。

最後に[設定](configuration.md)の Embedding と Reranker を入力します。「インストール完了」とディレクトリ、バージョン、起動スクリプトが表示されれば配置は完了です。「設定待ち」の場合はモデルサービス設定が必要です。
