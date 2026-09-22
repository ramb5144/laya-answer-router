# Laya Answer Router

A Chrome Manifest V3 side panel plus a Claude Desktop extension. They read the bound tab's DOM and cross-origin question frames on demand, ask local Laya which model lane should answer, and return the response from a loopback-only relay. Direct mode can operate captured text fields, single-choice groups, and dropdowns and, when enabled, click an explicit Check answer control only above 50% answer confidence.

In the interface, **Jev** is the guarded browser-operation loop; **Laya** is the local model router that chooses the response lane.

## Architecture

```text
bound tab DOM -> Chrome side panel -> short-lived in-memory snapshot
                                      -> 127.0.0.1 relay -> local Laya router
Claude Desktop -> local MCPB bridge --^                  -> fast or deep OpenAI model
```

Laya is the router, not the prose generator. Auto mode uses its typed `fast` / `deep` decision. If the local checkpoint is still warming or unavailable, a small deterministic complexity guard chooses a lane instead.

Neither extension receives or stores the OpenAI key. The Chrome manifest carries a public development key so its unpacked ID stays fixed at `oeijkdjbjmmepmljoehbainddpbddmhm`; the relay accepts browser requests only from that exact `chrome-extension://` origin and matching ID header. Claude uses a separate bearer token saved by Claude Desktop as sensitive configuration. The MCP bridge refuses non-loopback relay URLs so that token cannot be sent to a remote host. Page snapshots stay in relay memory for at most 15 minutes.

## First run

Prerequisites:

- Node.js 22 or newer
- Python 3.10 or newer
- An OpenAI API key with access to the models configured in `.env`

1. Clone the repository and install the relay dependencies:

   ```bash
   git clone https://github.com/ramb5144/laya-answer-router.git
   cd laya-answer-router
   npm install
   cp .env.example .env
   chmod 600 .env
   ```

2. Create a Python environment, install Laya, and cache its checkpoint before the relay switches it to offline mode:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install "laya==0.3.3"
   python -c "from huggingface_hub import snapshot_download; snapshot_download('convaiinnovations/laya')"
   ```

   Set `LAYA_PYTHON` in `.env` to the absolute path printed by `python -c "import sys; print(sys.executable)"`.

3. Run `npm run setup:bridge-token`. This creates one random bridge secret in `.env` and `~/.config/laya-answer-router/mcp-token`, both mode `0600`. Put the OpenAI key in `.env` as `OPENAI_API_KEY=...`. Do not put either secret under an extension or plugin directory.
4. Start the relay:

   ```bash
   npm start
   ```

5. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select:

   ```text
   laya-answer-router/extension
   ```

6. Open `http://127.0.0.1:8765/demo` and click the extension toolbar button. Direct mode discovers the answer box without requiring focus.

Chrome shows a broad site-access warning because cross-origin assignment players (including Pearson's) are separate documents. The extension injects its reader only when used; it does not install an always-running content script.

## Claude Desktop extension

Build the installable bundle:

```bash
npm run pack:claude
```

In Claude Desktop, open **Settings → Extensions → Advanced settings → Install Extension…** and select:

```text
dist/laya-answer-router-0.4.0.mcpb
```

Keep the default relay URL. For the relay token, paste the same `LAYA_MCP_TOKEN` value from `.env`; Claude stores fields marked sensitive in secure OS storage. Start the relay, then open or refresh the Laya Chrome side panel on the page. Claude can use `laya_answer_current_page` without opening or driving the browser itself.

This local extension works in Claude Desktop and Claude Code. Claude on the web and Cowork cannot reach this localhost bridge; those surfaces would require a public remote MCP connector.

## Other MCP clients

The bundled MCP server communicates with the loopback relay over HTTP. MCP clients that can launch local stdio servers can use the same server entry point and provide `LAYA_RELAY_URL` and `LAYA_MCP_TOKEN` as environment variables. Cloud-only clients cannot reach this localhost bridge without a separately secured remote connector.

The relay looks for a Laya Python environment at `../laya-demo/.venv/bin/python` by default. Set `LAYA_PYTHON` and, when needed, `LAYA_MODEL_PATH` in `.env` for a different local installation.

## Use

- Click the toolbar button on a question page. That tab becomes Jev's bound tab for the lifetime of the panel; switching to another tab does not redirect its actions.
- Direct mode searches every accessible frame, keeps the selected question frame first, and sends one bounded full-tab context containing the course shell, reference material, current item, prior parts, answer choices, and visible feedback. Expand **Full bound-tab context sent to the model** to inspect the exact broader context.
- **Auto** lets Laya route; **Fast** and **Deep** are manual overrides.
- **Check above 50%** uses the answering model's separate confidence value, not Laya's routing confidence. At 50% or below, it fills and stops for review.
- **Delay before Check** accepts 0–300 seconds and is saved between sessions. During the countdown, **Stop** cancels submission and leaves the filled answer in place.
- Harmless page mutations are deferred while an answer is streaming instead of cancelling it. Transient answer failures retry three times with backoff; if the local relay exits, the panel reports it explicitly and resumes the same question after the relay returns.
- After Pearson confirms a correct result and no unanswered part remains, Jev can click the uniquely identified **Next** control and recapture the new question. It stops on incorrect feedback.
- Every fill, selection, submission, and navigation uses a document token plus a question/options fingerprint. Immediately before Check, Jev recaptures the same bound tab and reacquires Pearson's current button, so a SPA rerender cannot leave it holding a stale element or cause a late result to act on a different question.

## Verify

```bash
npm run check
npm run validate:claude
```

For the browser-level content-agent regression harness, start a disposable Chrome debugging instance and run `node scripts/verify-page-agent.mjs PORT`. It proves that a Pearson-style rerender invalidates the old Check handle, that the fresh handle submits after the requested delay, and that the merged context contains both the outer course shell and inner assignment frame.

The relay health endpoint is `http://127.0.0.1:8765/api/health`. It reports whether the key is configured and whether Laya is cold, warming, ready, or on fallback.

## Privacy and security

- `.env`, generated release packages, logs, private keys, and local coverage output are excluded from Git.
- The OpenAI key is read only by the loopback relay; browser and MCP clients never receive it.
- Bound-tab DOM text and the selected question are sent through the loopback relay to the configured OpenAI API model. Review the captured context in the side panel before answering sensitive pages.
- Page context is kept in relay memory for at most 15 minutes and is not written to disk by the relay.
- Review [SECURITY.md](SECURITY.md) before changing relay exposure or credential handling.

## Responsible use

Use the extension only on pages you are authorized to access and automate. Follow applicable site terms, institutional rules, and academic-integrity requirements. Keep Direct mode and automatic submission disabled when human review is required.

## License

MIT. See [LICENSE](LICENSE).

Laya Answer Router is an independent project and is not affiliated with Convai Innovations, Pearson, Anthropic, OpenAI, or Google.
