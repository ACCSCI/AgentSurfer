import { useEffect, useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useMessageStore } from '@/stores/useMessageStore';

export function InputBar({
  onSubmit,
  onCancel,
  disabled,
}: {
  onSubmit: (prompt: string) => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  // isRunning is derived from MessageStore — last message is in 'draft' state.
  const { state } = useMessageStore();
  const lastMsg = state.messages[state.messages.length - 1];
  const isRunning = lastMsg?.status === 'draft';

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
    <div className="shrink-0 border-t bg-background p-2">
      <div className="flex min-w-0 items-end gap-2">
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
          className="min-h-[44px] min-w-0 max-w-full flex-1 resize-none"
          disabled={disabled}
        />
        {isRunning ? (
          <Button
            size="icon"
            variant="destructive"
            onClick={onCancel}
            title="Cancel run"
            className="shrink-0"
          >
            <Square className="h-4 w-4 fill-current" />
          </Button>
        ) : (
          <Button
            size="icon"
            onClick={submit}
            disabled={disabled || !value.trim()}
            title="Send"
            className="shrink-0"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
