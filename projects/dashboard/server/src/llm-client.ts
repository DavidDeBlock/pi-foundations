export interface LlmMessage {
  readonly role: 'system' | 'user'
  readonly content: string
}

export interface OpenAiCompatibleLlmClientOptions {
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
  readonly fetchFn?: typeof fetch
}

/** Minimal server-side OpenAI-compatible client. It intentionally exposes
 * only text completion; browser code never sees provider credentials. */
export class OpenAiCompatibleLlmClient {
  readonly model: string
  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #fetch: typeof fetch

  constructor(options: OpenAiCompatibleLlmClientOptions) {
    this.#apiKey = options.apiKey
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.model = options.model
    this.#fetch = options.fetchFn ?? fetch
  }

  async complete(messages: ReadonlyArray<LlmMessage>, options: { readonly maxCompletionTokens?: number } = {}): Promise<string> {
    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.2,
        max_completion_tokens: options.maxCompletionTokens ?? 2048,
        // MiniMax separates reasoning from display content when supported.
        reasoning_split: true,
      }),
    })

    if (!response.ok) {
      const body = (await response.text()).slice(0, 300)
      throw new Error(`LLM request failed (${response.status}): ${body || response.statusText}`)
    }

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: unknown } }>
    }
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('LLM response did not contain text content')
    }
    return content
  }
}
