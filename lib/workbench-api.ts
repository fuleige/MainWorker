export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(payload.error || `请求失败（${response.status}）`, response.status);
  }
  return response.json() as Promise<T>;
}

export function chatQuery(scope: string, articlePath?: string | null, sourceId?: string | null) {
  const params = new URLSearchParams({ scope });
  if (articlePath) params.set('article', articlePath);
  if (sourceId) params.set('source', sourceId);
  return params;
}

export function parseSse(buffer: string, onEvent: (event: string, payload: Record<string, unknown>) => void) {
  const blocks = buffer.replaceAll('\r\n', '\n').split('\n\n');
  const remainder = blocks.pop() || '';
  for (const block of blocks) {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data) onEvent(event, JSON.parse(data));
  }
  return remainder;
}
