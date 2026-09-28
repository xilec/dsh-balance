/**
 * The text half of the history export.
 *
 * The `full` detail level carries the words of a session — the user's prompts,
 * the assistant's answers and thinking, the tool arguments and results. None of
 * that lives in the cost projection, which deliberately holds usage and not
 * messages, so it is read from the session log here and normalized into flat
 * records the client can merge into the cost stream by time (D46).
 *
 * Nothing is truncated at this end: the client applies the 2000-character rule so
 * that the one place shaping the payload stays under the golden test (D45).
 */

/** The text of every `text` block of a message, in order. */
function textOfBlocks(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** The thinking of a message, which only the assistant side ever carries. */
function reasoningOfBlocks(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * Normalize one session log into the export's text records.
 *
 * Events below `inheritedEventCount` belong to the parent a forked child was
 * seeded with and are skipped, exactly as the cost fold skips them (D42): the
 * export of a child must not quote its parent's conversation.
 *
 * @param events - the session's events, in log order.
 * @param inheritedEventCount - events below this sequence belong to the parent.
 * @returns records carrying `seq`, `t`, `turn`, `step` and their own payload.
 */
export function textRecordsOf(events, inheritedEventCount = 0) {
  const records = []
  for (const event of events ?? []) {
    const seq = typeof event.seq === 'number' ? event.seq : 0
    if (seq < inheritedEventCount) continue
    const data = event.data ?? {}
    const base = {
      seq,
      t: typeof event.time === 'number' ? event.time : null,
      turn: typeof data.turn === 'number' ? data.turn : null,
      step: typeof data.step === 'number' ? data.step : null,
    }
    if (event.type === 'user/message') {
      // A user message *is* the event payload: unlike the assistant side, the
      // message sits at the top of `data` and the envelope carries no turn/step.
      const text = textOfBlocks(data.message ?? data)
      if (text !== '') records.push({ ...base, type: 'user_message', text })
    } else if (event.type === 'assistant/message') {
      const text = textOfBlocks(data.message)
      if (text !== '') records.push({ ...base, type: 'assistant_message', text })
      const thinking = reasoningOfBlocks(data.message)
      if (thinking !== '') records.push({ ...base, type: 'assistant_thinking', text: thinking })
    } else if (event.type === 'tool/call') {
      records.push({
        ...base,
        type: 'tool_call',
        name: typeof data.name === 'string' ? data.name : '',
        callId: typeof data.callId === 'string' ? data.callId : '',
        arguments: typeof data.arguments === 'string' ? data.arguments : '',
      })
    } else if (event.type === 'tool/result') {
      const text = textOfBlocks(data.message)
      if (text !== '') {
        records.push({
          ...base,
          type: 'tool_result',
          // The id pairs the result with its call; the flag says the tool failed.
          callId: typeof data.message?.toolCallId === 'string' ? data.message.toolCallId : '',
          isError: data.message?.isError === true,
          text,
        })
      }
    }
  }
  return records
}
