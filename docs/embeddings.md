# Embeddings

Back to [README](../README.md)

`POST /v1/embeddings` returns one vector per text input. The caller names one embedding deployment. The call does not use alias `auto`. It does not enter chat routing. Setup for each provider is in [Providers](providers.md).

## Where it fits

An embedding request is one attempt. It does not retry. It does not write a routing decision, a chat sample, or chat quality evidence. See the [request path](architecture.md#request-path).

## Request

The body accepts `model`, `input`, `encoding_format`, and `dimensions`. Any other field is rejected.

`model` is the name of an enabled deployment. The deployment and its connection must both be enabled. The deployment must list `embeddings`.

`input` is one text string or an array of text strings. An empty string is rejected. An empty array is rejected. The array holds at most 32 strings. Each string holds at most 8192 characters.

`encoding_format` is `float` or `base64`. Omit it and the encoding is `float`. `base64` is accepted on OpenAI. Vertex and a private deployment reject `base64`.

`dimensions` is optional. When you send it, it must equal the pinned contract dimension.

## Contract

`register-embedding-contract` stores one version for one deployment. You pass `--tenant-id`, `--deployment`, `--dimension`, and `--normalization`.

`normalization` is `none` or `l2`.

The proxy serves the highest contract version. That version must name the current upstream model. The proxy does not serve an older vector space. The proxy does not renormalize a vector into another policy.

A missing contract is rejected. A requested dimension that does not match the pin is rejected.

A successful attempt stores the token counts, the latency, and the cost status. `GET /internal/v1/metrics/summary` reads those totals for a time window. It does not return the input or the vectors.

The pinned dimension is an integer from 1 through 4096. OpenAI and Vertex dimensions must also fit the approved model.

## Approved models

OpenAI models are `text-embedding-3-small`, `text-embedding-3-large`, and `text-embedding-ada-002`.

`text-embedding-3-small` accepts a dimension from 1 through 1536. `text-embedding-3-large` accepts a dimension from 1 through 3072. `text-embedding-ada-002` accepts only dimension 1536. The proxy does not send a dimension for `text-embedding-ada-002`.

Vertex models are `text-embedding-004`, `text-embedding-005`, and `gemini-embedding-001`.

`text-embedding-004` and `text-embedding-005` accept a dimension from 1 through 768. `gemini-embedding-001` accepts a dimension from 1 through 3072.

The public body stays the OpenAI embeddings shape for Vertex.

A private embedding call requires validation status `validated_mock` and a loopback endpoint. A live private host does not receive embeddings.

Anthropic, xAI, and OpenRouter do not accept embeddings.

## Response

The response `object` is `list`. Each item has `object` `embedding`, an `index`, and `embedding`.

`float` encoding returns one finite number array per input. `base64` encoding returns one string per input. The decoded values must match the pinned dimension and the pinned normalization.

`usage` has `prompt_tokens` and `total_tokens`. Those two counts are equal.

`model` in the response is the deployment name.

## What is stored

A successful attempt stores token counts, latency, and cost. A failed attempt stores the failure.

The completion log has the request id, the deployment, the vector count, and the dimension. It has no input text and no vector.

## Errors

HTTP 404 `model_not_found` means the named deployment is missing or disabled.

HTTP 400 covers a missing contract, a model the deployment does not support, an empty input, an over-long input, a bad dimension, and an unsupported encoding.

HTTP 502 covers an upstream failure, a vector count that does not match the input, a non-finite value, a vector space that does not match the contract, and an upstream model that changed.

HTTP 503 `inference_disabled` means inference is off.

## Related

- [Providers](providers.md)
- [Chat](chat.md)
- [Cost](cost.md)
- [Operations](operations.md)
