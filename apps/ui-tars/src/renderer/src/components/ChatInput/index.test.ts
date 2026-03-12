import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@ui-tars/shared/constants', () => ({
  IMAGE_PLACEHOLDER: '__image__',
}));

vi.mock('@ui-tars/shared/types', () => ({
  StatusEnum: {
    INIT: 'init',
    RUNNING: 'running',
    CALL_USER: 'call_user',
  },
}));

vi.mock('@main/store/types', () => ({
  Operator: {
    RemoteComputer: 'Remote Computer Operator',
    RemoteBrowser: 'Remote Browser Operator',
    LocalComputer: 'Local Computer Operator',
    LocalBrowser: 'Local Browser Operator',
  },
}));

vi.mock('@renderer/hooks/useStore', () => ({
  useStore: () => ({
    status: 'init',
    instructions: '',
    messages: [],
    restUserData: null,
  }),
}));

vi.mock('@renderer/hooks/useRunAgent', () => ({
  useRunAgent: () => ({
    run: vi.fn(),
    stopAgentRuning: vi.fn(),
  }),
}));

vi.mock('@renderer/hooks/useSession', () => ({
  useSession: () => ({
    getSession: vi.fn(),
    updateSession: vi.fn(),
    chatMessages: [],
  }),
}));

vi.mock('../../hooks/useSetting', () => ({
  useSetting: () => ({
    settings: { operator: 'Local Computer Operator' },
    updateSetting: vi.fn(),
  }),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: React.forwardRef<
    HTMLButtonElement,
    React.ButtonHTMLAttributes<HTMLButtonElement>
  >(({ children, type: _type, ...props }, ref) =>
    React.createElement('button', { ...props, ref, type: 'button' }, children),
  ),
}));

vi.mock('@renderer/components/ui/textarea', () => ({
  Textarea: React.forwardRef<
    HTMLTextAreaElement,
    React.TextareaHTMLAttributes<HTMLTextAreaElement>
  >(({ children, ...props }, ref) =>
    React.createElement('textarea', { ...props, ref }, children),
  ),
}));

vi.mock('@renderer/api', () => ({
  api: {
    clearHistory: vi.fn(),
  },
}));

vi.mock('lucide-react', () => ({
  Loader2: () => React.createElement('span'),
  Play: () => React.createElement('span'),
  Send: () => React.createElement('span'),
  Square: () => React.createElement('span'),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('./startRun', () => ({
  executeChatInputRun: vi.fn(),
}));

import ChatInput from './index';

describe('ChatInput run-status instrumentation', () => {
  it('keeps run status observable without rendering raw enum text', () => {
    const operator =
      'Local Computer Operator' as unknown as React.ComponentProps<
        typeof ChatInput
      >['operator'];

    const markup = renderToStaticMarkup(
      React.createElement(ChatInput, {
        operator,
        sessionId: 'session-1',
        disabled: false,
      }),
    );

    expect(markup).toContain('data-testid="run-status"');
    expect(markup).toContain('data-status="idle"');
    expect(markup).toContain('hidden=""');
    expect(markup).not.toContain('>idle<');
    expect(markup).not.toContain('>thinking<');
    expect(markup).not.toContain('>executing<');
  });
});
