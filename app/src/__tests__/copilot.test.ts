/**
 * Tests for pure, stateless helpers exported from copilot.ts.
 * The heavy async stuff (streamCopilotChat, runCopilotAgent) relies on the
 * real Copilot API, so we test the logic helpers that underpin them instead.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  CopilotDiagnosticError,
  modelSupportsVision,
  isBlockedModel,
  familyKey,
  sanitizeLoop,
  estimateTokens,
  getStoredOAuthToken,
  clearOAuthToken,
} from '../services/copilot';
import type { ChatMessage } from '../types';

// ── CopilotDiagnosticError ────────────────────────────────────────────────────
describe('CopilotDiagnosticError', () => {
  it('sets name, message and detail', () => {
    const err = new CopilotDiagnosticError('boom', 'detailed info');
    expect(err.name).toBe('CopilotDiagnosticError');
    expect(err.message).toBe('boom');
    expect(err.detail).toBe('detailed info');
  });

  it('is an instance of Error', () => {
    const err = new CopilotDiagnosticError('x', 'y');
    expect(err).toBeInstanceOf(Error);
  });
});

// ── modelSupportsVision ───────────────────────────────────────────────────────
describe('modelSupportsVision', () => {
  it('returns false for o-series reasoning models', () => {
    expect(modelSupportsVision('o1')).toBe(false);
    expect(modelSupportsVision('o1-mini')).toBe(false);
    expect(modelSupportsVision('o3')).toBe(false);
    expect(modelSupportsVision('o3-mini')).toBe(false);
    expect(modelSupportsVision('o4-mini')).toBe(false);
  });

  it('returns true for GPT, Claude, and Gemini models', () => {
    expect(modelSupportsVision('gpt-4o')).toBe(true);
    expect(modelSupportsVision('gpt-4.1')).toBe(true);
    expect(modelSupportsVision('gpt-4.1-mini')).toBe(true);
    expect(modelSupportsVision('claude-sonnet-4-5')).toBe(true);
    expect(modelSupportsVision('claude-opus-4-5')).toBe(true);
    expect(modelSupportsVision('gemini-2.5-pro')).toBe(true);
  });

  it('only matches the leading "oN" pattern — not arbitrary strings starting with o', () => {
    expect(modelSupportsVision('ollama-mistral')).toBe(true);  // 'ol' not 'o1'
    expect(modelSupportsVision('openai-something')).toBe(true);
  });
});

// ── isBlockedModel ────────────────────────────────────────────────────────────
describe('isBlockedModel', () => {
  it('blocks exact matches', () => {
    expect(isBlockedModel('gpt-4')).toBe(true);
    expect(isBlockedModel('o1-mini')).toBe(true);
  });

  it('blocks models matched by a blocked prefix', () => {
    expect(isBlockedModel('gpt-3.5-turbo')).toBe(true);
    expect(isBlockedModel('gpt-4-turbo-preview')).toBe(true);
    expect(isBlockedModel('gpt-4-32k-0314')).toBe(true);
    expect(isBlockedModel('gpt-4-vision-preview')).toBe(true);
    expect(isBlockedModel('gpt-4-0613')).toBe(true);
    expect(isBlockedModel('text-davinci-003')).toBe(true);
    expect(isBlockedModel('text-embedding-ada-002')).toBe(true);
    expect(isBlockedModel('claude-3-haiku-20240307')).toBe(true);
    expect(isBlockedModel('claude-3-5-sonnet-20241022')).toBe(true);
    expect(isBlockedModel('o1-preview')).toBe(true);
    expect(isBlockedModel('o1-mini-2024-09-12')).toBe(true);
  });

  it('allows current-generation models through', () => {
    expect(isBlockedModel('gpt-4o')).toBe(false);
    expect(isBlockedModel('gpt-4.1')).toBe(false);
    expect(isBlockedModel('gpt-4.1-mini')).toBe(false);
    expect(isBlockedModel('gpt-4o-mini')).toBe(false);
    expect(isBlockedModel('claude-sonnet-4-5')).toBe(false);
    expect(isBlockedModel('claude-opus-4-5')).toBe(false);
    expect(isBlockedModel('claude-haiku-4-5')).toBe(false);
    expect(isBlockedModel('gemini-2.5-pro')).toBe(false);
    expect(isBlockedModel('o3')).toBe(false);
    expect(isBlockedModel('o3-mini')).toBe(false);
  });
});

// ── familyKey ─────────────────────────────────────────────────────────────────
describe('familyKey', () => {
  it('strips trailing 8-digit date stamps', () => {
    expect(familyKey('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet');
    expect(familyKey('gpt-4-0613')).toBe('gpt-4');
  });

  it('strips trailing single-segment minor patch numbers (-5, -6 etc.)', () => {
    expect(familyKey('claude-sonnet-4-5')).toBe('claude-sonnet-4');
    expect(familyKey('claude-sonnet-4-6')).toBe('claude-sonnet-4');
    expect(familyKey('claude-opus-4-5')).toBe('claude-opus-4');
    expect(familyKey('claude-haiku-4-5')).toBe('claude-haiku-4');
  });

  it('leaves models without trailing digits unchanged', () => {
    expect(familyKey('gpt-4o')).toBe('gpt-4o');
    expect(familyKey('gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(familyKey('o3-mini')).toBe('o3-mini');
  });

  it('does not strip non-numeric suffixes like -mini or -nano', () => {
    // gpt-4.1-mini → no trailing digit group ("-mini" is not a bare number)
    expect(familyKey('gpt-4.1-mini')).toBe('gpt-4.1-mini');
  });
});

// ── estimateTokens ────────────────────────────────────────────────────────────
describe('estimateTokens', () => {
  it('returns 0 for an empty message array', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('estimates ~1 token per 4 chars of content', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'a'.repeat(400) }];
    expect(estimateTokens(msgs)).toBe(100);
  });

  it('strips base64 data URLs before counting (they would massively inflate the estimate)', () => {
    const realContent = 'hello world'; // 11 chars
    const bigBase64 = 'data:image/png;base64,' + 'A'.repeat(100_000);
    const msgs: ChatMessage[] = [
      { role: 'user', content: `${realContent} ${bigBase64}` },
    ];
    // After stripping, content is "hello world [img]" ≈ 18 chars → ≈ 5 tokens
    // Without stripping, it would be ~25k tokens
    const tokens = estimateTokens(msgs);
    expect(tokens).toBeLessThan(50);
    expect(tokens).toBeGreaterThan(0);
  });

  it('accumulates across multiple messages', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'a'.repeat(80) },
      { role: 'user', content: 'b'.repeat(80) },
    ];
    expect(estimateTokens(msgs)).toBe(40);
  });
});

// ── sanitizeLoop ──────────────────────────────────────────────────────────────
describe('sanitizeLoop', () => {
  it('returns an empty array unchanged', () => {
    expect(sanitizeLoop([])).toEqual([]);
  });

  it('drops orphan tool messages with no preceding assistant tool_call', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'tool', content: 'result', tool_call_id: 'call_abc', name: 'read_file' },
    ];
    const out = sanitizeLoop(msgs);
    expect(out.every((m) => m.role !== 'tool')).toBe(true);
  });

  it('keeps a valid tool message that follows an assistant with matching tool_call_id', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'call a tool' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', content: 'file content here', tool_call_id: 'call_1', name: 'read_file' },
    ];
    const out = sanitizeLoop(msgs);
    expect(out.some((m) => m.role === 'tool')).toBe(true);
  });

  it('merges consecutive assistant messages (keeps tool_calls, joins content)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Thinking…' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{}' } }],
      },
    ];
    const out = sanitizeLoop(msgs);
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].tool_calls).toBeDefined();
  });

  it('merges consecutive user messages by joining their content', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'part one' },
      { role: 'user', content: 'part two' },
    ];
    const out = sanitizeLoop(msgs);
    const users = out.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].content).toContain('part one');
    expect(users[0].content).toContain('part two');
  });

  it('strips UI-only fields (items, toolActivities, activeFile) before sending', () => {
    const msg = {
      role: 'user' as const,
      content: 'hello',
      items: [{ type: 'text' as const, content: 'hi' }],
      activeFile: 'notes.md',
    };
    const out = sanitizeLoop([msg]);
    expect((out[0] as any).items).toBeUndefined();
    expect((out[0] as any).activeFile).toBeUndefined();
    expect(out[0].content).toBe('hello');
  });

  it('preserves a properly interleaved conversation unchanged', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Thanks' },
    ];
    const out = sanitizeLoop(msgs);
    expect(out).toHaveLength(4);
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });
});

// ── Auth helpers (localStorage) ──────────────────────────────────────────────
describe('getStoredOAuthToken / clearOAuthToken', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null when no token is stored', () => {
    expect(getStoredOAuthToken()).toBeNull();
  });

  it('returns the token after it has been written to localStorage', () => {
    localStorage.setItem('copilot-github-oauth-token', 'ghp_test123');
    expect(getStoredOAuthToken()).toBe('ghp_test123');
  });

  it('clearOAuthToken removes the token from localStorage', () => {
    localStorage.setItem('copilot-github-oauth-token', 'ghp_test123');
    clearOAuthToken();
    expect(getStoredOAuthToken()).toBeNull();
  });
});
