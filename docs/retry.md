# Retry

Back to [README](../README.md)

## Where it fits

This page covers the retry decision in step 6. See the [request path](architecture.md#request-path).

[llm-proxy](../README.md) sends one upstream attempt unless you turn retry on for that deployment. Retry stays off by default. There is no HTTP route that changes the policy.

An enabled policy makes at most two upstream attempts. The second attempt uses the same provider and the same deployment. The proxy does not switch the model after an error. The same request does not retry and also fall back. Fallback is a separate control. See [Fallback](fallback.md).

Provider clients set `maxRetries` to `0`, so the SDK does not retry on its own.

## When the second attempt runs

The second attempt can run for HTTP 429, HTTP 503, or a connection failure before the request is sent.

It does not run for any other HTTP status. It does not run when the caller cancels. It does not run after a stream has sent output. It does not run for a timeout before the request is sent, a timeout after the request is sent, an exhausted total deadline, or an ambiguous network failure after the request is sent.

A response header ends the connection deadline. The body can still finish inside the attempt deadline. A valid `Retry-After` is used only when the wait fits the remaining deadlines. An invalid `Retry-After` does not add wait beyond the bounded backoff. The proxy keeps `Retry-After` from the HTTP response.

A failure after the request was sent, with no usage, is an uncertain expense. The amount stays null. A missing usage count is not stored as zero.

## Deadlines

A deployment with no stored policy uses the deployment timeout. It does not arm a separate deadline.

A stored policy arms a connection deadline, an attempt deadline, and a total deadline. Retry can stay off while those deadlines stay on. For a response that is not a stream, the stored attempt deadline is the provider timeout. A stream keeps the deployment timeout and the stream timers.

A deadline is an integer from 100 through 600000. A backoff is an integer from 0 through 600000. The initial backoff cannot be above the maximum backoff. The unit is milliseconds.

## Commands

Turn retry off without deleting the policy row. The next request sends one attempt.

```bash
docker compose run --rm app node dist/cli.js set-execution-policy \
  --tenant-id <tenant-id> \
  --deployment <name> \
  --retries false \
  --connection-deadline-ms 30000 \
  --attempt-deadline-ms 30000 \
  --total-deadline-ms 30000 \
  --initial-backoff-ms 0 \
  --max-backoff-ms 0
```

Use `--retries true` when you want the second attempt. The change applies to that deployment only. The command needs `--tenant-id`, `--deployment`, `--retries`, and all five deadline and backoff flags. A deployment name cannot be `auto`.

## Related

- [Fallback](fallback.md)
- [Circuit breaker](breaker.md)
- [Streaming](streaming.md)
- [Cost](cost.md)
