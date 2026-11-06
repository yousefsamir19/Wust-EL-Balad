import { promises as dns } from 'node:dns';
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { AiFailureCode, JsonMode, JsonSchema, ProviderConfig, ProviderKey, ProviderKind, Transport, WireRequest, WireResult } from './types.js';
import { AiFailure } from './types.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const OLLAMA_ORIGINS = new Set(['http://127.0.0.1:11434', 'http://localhost:11434']);

/** Provider routes documented at https://ai.google.dev/api/generate-content. */
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
/** NIM route documented at https://docs.api.nvidia.com/nim/reference/llm-apis. */
const NIM_BASE = 'https://integrate.api.nvidia.com/v1';
/** OpenRouter route documented at https://openrouter.ai/docs/api-reference/overview. */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
/** Groq route documented at https://console.groq.com/docs/api-reference#chat-create. */
const GROQ_BASE = 'https://api.groq.com/openai/v1';
/** Ollama route documented at https://docs.ollama.com/api/chat. */
const OLLAMA_BASE = 'http://127.0.0.1:11434';

const OFFICIAL_ORIGINS: Record<Exclude<ProviderKind, 'compatible'>, string> = {
  gemini: new URL(GEMINI_BASE).origin,
  nim: new URL(NIM_BASE).origin,
  openrouter: new URL(OPENROUTER_BASE).origin,
  groq: new URL(GROQ_BASE).origin,
  ollama: new URL(OLLAMA_BASE).origin,
};

function failure(code: AiFailureCode, retryAfterMs = 0): never {
  throw new AiFailure(code, retryAfterMs);
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    return failure('unsafe_endpoint');
  }
}

function originIsAllowed(url: URL, allowedOrigins: string[]): boolean {
  return allowedOrigins.some((candidate) => {
    try {
      const allowed = new URL(candidate.trim());
      return !allowed.username && !allowed.password && !allowed.search && !allowed.hash && allowed.origin === url.origin;
    } catch {
      return false;
    }
  });
}

function hostName(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

function isLocalHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost' || normalized.endsWith('.localhost');
}

function ipv4Number(value: string): number | undefined {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return undefined;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipv4InRange(value: number, start: string, end: string): boolean {
  const first = ipv4Number(start);
  const last = ipv4Number(end);
  return first !== undefined && last !== undefined && value >= first && value <= last;
}

function isReservedAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ipv4 = mapped?.[1] ?? (isIP(normalized) === 4 ? normalized : undefined);
  if (ipv4) {
    const number = ipv4Number(ipv4);
    if (number === undefined) return true;
    return (
      ipv4InRange(number, '0.0.0.0', '0.255.255.255') ||
      ipv4InRange(number, '10.0.0.0', '10.255.255.255') ||
      ipv4InRange(number, '100.64.0.0', '100.127.255.255') ||
      ipv4InRange(number, '127.0.0.0', '127.255.255.255') ||
      ipv4InRange(number, '169.254.0.0', '169.254.255.255') ||
      ipv4InRange(number, '172.16.0.0', '172.31.255.255') ||
      ipv4InRange(number, '192.0.0.0', '192.0.0.255') ||
      ipv4InRange(number, '192.0.2.0', '192.0.2.255') ||
      ipv4InRange(number, '192.168.0.0', '192.168.255.255') ||
      ipv4InRange(number, '198.18.0.0', '198.19.255.255') ||
      ipv4InRange(number, '198.51.100.0', '198.51.100.255') ||
      ipv4InRange(number, '203.0.113.0', '203.0.113.255') ||
      ipv4InRange(number, '224.0.0.0', '255.255.255.255')
    );
  }

  if (isIP(normalized) !== 6) return false;
  const leading=parseInt(normalized.split(':')[0]||'0',16);
  if(leading<0x2000||leading>=0x4000)return true;
  const compact = normalized.replace(/:/g, '');
  return (
    normalized === '::' || normalized === '::1' ||
    normalized.startsWith('fc') || normalized.startsWith('fd') ||
    normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') ||
    normalized.startsWith('ff') || normalized.startsWith('2001:db8:') ||
    compact === ''
  );
}

