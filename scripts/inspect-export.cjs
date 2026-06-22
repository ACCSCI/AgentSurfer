const fs = require('fs');
const path = process.argv[2];
const j = JSON.parse(fs.readFileSync(path, 'utf8'));
const msgs = j.messages || [];

function brief(v, n = 400) {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > n ? s.slice(0, n) + '…(' + s.length + ')' : s;
  } catch {
    return String(v);
  }
}

function dumpMsg(i) {
  const m = msgs[i];
  console.log('\n=== msg #' + i + ' role=' + m.role + ' status=' + m.status +
    ' finishReason=' + m.finishReason + ' stopReason=' + m.stopReason + ' ===');
  (m.parts || []).forEach((p, idx) => {
    if (p.type === 'reasoning') {
      console.log(idx, 'reasoning:', brief(p.text || p.reasoning, 150));
    } else if (p.type === 'tool-call') {
      const tc = p.toolCall || {};
      console.log(idx, 'CALL', tc.name, brief(tc.args, 250));
    } else if (p.type === 'tool-result') {
      const tr = p.toolResult || {};
      console.log(idx, 'RESULT', tr.name || '', brief(tr.result !== undefined ? tr.result : tr, 350));
    } else if (p.type === 'text') {
      console.log(idx, 'TEXT:', brief(p.text, 300));
    } else {
      console.log(idx, p.type, brief(p, 200));
    }
  });
}

dumpMsg(7);
dumpMsg(9);
