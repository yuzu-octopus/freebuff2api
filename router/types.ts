/** Shared types used across the router. */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
}
