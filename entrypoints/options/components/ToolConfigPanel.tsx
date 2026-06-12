import React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Wrench } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { db, getToolConfigs, setToolEnabled } from '@/lib/db';
import { ALL_TOOLS, type ToolName } from '@/types';

const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  focusNext: 'Tab forward through focusable elements',
  focusPrevious: 'Tab backward through focusable elements',
  smartScreenshot: 'Schedule/region/refs screenshot modes',
  screenshot: 'Full-page screenshot (single shot)',
  tabsList: 'List all open tabs',
  tabsSwitch: 'Switch to a specific tab',
  tabsOpen: 'Open a new tab at a URL',
  domQuery: 'Query DOM elements by CSS selector',
  domClick: 'Click an element by CSS selector',
  domType: 'Type text into an input/textarea',
  pressKey: 'Send a keyboard event (Enter, Tab, Escape…)',
};

export function ToolConfigPanel() {
  const configs = useLiveQuery(
    () => getToolConfigs(),
    [],
    [],
  );

  async function toggle(name: string, enabled: boolean) {
    await setToolEnabled(name, enabled);
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
