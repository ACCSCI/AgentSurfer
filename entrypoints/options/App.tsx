import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Trash2, Star, CheckCircle2, AlertCircle, Pencil, X } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { db, newId, now } from '@/lib/db';
import { useChangeCount } from '@/lib/use-change-count';
import { sendToSW } from '@/lib/sw-messenger';
import { KnownModels } from '@/lib/llm';
import { ToolConfigPanel } from './components/ToolConfigPanel';
import {
  DefaultBaseUrl,
  DefaultModelId,
  DEFAULT_REASONING_EFFORT,
  ProviderMeta,
  ProviderSchema,
  REASONING_EFFORT_VALUES,
  type Provider,
  type ReasoningEffort,
} from '@/types';
import { ModelConfigSchema } from '@/types';

async function dbMsg(message: { type: string; [k: string]: unknown }): Promise<void> {
  const res = await sendToSW(message);
  if (!res.ok) throw new Error(res.error ?? 'db message failed');
}

export default function OptionsApp() {
  const configChangeCount = useChangeCount('modelConfigs');
  const configs = useLiveQuery(
    () => db.modelConfigs.orderBy('createdAt').toArray(),
    [configChangeCount],
    [],
  );

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">AgentSurfer</h1>
          <p className="text-sm text-muted-foreground">Model providers and API keys</p>
        </div>
        <Badge variant="outline" className="text-xs">v0.1</Badge>
      </header>

      <ConfigForm />

      <Separator className="my-6" />

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Saved configurations
        </h2>
        <ScrollArea className="h-[400px] rounded-md border">
          <div className="space-y-2 p-2">
            {configs?.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">
                No configurations yet. Add one above to get started.
              </p>
            )}
            {configs?.map((c) => (
              <ConfigRow key={c.id} config={c} />
            ))}
          </div>
        </ScrollArea>
      </section>

      <ToolConfigPanel />

      <p className="mt-6 text-xs text-muted-foreground">
        API keys are stored locally in this browser via IndexedDB. They never leave your machine
        except to call the provider you configured.
      </p>
    </div>
  );
}

// ---------- Form: add / edit a config ----------

