import {
  toolResultResponse,
  type CallToolResolvedResponse,
  type CallToolResponse,
} from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { defineTool, type ToolDefinition } from '@truefoundry/trueforge-core/core/mcp/LocalToolMCP';
import type { SandboxProviderTools } from '@truefoundry/trueforge-core/core/sandbox/Sandbox';
import { z } from 'zod';
import {
  DESKTOP_CLIPBOARD_MAX_BYTES,
  DESKTOP_HEIGHT,
  DESKTOP_TYPE_MAX_CHARS,
  DESKTOP_WIDTH,
  DesktopButtonSchema,
  type DesktopAction,
  type DesktopScreenshotResultPayload,
} from './protocol';
import type { DesktopCallResult, DesktopFailureCode, RemoteComputerProvider } from './RemoteComputerProvider';

/** Lets a click's effect reach the screen before the screenshot that shows it. */
const SETTLE_MS = 500;

const X_SCHEMA = z
  .number()
  .int()
  .min(0)
  .max(DESKTOP_WIDTH - 1)
  .describe(`Pixels from the left edge, 0 to ${String(DESKTOP_WIDTH - 1)}.`);
const Y_SCHEMA = z
  .number()
  .int()
  .min(0)
  .max(DESKTOP_HEIGHT - 1)
  .describe(`Pixels from the top edge, 0 to ${String(DESKTOP_HEIGHT - 1)}.`);
const POINT_SCHEMA = z.object({ x: X_SCHEMA, y: Y_SCHEMA });

const NO_INPUT_SCHEMA = z.object({});
const CLICK_SCHEMA = z.object({
  x: X_SCHEMA,
  y: Y_SCHEMA,
  button: DesktopButtonSchema.default('left'),
  count: z.number().int().min(1).max(3).default(1).describe('2 for a double click, 3 for a triple click.'),
});
const TYPE_SCHEMA = z.object({ text: z.string().min(1).max(DESKTOP_TYPE_MAX_CHARS) });
const KEY_SCHEMA = z.object({
  keys: z.string().min(1).max(64).describe('An xdotool key chord, e.g. "ctrl+l", "Return", "ctrl+shift+t".'),
});
const SCROLL_SCHEMA = z.object({
  x: X_SCHEMA,
  y: Y_SCHEMA,
  dx: z.number().int().min(-50).max(50).describe('Wheel clicks; positive scrolls right.'),
  dy: z.number().int().min(-50).max(50).describe('Wheel clicks; positive scrolls down.'),
});
const DRAG_SCHEMA = z.object({ from: POINT_SCHEMA, to: POINT_SCHEMA });
const CLIPBOARD_WRITE_SCHEMA = z.object({
  text: z.string().refine(text => new TextEncoder().encode(text).byteLength <= DESKTOP_CLIPBOARD_MAX_BYTES, {
    message: `At most ${String(DESKTOP_CLIPBOARD_MAX_BYTES)} bytes`,
  }),
});

/**
 * The single place a screenshot becomes tool content. Images in tool results are not wired yet,
 * so it says what was captured instead of showing it.
 */
export function screenshotToolContent(
  shot: DesktopScreenshotResultPayload,
): CallToolResolvedResponse['result']['content'] {
  return [
    {
      type: 'text',
      text: `[screenshot ${String(shot.width)}x${String(shot.height)} captured; image delivery arrives in Phase 9a-2]`,
    },
  ];
}

/** Written for the model: each tells it what to do next, not only what went wrong. */
export function desktopFailureText({ code, message }: { code: DesktopFailureCode; message: string }): string {
  switch (code) {
    case 'human_in_control':
      return (
        'A person has taken control of this computer, so desktop actions and commands are paused. ' +
        'Do not retry. Call request_human_takeover if you need them to do something, then stop and end your turn.'
      );
    case 'desktop_busy':
      return (
        'Another session is using this computer’s desktop. Do not retry now; finish what you can with exec, ' +
        'or tell the user the desktop is busy.'
      );
    case 'desktop_unavailable':
      return `The desktop on this computer is not running (${message}). Desktop tools will not work; use exec instead.`;
    case 'failed':
      return message;
  }
}

