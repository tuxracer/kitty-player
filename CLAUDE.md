# kitty-video-player

## Commands

- `pnpm check` - typecheck + lint + run all tests (run before committing)
- `pnpm test` - vitest in watch mode (`pnpm test:run` for a single pass)
- `pnpm lint` / `pnpm lint:fix` - ESLint over `src/`
- `pnpm typecheck` - `tsc --noEmit`
- `pnpm build` - typecheck then tsup. The build has two entries: `cli` (the executable bin, `dist/cli.js`, which runs the player at module top level) and `index` (the library entry, `dist/index.js`, for hosts embedding the Player in their own Ink app). They must stay separate bundles because importing the cli entry starts playback
- `pnpm dev` - run the CLI from source via tsx. `pnpm dev --help` forwards flags as expected, but `pnpm dev -- --help` does not (pnpm 11 passes the literal `--` through as a positional, which the CLI rejects as an unsupported file argument)

## Architecture

Data flow: `cli` parses argv (`parseCliArgs`, a pure function in its own file so tests can import it without executing the entry) and guards on terminal capability. If stdout is not a TTY it prints a notice and exits 0 (CI-friendly). `--render-mode kitty` alone forces the full Ink player past detection. `--fallback` alone, a cell `--render-mode`, or `--fallback` combined with `--render-mode kitty` all force the fallback player, the last of those a forced kitty-without-controls tier for terminals like iTerm2 that have graphics but no placeholders, and a forced mode resolves immediately with no probe and no prompt. With no flags, if `detectFallbackReasons` reports missing placeholder support or a tmux/screen session, the cli resolves the fallback tier first via `resolveFallbackRenderMode` (kitty graphics without controls when the kitty graphics probe passes, otherwise the auto cell mode from `detectCellRenderMode`), warns, appends a note when the resolved tier is kitty, and prompts with wording that matches the resolved tier. The kitty tier is skipped inside tmux/screen because the multiplexer swallows the graphics escapes even when the environment looks like kitty, so the cell renderer is used there, and `--fallback --render-mode kitty` remains the forced escape hatch for tmux with allow-passthrough. Declining exits 0. Either path then opens the `FrameSource` (`ffmpegSource` when a file argument is given, the built-in `proceduralSource` otherwise). In fallback mode `runFallbackPlayer` drives a probe-free Screen at the resolved render mode with its own clock and raw-stdin keys, and never renders Ink. Otherwise the cli computes the panel `region` with `computePanelRegion`, and awaits kitty-motion's `createScreen` (with `renderMode: 'kitty'` when `--render-mode kitty` was given without `--fallback`, otherwise following detection) BEFORE calling Ink's `render()`. That ordering is load-bearing because the capability probes read responses from stdin, and Ink's `useInput` takes stdin over once rendering starts. Then it renders `<Video screen source info autoPlay loop controls keyboard title help />` with `exitOnCtrlC: false` so Video's own input handler can dispose the Screen and close the source before Ink tears down. For file arguments the cli also opens an `AudioPlayer` (`createFfmpegAudioPlayer`) alongside the ffmpeg source, passed through as the `audio` prop, and the playback clock (and the fallback loop's own copy of it) drives that player on play, pause, seek, and loop with a 250 ms drift snap back to the video clock's position once per displayed second. The video clock stays master, never the other way around.

`Video` owns the playback clock, in the `usePlaybackClock` hook. A `setInterval` at the source frame rate lives outside React state, refs mirror `playing` and elapsed time as the source of truth for the interval callback, and an in-flight guard keeps async `getFrameAt` calls from piling up behind a slow source. A two-phase buffering gate holds the clock at startup, seeks, loop wraps, replays, resumes, and drift resyncs, retrying the gated position each tick: phase one waits for the frame at the playhead, phase two starts audio there and holds until the source's readahead is full (`FrameSource.isBuffering`) and the audio has made sound or reported it cannot (`AudioPlayer.isStarting`), so playback begins buffered, with picture, bar, and sound together, even when a remote URL takes seconds to deliver either. Every audio start goes through the gate. Each gate release also re-anchors the running clock to wall time, and ticks compute the playhead from that anchor rather than counting intervals, because a late timer fire permanently loses its lateness (1-2% under decode load) and a tick-counted clock drags behind the wall-paced audio until the drift snap fires forever. Once playing, a null frame still advances the clock (frames drop, playback stays realtime), and seeks move the playhead synchronously with a timeline bump so a stale fetch cannot clobber the new position. `runFallbackPlayer` ports the same gate and anchor. Frames go straight to `screen.pushFrame()`, bypassing React entirely, and React state (so an Ink redraw) updates only when the displayed whole second changes. On terminal resize Video debounces the stdout `resize` event, calls `screen.setRegion()` with a freshly computed panel region, RE-READS `screen.getPlaceholderRows()` (the grid size can change, so the old rows are stale), and repaints the current frame.

`FrameSource` is the seam the ffmpeg decoder plugs into. It is a pull model: the player's clock requests frames by timestamp via `getFrameAt(timeMs)`, `null` means no frame is ready and the player keeps showing the last one, and returned buffers may be reused by the source (valid only until the next call). `seek(timeMs)` makes nearby reads cheap, `close()` is idempotent.

### Module map

- `src/cli/` - executable bin entry (`index.tsx` runs the player on import, opening an `AudioPlayer` alongside the source for file arguments and forwarding `--muted`) plus `parseCliArgs.ts`, the exit codes, help text, and `VERSION`
- `src/Video/` - the Ink component `Video`: playback clock in `usePlaybackClock.ts`, self-managed resource lifecycle in `useManagedResources.ts`, probe-free Screen construction in `managedScreen.ts`, plus the two-mode props union (external resources vs. self-managed)
- `src/frameSource/` - interface-only module holding the `FrameSource`/`FrameSourceInfo` contract (no implementation, no consts)
- `src/audioPlayer/` - interface-only module holding the `AudioPlayer`/`AudioPlayerInfo` contract (no implementation, no consts)
- `src/ffmpegAudioPlayer/` - decodes a file's audio track with a second bundled-ffmpeg process into an audify (RtAudio) output stream. playFrom respawns ffmpeg with `-ss` placed by the video decoder's seekability rules (see `src/ffmpegSource/`), pause kills the decoder and clears the device queue, mute sets the device volume to zero, and position is the playFrom offset plus device frames actually played, reported as null until the decoder's sound actually plays (a non-null frozen position would make the clock's drift snap kill a starting decoder every second, which silenced remote playback entirely). isStarting reports a live decode attempt with no sound out yet, which is what holds the clock's buffering gate, and flips false when the attempt's process exits so a dead attempt releases the gate instead of stalling it. Each start holds AUDIO_PREBUFFER_MS of PCM back from the device before releasing any of it, and AUDIO_QUEUE_CAP_MS sizes the steady-state backlog cushion that absorbs delivery hiccups without underrunning. Every failure resolves to silent playback, never a crash
- `src/fallbackPlayer/` - fallback playback for terminals that cannot run the full Ink player. `resolveFallbackRenderMode` picks the mode (a forced mode wins untouched, a multiplexed session skips the probe and takes the cell mode, otherwise the kitty graphics probe decides, falling back to `detectCellRenderMode`, cell-background on Terminal.app, half-block elsewhere). Probe-free `createFallbackScreen` builds the Screen at that mode (full-screen, autoResize), and `runFallbackPlayer` is a React-free port of the playback clock with raw-stdin keys (space, arrows, m mute, q/Ctrl-C) and no Ink UI
- `src/proceduralSource/` - the built-in demo source, a hue-cycling ball on a Lissajous path rendered as a pure function of time into a reused framebuffer
- `src/ffmpegSource/` - decodes video files and http(s) URLs with bundled ffmpeg-static/ffprobe-static: ffprobe metadata probe, one streaming ffmpeg process decoding rawvideo rgb24 into a readahead queue (stream pause/resume backpressure, `isBuffering` reports true while it fills so the clock's gate can wait for a full buffer), respawned with `-ss` on seek or backward time jump, frames scaled to fit 960x540. `-ss` placement follows input seekability, detected once at open by `detectRangeSupport` (a one-byte Range request): input-side for local files and range-supporting servers, output-side (read from the start, discard up to the target) for non-seekable streams, and no `-ss` at all for a start at zero, because even `-ss 0` corrupts VP9 decoding of live-muxed matroska over non-seekable http
- `src/playerLayout/` - `computePanelRegion` sizes the video panel's cell grid from the terminal size via kitty-motion's `fitToTerminal`, and `computeEmbeddedRegion` letterboxes a source frame into a fixed cell box for embedded mode (deliberately not via `fitToTerminal`, whose minimum-display floor distorts small boxes)
- `src/formatTime/` - millisecond timestamps as `m:ss`, switching to `h:mm:ss` at one hour
- `src/index.ts` - library entry with explicit (not star) re-exports, because several modules define their own `MS_PER_SECOND` and star exports would silently drop the ambiguous name

## Gotchas

- **`createScreen` before Ink `render()`**: the kitty-motion capability probes read stdin, and Ink's `useInput` takes stdin after `render()`. Creating the Screen after rendering hangs or corrupts the probe handshake. The cli entry already does this in the right order, keep it that way
- **Re-read placeholder rows after `setRegion()`**: the placeholder grid size can change with the region, so cached rows go stale. The Player's resize effect calls `screen.getPlaceholderRows()` again after every `setRegion()`
- **`minimumReleaseAge` install policy**: `pnpm-workspace.yaml` blocks package versions published less than 7 days ago, with `kitty-motion` excluded (our own package, every published version is newer than the cutoff). If `pnpm add` or `pnpm update` fails to resolve a brand-new release, pin an older version instead of fighting the resolver
- **AGENTS.md is a symlink to CLAUDE.md**: edit CLAUDE.md only, never create a separate AGENTS.md
- **ink is pinned to 5.x with react 18**: `@inkjs/ui` 2.x targets ink 5, and Ink's width measurement of the placeholder cells is version-sensitive. ink 7 requires react 19 and is a deliberate future upgrade, not a casual dependency bump
- **`VERSION` in `src/cli/consts.ts` mirrors package.json**: it is a literal (importing package.json from outside `src/` breaks the tsconfig include), so bump it together with the `version` field on every release
- **ffmpeg-static needs its install script**: `pnpm-workspace.yaml` allowlists `ffmpeg-static` under `allowBuilds` because it downloads its binary in a postinstall step. If the CLI dies with ENOENT spawning ffmpeg, the script was blocked. Run `pnpm install --force` after checking the allowlist
- **audify needs its install script**: `pnpm-workspace.yaml` allowlists `audify` under `allowBuilds` because its install script fetches a prebuilt RtAudio binding or, when no prebuild matches the platform, compiles the binding locally with cmake-js. Blocking that script is what causes silent audio degradation. If audio silently degrades with the "audio output is unavailable" notice on a machine that has sound, check the allowlist and run `pnpm install --force`. Never construct audify's RtAudio in tests. It opens a real device, so use the injectable `createDevice` seam or `vi.mock('audify')` instead
- **Never register audify's frameOutputCallback**: passing a callback to `openStream` (or `setFrameOutputCallback`) creates a native thread-safe function that audify never releases, not even on `closeStream()`, so the process can never exit again on its own. The RtAudio adapter passes `null` there and paces `onFrameDone` from an unref'd wall-clock timer instead. Keep it that way

## Git

- **Never create merge commits**: When integrating a branch, always rebase. Use `git rebase`, `git pull --rebase`, or `git merge --ff-only` to keep history linear. Never run a plain `git merge` that produces a merge commit.

## Coding Standards

- **Package manager**: Use `pnpm` for all package management (install, add, remove, etc.)
- **ESM imports only**: Always use `import` syntax, never `require()`. This is an ESM project and `require` will throw `ReferenceError: require is not defined`
- **Explicit `.ts`/`.tsx` extensions on relative imports**: Write `from "./consts.ts"` and `from "../Player/index.tsx"`, never extensionless `from "./consts"`. Enforced by ESLint
- **Erasable syntax only**: `erasableSyntaxOnly` is on in tsconfig. No constructor parameter properties (`constructor(private foo: T)`), enums, or namespaces. Declare fields explicitly and assign in the constructor
- **Arrow functions**: Use `const foo = () => { ... }` (enforced by ESLint, auto-fixable with `pnpm lint:fix`)
- **Reserve `use` prefix for React hooks**: This project has real React hooks (Ink components), so the `useFoo` naming convention is reserved for them. For boolean options or flags, use names like `systemFont`, `enableCache`, or `withValidation` instead of `useSystemFont`, `useCache`, or `useValidation`
- **Named constants**: Use `const HEADER_SIZE = 16` not magic numbers
- **Numeric separators**: Use underscore separators for numbers 1000 and above for readability (`1_500`, `44_100`, `100_000`)
- **DRY (Don't Repeat Yourself)**: When a pattern appears 3+ times, extract it into a helper function. This improves readability and maintainability without impacting performance
- **Module structure**: Always create modules as directories with `index.ts` (or `index.tsx` for components), never as single `moduleName.ts` files. Name the directory after the primary export (class, function, component, or concept). This provides a consistent location for related files:

  ```
  # GOOD - directory structure allows for growth
  src/
    Player/
      index.tsx      # exports the Player component
      tests.tsx      # tests for the module (.tsx when tests render JSX)
      consts.ts      # SEEK_STEP_MS, HELP_TEXT, etc.
      types.ts       # PlayerProps, PlayerScreen interfaces
    formatTime/
      index.ts       # exports formatTime()
      tests.ts
      consts.ts

  # BAD - single files have nowhere for related code to go
  src/
    Player.tsx
    formatTime.ts
  ```

  Standard files within a module directory:
  - `index.ts` / `index.tsx` - Main module implementation and exports (no constants or type definitions here)
  - `tests.ts` / `tests.tsx` - Tests for the module (`.tsx` when the tests render components)
  - `consts.ts` - **All** module-specific constants (primitives, arrays, objects)
  - `types.ts` - **All** type definitions, interfaces, and type guards

- **Keep index.ts focused on implementation**: The `index.ts` file should only contain the main implementation (classes, functions, components). All constants go in `consts.ts` and all types/interfaces/type guards go in `types.ts`:

  ```typescript
  // BAD - constants defined in index.ts
  // Player/index.tsx
  const SEEK_STEP_MS = 5_000;
  export const Player = () => { ... };

  // GOOD - constants in consts.ts, imported into index.tsx
  // Player/consts.ts
  export const SEEK_STEP_MS = 5_000;

  // Player/index.tsx
  import { SEEK_STEP_MS } from "./consts.ts";
  export const Player = () => { ... };
  ```

- **Re-export types and consts from index.ts**: Each module's `index.ts` should re-export all types and consts from `types.ts` and `consts.ts`. External code should import from the module, not directly from internal files:

  ```typescript
  // GOOD - import from the module's index
  import { SEEK_STEP_MS, PlayerProps } from "../Player/index.tsx";

  // BAD - importing directly from internal module files
  import { SEEK_STEP_MS } from "../Player/consts.ts";
  import type { PlayerProps } from "../Player/types.ts";
  ```

  One exception is deliberate here. `src/index.ts` uses explicit named re-exports instead of `export *`, because several modules define their own `MS_PER_SECOND` and star exports would silently drop the ambiguous name

- **JSDoc**: Skip `@param`/`@returns` tags (TypeScript provides types), use inline comments if needed
- **Doc comments on interface/type properties**: Use a `/** ... */` block comment above the property, not a trailing `//` comment. Editors surface `/** */` on hover, but trailing `//` comments are invisible until you scroll to that line:

  ```typescript
  // GOOD - shows on hover in editors
  export interface ProceduralSourceOptions {
    /** Source framebuffer width in pixels (default 240) */
    width?: number;
  }

  // BAD - trailing comment doesn't show on hover
  export interface ProceduralSourceOptions {
    width?: number; // Source framebuffer width in pixels (default 240)
  }
  ```

- **Export interfaces**: Almost always export `interface`/`type` declarations, even ones that look internal to a module. Consumers (and tests) frequently need to reference a function's options or return shape, and an unexported type forces them to redefine or `ReturnType<>`/`Parameters<>` it instead:

  ```typescript
  // BAD - unexported, so callers can't name this type
  interface PanelRegionOptions {
    termCols: number;
    termRows: number;
    sourceWidth: number;
    sourceHeight: number;
  }

  // GOOD - exported so callers can use the type directly
  export interface PanelRegionOptions {
    termCols: number;
    termRows: number;
    sourceWidth: number;
    sourceHeight: number;
  }
  ```

- **Loading indicators**: Delay by ~1 second to avoid flash for fast operations
- **Intl API**: Prefer `Intl.DateTimeFormat`, `Intl.NumberFormat`, etc. over manual formatting for dates, numbers, and currencies
- **Explicit conditionals for derived values**: When a value is derived from another value, use the source value in conditionals, not the derived value. This makes the logic clearer and avoids confusion:

  ```typescript
  // GOOD - explicit about what each branch handles
  if (this.limitColors === 16) {
    /* ANSI 16 */
  } else if (this.limitColors === 256) {
    /* ANSI 256 */
  } else {
    /* True color (limitColors === 0) */
  }

  // BAD - confusing because useTrueColor is derived from limitColors
  if (this.limitColors === 16) {
    /* ANSI 16 */
  } else if (this.useTrueColor) {
    /* True color */
  } else {
    /* ANSI 256 */
  }
  ```

- **Type guards over type assertions**: Never use `as` type assertions on values with unknown runtime types. Write small hand-rolled type guards instead:

  ```typescript
  // GOOD - type guard validates at runtime
  const isString = (value: unknown): value is string => typeof value === "string";

  if (isString(value)) {
    config.name = value;
  }

  // BAD - blind cast assumes type without validation
  config.name = value as string;
  ```

  For union types (e.g., `ColorSpace` from kitty-motion), create a type guard that validates the actual values, not just the primitive type:

  ```typescript
  // GOOD - validates the value is one of the allowed options
  if (isColorSpace(value)) {
    config.colorSpace = value; // No cast needed
  }

  // BAD - isString only checks primitive type, not valid union values
  if (isString(value)) {
    config.colorSpace = value as ColorSpace; // Still a blind cast!
  }
  ```

  When creating type guards for union types, use the named type in the return type annotation - don't hardcode the union:

  ```typescript
  // GOOD - uses the named type
  import type { ColorSpace } from "kitty-motion";

  const COLOR_SPACES: readonly ColorSpace[] = ["rgb15", "rgb24"];

  export const isColorSpace = (value: unknown): value is ColorSpace =>
    isString(value) && COLOR_SPACES.includes(value as ColorSpace);

  // BAD - hardcodes the union type (duplicates the type definition)
  export const isColorSpace = (value: unknown): value is "rgb15" | "rgb24" => {
    // ...
  };
  ```

- **Typed errors over string messages**: When throwing errors, create a custom error class with a typed `code` property instead of using plain `Error` with string messages. This enables type-safe error handling:

  ```typescript
  // GOOD - typed error with machine-readable code
  type MyErrorCode = "NOT_FOUND" | "PERMISSION_DENIED" | "TIMEOUT";

  class MyError extends Error {
    readonly code: MyErrorCode;
    constructor(code: MyErrorCode) {
      super(code);
      this.name = "MyError";
      this.code = code;
    }
  }

  const isMyError = (error: unknown): error is MyError => {
    return error instanceof MyError;
  };

  // Usage - callers get autocomplete and type checking
  try {
    await doSomething();
  } catch (error) {
    if (isMyError(error)) {
      switch (error.code) {
        case "NOT_FOUND": // TypeScript knows valid codes
        // ...
      }
    }
  }

  // BAD - string messages aren't type-safe
  throw new Error("Not found");
  throw new Error("Permission denied");
  ```

- **Tests verify behavior, not implementation**: Tests should verify that code works correctly, not enshrine implementation details. Never write tests that just check constant values - if a constant matters, test the behavior it affects:

  ```typescript
  // BAD - tests implementation detail, provides no value
  it("should have expected default value", () => {
    expect(SEEK_STEP_MS).toBe(5_000);
  });

  // GOOD - tests actual behavior that depends on the constant
  it("should seek 5 seconds forward on right arrow", () => {
    stdin.write("[C");
    expect(fakeSource.lastSeekMs).toBe(5_000);
  });
  ```

## Documentation Style

Applies to all prose: README, doc comments, JSDoc, commit messages, and PR descriptions.

- **No emdashes**: Never use emdashes (—) or spaced hyphens as emdash substitutes. Restructure into separate sentences, or use a comma, colon, or parentheses instead:

  ```
  # BAD
  The player is light — roughly one Ink redraw per second — so the UI never stutters.

  # GOOD
  The player is light (roughly one Ink redraw per second), so the UI never stutters.
  ```

- **No semicolons or mid-sentence colons**: Human-written docs rarely use them, AI-generated ones lean on them constantly. Split into separate sentences instead. A colon that introduces a list, example, or code block is fine:

  ```
  # BAD
  Ink owns the layout; the pixels are kitty-motion's problem: encoding, diffing, and backpressure.

  # GOOD
  Ink owns the layout. The pixels are kitty-motion's problem, covering
  encoding, diffing, and backpressure.
  ```

- **No AI-isms**: Avoid filler words and hype phrasing that reads as machine-generated. Say what the thing does in plain, direct language:
  - Banned words: "delve", "leverage" (as a verb; use "use"), "seamless", "seamlessly", "robust", "powerful", "cutting-edge", "blazingly fast", "supercharge", "elevate", "streamline", "harness" (as a verb), "unlock", "empower", "crucial", "comprehensive", "furthermore", "moreover", "additionally" (as a sentence opener)
  - Banned constructions: "It's not just X, it's Y", "Whether you're X or Y", "In today's world of...", "Let's dive in", "the beauty of X is", rhetorical questions as section openers
  - No summary padding: skip closing paragraphs like "In conclusion" or "With these tools in place, you're ready to..."

  ```
  # BAD
  kitty-video-player provides a robust, seamless playback experience that empowers
  you to effortlessly watch video in the terminal. Whether you're demoing or
  debugging, it's not just smooth, it's blazingly fast.

  # GOOD
  kitty-video-player plays video in the terminal through an Ink UI. Frames bypass
  React entirely, so Ink redraws about once per second while pixels update
  at 30fps.
  ```

- **Concrete over promotional**: Prefer measurable claims ("Ink redraws once per second") over adjectives ("high-performance"). If a claim has no number or specific behavior behind it, cut it.