function configuredAllowedOrigins(): string[] {
  return (process.env.AI_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

export function defaults(kind: ProviderKind): { baseUrl: string; jsonMode: JsonMode } {
  switch (kind) {
    case 'gemini': return { baseUrl: GEMINI_BASE, jsonMode: 'schema' };
    case 'nim': return { baseUrl: NIM_BASE, jsonMode: 'prompt' };
    case 'openrouter': return { baseUrl: OPENROUTER_BASE, jsonMode: 'prompt' };
    case 'groq': return { baseUrl: GROQ_BASE, jsonMode: 'prompt' };
    case 'ollama': return { baseUrl: OLLAMA_BASE, jsonMode: 'schema' };
    case 'compatible': return { baseUrl: '', jsonMode: 'prompt' };
  }
}

export function validateEndpoint(kind: ProviderKind, baseUrl: string, allowedOrigins: string[] = []): void {
  const url = parseUrl(baseUrl);
  if (!url.hostname || url.username || url.password || url.search || url.hash) failure('unsafe_endpoint');

  const manual = originIsAllowed(url, allowedOrigins);
  const origin = url.origin;
  if (kind !== 'compatible' && origin !== OFFICIAL_ORIGINS[kind] && !manual) failure('unsafe_endpoint');
  if (kind === 'ollama' && !manual && !OLLAMA_ORIGINS.has(origin)) failure('unsafe_endpoint');
  if (url.protocol !== 'https:' && !manual && !(kind === 'ollama' && OLLAMA_ORIGINS.has(origin))) failure('unsafe_endpoint');

  if (kind === 'compatible' && !manual) {
    const host = hostName(url);
    if (isLocalHost(host) || isReservedAddress(host)) failure('unsafe_endpoint');
  }
}

function normalizedGoogleSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {};
  const source = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  let type = typeof source.type === 'string' ? source.type.toUpperCase() : undefined;
  let nullable = source.nullable === true;
  if (Array.isArray(source.type)) {
    const types = source.type.filter((entry): entry is string => typeof entry === 'string');
    nullable ||= types.some(entry=>entry.toUpperCase()==='NULL');
    type = types.find((entry) => entry.toUpperCase() !== 'NULL')?.toUpperCase();
  }
  if (!type && source.properties && typeof source.properties === 'object' && !Array.isArray(source.properties)) type = 'OBJECT';
  if (!type && source.items && typeof source.items === 'object') type = 'ARRAY';
  if (type) result.type = type;
  if (nullable) result.nullable = true;
  if (Array.isArray(source.enum)) result.enum = source.enum;

  if (source.properties && typeof source.properties === 'object' && !Array.isArray(source.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(source.properties as Record<string, unknown>)) properties[name] = normalizedGoogleSchema(value);
    result.properties = properties;
  }
  if (source.items && typeof source.items === 'object' && !Array.isArray(source.items)) result.items = normalizedGoogleSchema(source.items);
  if (Array.isArray(source.required)) result.required = source.required.filter((entry): entry is string => typeof entry === 'string');
  return result;
}

function schemaText(schema: JsonSchema): string {
  try {
    return JSON.stringify(schema) || '{}';
  } catch {
    return '{}';
  }
}

const JSON_ONLY_INSTRUCTION = 'Respond with exactly one valid JSON value and no markdown, commentary, or code fences.';

function promptMode(request: WireRequest): { system: string; prompt: string } {
  return {
    system: `${request.system}\n\n${JSON_ONLY_INSTRUCTION}`,
    prompt: `${request.prompt}\n\nReturn JSON matching this schema:\n${schemaText(request.schema)}`,
  };
}

function messages(request: WireRequest, mode: JsonMode): Array<{ role: 'system' | 'user'; content: string }> {
  const content = mode === 'prompt' ? promptMode(request) : { system: request.system, prompt: request.prompt };
  return [{ role: 'system', content: content.system }, { role: 'user', content: content.prompt }];
}

function endpointFor(provider: ProviderConfig): URL {
  const baseUrl = provider.baseUrl || defaults(provider.kind).baseUrl;
  const base = parseUrl(baseUrl);
  const path=base.pathname.replace(/\/$/,'');
  if(provider.kind==='gemini')base.pathname=`${path.endsWith('/v1beta')?path:path+'/v1beta'}/models/${encodeURIComponent(provider.model)}:generateContent`;
  else if(provider.kind==='ollama')base.pathname=path.endsWith('/api/chat')?path:path.endsWith('/api')?path+'/chat':path+'/api/chat';
  else base.pathname=path.endsWith('/chat/completions')?path:path+'/chat/completions';
  return base;
}

function authHeaders(kind: ProviderKind, key: ProviderKey | undefined): Record<string, string> {
  const value = key && key.enabled !== false ? key.value : undefined;
  if (!value || kind === 'ollama') return {};
  return kind === 'gemini' ? { 'x-goog-api-key': value } : { authorization: `Bearer ${value}` };
}

function requestBody(provider: ProviderConfig, request: WireRequest): Record<string, unknown> {
  if (provider.kind === 'gemini') {
    const content = promptMode(request);
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: content.prompt }] }],
      systemInstruction: { parts: [{ text: provider.jsonMode === 'prompt' ? content.system : request.system }] },
      generationConfig: { maxOutputTokens: request.maxOutputTokens },
    };
    const generationConfig = body.generationConfig as Record<string, unknown>;
    if (provider.jsonMode !== 'prompt') generationConfig.responseMimeType = 'application/json';
    if (provider.jsonMode === 'schema') generationConfig.responseSchema = normalizedGoogleSchema(request.schema);
    return body;
  }

  if (provider.kind === 'ollama') {
    const content = provider.jsonMode === 'prompt' ? promptMode(request) : { system: request.system, prompt: request.prompt };
    const body: Record<string, unknown> = {
      model: provider.model,
      messages: [{ role: 'system', content: content.system }, { role: 'user', content: content.prompt }],
      stream: false,
      options: { num_predict: request.maxOutputTokens },
    };
    if (provider.jsonMode === 'schema') body.format = request.schema;
    else if (provider.jsonMode === 'object') body.format = 'json';
    return body;
  }

  const body: Record<string, unknown> = { model: provider.model, messages: messages(request, provider.jsonMode), max_tokens: request.maxOutputTokens };
  if (provider.jsonMode === 'schema') body.response_format = { type: 'json_schema', json_schema: { name: 'game_response', strict: true, schema: request.schema } };
  else if (provider.jsonMode === 'object') body.response_format = { type: 'json_object' };
  return body;
}

