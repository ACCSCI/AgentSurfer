import { useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Image, User } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { MessageBuffer, ToolCallBuffer } from '@/lib/message-store';
import { cn } from '@/lib/utils';

export function MessageBubble({ message }: { message: MessageBuffer }) {
  const isUser = message.role === 'user';
  const isLive = message.status === 'draft';

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
        {message.reasoning && (
          <div
            data-testid="message-reasoning"
            data-reasoning-length={message.reasoning.length}
            className="rounded-lg border border-dashed border-muted-foreground/30 bg-muted/30 px-3 py-2 text-xs italic text-muted-foreground whitespace-pre-wrap break-words"
          >
            💭 {message.reasoning}
          </div>
        )}
        {message.text && (
          <div
            data-testid="message-text"
            data-text-length={message.text.length}
            className={cn(
              'rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words',
              isUser
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-foreground',
            )}
          >
            {message.text}
            {isLive && (
              <span
                data-testid="streaming-cursor"
                className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-current align-middle"
              />
            )}
          </div>
        )}
        {message.toolCalls.length > 0 && (
          <div className="space-y-1">
            {message.toolCalls.map((tc) => (
              <ToolCallRow key={tc.id} tc={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCallRow({ tc }: { tc: ToolCallBuffer }) {
  const argsKeys = Object.keys(tc.args);
  const showResult = tc.status === 'complete' || tc.status === 'error';
  return (
    <div
      data-testid="tool-call"
      data-tool-name={tc.name}
      data-tool-status={tc.status}
      className="rounded border border-dashed border-primary/40 bg-primary/5 p-2 font-mono text-[11px]"
    >
      <div className="flex items-center gap-1">
        <span className="text-primary font-semibold">{tc.status === 'pending' ? '…' : tc.status === 'error' ? '✗' : '✓'}</span>
        <span className="font-semibold">{tc.name}</span>
        {argsKeys.length > 0 && (
          <span className="text-muted-foreground">({summarizeArgs(tc.args)})</span>
        )}
        <Badge variant="outline" className="ml-auto text-[9px]">
          {tc.status}
        </Badge>
      </div>
      {argsKeys.length > 0 && (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-muted-foreground">
          {JSON.stringify(tc.args, null, 2)}
        </pre>
      )}
      {showResult && <ToolResultView name={tc.name} result={tc.result} isError={tc.status === 'error'} />}
    </div>
  );
}

function ToolResultView({ name, result, isError }: { name: string; result: unknown; isError: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (result == null) return null;

  const asObj = result as Record<string, unknown>;
  // Screenshot result: render as image
  if (asObj.dataUrl && typeof asObj.dataUrl === 'string' && name === 'screenshot') {
    return (
      <div className="mt-2 rounded bg-muted/50 p-2">
        <div className="flex items-center gap-1 text-[11px]">
          <Image className="h-3 w-3" />
          <span className={isError ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}>
            {isError ? '✗' : '✓'}
          </span>
          <span className="font-semibold">{name}</span>
          {(asObj.width != null && asObj.height != null) && (
            <span className="text-muted-foreground">
              {asObj.width as number}×{asObj.height as number}px
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

  // Default: collapsible JSON
  const str = JSON.stringify(result, null, 2);
  const preview = str.length > 120 ? str.slice(0, 120) + '…' : str;
  return (
    <div className="mt-2 rounded bg-muted/50 p-2">
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
