/**
 * 統合確認用のモック Ollama。
 *
 * 実際の Ollama を起動せずに、`/api/chat` が返す形だけを再現する。
 * 使い方:
 *   node tools/mock-ollama.js
 * 別のポートで待ち受けたい場合:
 *   MOCK_OLLAMA_PORT=11500 node tools/mock-ollama.js
 */

import { createServer } from 'node:http'

const port = Number(process.env.MOCK_OLLAMA_PORT ?? 11434)
const host = process.env.MOCK_OLLAMA_HOST ?? '127.0.0.1'

const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/api/chat') {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
    return
  }
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'invalid json' }))
      return
    }
    const user = parsed.messages?.at(-1)?.content ?? ''
    // プレースホルダはそのまま残し、本文には目印を付けて返す。プラグイン側の
    // 復元処理が動いていることをログで確認できるようにするため。
    const content = `[mock-ollama] ${user}`
    console.log(JSON.stringify({ model: parsed.model, chars: user.length }))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      model: parsed.model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content },
      done: true,
    }))
  })
})

server.listen(port, host, () => {
  console.log(`[mock-ollama] listening on http://${host}:${port}`)
})
