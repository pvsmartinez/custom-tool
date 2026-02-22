import type { ChatMessage, CopilotStreamChunk, CopilotModel, CopilotModelInfo } from '../types';
import { FALLBACK_MODELS } from '../types';

// GitHub Copilot API — OpenAI-compatible endpoint.
// Requires a GitHub Personal Access Token with `copilot` scope.
// Set VITE_GITHUB_TOKEN in your .env file.
const COPILOT_API_URL = 'https://api.githubcopilot.com/chat/completions';

export const DEFAULT_MODEL: CopilotModel = 'gpt-4o';

function getToken(): string {
  const token = import.meta.env.VITE_GITHUB_TOKEN;
  if (!token) throw new Error('VITE_GITHUB_TOKEN is not set in .env');
  return token;
}

/**
 * Stream a Copilot chat completion.
 * Calls the GitHub Copilot API with the provided messages and
 * invokes `onChunk` with each streamed text fragment.
 */
export async function streamCopilotChat(
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  model: CopilotModel = DEFAULT_MODEL
): Promise<void> {
  try {
    const response = await fetch(COPILOT_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
        'Copilot-Integration-Id': 'vscode-chat',
        'Editor-Version': 'vscode/1.85.0',
        'Editor-Plugin-Version': 'copilot-chat/0.11.1',
        'User-Agent': 'GitHubCopilotChat/0.11.1',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: 4096,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Copilot API error ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const chunk: CopilotStreamChunk = JSON.parse(trimmed.slice(6));
          const text = chunk.choices[0]?.delta?.content;
          if (text) onChunk(text);
        } catch {
          // skip malformed lines
        }
      }
    }

    onDone();
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Helper: get a one-shot (non-streamed) completion for internal use.
 */
export async function copilotComplete(
  messages: ChatMessage[],
  model: CopilotModel = DEFAULT_MODEL
): Promise<string> {
  return new Promise((resolve, reject) => {
    let result = '';
    streamCopilotChat(
      messages,
      (chunk) => { result += chunk; },
      () => resolve(result),
      reject,
      model
    );
  });
}

// ── Model discovery ──────────────────────────────────────────────────────────

interface RawModel {
  id: string;
  name?: string;
  // GitHub Copilot API field for cost relative to a standard request
  billing_multiplier?: number;
  // Some API versions use this instead
  multiplier?: number;
  vendor?: string;
  capabilities?: { family?: string };
}

/** Fetches available models from the GitHub Copilot /models endpoint. */
export async function fetchCopilotModels(): Promise<CopilotModelInfo[]> {
  try {
    const token = getToken();
    const res = await fetch('https://api.githubcopilot.com/models', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Copilot-Integration-Id': 'vscode-chat',
        'Editor-Version': 'vscode/1.97.0',
        'Editor-Plugin-Version': 'copilot-chat/0.24.0',
        'User-Agent': 'GitHubCopilotChat/0.24.0',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { data?: RawModel[] };
    const raw: RawModel[] = json.data ?? [];

    // Filter to chat-compatible models only
    const models: CopilotModelInfo[] = raw
      .filter((m) => m.id && !m.id.includes('embedding') && !m.id.includes('whisper'))
      .map((m) => {
        const mult = m.billing_multiplier ?? m.multiplier ?? 1;
        return {
          id: m.id,
          name: m.name ?? m.id,
          multiplier: mult,
          isPremium: mult > 1,
          vendor: m.vendor,
        };
      })
      .sort((a, b) => a.multiplier - b.multiplier || a.name.localeCompare(b.name));

    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}
