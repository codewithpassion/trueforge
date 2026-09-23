import {
  toolResultResponse,
  type CallToolResolvedResponse,
  type CallToolResponse,
} from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { defineTool, type ToolDefinition } from '@truefoundry/trueforge-core/core/mcp/LocalToolMCP';
import type { SandboxProviderTools } from '@truefoundry/trueforge-core/core/sandbox/Sandbox';
import { z } from 'zod';
import {
  DESKTOP_HEIGHT,
  DESKTOP_SCROLL_BATCH_MAX,
  DESKTOP_TYPE_MAX_CHARS,
  DESKTOP_WIDTH,
  DesktopButtonSchema,
  DesktopClickCountSchema,
  DesktopClipboardTextSchema,
  DesktopKeysSchema,
  DesktopScrollDeltaSchema,
  DesktopTypeTextSchema,
  DesktopXSchema,
  DesktopYSchema,
  scrollClicks,
  type DesktopAction,
  type DesktopScreenshotResultPayload,
} from './protocol';
import type { DesktopCallResult, DesktopFailureCode, RemoteComputerProvider } from './RemoteComputerProvider';
import { REQUEST_HUMAN_TAKEOVER_TOOL, RequestHumanTakeover } from './requestHumanTakeover';

/** Lets a click's effect reach the screen before the screenshot that shows it. */
const SETTLE_MS = 500;

const X_SCHEMA = DesktopXSchema.describe(`Pixels from the left edge, 0 to ${String(DESKTOP_WIDTH - 1)}.`);
const Y_SCHEMA = DesktopYSchema.describe(`Pixels from the top edge, 0 to ${String(DESKTOP_HEIGHT - 1)}.`);
const POINT_SCHEMA = z.object({ x: X_SCHEMA, y: Y_SCHEMA });

const NO_INPUT_SCHEMA = z.object({});
const CLICK_SCHEMA = z.object({
  x: X_SCHEMA,
  y: Y_SCHEMA,
  button: DesktopButtonSchema.default('left'),
  count: DesktopClickCountSchema.default(1).describe('2 for a double click, 3 for a triple click.'),
});
const TYPE_SCHEMA = z.object({ text: DesktopTypeTextSchema });
const KEY_SCHEMA = z.object({
  keys: DesktopKeysSchema.describe('An xdotool key chord, e.g. "ctrl+l", "Return", "ctrl+shift+t".'),
});
const SCROLL_SCHEMA = z
  .object({
    x: X_SCHEMA,
    y: Y_SCHEMA,
    dx: DesktopScrollDeltaSchema.describe('Wheel clicks; positive scrolls right.'),
    dy: DesktopScrollDeltaSchema.describe('Wheel clicks; positive scrolls down.'),
  })
  .refine(input => scrollClicks(input) <= DESKTOP_SCROLL_BATCH_MAX, {
    message: `|dx| + |dy| is at most ${String(DESKTOP_SCROLL_BATCH_MAX)}`,
  });
const DRAG_SCHEMA = z.object({ from: POINT_SCHEMA, to: POINT_SCHEMA });
const CLIPBOARD_WRITE_SCHEMA = z.object({ text: DesktopClipboardTextSchema });

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
      text: `[screenshot ${String(shot.width)}x${String(shot.height)} captured; this model does not receive images yet]`,
    },
  ];
}