function retryAfterMs(value: string | string[] | undefined, now = Date.now()): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return 0;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(seconds * 1000)));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now)) : 0;
}

async function pinnedAddress(url: URL, allowPrivate: boolean): Promise<string> {
  const host = hostName(url);
  if (isIP(host)) {
    if (!allowPrivate && isReservedAddress(host)) failure('unsafe_endpoint');
    return host;
  }
  if (isLocalHost(host) && !allowPrivate) failure('unsafe_endpoint');
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    failure('network_error');
  }
  if (!addresses.length) failure('network_error');
  if (!allowPrivate && addresses.some(({ address }) => isReservedAddress(address))) failure('unsafe_endpoint');
  return (addresses.find(value=>value.family===4)??addresses[0]).address;
}

function jsonRequest(url: URL, headers: Record<string, string>, body: string, signal: AbortSignal, allowPrivate: boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined;
    let settled = false;
    const finish = (error?: AiFailure, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      finish(new AiFailure('timeout'));
      req?.destroy();
    };

    signal.addEventListener('abort', abort, { once: true });
    if(signal.aborted){abort();return;}
    void pinnedAddress(url, allowPrivate).then((address) => {
      if(settled)return;
      if (signal.aborted) return abort();
      const lookup = ((_: string, __: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => callback(null, address, isIP(address))) as NonNullable<RequestOptions['lookup']>;
      const options: RequestOptions & { servername?: string } = {
        protocol: url.protocol,
        hostname: hostName(url),
        port: url.port || undefined,
        family: isIP(address),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(body).toString() },
        lookup,
        servername: isIP(hostName(url)) ? undefined : hostName(url),
      };
      const client = (url.protocol === 'https:' ? httpsRequest : httpRequest) as typeof httpRequest;
      req = client(options, (response: IncomingMessage) => {
        const chunks: string[] = [];
        let size = 0;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (settled) return;
          size += Buffer.byteLength(chunk);
          if (size > MAX_RESPONSE_BYTES) {
            finish(new AiFailure('invalid_output'));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('aborted', () => finish(new AiFailure(signal.aborted ? 'timeout' : 'network_error')));
        response.on('error', () => finish(new AiFailure(signal.aborted ? 'timeout' : 'network_error')));
        response.on('end', () => {
          if (settled) return;
          const status = response.statusCode ?? 0;
          if (status === 401 || status === 403) return finish(new AiFailure('invalid_key'));
          if (status === 429) return finish(new AiFailure('rate_limited', retryAfterMs(response.headers['retry-after'])));
          if (status >= 500 && status <= 599) return finish(new AiFailure('server_error'));
          if (status < 200 || status >= 300) return finish(new AiFailure('invalid_output'));
          try {
            finish(undefined, JSON.parse(chunks.join('')));
          } catch {
            finish(new AiFailure('invalid_output'));
          }
        });
      });
      req.on('error', () => finish(new AiFailure(signal.aborted ? 'timeout' : 'network_error')));
      req.end(body);
    }).catch((error: unknown) => {
      if (error instanceof AiFailure) finish(error);
      else finish(new AiFailure(signal.aborted ? 'timeout' : 'network_error'));
    });
  });
}

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') return (part as Record<string, string>).text;
    return '';
  });
  return parts.join('');
}

