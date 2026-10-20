# Mock upstream fixtures

The integration mock selects a scene from the user message text. It does not read a caller-selected URL. Each accepted stream is one HTTP request with `stream` true and the configured upstream model.

`test/fixtures/openai-stream-success.sse` is the success body. The file is not copied here. Its frames, in order, are:

1. A `chat.completion.chunk` whose delta role is `assistant` and whose finish reason is null.
2. A text delta chunk. The proxy keeps the completion id from frame 1 when a later frame carries another id.
3. A text delta chunk whose finish reason is `stop`.
4. A usage chunk with empty `choices` and integer prompt, completion, and total counts.
5. `data: [DONE]`.

Other scenes in `test/stream-integration.test.ts`:

- Client cancel writes the frames before `[DONE]` and leaves the response open until the upstream socket closes.
- Backpressure writes one small role frame, then up to 24 frames of 256 KiB, and stops when the request is aborted.
- Provider failure before the first event returns HTTP 500 and no SSE.
- Provider failure after partial output writes one text frame, then an SSE error object, and does not write `[DONE]`.
- A missing `[DONE]` closes the body after the finish frame.
- A missing usage body omits the usage object and still sends `[DONE]`.
- Unicode is split across two socket writes inside one text delta.
- A capacity hold waits, then writes the success body. A second stream during that hold is rejected by the proxy before SSE.

The image proof used a separate mock on a throwaway network. A non-stream request returned one JSON chat completion. A stream request returned the role frame, one text frame, a `stop` frame, an integer usage frame, and one `[DONE]`. That mock log recorded the stream flag and the request byte count. It did not record the prompt or the generated text.
