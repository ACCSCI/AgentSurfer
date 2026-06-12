import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Trash2, Star, CheckCircle2, AlertCircle } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { db, deleteConfig, newId, now, setActiveConfig, upsertConfig } from '@/lib/db';
import { KnownModels } from '@/lib/llm';
import { ToolConfigPanel } from './components/ToolConfigPanel';
import {
  DefaultBaseUrl,
  DefaultModelId,
  ProviderMeta,
  ProviderSchema,
  type Provider,
} from '@/types';
import { ModelConfigSchema } from '@/types';

export default function OptionsApp() {
  const configs = useLiveQuery(() => db.modelConfigs.orderBy('createdAt').toArray(), [], []);

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
      createdAt: now(),
    };
    const parsed = ModelConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid configuration');
      return;
    }
    try {
      await upsertConfig(parsed.data);
      if (makeDefault) await setActiveConfig(parsed.data.id);
      // Reset form
      setName('');
      setApiKey('');
      setBaseUrl('');
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
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{config.name}</span>
            {config.isDefault && (
              <Badge variant="secondary" className="text-[10px]">
                <Star className="mr-1 h-3 w-3" /> default
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
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!config.isDefault && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setActiveConfig(config.id)}
              title="Set as default"
            >
              <Star className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => deleteConfig(config.id)}
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
