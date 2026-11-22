'use strict'

/**
 * Markdown transcript renderer.
 *
 * The session log is the only durable truth, so the transcript is *derived*
 * from one `readSession` snapshot: user and assistant text stay readable, tool
 * traffic is folded into `<details>` blocks, and nothing is truncated away
 * except tool payload previews.
 */

const { TOOL_PREVIEW_CHARS } = require('./constants')

const ROLE_LABEL = {
  user: '👤 用户',
  assistant: '🤖 助手',
  tool: '🔧 工具',
  system: '⚙️ 系统',
}

/**
 * A turn that ended for one of these reasons finished normally; anything else
 * (error, aborted, interrupted, …) is surfaced in the transcript.
 * `completed` is what the current Host writes on success.
 */
const SUCCESS_REASONS = new Set(['complete', 'completed', 'ok', 'stop', 'success', 'natural'])

function isoTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }
  return ''
}

function truncate(text, limit = TOOL_PREVIEW_CHARS) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…（已截断，共 ${value.length} 字符）`
}

function fenced(text, language = 'text') {
  const body = String(text ?? '')
  // Keep the fence longer than any run of backticks inside the payload.
  let fence = '```'
  while (body.includes(fence)) fence += '`'
  return `${fence}${language}\n${body}\n${fence}`
}

function blockquote(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
}

function textParts(content) {
  if (!Array.isArray(content)) return { text: '', reasoning: '', tools: [] }
  const texts = []
  const reasoning = []
  const tools = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    else if (part.type === 'reasoning' && typeof part.text === 'string') reasoning.push(part.text)
    else if (part.type === 'tool-call') tools.push(part)
    else if (part.type === 'tool-result' && typeof part.output === 'string') texts.push(part.output)
  }
  return { text: texts.join('\n\n').trim(), reasoning: reasoning.join('\n\n').trim(), tools }
}

function toolSummary(name, argsPreview) {
  const label = name ? `工具调用 · ${name}` : '工具调用'
  return argsPreview ? `${label} · ${argsPreview}` : label
}

function renderToolCall(name, argsPreview, body) {
  const summary = toolSummary(name, argsPreview)
  const inner = body ? `\n\n${body}\n` : '\n'
  return `<details><summary>${summary}</summary>${inner}</details>\n`
}

/**
 * Render a session snapshot as Markdown.
 *
 * The rendered text is *content*: it must not contain the export timestamp or
 * anything else that changes between two exports of unchanged events, because
 * the archive hash is computed over the rendered bytes. `exportedAt` therefore
 * lives only in `meta.json`.
 *
 * @param {{header: object, events: object[], title?: string, device?: object}} input
 * @returns {string} markdown ending with exactly one newline
 */
function renderTranscript(input) {
  const header = input.header && typeof input.header === 'object' ? input.header : {}
  const events = Array.isArray(input.events) ? input.events : []

  let title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) {
    for (const event of events) {
      if (event && event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
        title = event.data.title.trim()
      }
    }
  }
  if (!title) title = 'DSH 会话'

  const lines = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`- 会话 ID：\`${header.id ?? ''}\``)
  if (header.createdAt !== undefined) lines.push(`- 创建时间：${isoTime(header.createdAt)}`)
  if (header.cwd) lines.push(`- 工作目录：\`${header.cwd}\``)
  lines.push(`- 消息事件数：${events.length}`)
  if (input.device && input.device.name) lines.push(`- 来源设备：${input.device.name}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  // callId -> tool name, so a result can be labelled with the tool it belongs to.
  const toolNames = new Map()

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const type = event.type
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    const time = isoTime(event.time)

    if (type === 'user/message') {
      const { text } = textParts(data.content)
      if (!text) continue
      lines.push(`### ${ROLE_LABEL.user}`)
      lines.push('')
      if (time) lines.push(`<sub>${time}</sub>`)
      lines.push('')
      lines.push(blockquote(text))
      lines.push('')
      continue
    }

    if (type === 'assistant/message') {
      const message = data.message && typeof data.message === 'object' ? data.message : data
      const { text, reasoning, tools } = textParts(message.content)
      if (reasoning) {
        lines.push(`<details><summary>💭 思考过程</summary>\n\n${fenced(reasoning, 'text')}\n\n</details>`)
        lines.push('')
      }
      if (text) {
        lines.push(`### ${ROLE_LABEL.assistant}`)
        lines.push('')
        if (time) lines.push(`<sub>${time}</sub>`)
        lines.push('')
        lines.push(text)
        lines.push('')
      }
      for (const call of tools) {
        const name = typeof call.name === 'string' ? call.name : 'tool'
        if (call.id) toolNames.set(call.id, name)
        const argsText = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {})
        lines.push(renderToolCall(name, truncate(argsText, 160), fenced(truncate(argsText, 4000), 'json')))
      }
      continue
    }

    if (type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : 'tool'
      if (data.callId) toolNames.set(data.callId, name)
      const argsText = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {})
      lines.push(renderToolCall(name, truncate(argsText, 160), fenced(truncate(argsText, 4000), 'json')))
      continue
    }

    if (type === 'tool/result') {
      const message = data.message && typeof data.message === 'object' ? data.message : data
      const callId = message.toolCallId ?? data.toolCallId ?? (message.source && message.source.callId)
      const name = (callId && toolNames.get(callId)) || 'tool'
      const { text } = textParts(message.content)
      lines.push(renderToolCall(`${name} · 结果`, '', fenced(truncate(text), 'text')))
      continue
    }

    if (type === 'turn/end') {
      const reason = data.reason
      const kind = reason && typeof reason === 'object' ? reason.kind : reason
      if (kind && !SUCCESS_REASONS.has(kind)) {
        const detail = reason && reason.error ? reason.error.message ?? String(reason.error) : ''
        lines.push(`> ⚠️ 回合 ${data.turn ?? ''} 结束：${kind}${detail ? ` — ${truncate(detail, 200)}` : ''}`)
        lines.push('')
      }
      continue
    }

    if (type === 'session/title') continue
  }

  let body = lines.join('\n')
  body = body.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n')
  body = body.trimEnd()
  return `${body}\n`
}

module.exports = { renderTranscript, isoTime, truncate, ROLE_LABEL }