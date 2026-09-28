import assert from 'node:assert/strict'
import test from 'node:test'
import { textRecordsOf } from '../src/export-text.js'

const message = (blocks) => ({ content: blocks })

const log = [
  { seq: 1, time: 1000, type: 'step/start', data: { turn: 1, step: 1 } },
  { seq: 2, time: 1100, type: 'user/message', data: { turn: 1, step: 1, message: message([{ type: 'text', text: 'where did the money go?' }]) } },
  { seq: 3, time: 1200, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls -la"}' } },
  { seq: 4, time: 1300, type: 'tool/result', data: { turn: 1, step: 1, message: { ...message([{ type: 'text', text: 'total 0' }]), toolCallId: 'call-1', isError: false } } },
  {
    seq: 5,
    time: 1400,
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: message([{ type: 'reasoning', text: 'count the calls' }, { type: 'text', text: 'here it is' }]),
    },
  },
  { seq: 6, time: 1500, type: 'assistant/message', data: { turn: 1, step: 1, interrupted: true } },
]

test('the text extractor normalizes the log into the export records', () => {
  const records = textRecordsOf(log)
  assert.deepEqual(records.map((record) => [record.seq, record.type]), [
    [2, 'user_message'],
    [3, 'tool_call'],
    [4, 'tool_result'],
    [5, 'assistant_message'],
    [5, 'assistant_thinking'],
  ], 'every record keeps the log order and its own sequence')
  assert.deepEqual(records[0], { seq: 2, t: 1100, turn: 1, step: 1, type: 'user_message', text: 'where did the money go?' })
  assert.deepEqual(records[1], {
    seq: 3, t: 1200, turn: 1, step: 1, type: 'tool_call', name: 'bash', callId: 'call-1', arguments: '{"command":"ls -la"}',
  })
  assert.deepEqual(
    { callId: records[2].callId, isError: records[2].isError },
    { callId: 'call-1', isError: false },
    'a result cites the call it answers and whether it failed',
  )
  assert.equal(records[3].text, 'here it is')
  assert.equal(records[4].text, 'count the calls', 'thinking is its own record, not part of the answer')
  assert.equal(records.some((record) => record.seq === 6), false, 'a message with no text is not a record')
  assert.equal(records.some((record) => record.seq === 1), false, 'steps carry usage, not words')
})

test('the text of a forked child does not quote its parent', () => {
  const records = textRecordsOf(log, 4)
  assert.deepEqual(records.map((record) => record.seq), [4, 5, 5], 'events below the inherited count are the parent’s, exactly as in the cost fold')
})

test('a log with no text at all yields no records', () => {
  assert.deepEqual(textRecordsOf(undefined), [])
  assert.deepEqual(textRecordsOf([{ seq: 1, time: 1, type: 'step/start', data: { turn: 1, step: 1 } }]), [])
  // Shapes the harness does not produce are ignored rather than thrown over.
  assert.deepEqual(textRecordsOf([{ seq: 1, type: 'user/message', data: { message: { content: 'plain' } } }]), [])
})
