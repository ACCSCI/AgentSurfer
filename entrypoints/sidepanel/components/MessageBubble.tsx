import { useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Image, Loader2, User } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { AgentStep, ChatMessage } from '@/types';
import { cn } from '@/lib/utils';

export function MessageBubble({
  message,
  steps,
  isLive,
  liveText = '',
  liveReasoning = '',
  liveToolCalls = [],
}: {
  message: ChatMessage;
  steps: AgentStep[];
  isLive: boolean;
  liveText?: string;
  liveReasoning?: string;
  liveToolCalls?: import('@/types/agent').ToolCall[];
}) {
  const isUser = message.role === 'user';
  const baseText = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n');
  // Extract reasoning from Dexie parts (persisted from previous runs).
  const baseReasoning = message.parts
    .filter((p): p is { type: string; reasoning: string } => p.type === 'reasoning' && typeof p.reasoning === 'string')
    .map((p) => p.reasoning)
    .join('\n');
  const reasoning = liveReasoning || baseReasoning;
  const text = liveText || baseText;

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
        {reasoning && (
          <div className="rounded-lg border border-dashed border-muted-foreground/30 bg-muted/30 px-3 py-2 text-xs italic text-muted-foreground whitespace-pre-wrap break-words">
            💭 {reasoning}
          </div>
        )}
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
            {isLive && (
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
  // Auto-expand if the step has text (the model's thinking/narration) or
  // if it's the latest step. Only collapse steps that are purely tool
  // calls with no text.
  const [expanded, setExpanded] = useState(isLatest || !!step.text);
  const hasContent = step.text || step.toolCalls.length > 0 || step.toolResults.length > 0;

  if (!hasContent) return null;

  return (
    <div
      className={cn(
        'rounded border bg-background/50 p-2 text-xs',
        isLatest ? 'border-primary/50 bg-primary/5' : 'border-border',
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-1 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <Badge variant="outline" className="text-[10px]">
          step {step.stepNumber}
        </Badge>
        {step.usage && (
          <span className="text-muted-foreground">
            {step.usage.promptTokens}+{step.usage.completionTokens} tok
          </span>
        )}
        {step.durationMs > 0 && (
          <span className="text-muted-foreground">{step.durationMs}ms</span>
        )}
        {step.toolCalls.length > 0 && (
          <span className="text-muted-foreground">
            {step.toolCalls.length} tool{step.toolCalls.length > 1 ? 's' : ''}
          </span>
        )}
        {!expanded && step.text && (
          <span className="ml-1 truncate text-muted-foreground">
            — {step.text.slice(0, 60)}
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 pl-4">
          {step.text && (
            <div className="whitespace-pre-wrap text-muted-foreground italic">
              {step.text}
            </div>
          )}
          {step.toolCalls.map((tc) => (
            <ToolCallRow key={tc.id} name={tc.name} args={tc.args} />
          ))}
          {step.toolResults.map((tr) => (
            <ToolResultRow
              key={tr.toolCallId}
              name={tr.name}
              result={tr.result}
              isError={tr.isError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallRow({ name, args }: { name: string; args: Record<string, unknown> }) {
  const keys = Object.keys(args);
  return (
    <div className="rounded bg-muted/50 p-2 font-mono text-[11px]">
      <div className="flex items-center gap-1">
        <span className="text-primary font-semibold">→</span>
        <span className="font-semibold">{name}</span>
        {keys.length > 0 && (
          <span className="text-muted-foreground">({keys.length} arg{keys.length > 1 ? 's' : ''})</span>
        )}
      </div>
      {keys.length > 0 && (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-muted-foreground">
          {JSON.stringify(args, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultRow({
  name,
  result,
  isError,
}: {
  name: string;
  result: unknown;
  isError: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (result == null) return null;

  // Screenshot result: show as image
  const asObj = result as Record<string, unknown>;
  if (asObj.dataUrl && typeof asObj.dataUrl === 'string' && name === 'screenshot') {
    return (
      <div className="rounded bg-muted/50 p-2">
        <div className="flex items-center gap-1 text-[11px]">
          <Image className="h-3 w-3" />
          <span className={isError ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}>
            {isError ? '✗' : '✓'}
          </span>
          <span className="font-semibold">{name}</span>
          {asObj.width && asObj.height && (
            <span className="text-muted-foreground">
              {asObj.width}×{asObj.height}px
            </span>
          )}
        </div>
        {!isError && (
          <img
            src={asObj.dataUrl as string}
            alt={`Screenshot from ${name}`}
            className="mt-2 max-h-64 rounded border object-contain"
          />
        )}
      </div>
    );
  }

  // Schedule result: show as metadata
  if (asObj.kind === 'schedule' && Array.isArray(asObj.frames)) {
    return (
      <div className="rounded bg-muted/50 p-2">
        <div className="flex items-center gap-1 text-[11px]">
          <span className={isError ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}>
            {isError ? '✗' : '✓'}
          </span>
          <span className="font-semibold">{name}</span>
          <span className="text-muted-foreground">
            schedule: {asObj.totalFrames} frames, {asObj.totalDurationMs}ms
          </span>
        </div>
        <div className="mt-1 space-y-0.5">
          {(asObj.frames as Array<Record<string, unknown>>).slice(0, 10).map((f, i) => (
            <div key={i} className="text-[10px] text-muted-foreground">
              [{String(f.index)}] t={String(f.timestamp)}ms change={String(f.changeFromBaseline)}px
              {f.bbox ? (
                <span> bbox=({(f.bbox as Record<string, unknown>).x},{(f.bbox as Record<string, unknown>).y})</span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Default: show as JSON (collapsible)
  const str = JSON.stringify(result, null, 2);
  const preview = str.length > 120 ? str.slice(0, 120) + '…' : str;

  return (
    <div className="rounded bg-muted/50 p-2">
      <button
        type="button"
        className="flex items-center gap-1 text-[11px]"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={isError ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}>
          {isError ? '✗' : '✓'}
        </span>
        <span className="font-semibold">{name}</span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        )}
      </button>
      {expanded ? (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground">
          {str}
        </pre>
      ) : (
        <div className="mt-0.5 text-[10px] text-muted-foreground">{preview}</div>
      )}
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

function shortVal(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
