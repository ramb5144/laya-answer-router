# Security

## Secrets

Keep `OPENAI_API_KEY` and `LAYA_MCP_TOKEN` in the local `.env` file. Never put
either value in the Chrome extension, the Claude extension bundle, source
files, screenshots, issues, or commits. The relay binds to `127.0.0.1` and is
the only component that reads the OpenAI key.

The `key` field in `extension/manifest.json` is a public Chrome extension key
used to keep the unpacked extension ID stable. It is not an API credential or
a private signing key.

## Reporting a vulnerability

Please use GitHub's private vulnerability-reporting feature for this
repository. Do not include live credentials or captured page content in a
public issue.