function outerJsonText(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return match ? match[1].trim() : trimmed;
}

function parseJsonText(value: string | undefined): unknown {
  if (!value) failure('invalid_output');
  try {
    return JSON.parse(outerJsonText(value));
  } catch {
    failure('invalid_output');
  }
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function parseGemini(value: unknown): WireResult {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const candidate = candidates[0] && typeof candidates[0] === 'object' ? candidates[0] as Record<string, unknown> : {};
  const content = candidate.content && typeof candidate.content === 'object' ? candidate.content as Record<string, unknown> : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = parts.map((part) => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, string>).text : '').join('');
  const usage = root.usageMetadata && typeof root.usageMetadata === 'object' ? root.usageMetadata as Record<string, unknown> : {};
  return { value: parseJsonText(text), inputTokens: tokenCount(usage.promptTokenCount), outputTokens: tokenCount(usage.candidatesTokenCount) };
}

function parseOpenAi(value: unknown): WireResult {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : {};
  const message = choice.message && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : {};
  const usage = root.usage && typeof root.usage === 'object' ? root.usage as Record<string, unknown> : {};
  return { value: parseJsonText(textValue(message.content)), inputTokens: tokenCount(usage.prompt_tokens), outputTokens: tokenCount(usage.completion_tokens) };
}

function parseOllama(value: unknown): WireResult {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const message = root.message && typeof root.message === 'object' ? root.message as Record<string, unknown> : {};
  return { value: parseJsonText(typeof message.content === 'string' ? message.content : undefined), inputTokens: tokenCount(root.prompt_eval_count), outputTokens: tokenCount(root.eval_count) };
}

export const defaultTransport: Transport = async (provider, key, request, signal) => {
  if (signal.aborted) failure('timeout');
  const baseUrl = provider.baseUrl || defaults(provider.kind).baseUrl;
  const allowedOrigins = configuredAllowedOrigins();
  validateEndpoint(provider.kind, baseUrl, allowedOrigins);
  const endpoint = endpointFor({ ...provider, baseUrl });
  const allowPrivate = originIsAllowed(endpoint, allowedOrigins) || (provider.kind === 'ollama' && OLLAMA_ORIGINS.has(endpoint.origin));
  const body = JSON.stringify(requestBody(provider, request));
  const result = await jsonRequest(endpoint, authHeaders(provider.kind, key), body, signal, allowPrivate);
  if (provider.kind === 'gemini') return parseGemini(result);
  if (provider.kind === 'ollama') return parseOllama(result);
  return parseOpenAi(result);
};
