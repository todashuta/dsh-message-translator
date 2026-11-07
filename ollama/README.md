# PLaMo 3 Translate を Ollama で使う

PLaMo 3 Translate 0.8B の GGUF は Ollama の公式ライブラリにはありませんが、
次の 2 通りで使えます。

1. Hugging Face の GGUF を Ollama に直接取得させる
2. 手元の GGUF から Modelfile で登録する

どちらもモデルのライセンスは [PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-ja) です。

## 方法 1: Hugging Face から直接取得する

PFN のモデルカードに Ollama 用の手順が記載されています。

```sh
ollama pull hf.co/pfnet/plamo-3-translate-0.8b-GGUF:Q4_K_M
ollama run hf.co/pfnet/plamo-3-translate-0.8b-GGUF:Q4_K_M
```

量子化は `Q4_K_M`（0.57 GB）、`Q4_0`（0.55 GB）、`Q3_K_M`（0.49 GB）、
`Q2_K`（0.41 GB）から選べます。訳文の品質を優先するなら `Q4_K_M` が無難です。

この方法では Ollama が GGUF をそのまま取り込みます。チャットテンプレートが
GGUF の Jinja 定義から正しく反映されるかは Ollama のバージョンに依存します。
うまく動かない場合は方法 2 の `Modelfile.plamo-ja` を使ってください。

## 方法 2: ローカルの GGUF から Modelfile で登録する

GGUF をダウンロードします。

```sh
hf download pfnet/plamo-3-translate-0.8b-GGUF plamo-3-translate-0.8b-Q4_K_M.gguf --local-dir .
```

このディレクトリの Modelfile は、GGUF が同じ場所にある前提で `FROM` を
書いています。実際のファイル名に合わせてから登録します。

```sh
ollama create plamo-3-translate:0.8b -f Modelfile.plamo-ja
ollama run plamo-3-translate:0.8b
```

### 2 つの Modelfile の違い

| ファイル | 向いている使い方 | 翻訳先 |
|---|---|---|
| `Modelfile.plamo-ja` | `/api/chat` を使うクライアント | 日本語固定 |
| `Modelfile.plamo-raw` | `/api/generate` に `raw: true` で PFML3 を直接渡す | 自由 |

`Modelfile.plamo-ja` は Ollama のチャットテンプレートを PFML3 に固定します。
Ollama が GGUF の Jinja テンプレートを読めない場合でも、`/api/chat` に
user メッセージを 1 つ送るだけで翻訳できます。翻訳先は `ja` 固定です。

`Modelfile.plamo-raw` はテンプレートを持たないので、呼び出し側が PFML3 を
組み立てて `/api/generate` に渡します。翻訳先や文体を切り替えたい場合や、
GGUF 埋め込みのテンプレートに依存したくない場合に向いています。

```sh
curl http://127.0.0.1:11434/api/generate -d '{
  "model": "plamo-3-translate:0.8b",
  "raw": true,
  "prompt": "<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:msg|>The meeting has been rescheduled.<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>",
  "stream": false,
  "options": { "temperature": 0, "stop": ["<|plamo:tag|>", "<|plamo:bos|>"] }
}'
```

PFML3 の組み立て方と `target_lang` の言語コードは、モデルカードの
「PFML3 プロンプト形式」と「対応言語」を参照してください。日本語は `ja`、
英語は `en`、中国語（簡体字）は `zh-hans` です。

## dsh-message-translator との組み合わせ

プラグインは `provider: plamo` で PFML3 を自前で組み立て、`/api/generate` に
`raw: true` で渡します。Modelfile のチャットテンプレートは使わないため、
`Modelfile.plamo-raw` または `ollama pull hf.co/...` で取り込んだモデルを
そのまま指定できます。

```yaml
- id: message-translator
  config:
    provider: plamo
    model: hf.co/pfnet/plamo-3-translate-0.8b-GGUF:Q4_K_M
    targetLanguage: ja
    form: polite
    temperature: 0
    numCtx: 8192
```

実機（Ollama v0.40.15）で次の翻訳を確認しました。

- 原文: `The lighthouse swept its steady beam across the dark water, a quiet promise that the shore was still there.`
- 訳文: `灯台は暗い水面を一定の光束で照らし、岸はまだそこにあるという静かな約束を告げました。`

コードブロックのプレースホルダ `[[CODE_BLOCK_0]]` も保持されることを
確認しています。

`Modelfile.plamo-ja` は `/api/chat` を直接使うクライアント向けです。
プラグインの `plamo` モードでは使いません。

## 注意

- PLaMo 3 Translate は翻訳専用です。チャットや要約には使えません。
- 入力と出力の合計は 32,768 トークンまでです。長い回答はプラグインの
  `maxTextChars` で分割してください。
- `num_ctx` はメモリに合わせて調整してください。`Modelfile` では 16,384 に
  しています。
- Ollama のテンプレートはバージョンによって挙動が変わります。うまく訳が
  返らない場合は、まず `ollama show --modelfile plamo-3-translate:0.8b` で
  実際に使われている TEMPLATE を確認してください。
