# Known limitations

- There is no lint script. This slice does not add one, and it does not claim a lint pass.
- The default tests do not call a live provider. `scripts/anthropic-smoke.mjs` exits without a network call unless `ANTHROPIC_SMOKE=1`. That command was not run with the flag.
- Anthropic Messages responses have no `created` time. The proxy sets `created` from its own clock.
- Thinking and redacted thinking blocks are omitted. A response that contains only those blocks returns empty assistant text. Tool-use and any other content block or stop reason reject the whole response. The attempt still stores the message id, native stop reason, and reported usage. The caller does not receive the block.
- Anthropic accepts one leading system message, alternating user and assistant text that ends on a user message, temperature from 0 through 1, stop sequences, and an output token limit. Streaming, tools, images, developer messages, assistant prefill, and other sampling fields are rejected. They are not removed and then forwarded.
- Public usage still has the three OpenAI token fields. Cache categories are stored on the attempt only when Anthropic reports them. Missing counts stay null.
- Each accepted request makes one upstream call. `maxRetries` is 0. There is no fallback to the other provider.
- One tenant has one connection per provider. Anthropic stays unusable until that connection and that deployment are enabled.
- A failed attempt-status write returns the completion already received and does not call the provider again. The row can stay `pending`.
- Provider credentials stay AES-256-GCM ciphertext. There is no external secret manager.
- A holder of the migration password can `SET ROLE llm_owner` and bypass row level security.