function failure(result: Extract<DesktopCallResult<unknown>, { ok: false }>): CallToolResponse {
  return toolResultResponse({ text: desktopFailureText(result), isError: true });
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function screenshot(provider: RemoteComputerProvider): Promise<CallToolResponse> {
  const shot = await provider.desktopScreenshot();
  if (!shot.ok) {
    return failure(shot);
  }
  return { result: { content: screenshotToolContent(shot.value) }, wasInitialized: undefined };
}

/**
 * Acting and then looking are two relay calls, and each is checked against the lease on its own:
 * a person who takes control between them must not be screenshotted.
 */
async function actThenLook({
  provider,
  actions,
}: {
  provider: RemoteComputerProvider;
  actions: readonly DesktopAction[];
}): Promise<CallToolResponse> {
  const acted = await provider.desktopInput(actions);
  if (!acted.ok) {
    return failure(acted);
  }
  await wait(SETTLE_MS);
  return screenshot(provider);
}

function inputTools(provider: RemoteComputerProvider): ToolDefinition[] {
  return [
    defineTool({
      name: 'computer_click',
      description: 'Click at a point on the desktop, then return a screenshot.',
      schema: CLICK_SCHEMA,
      handler: input =>
        actThenLook({
          provider,
          actions: [{ type: 'click', x: input.x, y: input.y, button: input.button, count: input.count }],
        }),
    }),
    defineTool({
      name: 'computer_type',
      description: `Type text into the focused window, then return a screenshot. At most ${String(DESKTOP_TYPE_MAX_CHARS)} characters; for more, write the clipboard and paste with ctrl+v.`,
      schema: TYPE_SCHEMA,
      handler: input => actThenLook({ provider, actions: [{ type: 'type', text: input.text }] }),
    }),
    defineTool({
      name: 'computer_key',
      description: 'Press a key or key chord, then return a screenshot.',
      schema: KEY_SCHEMA,
      handler: input => actThenLook({ provider, actions: [{ type: 'key', keys: input.keys }] }),
    }),
    defineTool({
      name: 'computer_scroll',
      description: 'Scroll the mouse wheel at a point, then return a screenshot.',
      schema: SCROLL_SCHEMA,
      handler: input =>
        actThenLook({
          provider,
          actions: [{ type: 'scroll', x: input.x, y: input.y, dx: input.dx, dy: input.dy }],
        }),
    }),
    defineTool({
      name: 'computer_drag',
      description: 'Drag with the left button from one point to another, then return a screenshot.',
      schema: DRAG_SCHEMA,
      handler: input =>
        actThenLook({
          provider,
          actions: [
            { type: 'mouse_move', x: input.from.x, y: input.from.y },
            { type: 'mouse_down', button: 'left' },
            { type: 'mouse_move', x: input.to.x, y: input.to.y },
            { type: 'mouse_up', button: 'left' },
          ],
        }),
    }),
    defineTool({
      name: 'computer_clipboard_write',
      description: 'Put text on the desktop clipboard (CLIPBOARD and PRIMARY), then return a screenshot.',
      schema: CLIPBOARD_WRITE_SCHEMA,
      handler: async input => {
        const written = await provider.desktopClipboardSet(input.text);
        return written.ok ? screenshot(provider) : failure(written);
      },
    }),
  ];
}

function readTools(provider: RemoteComputerProvider): ToolDefinition[] {
  return [
    defineTool({
      name: 'computer_screenshot',
      description: `Take a ${String(DESKTOP_WIDTH)}x${String(DESKTOP_HEIGHT)} screenshot of the desktop.`,
      schema: NO_INPUT_SCHEMA,
      handler: () => screenshot(provider),
    }),
    defineTool({
      name: 'computer_clipboard_read',
      description: 'Read the text on the desktop clipboard.',
      schema: NO_INPUT_SCHEMA,
      handler: async () => {
        const read = await provider.desktopClipboardGet();
        return read.ok ? toolResultResponse({ text: read.value.text }) : failure(read);
      },
    }),
  ];
}

const BASE_INSTRUCTIONS = [
  `This computer has a ${String(DESKTOP_WIDTH)}x${String(DESKTOP_HEIGHT)} desktop you can see and drive with the computer_* tools; coordinates are pixels from the top-left corner.`,
  'DISPLAY is already set for exec, so start applications with exec and a trailing &, for example `chromium https://example.com &` or `xterm &`.',
  'Prefer exec and the filesystem over the desktop whenever both can do the job.',
  'For logins, CAPTCHAs and two-factor prompts, call request_human_takeover instead of guessing or asking for credentials.',
].join(' ');

const APPROVAL_INSTRUCTIONS =
  'This computer asks a person to approve each action, and desktop input cannot be approved yet, so only computer_screenshot and computer_clipboard_read are available.';

/**
 * The desktop tools for one turn of an agent that asked for the desktop. A machine whose desktop is
 * down gets none, and the model is told why. With `requireApproval` set the input tools are
 * withheld, because nothing can yet ask a person before a click.
 */
export function desktopProviderTools(provider: RemoteComputerProvider): SandboxProviderTools {
  if (!provider.supportsDesktop) {
    const reason = provider.desktopUnavailableReason;
    return {
      tools: [],
      instructions: `This agent is set up to use the desktop of this computer, but the desktop is not running${reason === null ? '' : ` (${reason})`}, so no desktop tools are available.`,
    };
  }
  // request_human_takeover joins this list once takeover is built.
  const tools = provider.requiresApproval ? readTools(provider) : [...readTools(provider), ...inputTools(provider)];
  return {
    tools,
    instructions: provider.requiresApproval ? `${BASE_INSTRUCTIONS} ${APPROVAL_INSTRUCTIONS}` : BASE_INSTRUCTIONS,
  };
}
