## 概要

Azure Functions (Node.js) で **LINE Messaging API のWebhook** を受け、受信した **テキストメッセージ** を GitHub リポジトリ `KijimaMotofumi/note` の **当日ファイルへ追記**します。

## 使い方（環境変数）

Function App の「構成」(Application settings) か `local.settings.json` に以下を設定してください。
（`local.settings.json` は Git 管理されないので、必要なら `local.settings.example.json` を参考に作ってください。）

- **`LINE_CHANNEL_SECRET`**: LINEチャネルシークレット（署名検証に使用）
- **`GITHUB_TOKEN`**: GitHub Personal Access Token（`repo` 権限 or 対象repo書き込み可能な権限）
- **`GITHUB_OWNER`**: 省略時 `KijimaMotofumi`
- **`GITHUB_REPO`**: 省略時 `note`
- **`GITHUB_BRANCH`**: 省略時 `main`
- **`NOTE_DAY_CUTOFF_HOURS`**: 日付の切り替え時刻（時間）。省略時 `4`
  - 例: `4` の場合、**28:00(=翌4:00)** で日付が切り替わる（0:00〜3:59は前日扱い）
- **`NOTE_FILE_PATH_TEMPLATE`**: 追記先パスのテンプレート（省略時 `daily/{date}.md`）
  - 置換: `{yyyy}` `{yy}` `{mm}` `{dd}` `{date}`（例 `{date}` → `2026-01-02`）

例:

- `NOTE_FILE_PATH_TEMPLATE=diary/{yyyy}/{date}.md`
- `NOTE_FILE_PATH_TEMPLATE={date}.md`
- `NOTE_FILE_PATH_TEMPLATE={yy}/{mm}/{dd}.md`（例: `26/01/01.md`）

## LINE側設定

LINE Developers の Webhook URL に、この Function の URL を設定してください。

- `POST /api/note-push`

## 追記フォーマット

当日ファイルに以下の形式で追記します（JST/Asia/Tokyo）。

- `- HH:mm メッセージ本文`


