// Inspect the bing export WITHOUT dumping base64. Auto-discovers structure.
const fs = require('node:fs');
const p = '.e2e-logs/22-bing-export.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));

console.log('=== TOP-LEVEL KEYS ===');
console.log(Object.keys(j));
console.log('\n=== VERDICT FIELDS ===');
for (const k of ['terminationReason','finishReason','lastAssistantStatus','messageCount','stepCount']) {
  console.log(`  ${k} = ${JSON.stringify(j[k])}`);
}

const msgs = j.messages || j.session?.messages || [];
console.log(`\n=== MESSAGES (${msgs.length}) ===`);
for (const m of msgs) {
  if (!m) continue;
  const text = String(m.content ?? m.text ?? '');
  console.log(`- role=${m.role} status=${m.status} stopReason=${m.stopReason ?? ''} finishReason=${m.finishReason ?? ''} len=${text.length}`);
  if (m.role === 'assistant' && text) {
    console.log('  preview:', text.slice(0, 600).replace(/\s+/g, ' '));
  }
}

const steps = j.steps || j.agentSteps || [];
console.log(`\n=== STEPS (${steps.length}) ===`);
const emptyMsgIds = steps.filter(s => !s.messageId).length;
console.log(`  steps with EMPTY messageId: ${emptyMsgIds} / ${steps.length}`);
for (const s of steps.slice(0, 20)) {
  const tools = (s.toolCalls || s.tools || []).map(t => t?.name || t?.toolName || t).join(',');
  console.log(`  step#${s.stepNumber ?? '?'} msgId=${s.messageId || '<EMPTY>'} tools=[${tools}]`);
}