/** Written for the model: each tells it what to do next, not only what went wrong. */
export function desktopFailureText({ code, message }: { code: DesktopFailureCode; message: string }): string {
  switch (code) {
    case 'human_in_control':
      return (
        'A person is using the desktop of this computer, so desktop actions and commands are paused. ' +
        `Do not retry: if you need them to finish a step for you, call ${REQUEST_HUMAN_TAKEOVER_TOOL} with what they should do, then stop.`
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
 * Looks after an action that already happened. When the look is refused the model must still learn
 * the action ran, or it would repeat a click or retype text.
 */
async function lookAfterActing(provider: RemoteComputerProvider): Promise<CallToolResponse> {
  const shot = await provider.desktopScreenshot();
  if (shot.ok) {
    return { result: { content: screenshotToolContent(shot.value) }, wasInitialized: undefined };
  }
  return toolResultResponse({
    text: `The action already ran, but the screenshot after it was refused. ${desktopFailureText(shot)}`,
    isError: true,
  });
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
  return lookAfterActing(provider);
}

/**
 * Runs desktop tool calls one at a time. A model may call several in parallel, and one call's
 * action and screenshot must not interleave with another's.
 */
function serialQueue(): (task: () => Promise<CallToolResponse>) => Promise<CallToolResponse> {
  let tail: Promise<unknown> = Promise.resolve();
  return task => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

type Serial = ReturnType<typeof serialQueue>;

function inputTools({ provider, serial }: { provider: RemoteComputerProvider; serial: Serial }): ToolDefinition[] {
  return [
    defineTool({
      name: 'computer_click',
      description: 'Click at a point on the desktop, then return a screenshot.',
      schema: CLICK_SCHEMA,
      handler: input =>
        serial(() =>
          actThenLook({
            provider,
            actions: [{ type: 'click', x: input.x, y: input.y, button: input.button, count: input.count }],
          }),
        ),
    }),
    defineTool({
      name: 'computer_type',
      description: `Type text into the focused window, then return a screenshot. At most ${String(DESKTOP_TYPE_MAX_CHARS)} characters; for more, write the clipboard and paste with ctrl+v.`,
      schema: TYPE_SCHEMA,
      handler: input => serial(() => actThenLook({ provider, actions: [{ type: 'type', text: input.text }] })),
    }),
    defineTool({
      name: 'computer_key',
      description: 'Press a key or key chord, then return a screenshot.',
      schema: KEY_SCHEMA,
      handler: input => serial(() => actThenLook({ provider, actions: [{ type: 'key', keys: input.keys }] })),
    }),
    defineTool({
      name: 'computer_scroll',
      description: 'Scroll the mouse wheel at a point, then return a screenshot.',
      schema: SCROLL_SCHEMA,
      handler: input =>
        serial(() =>
          actThenLook({
            provider,
            actions: [{ type: 'scroll', x: input.x, y: input.y, dx: input.dx, dy: input.dy }],
          }),
        ),
    }),
    defineTool({
      name: 'computer_drag',
      description: 'Drag with the left button from one point to another, then return a screenshot.',
      schema: DRAG_SCHEMA,
      handler: input =>
        serial(() =>
          actThenLook({
            provider,
            actions: [
              { type: 'mouse_move', x: input.from.x, y: input.from.y },
              { type: 'mouse_down', button: 'left' },
              { type: 'mouse_move', x: input.to.x, y: input.to.y },
              { type: 'mouse_up', button: 'left' },
            ],
          }),
        ),
    }),
    defineTool({
      name: 'computer_clipboard_write',
      description: 'Put text on the desktop clipboard (CLIPBOARD and PRIMARY), then return a screenshot.',
      schema: CLIPBOARD_WRITE_SCHEMA,
      handler: input =>
        serial(async () => {
          const written = await provider.desktopClipboardSet(input.text);
          return written.ok ? lookAfterActing(provider) : failure(written);
        }),
    }),
  ];
}

function readTools({ provider, serial }: { provider: RemoteComputerProvider; serial: Serial }): ToolDefinition[] {
  return [
    defineTool({
      name: 'computer_screenshot',
      description: `Take a ${String(DESKTOP_WIDTH)}x${String(DESKTOP_HEIGHT)} screenshot of the desktop.`,
      schema: NO_INPUT_SCHEMA,
      handler: () => serial(() => screenshot(provider)),
    }),
    defineTool({
      name: 'computer_clipboard_read',
      description: 'Read the text on the desktop clipboard.',
      schema: NO_INPUT_SCHEMA,
      handler: () =>
        serial(async () => {
          const read = await provider.desktopClipboardGet();
          return read.ok ? toolResultResponse({ text: read.value.text }) : failure(read);
        }),
    }),
  ];
}

const BASE_INSTRUCTIONS = [
  `This computer has a ${String(DESKTOP_WIDTH)}x${String(DESKTOP_HEIGHT)} desktop you can see and drive with the computer_* tools; coordinates are pixels from the top-left corner.`,
  'DISPLAY is already set for exec, so start applications with exec and a trailing &, for example `chromium https://example.com &` or `xterm &`.',
  'Prefer exec and the filesystem over the desktop whenever both can do the job.',
].join(' ');

const TAKEOVER_INSTRUCTIONS = `For logins, CAPTCHAs and two-factor prompts, call ${REQUEST_HUMAN_TAKEOVER_TOOL} so a person does that step on the desktop, instead of guessing or asking for credentials.`;

const APPROVAL_INSTRUCTIONS =
  'This computer asks a person to approve each action, and desktop input cannot be approved yet, so only computer_screenshot and computer_clipboard_read are available.';

/**
 * The desktop tools for one turn of an agent that asked for the desktop, with the takeover request
 * beside them. A machine whose desktop is down gets none, and the model is told why. With
 * `requireApproval` set the input tools are withheld, because nothing can yet ask a person before
 * a click; a person can still take over.
 */
export function desktopProviderTools(provider: RemoteComputerProvider): SandboxProviderTools {
  if (!provider.supportsDesktop) {
    const reason = provider.desktopUnavailableReason;
    return {
      tools: [],
      instructions: `This agent is set up to use the desktop of this computer, but the desktop is not running${reason === null ? '' : ` (${reason})`}, so no desktop tools are available.`,
      clientSideToolSets: [],
      clientSideInstructions: '',
    };
  }
  const serial = serialQueue();
  const tools = provider.requiresApproval
    ? readTools({ provider, serial })
    : [...readTools({ provider, serial }), ...inputTools({ provider, serial })];
  return {
    tools,
    instructions: provider.requiresApproval ? `${BASE_INSTRUCTIONS} ${APPROVAL_INSTRUCTIONS}` : BASE_INSTRUCTIONS,
    clientSideToolSets: [new RequestHumanTakeover()],
    clientSideInstructions: TAKEOVER_INSTRUCTIONS,
  };
}
