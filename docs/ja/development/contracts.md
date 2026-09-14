# 機械契約

データベース構造と移行は `schema/database/`、データパッケージは `schema/data-package/`、HTTP は `schema/api/openapi.yaml`、エラーは `schema/api/error-catalog.json`、既定値は構造化された `config/`、言語対応は `docs/locales.json` と `schema/docs/locales.schema.json` を唯一の情報源とします。

Schema または構造化設定、検証処理と実装、正常・異常・境界テスト、四言語文書の順に変更します。公開済みの移行ファイルは原文を保持し、構造変更には次の番号の移行を追加して、新規構築、更新、ロールバックをテストします。実行時の経路と OpenAPI は双方向に比較します。エラーはエラーカタログで定義し、ユーザーインターフェースは共通の対応表から表示文を読みます。

実行時に調整できる値と適用順序は[設定](../user/configuration.md)で一度だけ定義します。共有項目、定数、テンプレートは構造化された情報源に保存します。Markdown は利用方法の説明に使い、プログラムは対応する Schema または構造化設定から構造化入力を読み取ります。
