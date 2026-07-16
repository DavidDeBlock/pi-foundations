import { describe, expect, it, vi } from 'vitest'
import { OpenAiCompatibleLlmClient } from './llm-client.js'

describe('OpenAiCompatibleLlmClient', () => {
  it('calls the configured chat-completions endpoint without exposing its key in output', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = new OpenAiCompatibleLlmClient({
      apiKey: 'minimax-secret',
      baseUrl: 'https://api.minimax.io/v1/',
      model: 'MiniMax-M2.7',
      fetchFn,
    })

    await expect(client.complete([{ role: 'user', content: 'hello' }])).resolves.toBe('{"ok":true}')
    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.minimax.io/v1/chat/completions')
    expect(init.headers).toMatchObject({ authorization: 'Bearer minimax-secret' })
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'MiniMax-M2.7',
      reasoning_split: true,
      messages: [{ role: 'user', content: 'hello' }],
    })
  })

  it('returns an actionable provider error without throwing on invalid JSON', async () => {
    const client = new OpenAiCompatibleLlmClient({
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1',
      model: 'model',
      fetchFn: vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })),
    })
    await expect(client.complete([{ role: 'user', content: 'hello' }]))
      .rejects.toThrow('LLM request failed (429): rate limited')
  })
})
