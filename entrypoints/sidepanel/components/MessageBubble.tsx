import { Bot, User } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { AgentStep, ChatMessage } from '@/types';
import { cn } from '@/lib/utils';

export function MessageBubble({
  message,
  steps,
  isLive,
  liveText = '',
  liveToolCalls = [],
}: {
  message: ChatMessage;
  steps: AgentStep[];
  isLive: boolean;
  liveText?: string;
  liveToolCalls?: import('@/types/agent').ToolCall[];
}) {
  const isUser = message.role === 'user';
  const baseText = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n');
  const text = isLive && liveText ? baseText + liveText : baseText;

  return (
    <div className={cn('flex gap-2', isUser ? 'flex-row-reverse' : 'flex-row')} data-testid="message-bubble">
      <div
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        {text && (
          <div
            className={cn(
              'rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words',
              isUser
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-foreground',
            )}
          >
            {text}
            {isLive && liveText && (
              <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-current align-middle" />
            )}
          </div>
        )}
        {steps.length > 0 && (
          <div className="space-y-1">
            {steps.map((s) => (
              <StepRow key={s.id} step={s} isLatest={isLive && s.stepNumber === steps.length} />
            ))}
          </div>
        )}
        {isLive && liveToolCalls.length > 0 && (
          <div className="space-y-1">
            {liveToolCalls.map((tc) => (
              <div
                key={tc.id}
                className="rounded border border-dashed border-primary/50 bg-primary/5 p-2 font-mono text-[11px]"
              >
                <span className="text-primary">→</span> {tc.name}
                {Object.keys(tc.args).length > 0 && (
                  <span className="ml-1 text-muted-foreground">({summarizeArgs(tc.args)})</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StepRow({ step, isLatest }: { step: AgentStep; isLatest: boolean }) {
  return (
    <div
      className={cn(
        'rounded border border-dashed bg-background/50 p-2 text-xs',
        isLatest && 'border-primary/50 bg-primary/5',
      )}
    >
      <div className="flex items-center gap-1 text-muted-foreground">
        <Badge variant="outline" className="text-[10px]">
          step {step.stepNumber}
        </Badge>
        {step.usage && (
          <span>
            {step.usage.promptTokens}+{step.usage.completionTokens} tok
          </span>
        )}
        {step.durationMs > 0 && <span>{step.durationMs}ms</span>}
      </div>
      {step.text && <p className="mt-1 whitespace-pre-wrap">{step.text}</p>}
      {step.toolCalls.map((tc) => (
        <div key={tc.id} className="mt-1 font-mono text-[11px]">
          <span className="text-primary">→</span> {tc.name}
          {Object.keys(tc.args).length > 0 && (
            <span className="text-muted-foreground">({summarizeArgs(tc.args)})</span>
          )}
        </div>
      ))}
      {step.toolResults.map((tr) => (
        <div key={tr.toolCallId} className="mt-0.5 font-mono text-[11px] text-muted-foreground">
          <span className={tr.isError ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}>
            {tr.isError ? '✗' : '✓'}
          </span>{' '}
          {tr.name} → {summarizeResult(tr.result)}
        </div>
      ))}
    </div>
  );
}

function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  const preview = keys
    .slice(0, 2)
    .map((k) => `${k}=${shortVal(args[k])}`)
    .join(', ');
  return keys.length > 2 ? `${preview}, +${keys.length - 2}` : preview;
}

function summarizeResult(result: unknown): string {
  if (result == null) return 'null';
  if (typeof result === 'object') {
    const r = result as { dataUrl?: unknown };
    if (r.dataUrl && typeof r.dataUrl === 'string') return '<screenshot>';
    const arr = Array.isArray(result) ? result : null;
    if (arr) return `Array(${arr.length})`;
    return '{…}';
  }
  return shortVal(result);
}

function shortVal(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
