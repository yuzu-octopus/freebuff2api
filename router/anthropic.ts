/**
 * Anthropic ↔ OpenAI format conversion layer.
 *
 * Allows the router to accept `/v1/messages` (Anthropic API) requests and
 * translate them to OpenAI `/v1/chat/completions` format for Freebuff upstream.
 * Also translates OpenAI streaming responses back to Anthropic SSE format.
 *
 * Adapted from Quorinex/Freebuff2API (Go) approach, simplified for our
 * Bun/TypeScript stack. Supports the core: text, image, tool_use, tool_result,
 * and thinking content parts.
 */

import type { ChatMessage } from './types'

// --- Helpers ---

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function lower(v: unknown): string {
  return str(v).toLowerCase().trim()
}

function sanitizeToolID(id: string): string {
  // Anthropic tool IDs may contain characters (e.g. colons) not valid for OpenAI.
  // Replace with a safe format: tool_use_<hash>
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `tool_use_${cleaned.slice(0, 64)}`
}

// Map Anthropic built-in tool types to Freebuff/OpenAI equivalents.
const BUILTIN_TOOL_MAP: Record<string, string> = {
  web_search: 'web_search',
  web_search_20250305: 'web_search',
}

// --- Request conversion (Anthropic → OpenAI) ---

/** Convert an Anthropic `/v1/messages` request body to OpenAI chat format. */
export function claudeToOpenAI(body: Record<string, unknown>): {
  openaiBody: Record<string, unknown>
  model: string
  stream: boolean
} {
  const messages: Array<Record<string, unknown>> = []

  // System → system message (Anthropic system can be string or array of parts)
  const system = body.system
  if (system !== undefined) {
    const sysMsg = convertClaudeSystem(system)
    if (sysMsg) messages.push(sysMsg)
  }

  // Messages
  const claudeMessages = (body.messages as Array<Record<string, unknown>> | undefined) ?? []
  for (const msg of claudeMessages) {
    const role = lower(msg.role)
    const parts = convertClaudeMessageContent(role, msg.content)
    // Tool results come before the assistant message they respond to
    for (const preMsg of parts.beforeMessages) messages.push(preMsg)
    if (parts.contentParts.length > 0) {
      const openAIMsg: Record<string, unknown> = { role, content: normalizeContent(parts.contentParts) }
      if (parts.toolCalls.length > 0) {
        openAIMsg.tool_calls = parts.toolCalls
      }
      if (parts.reasoning) {
        openAIMsg.reasoning_content = parts.reasoning
      }
      messages.push(openAIMsg)
    }
    for (const postMsg of parts.afterMessages) messages.push(postMsg)
  }

  // Tools
  const tools = (body.tools as Array<Record<string, unknown>> | undefined) ?? []
  const openAITools: Array<Record<string, unknown>> = []
  const builtinToolKinds: Record<string, string> = {}
  for (const tool of tools) {
    const [openAITool, kind] = convertClaudeTool(tool)
    if (openAITool) {
      openAITools.push(openAITool)
      if (kind && tool.name) {
        builtinToolKinds[str(tool.name)] = kind
      }
    }
  }

  // Tool choice
  let toolChoice: unknown
  const tc = body.tool_choice
  if (tc && isObject(tc)) {
    const [converted] = convertClaudeToolChoice(tc, builtinToolKinds)
    if (converted !== undefined) toolChoice = converted
  }

  // Model
  const model = str(body.model)

  // Stream
  const stream = body.stream === true

  const openaiBody: Record<string, unknown> = {
    model,
    messages,
    stream,
  }

  if (openAITools.length > 0) {
    openaiBody.tools = openAITools
  }
  if (toolChoice !== undefined) {
    openaiBody.tool_choice = toolChoice
  }
  // Pass through common params
  if (body.temperature) openaiBody.temperature = body.temperature
  if (body.top_p) openaiBody.top_p = body.top_p
  if (body.max_tokens) openaiBody.max_tokens = body.max_tokens
  if (body.max_output_tokens) openaiBody.max_tokens = body.max_output_tokens

  return { openaiBody, model, stream }
}

interface ClaudeMessageParts {
  contentParts: Array<Record<string, unknown>>
  beforeMessages: Array<Record<string, unknown>>
  afterMessages: Array<Record<string, unknown>>
  toolCalls: Array<Record<string, unknown>>
  reasoning: string
}

function convertClaudeSystem(system: unknown): Record<string, unknown> | null {
  if (typeof system === 'string') {
    const text = system.trim()
    if (!text) return null
    return { role: 'system', content: text }
  }
  if (Array.isArray(system)) {
    const contentParts: Array<Record<string, unknown>> = []
    for (const part of system) {
      if (isObject(part) && lower(part.type) === 'text') {
        const text = str(part.text).trim()
        if (text) contentParts.push({ type: 'text', text })
      }
    }
    if (contentParts.length === 0) return null
    return { role: 'system', content: normalizeContent(contentParts) }
  }
  return null
}

