import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_S_ENDPOINT,
  resolveSidecarEndpoint,
} from './resolveSidecarEndpoint';

describe('resolveSidecarEndpoint', () => {
  it('keeps https URL without explicit port unchanged', () => {
    const input = 'https://example.com/path';
    const out = resolveSidecarEndpoint(input, undefined);

    expect(out).toBe('https://example.com/path');
  });

  it('keeps http URL without explicit port unchanged', () => {
    const input = 'http://example.com/';
    const out = resolveSidecarEndpoint(input, undefined);

    expect(out).toBe('http://example.com');
  });

  it('uses default Agent-S port for local http URL without explicit port', () => {
    const input = 'http://localhost';
    const out = resolveSidecarEndpoint(input, undefined);

    expect(out).toBe('http://localhost:10800');
  });

  it('uses default Agent-S port for local https URL without explicit port', () => {
    const input = 'https://127.0.0.1/path';
    const out = resolveSidecarEndpoint(input, undefined);

    expect(out).toBe('https://127.0.0.1:10800/path');
  });

  it('applies explicit custom port override', () => {
    const input = 'http://localhost';
    const out = resolveSidecarEndpoint(input, 5050);

    expect(out).toBe('http://localhost:5050');
  });

  it('keeps remote https URL default port semantics when rawPort is set', () => {
    const input = 'https://example.com/path';
    const out = resolveSidecarEndpoint(input, 5050);

    expect(out).toBe('https://example.com/path');
  });

  it('uses configured port for blank URL fallback', () => {
    const out = resolveSidecarEndpoint('', 5050);

    expect(out).toBe('http://127.0.0.1:5050');
  });

  it('falls back to localhost default when URL is blank', () => {
    const out = resolveSidecarEndpoint('', undefined);

    expect(out).toBe(DEFAULT_AGENT_S_ENDPOINT);
  });

  it('falls back to default endpoint for invalid URL', () => {
    const out = resolveSidecarEndpoint('not-a url', undefined);

    expect(out).toBe(DEFAULT_AGENT_S_ENDPOINT);
  });
});
