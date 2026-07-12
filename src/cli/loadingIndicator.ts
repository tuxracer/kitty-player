import { LOADING_DELAY_MS } from '../Video/index.tsx';
import { CLEAR_LINE, SPINNER_FRAMES, SPINNER_INTERVAL_MS } from './consts.ts';
import type { LoadingIndicator, LoadingIndicatorOutput } from './types.ts';

/**
 * Delayed loading indicator for the cli's source open, which can take
 * seconds for remote URLs with nothing else on screen yet. After
 * LOADING_DELAY_MS (so fast local opens never flash it) a TTY gets an
 * animated spinner line, erased again on stop, and a non-TTY gets a single
 * plain notice. This runs before any Ink render exists (and must not touch
 * stdin or stdout while the terminal probes run), so it writes the same
 * dots animation @inkjs/ui's Spinner uses directly to stderr instead of
 * mounting a component.
 */
export const startLoadingIndicator = (
  target: string,
  output: LoadingIndicatorOutput = process.stderr,
): LoadingIndicator => {
  let interval: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  let drewSpinner = false;

  const drawFrame = (): void => {
    drewSpinner = true;
    output.write(`\r${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} loading ${target}…`);
    frame += 1;
  };

  const timer = setTimeout(() => {
    if (output.isTTY) {
      drawFrame();
      interval = setInterval(drawFrame, SPINNER_INTERVAL_MS);
    } else {
      output.write(`kitty-media-player: loading ${target}…\n`);
    }
  }, LOADING_DELAY_MS);

  return {
    stop: () => {
      clearTimeout(timer);
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
      if (drewSpinner) {
        drewSpinner = false;
        output.write(CLEAR_LINE);
      }
    },
  };
};