function ConfigForm() {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<Provider>('openai');
  const [modelId, setModelId] = useState(DefaultModelId.openai);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [maxSteps, setMaxSteps] = useState<number>(99);
  // Reasoning effort — surfaced in the form for StepFun. Other providers
  // silently ignore it (lib/runtime/loop.ts only spreads `providerOptions`
  // when this is set). Reset to DEFAULT_REASONING_EFFORT on provider
  // switch so users don't carry a stale value across providers.
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(DEFAULT_REASONING_EFFORT);
  const [makeDefault, setMakeDefault] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const meta = ProviderMeta[provider];
  const needsBaseUrl = meta.needsBaseUrl;
  const knownModels = KnownModels[provider] ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(false);

    const candidate = {
      id: newId(),
      name: name.trim() || `${meta.label} (${modelId})`,
      provider,
      modelId: modelId.trim() || DefaultModelId[provider],
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim() || null,
      isDefault: makeDefault,
      // Coerce to number explicitly — <input type="number"> returns
      // "" when cleared, which Zod rejects; clamp to schema range
      // and let ModelConfigSchema re-validate the final value.
      maxSteps: Number.isFinite(maxSteps) ? maxSteps : 99,
      // Always store reasoningEffort for new configs — the value is
      // provider-agnostic (StepFun honors it; others ignore it via
      // the loop's conditional spread). This avoids schema-vs-form
      // drift when a user re-edits the same config after switching
      // providers.
      reasoningEffort,
      createdAt: now(),
    };
    const parsed = ModelConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid configuration');
      return;
    }
    try {
      await dbMsg({ type: 'db:upsert-config', config: parsed.data });
      if (makeDefault) await dbMsg({ type: 'db:set-active-config', id: parsed.data.id });
      // Reset form
      setName('');
      setApiKey('');
      setBaseUrl('');
      setMaxSteps(99);
      setReasoningEffort(DEFAULT_REASONING_EFFORT);
      setOk(true);
      setTimeout(() => setOk(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plus className="h-4 w-4" /> Add model configuration
        </CardTitle>
        <CardDescription>
          Pick a provider, enter your API key, and (optionally) make it the default.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="provider">Provider</Label>
              <Select
                value={provider}
                onValueChange={(v) => {
                  const next = ProviderSchema.parse(v);
                  setProvider(next);
                  setModelId(DefaultModelId[next]);
                  // Reset reasoning effort to the default on provider
                  // change so a stale value from a previous provider
                  // doesn't leak into the new config. The field is
                  // still saved (other providers ignore it) but the
                  // initial UI value reflects the recommended default.
                  setReasoningEffort(DEFAULT_REASONING_EFFORT);
                }}
              >
                <SelectTrigger id="provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ProviderSchema.options.map((p) => (
                    <SelectItem key={p} value={p}>
                      {ProviderMeta[p].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="model">Model</Label>
              <Input
                id="model"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder={DefaultModelId[provider]}
                list="known-models"
              />
              {knownModels.length > 0 && (
                <datalist id="known-models">
                  {knownModels.map((m: string) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="name">Display name (optional)</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${meta.label} · ${modelId}`}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="key">API key</Label>
            <Input
              id="key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                meta.authHeader === 'api-key'
                  ? 'MIMO_API_KEY'
                  : meta.authHeader === 'x-api-key'
                    ? 'sk-ant-...'
                    : 'sk-...'
              }
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Auth header: <code>{meta.authHeader}</code>
              {DefaultBaseUrl[provider] && (
                <>
                  {' · '}default URL: <code>{DefaultBaseUrl[provider]}</code>
                </>
              )}
            </p>
          </div>

          {needsBaseUrl && (
            <div className="space-y-1">
              <Label htmlFor="baseurl">Base URL</Label>
              <Input
                id="baseurl"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="maxsteps">Max steps per run</Label>
            <Input
              id="maxsteps"
              type="number"
              min={1}
              max={999}
              step={1}
              value={maxSteps}
              onChange={(e) => {
                // <input type="number"> yields '' when the user clears
                // the field. Treat that as "leave it alone for now" and
                // let Zod catch any out-of-range value on submit.
                const n = e.target.value === '' ? 99 : Number.parseInt(e.target.value, 10);
                setMaxSteps(Number.isFinite(n) ? n : 99);
              }}
              placeholder="99"
            />
            <p className="text-xs text-muted-foreground">
              Cap on how many tool-call steps the agent can take in a single run
              (1-999, default 99). Raise for long multi-step tasks like
              "search → click N results → summarize".
            </p>
          </div>

          {/* Reasoning effort — exposed for StepFun's step-3.7-flash. Other
              providers silently ignore it (see lib/runtime/loop.ts). We
              keep the field visible for all providers so users have one
              mental model; the loop only forwards it to OpenAI-compat
              when set. step-3.5-flash-2603 supports low/high only —
              selecting `medium` for that model will return a 400 from
              the API. */}
          <div className="space-y-1">
            <Label htmlFor="reasoning">Reasoning effort</Label>
            <Select
              value={reasoningEffort}
              onValueChange={(v) => {
                // Cast: Zod-enum produces ReasoningEffort; the Select
                // value comes from REASONING_EFFORT_VALUES which is the
                // exact tuple Zod was built from, so this is safe.
                setReasoningEffort(v as ReasoningEffort);
              }}
            >
              <SelectTrigger id="reasoning">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASONING_EFFORT_VALUES.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              <code>low</code> 简单问答/摘要 · <code>medium</code> 默认推荐 ·
              <code>high</code> 复杂推理/代码. Honored by StepFun step-3.7-flash;
              ignored by other providers.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
              className="h-4 w-4"
            />
            Set as default
          </label>

          {error && (
            <p className="flex items-center gap-1 text-sm text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> {error}
            </p>
          )}
          {ok && (
            <p className="flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> Saved
            </p>
          )}

          <Button type="submit" className="w-full">
            Save configuration
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------- Row: saved config ----------

function ConfigRow({ config }: { config: import('@/types').ModelConfig }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return <ConfigEditRow config={config} onClose={() => setEditing(false)} />;
  }

  return (
    <Card className={config.isDefault ? 'border-primary/50 bg-primary/5' : ''}>
      <CardContent className="flex items-center justify-between p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{config.name}</span>
            {config.isDefault && (
              <Badge variant="default" className="text-[10px]">
                <Star className="mr-1 h-3 w-3" /> active
              </Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {ProviderMeta[config.provider].label} · <code>{config.modelId}</code>
            {config.baseUrl && (
              <>
                {' · '}
                <code>{config.baseUrl}</code>
              </>
            )}
            {' · max steps: '}
            <code>{config.maxSteps ?? 99}</code>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!config.isDefault && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => dbMsg({ type: 'db:set-active-config', id: config.id })}
              title="Set as default"
            >
              <Star className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing(true)}
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => dbMsg({ type: 'db:delete-config', id: config.id })}
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Row: inline-edit an existing config ----------

function ConfigEditRow({
  config,
  onClose,
}: {
  config: import('@/types').ModelConfig;
  onClose: () => void;
}) {
  const meta = ProviderMeta[config.provider];
  const knownModels = KnownModels[config.provider] ?? [];

  const [name, setName] = useState(config.name);
  const [modelId, setModelId] = useState(config.modelId);
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl ?? '');
  const [maxSteps, setMaxSteps] = useState<number>(config.maxSteps ?? 99);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    config.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setError(null);
    // Re-validate against the same schema the add-form uses. Preserve the
    // config's id/provider/isDefault/createdAt so this is an update, not a
    // new row — `db:upsert-config` is a put keyed on `id`.
    const candidate = {
      ...config,
      name: name.trim() || `${meta.label} (${modelId})`,
      modelId: modelId.trim() || config.modelId,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim() || null,
      maxSteps: Number.isFinite(maxSteps) ? maxSteps : 99,
      reasoningEffort,
    };
    const parsed = ModelConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid configuration');
      return;
    }
    setSaving(true);
    try {
      await dbMsg({ type: 'db:upsert-config', config: parsed.data });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <Card className={config.isDefault ? 'border-primary/50 bg-primary/5' : ''}>
      <CardContent className="space-y-3 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Editing · {meta.label}
          </span>
          <Button size="sm" variant="ghost" onClick={onClose} title="Cancel">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="space-y-1">
          <Label htmlFor={`edit-name-${config.id}`}>Display name</Label>
          <Input
            id={`edit-name-${config.id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${meta.label} · ${modelId}`}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor={`edit-model-${config.id}`}>Model</Label>
          <Input
            id={`edit-model-${config.id}`}
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            list={`edit-known-models-${config.id}`}
          />
          {knownModels.length > 0 && (
            <datalist id={`edit-known-models-${config.id}`}>
              {knownModels.map((m: string) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor={`edit-key-${config.id}`}>API key</Label>
          <Input
            id={`edit-key-${config.id}`}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </div>

        {meta.needsBaseUrl && (
          <div className="space-y-1">
            <Label htmlFor={`edit-baseurl-${config.id}`}>Base URL</Label>
            <Input
              id={`edit-baseurl-${config.id}`}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor={`edit-maxsteps-${config.id}`}>Max steps per run</Label>
          <Input
            id={`edit-maxsteps-${config.id}`}
            type="number"
            min={1}
            max={999}
            step={1}
            value={maxSteps}
            onChange={(e) => {
              const n = e.target.value === '' ? 99 : Number.parseInt(e.target.value, 10);
              setMaxSteps(Number.isFinite(n) ? n : 99);
            }}
            placeholder="99"
          />
          <p className="text-xs text-muted-foreground">
            一次回复中 agent 最多允许的工具调用步数 (1-999, 默认 99).
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor={`edit-reasoning-${config.id}`}>Reasoning effort</Label>
          <Select
            value={reasoningEffort}
            onValueChange={(v) => setReasoningEffort(v as ReasoningEffort)}
          >
            <SelectTrigger id={`edit-reasoning-${config.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REASONING_EFFORT_VALUES.map((v) => (
                <SelectItem key={v} value={v}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {error && (
          <p className="flex items-center gap-1 text-sm text-destructive">
            <AlertCircle className="h-3.5 w-3.5" /> {error}
          </p>
        )}

        <div className="flex gap-2">
          <Button type="button" className="flex-1" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
