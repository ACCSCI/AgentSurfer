import { useEffect, useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAgentStore } from '@/stores';

export function InputBar({
  onSubmit,
  disabled,
}: {
  onSubmit: (prompt: string) => void;
  disabled?: boolean;
}) {
  const isRunning = useAgentStore((s) => s.isRunning);
  const cancel = useAgentStore((s) => s.cancel);
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Auto-focus when the panel opens.
    taRef.current?.focus();
  }, []);

  function submit() {
    const text = value.trim();
    if (!text || isRunning) return;
    onSubmit(text);
    setValue('');
  }

  return (
    <div className="border-t bg-background p-2">
      <div className="flex items-end gap-2">
        <Textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            isRunning ? 'Agent is running… (press Esc to cancel)' : 'Ask the agent to do something…'
          }
          rows={2}
          className="min-h-[44px] flex-1 resize-none"
          disabled={disabled}
        />
        {isRunning ? (
          <Button
            size="icon"
            variant="destructive"
            onClick={cancel}
            title="Cancel run"
          >
            <Square className="h-4 w-4 fill-current" />
          </Button>
        ) : (
          <Button size="icon" onClick={submit} disabled={disabled || !value.trim()} title="Send">
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
