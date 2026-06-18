import React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Wrench } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { getToolConfigs } from '@/lib/db';
import { useChangeCount } from '@/lib/use-change-count';
import { sendToSW } from '@/lib/sw-messenger';
import { ALL_TOOLS, type ToolName } from '@/types';

async function dbMsg(message: { type: string; [k: string]: unknown }): Promise<void> {
  const res = await sendToSW(message);
  if (!res.ok) throw new Error(res.error ?? 'db message failed');
}

const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  focusNext: 'Tab forward through focusable elements',
  focusPrevious: 'Tab backward through focusable elements',
  smartScreenshot: 'Schedule/region/refs screenshot modes',
  screenshot: 'Full-page screenshot (single shot)',
  tabsList: 'List all open tabs',
  tabsSwitch: 'Switch to a specific tab',
  tabsOpen: 'Open a new tab at a URL',
  tabsClose: 'Close a tab by index',
  domQuery: 'Query DOM elements by CSS selector',
  domClick: 'Click an element by CSS selector',
  domType: 'Type text into an input/textarea',
  pressKey: 'Send a keyboard event (Enter, Tab, Escape…)',
  cdpAim: 'Highlight a DOM element at coordinates (x, y)',
  cdpConfirm: 'Confirm a click target at coordinates (x, y)',
  cdpScroll: 'Scroll the page by delta (x, y)',
  cdpCancel: 'Cancel the current CDP action',
  cdpClick: 'Click at coordinates (x, y)',
  cdpType: 'Type text via CDP keyboard events',
  cdpPressKey: 'Press a key via CDP (key code)',
  cdpScreenshot: 'Take a screenshot of the current tab via CDP',
  todo: 'Update the agent todo list for multi-step planning',
};

export function ToolConfigPanel() {
  const toolChangeCount = useChangeCount('toolConfigs');
  const configs = useLiveQuery(
    () => getToolConfigs(),
    [toolChangeCount],
    [],
  );

  async function toggle(name: string, enabled: boolean) {
    await dbMsg({ type: 'db:set-tool-enabled', name, enabled });
  }

  if (!configs) return null;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench className="h-4 w-4" />
          Tools
        </CardTitle>
        <CardDescription>
          Enable or disable tools the agent can use. Disabling a tool removes it from the system prompt
          and the agent won't try to use it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-0">
        {ALL_TOOLS.map((name, i) => {
          const cfg = configs.find((c) => c.name === name);
          const enabled = cfg?.enabled ?? true;
          return (
            <React.Fragment key={name}>
              {i > 0 && <Separator className="my-2" />}
              <div className="flex items-center justify-between py-2">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">{name}</Label>
                  <p className="text-xs text-muted-foreground">{TOOL_DESCRIPTIONS[name]}</p>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={(checked) => toggle(name, checked)}
                />
              </div>
            </React.Fragment>
          );
        })}
      </CardContent>
    </Card>
  );
}