function convertClaudeMessageContent(role: string, content: unknown): ClaudeMessageParts {
  const result: ClaudeMessageParts = {
    contentParts: [],
    beforeMessages: [],
    afterMessages: [],
    toolCalls: [],
    reasoning: '',
  }

  if (typeof content === 'string') {
    if (content.trim()) {
      result.contentParts.push({ type: 'text', text: content })
    }
    return result
  }

  if (Array.isArray(content)) {
    const reasoningParts: string[] = []

    for (const rawPart of content) {
      if (!isObject(rawPart)) continue

      const partType = lower(rawPart.type)

      switch (partType) {
        case 'text': {
          const text = str(rawPart.text).trim()
          if (text) result.contentParts.push({ type: 'text', text })
          break
        }

        case 'image': {
          const imagePart = convertClaudeImagePart(rawPart)
          if (imagePart) result.contentParts.push(imagePart)
          break
        }

        case 'tool_use':
        case 'server_tool_use': {
          if (role !== 'assistant') continue
          const toolCallID = sanitizeToolID(str(rawPart.id))
          result.toolCalls.push({
            id: toolCallID,
            type: 'function',
            function: {
              name: str(rawPart.name),
              arguments: marshalJSON(rawPart.input),
            },
          })
          break
        }

        case 'tool_result': {
          const toolMsg = buildOpenAIToolResultMessage(str(rawPart.tool_use_id), rawPart.content)
          if (toolMsg) {
            if (role === 'assistant') {
              result.afterMessages.push(toolMsg)
            } else {
              result.beforeMessages.push(toolMsg)
            }
          }
          break
        }

        case 'thinking': {
          if (role !== 'assistant') continue
          const thinkingText = str(rawPart.thinking || rawPart.text || '').trim()
          if (thinkingText) reasoningParts.push(thinkingText)
          break
        }

        default: {
          if (partType.endsWith('_tool_use')) {
            if (role !== 'assistant') continue
            const toolCallID = sanitizeToolID(str(rawPart.tool_use_id || rawPart.id))
            result.toolCalls.push({
              id: toolCallID,
              type: 'function',
              function: {
                name: str(rawPart.name || rawPart.tool_name),
                arguments: marshalJSON(rawPart.input),
              },
            })
          } else if (partType.endsWith('_tool_result')) {
            const toolContent = isObject(rawPart) && rawPart.content !== undefined
              ? rawPart.content
              : rawPart
            const toolMsg = buildOpenAIToolResultMessage(
              str(rawPart.tool_use_id || rawPart.id),
              toolContent,
            )
            if (toolMsg) {
              if (role === 'assistant') {
                result.afterMessages.push(toolMsg)
              } else {
                result.beforeMessages.push(toolMsg)
              }
            }
          }
          break
        }
      }
    }

    if (reasoningParts.length > 0) {
      result.reasoning = reasoningParts.join('\n\n')
    }
  }

  return result
}

function convertClaudeImagePart(part: Record<string, unknown>): Record<string, unknown> | null {
  const source = part.source
  if (!isObject(source)) return null

  const mediaType = str(source.media_type || source.type)
  const data = str(source.data)

  if (partType_mediaIsURL(source)) {
    return {
      type: 'image_url',
      image_url: { url: str(source.url) },
    }
  }

  return {
    type: 'image_url',
    image_url: {
      url: `data:${mediaType};base64,${data}`,
    },
  }
}

function partType_mediaIsURL(source: Record<string, unknown>): boolean {
  return 'url' in source
}

function convertClaudeTool(tool: Record<string, unknown>): [Record<string, unknown> | null, string] {
  const toolType = lower(tool.type)
  if (BUILTIN_TOOL_MAP[toolType]) {
    const mapped = { ...tool }
    mapped.type = BUILTIN_TOOL_MAP[toolType]
    delete (mapped as Record<string, unknown>).name
    return [mapped, BUILTIN_TOOL_MAP[toolType]]
  }

  const func: Record<string, unknown> = {
    name: str(tool.name),
    description: str(tool.description),
  }
  if (tool.input_schema) {
    func.parameters = tool.input_schema
  }

  return [{ type: 'function', function: func }, '']
}

function convertClaudeToolChoice(
  toolChoice: Record<string, unknown>,
  builtinToolKinds: Record<string, string>,
): [unknown, boolean] {
  const tcType = lower(toolChoice.type)

  switch (tcType) {
    case 'none':
      return ['none', true]
    case 'auto':
      return ['auto', true]
    case 'any':
      return ['required', true]
    case 'tool': {
      const toolName = str(toolChoice.name).trim()
      if (!toolName) return [null, false]
      const builtinType = builtinToolKinds[toolName]
      if (builtinType) {
        return [{ type: builtinType }, true]
      }
      return [
        { type: 'function', function: { name: toolName } },
        true,
      ]
    }
    default:
      return [null, false]
  }
}

