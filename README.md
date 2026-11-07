# dsh-message-translator

DeepSeek Harness（DSH）の回答を、ローカルの Ollama で翻訳してセッションへ記録するプラグインです。

- 翻訳は **127.0.0.1 の Ollama**（既定 `http://127.0.0.1:11434`）へ投げます。外部 API や API キーは不要です。
- 翻訳専用モデルの [PLaMo 3 Translate](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF) にも対応しています（`provider: plamo`）。
- 翻訳結果は会話に「翻訳」カードとして表示されます。原文はそのまま残ります。
- ターンが完了したとき、そのターンの**最後の回答**だけを翻訳します。ツール呼び出しの途中説明や reasoning は対象外です。
- 結果は `plugin:message-translator/translation` という **plugin record** として同じセッションログへ追記します。元の会話は変更しません。
- Ollama が落ちていても会話は壊れません。翻訳の失敗は警告ログに留めます。

## 動作

```
assistant/message（最後の本文を保持）
        ↓
agent/turn-stopping（正常完了するターンだけ）
        ↓
コードブロックを退避 → 長文を段落単位で分割
        ↓
Ollama で 1 断片ずつ翻訳
        ↓
plugin:message-translator/translation を追記 → flush
        ↓
turn/end
```

記録されるデータは次の形です。後から GUI 側で「翻訳に切り替える」UI を作るときは、この record を読むだけで済みます。

```json
{
  "turn": 3,
  "step": 5,
  "messageSeq": 42,
  "text": "翻訳された本文",
  "model": "qwen3:8b",
  "targetLanguage": "Japanese",
  "sourceLanguage": "auto",
  "recipe": "ollama-chat-v1:qwen3:8b:Japanese:auto",
  "createdAt": "2026-11-06T03:40:00.000Z"
}
```

`messageSeq` は翻訳対象になった `assistant/message` のイベント seq です。原文と対応付けるときに使います。

## インストール

```sh
# このリポジトリのディレクトリで
dsh plugin --profile web add .

# もしくは GitHub から
dsh plugin --profile web add github:todashuta/dsh-message-translator
```

`dsh plugin add` はプロファイルの `package.json` に依存を追加し、`dsh.profile.bundles` へバンドルを登録します。同梱の `cordis.patch.yml` がプラグイン行を挿入します。

Ollama が起動していることを確認してください。

```sh
curl http://127.0.0.1:11434/api/tags
```

## 設定

プロファイルの `cordis.patch.yml` で、挿入された行の `config` を上書きできます。パッチは行の `config` 全体を置き換えるので、必要なキーをすべて書いてください。

```yaml
- id: message-translator
  config:
    provider: chat
    endpoint: http://127.0.0.1:11434
    model: qwen3:8b
    targetLanguage: Japanese
    sourceLanguage: auto
    form: auto
    maxTextChars: 4000
    timeoutMs: 120000
    temperature: 0.2
    enabled: true
```

| キー | 既定値 | 意味 |
|---|---|---|
| `provider` | `chat` | `chat`（system + user の汎用形式）または `plamo`（PFML3） |
| `endpoint` | `http://127.0.0.1:11434` | Ollama の基底 URL |
| `model` | `qwen3:8b` | 翻訳に使うモデル。`ollama list` で確認する |
| `targetLanguage` | `Japanese` | 翻訳先。`plamo` では言語コード（`ja`）を推奨 |
| `sourceLanguage` | `auto` | 原文の言語名。`auto` なら自動判定。`plamo` では未使用 |
| `form` | `auto` | 日本語の文体。`auto` / `plain` / `polite`。`plamo` のときだけ有効 |
| `maxTextChars` | `4000` | 1 リクエストの最大文字数。超えたら分割 |
| `numCtx` | `8192` | Ollama のコンテキスト長。長い回答では広げる |
| `timeoutMs` | `120000` | Ollama 1 リクエストの期限 |
| `temperature` | `0.2` | サンプリング温度 |
| `enabled` | `true` | `false` でプラグインを休止 |

## PLaMo 3 Translate を使う

翻訳専用モデルの [PLaMo 3 Translate](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF)
を使う場合は `provider: plamo` にします。PFML3 プロンプトを組み立てて
`/api/generate` に `raw: true` で渡すため、Ollama のチャットテンプレートの
解釈に依存しません。

```yaml
- id: message-translator
  config:
    provider: plamo
    endpoint: http://127.0.0.1:11434
    model: plamo-3-translate:0.8b
    targetLanguage: ja
    form: polite
    temperature: 0
```

`targetLanguage` は言語コード（`ja`、`en`、`zh-hans` など）で指定します。
よく使う言語名（`Japanese` など）は自動でコードへ変換されます。`form` は
`auto` / `plain` / `polite` から選べます。

Ollama へのモデル登録は [ollama/README.md](ollama/README.md) を参照してください。


## 仕組み

- **コードブロックは翻訳しません。** フェンス付きコードブロックをプレースホルダへ退避し、翻訳後に元の位置へ戻します。小さいモデルがコードを壊すのを防ぐためです。モデルがプレースホルダを落とした場合は、コードブロックを翻訳結果の末尾へ原文のまま追加します。
- **長文は段落単位で分割します。** `maxTextChars` を超える回答は、空行の位置を優先して複数リクエストに分けます。
- **失敗は本体を止めません。** Ollama 未起動、モデル不在、タイムアウトなどは `warn` ログになり、会話はそのまま続行します。
- **セッション終了時は翻訳をキャンセルします。** 閉じたセッションへ record を追記しようとはしません。

## テスト

```sh
npm test
```

Ollama の実プロセスは使わず、fetch と翻訳関数をモックして検証します。

## 翻訳の表示

ホスト側が記録した `plugin:message-translator/translation` を、クライアント側の
[lib/client.js](lib/client.js) が Turn の Location data として公開します。回答
（`assistant-step`）のレンダラを置き換え、通常の回答部分を訳文にします。
原文は「原文」の折りたたみの中に残ります。

翻訳がまだ生成されていないターンやストリーミング中は、従来どおり原文を表示します。

`lib/client.js` の変更は DSH のクライアントプラグイン HMR で反映されます。
反映されない場合は DSH Web を再起動してください。

## 制限

- 翻訳はターン完了後のバックグラウンド処理です。長い回答では翻訳が終わるまで数秒〜数十秒かかります。
- 翻訳は会話の「翻訳」カードとして表示されます。カードは開いた状態で出るので、訳文だけを見たいときは summary をクリックして折りたたんでください。
- plugin record は実験的な保持扱いです。DSH のセッション形式移行で失われる可能性があります。
- サブエージェントのセッションも同じ条件で翻訳対象になります。

## ライセンス

MIT

### 統合確認（モック Ollama）

実際の Ollama を使わずに、DSH の headless プロファイルで 1 ターン流し、
セッションログへ record が追記されるところまで確認できます。

```sh
# ターミナル 1: モック Ollama（127.0.0.1:11434）
node tools/mock-ollama.js

# ターミナル 2: 検証用プロファイル（DSH の checkout で実行）
export DSH_HOME=/tmp/dsh-translator-test
pnpm dsh --profile translator-test --from-default-profile headless --dump-config
pnpm dsh plugin --profile translator-test add /path/to/dsh-message-translator
pnpm dsh --profile translator-test "hello"
```

検証用プロファイルの `cordis.patch.yml` には、LLM の設定（`llm-pi-ai` と
`agent-default-model`）と、`message-translator` の `endpoint` をモックへ向ける
上書きを書いてください。セッションログに `plugin:message-translator/translation`
が `turn/end` の直前に現れれば成功です。
