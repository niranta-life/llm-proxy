# Known limitations

- The only upstream is the official OpenAI chat completions API. The process default is `https://api.openai.com/v1`. `OPENAI_BASE_URL` exists so an operator can point this process at a mock. Callers cannot set it.
- Only non-streaming text chat is implemented. Tools, images, audio, other response formats, fallback, retries, and quality routing are rejected or absent.
- Each accepted request makes one upstream call and one attempt row. The tables allow a later attempt for the same request, and this slice does not create one.
- Inference is off unless `INFERENCE_ENABLED=true`. A disabled deployment or a tenant with no enabled deployment makes no upstream call.
- Provider credentials use AES-256-GCM and `PROVIDER_CREDENTIAL_KEY`. There is no external secret manager.
- If the model call succeeds and the status update fails, the caller receives the completion, the model is not called again, and the row can remain `pending`. The critical log contains the request id and the attempt id.
- Missing token usage is stored as null and is omitted from the response. Metrics do not turn that into zero, a price, or a quality score.
- The metrics window requires `from` and `to` and rejects a span longer than 32 days.
- The default tests use PostgreSQL and a mock HTTP server. They do not call the live OpenAI API. A live check is documented and is optional.
- There is no lint script, CI workflow, HTTP admin API, rate limit, or billing.
- A holder of the migration password can `SET ROLE llm_owner` and bypass row level security. That password is an administrative credential.