function buildOpenAIToolResultMessage(
  toolUseID: string,
  content: unknown,
): Record<string, unknown> | null {
  const id = toolUseID.trim()
  if (!id) return null

  let textContent: string
  if (typeof content === 'string') {
    textContent = content
  } else {
    textContent = JSON.stringify(content)
  }

  return {
    role: 'tool',
    tool_call_id: sanitizeToolID(id),
    content: textContent,
  }
}

function normalizeContent(parts: Array<Record<string, unknown>>): unknown {
  if (parts.length === 1 && parts[0].type === 'text') {
    return parts[0].text
  }
  return parts
}

function marshalJSON(obj: unknown): string {
  if (obj === undefined || obj === null) return '{}'
  const json = JSON.stringify(obj)
  return json === undefined ? '{}' : json
}

// --- Response conversion (OpenAI SSE → Anthropic SSE) ---

interface AnthropicStreamState {
  textBuffer: string
  toolUseBuffer: Array<{ id: string; name: string; args: string }>
  toolIndex: number
  hasContent: boolean
  finishReason: string | null
}

/** Convert an OpenAI SSE chunk to Anthropic SSE events. */
export function openAIChunkToClaudeEvents(
  chunk: Record<string, unknown>,
  state: AnthropicStreamState,
  contentBlockIndex: number,
  toolBlockIndex: number,
): Array<Record<string, string>> {
  const events: Array<Record<string, string>> = []

  const choices = chunk.choices as Array<Record<string, unknown>> | undefined
  if (!choices || choices.length === 0) return events

  const choice = choices[0]
  const delta = choice.delta as Record<string, unknown> | undefined
  if (!delta) return events

  // Content
  if (typeof delta.content === 'string' && delta.content) {
    state.textBuffer = (state.textBuffer || '') + delta.content
    state.hasContent = true
    events.push({
      type: 'content_block_delta',
      index: '0',
      data: JSON.stringify({ type: 'text_delta', text: delta.content }),
    })
  }

  // Tool calls
  if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const tcObj = tc as Record<string, unknown>
      const idx = tcObj.index as number
      const fn = tcObj.function as Record<string, unknown> | undefined

      if (str(fn?.name) && !state.toolUseBuffer[idx]) {
        state.toolUseBuffer[idx] = { id: str(tcObj.id), name: str(fn?.name), args: '' }
      } else if (state.toolUseBuffer[idx]) {
        if (fn?.arguments) {
          state.toolUseBuffer[idx].args += str(fn.arguments)
        }
      }
    }
  }

  // Finish reason
  const finishReason = str(choice.finish_reason)
  if (finishReason && !state.finishReason) {
    state.finishReason = finishReason
  }

  return events
}

/** Generate the final messages to close the Anthropic stream. */
export function finalizeClaudeStream(
  state: AnthropicStreamState,
  usage?: { prompt_tokens?: number; completion_tokens?: number },
): Array<Record<string, string>> {
  const events: Array<Record<string, string>> = []

  // Send tool use content blocks if any
  for (let i = 0; i < state.toolUseBuffer.length; i++) {
    const tool = state.toolUseBuffer[i]
    if (tool) {
      const blockIndex = state.hasContent ? i + 1 : i
      events.push({
        type: 'content_block_start',
        index: String(blockIndex),
        data: JSON.stringify({
          type: 'tool_use',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: tool.id,
            name: tool.name,
            input: JSON.parse(tool.args || '{}'),
          },
        }),
      })
      events.push({
        type: 'content_block_stop',
        index: String(blockIndex),
        data: JSON.stringify({}),
      })
    }
  }

  // Stop the text content block if we had content
  if (state.hasContent) {
    events.push({
      type: 'content_block_stop',
      index: '0',
      data: JSON.stringify({}),
    })
  }

  // Message delta with stop
  const claudeFinishReason = state.finishReason === 'stop' || state.finishReason === 'tool_calls'
    ? state.finishReason
    : 'end_turn'

  events.push({
    type: 'message_delta',
    data: JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: claudeFinishReason, stop_sequence: null },
      usage: usage
        ? { output_tokens: usage.completion_tokens || 0 }
        : undefined,
    }),
  })

  events.push({
    type: 'message_stop',
    data: JSON.stringify({ type: 'message_stop' }),
  })

  return events
}

// Initialize streaming state for Anthropic response
export function initAnthropicStreamState(): AnthropicStreamState {
  return {
    textBuffer: '',
    toolUseBuffer: [],
    hasContent: false,
    finishReason: null,
    toolIndex: 0,
  }
}
