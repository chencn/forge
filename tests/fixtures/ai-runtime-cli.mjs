// Deterministic local test peer. Never launches a provider or contacts a service.
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [provider, scenario = 'deny'] = process.argv.slice(2);
const send = (value) => {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  // Exercise partial pipe frames, including multibyte UTF-8 boundaries.
  for (let i = 0; i < bytes.length; i += 3) process.stdout.write(bytes.subarray(i, i + 3));
};
const thread = 'native-session';
const reconnectMarker = `disconnect-once-${provider}.marker`;
const line = createInterface({ input: process.stdin });
line.on('line', (raw) => {
  const msg = JSON.parse(raw);
  if (scenario === 'oversize') { process.stdout.write('x'.repeat(16 * 1024 * 1024 + 20)); return; }
  if (scenario === 'crash') { process.stderr.write('fixture crash'); process.exit(7); }
  if (scenario === 'flood') { for (let i = 0; i < 10000; i++) process.stdout.write(JSON.stringify({ index: i }) + '\n'); setInterval(() => {}, 1000); return; }
  if (scenario === 'truncated') { process.stdout.write('{"unfinished":'); process.exit(0); }
  if (scenario === 'child') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
    send({ childPid: child.pid });
    setInterval(() => {}, 1000); return;
  }
  if (provider === 'codex') {
    if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'fixture' } });
    else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
      if (msg.params.sandbox !== 'workspace-write' || msg.params.approvalPolicy !== 'on-request' || msg.params.approvalsReviewer !== 'user') process.exit(9);
      if (msg.method === 'thread/resume' && msg.params.threadId !== thread) process.exit(10);
      send({ id: msg.id, result: { thread: { id: thread }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' } } });
    } else if (msg.method === 'thread/compact/start' || msg.method === 'review/start') {
      if (!scenario.startsWith('slash-') || msg.params.threadId !== thread || 'serviceTierForTurn' in msg.params || 'effort' in msg.params) process.exit(13);
      const compact = msg.method === 'thread/compact/start';
      if (compact) {
        if (Object.keys(msg.params).length !== 1) process.exit(14);
        send({ id: msg.id, result: {} });
      } else {
        const expected = scenario === 'slash-review-default' ? { type: 'uncommittedChanges' } : { type: 'custom', instructions: ' "a b" --flag\n第二行  ' };
        if (msg.params.delivery !== 'inline' || JSON.stringify(msg.params.target) !== JSON.stringify(expected)) {
          // Object key ordering is not part of JSON-RPC.
          if (msg.params.delivery !== 'inline' || msg.params.target.type !== expected.type || msg.params.target.instructions !== expected.instructions) process.exit(15);
        }
        send({ id: msg.id, result: { reviewThreadId: thread, turn: { id: 'turn-1' } } });
      }
      // Compaction may expose the turn ID first through its item notification.
      send({ method: 'item/started', params: { threadId: thread, turnId: 'turn-1', item: { id: 'command-1', type: compact ? 'contextCompaction' : 'enteredReviewMode' } } });
      send({ method: 'item/completed', params: { threadId: thread, turnId: 'turn-1', item: { id: 'command-1', type: compact ? 'contextCompaction' : 'exitedReviewMode', review: 'fixture review 中文😀' } } });
      setTimeout(() => send({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'turn-1', status: 'completed' } } }), 30);
    } else if (msg.method === 'thread/turns/list' && scenario === 'disconnect-recover') {
      send({ id: msg.id, result: { data: [{ id: 'turn-1', status: 'completed', items: [{ id: 'recovered', type: 'agentMessage', text: '恢复完成' }] }], nextCursor: null } });
    } else if (msg.method === 'turn/start') {
      if (scenario.startsWith('slash-')) process.exit(16);
      if (scenario === 'disconnect-recover') {
        if (existsSync(reconnectMarker)) process.exit(19);
        send({ id: msg.id, result: { turn: { id: 'turn-1' } } });
        writeFileSync(reconnectMarker, 'disconnected');
        send({ method: 'item/agentMessage/delta', params: { threadId: thread, itemId: 'partial', delta: '中断前' } });
        setTimeout(() => process.exit(23), 20);
        return;
      }
      send({ id: msg.id, result: { turn: { id: 'turn-1' } } });
      send({ method: 'item/agentMessage/delta', params: { threadId: thread, itemId: 'text-1', delta: '中文😀' } });
      send({ method: 'item/completed', params: { threadId: thread, item: { id: 'text-1', type: 'agentMessage', text: '中文😀' } } });
      send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: thread, turnId: 'turn-1', itemId: 'cmd-1', command: 'fixture writes marker' } });
    } else if (msg.id === 'approval-1') {
      if (msg.result.decision === 'accept') writeFileSync('allowed-marker.txt', 'approved');
      else if (msg.result.decision !== 'decline') process.exit(11);
      send({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'turn-1', status: 'completed' } } });
    } else if (msg.method === 'turn/interrupt') {
      send({ id: msg.id, result: {} });
      send({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'turn-1', status: 'interrupted' } } });
    }
  } else {
    if (msg.type === 'control_request' && msg.request.subtype === 'initialize') send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: scenario.startsWith('slash-') ? { commands: [{ name: 'fixture:check', description: 'Fixture command', argumentHint: '<file> [args]' }], account: { secret: 'discard-fixture-secret' } } : {} } });
    else if (msg.type === 'control_request' && msg.request.subtype === 'get_context_usage') {
      if (msg.request.detail !== 'summary') process.exit(12);
      if (scenario === 'context-timeout') return;
      if (scenario === 'context-eof') { line.close(); return; }
      if (scenario === 'context-unsupported') {
        send({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'unsupported' } });
      } else {
        send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {
          model: 'fixture-model', totalTokens: 6000, rawMaxTokens: 10000,
          categories: [{ name: 'System prompt', tokens: 1000, kind: 'used' }, { name: 'MCP tools', tokens: 2000, kind: 'used' }, { name: 'Messages', tokens: 3000, kind: 'used' }, { name: 'Free space', tokens: 4000, kind: 'free' }, { name: 'Deferred', tokens: 90000, kind: 'deferred' }],
          systemPromptSections: [{ name: 'Base instructions', tokens: 1000 }],
          mcpTools: [{ name: 'fixture_read', serverName: 'fixture', tokens: 2000, isLoaded: true }],
          messageBreakdown: { userMessageTokens: 500, assistantMessageTokens: 2500 },
          apiUsage: { input_tokens: 999999 },
        } } });
      }
    }
    else if (msg.type === 'user') {
      if (scenario === 'slash-missing') process.exit(17);
      if (scenario === 'slash-claude') {
        if (msg.message.content !== '/fixture:check  "a b" --flag\n第二行  ' || msg.origin?.kind !== 'human') process.exit(18);
        send({ type: 'system', subtype: 'init', session_id: thread, terminal_slash_commands: ['exit'] });
        send({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'replacement', description: 'new catalog', argumentHint: '[text]' }] });
        send({ type: 'system', subtype: 'local_command_output', session_id: thread, uuid: 'command-output', content: 'fixture output 中文😀' });
        send({ type: 'result', subtype: 'success', session_id: thread, is_error: false, result: 'fixture output 中文😀' });
        return;
      }
      if (scenario === 'disconnect-recover') {
        if (existsSync(reconnectMarker)) process.exit(19);
        send({ type: 'system', subtype: 'init', session_id: thread });
        writeFileSync(reconnectMarker, 'disconnected');
        send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'partial' } } });
        send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '中断前' } } });
        setTimeout(() => process.exit(23), 20);
        return;
      }
      send({ type: 'system', subtype: 'init', session_id: thread });
      send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'text-1' } } });
      send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '中文😀' } } });
      send({ type: 'assistant', message: { id: 'text-1', content: [{ type: 'text', text: '中文😀' }] } });
      send({ type: 'control_request', request_id: 'approval-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'fixture writes marker' } } });
    } else if (msg.type === 'control_response') {
      const reply = msg.response.response;
      if (reply.behavior === 'allow') writeFileSync('allowed-marker.txt', 'approved');
      else if (reply.behavior !== 'deny') process.exit(11);
      send({ type: 'result', subtype: 'success', session_id: thread, is_error: false, result: '中文😀' });
    } else if (msg.type === 'control_request' && msg.request.subtype === 'interrupt') {
      send({ type: 'result', subtype: 'success', session_id: thread, is_error: false, result: '' });
    }
  }
});
line.on('close', () => process.exit(0));
