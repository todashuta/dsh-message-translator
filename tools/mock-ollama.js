/**
 * 統合確認用のモック Ollama。
 *
 * 実際の Ollama を起動せずに、`/api/chat` と `/api/generate` が返す形だけを
 * 再現する。PFML3 の `input` はそのまま取り出して返すので、プラグインが
 * 組み立てたプロンプトが正しいかをログで確認できる。
 *
 * 使い方:
 *   node tools/mock-ollama.js
 * 別のポートで待ち受けたい場合:
 *   MOCK_OLLAMA_PORT=11500 node tools/mock-ollama.js
 */

import { createServer } from 'node:http'

const port = Number(process.env.MOCK_OLLAMA_PORT ?? 11434)
const host = process.env.MOCK_OLLAMA_HOST ?? '127.0.0.1'

/** PFML3 の input 要素だけを取り出す。 */
function pfml3Input(prompt) {
  const match = /<\|plamo:tag\|>input<\|plamo:msg\|>([\s\S]*?)<\|plamo:tag\|>output/.exec(prompt)
  return match?.[1] ?? prompt
}

const server = createServer((request, response) => {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    if (request.method !== 'POST' || (request.url !== '/api/chat' && request.url !== '/api/generate')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'invalid json' }))
      return
    }

    if (request.url === '/api/generate') {
      const source = pfml3Input(parsed.prompt ?? '')
      console.log(JSON.stringify({ api: 'generate', model: parsed.model, raw: parsed.raw, chars: source.length }))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        model: parsed.model,
        response: `[mock-plamo] ${source}`,
        done: true,
      }))
      return
    }

    const user = parsed.messages?.at(-1)?.content ?? ''
    // プレースホルダはそのまま残し、本文には目印を付けて返す。プラグイン側の
    // 復元処理が動いていることをログで確認できるようにするため。
    console.log(JSON.stringify({ api: 'chat', model: parsed.model, chars: user.length }))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      model: parsed.model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: `[mock-ollama] ${user}` },
      done: true,
    }))
  })
})

server.listen(port, host, () => {
  console.log(`[mock-ollama] listening on http://${host}:${port}`)
})
