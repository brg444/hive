# The agent's API

The local agent accepts `POST /v1/chat/completions` for the model in its approved
quote and serves that model through `GET /v1/models`. Messages contain exactly
`role` and string `content`; supported roles are `system`, `user`, and
`assistant`, with one to 256 messages per request.

The accepted request fields are `model`, `messages`, `stream`, `stream_options`,
`max_tokens`, `max_completion_tokens`, `temperature`, `top_p`, `seed`, `stop`,
`presence_penalty`, and `frequency_penalty`. Fields such as `tools`, `user`,
`response_format`, and `n`, and array or image message content, are unsupported.
Optional sampling fields are forwarded to the inference service, whose model
and version determine their supported values.

Both token-limit aliases must be positive safe integers. When both are present,
`max_completion_tokens` takes precedence. Without either field, the agent's
`defaultOutputTokens` bounds payable output; its default is 128. The sidecar may
use a stricter configured output limit. `stream_options` accepts only a boolean
`include_usage`; the sidecar requests usage for every streamed response.

JSON responses and complete SSE bodies remain buffered until usage is checked
and a receipt is accepted. Streaming clients consequently receive the retained
body after payment, without incremental token delivery. An empty terminal
chunk carrying a finish reason may follow the usage chunk, while further
content, tool-call or reasoning payload and a second usage chunk are rejected.

Send an `Idempotency-Key` header chosen and saved before each request. Recovery
requires the same key and identical request bytes, including whitespace and
field order. The agent generates a key when none is supplied, but returns it
only in the response headers; a client that loses those headers cannot recover
a paid response using that generated key. A different key starts a different
request and can incur another charge.

Each agent configuration requires `perRequestMaxSats` and a private
`sidecarBearerTokens` entry keyed by the escrow id. The spending ceiling limits
the increase in cumulative authorized sats for one request. Input usage is
bounded by the original UTF-8 request byte length plus 64 tokens per message,
and output usage by the effective completion limit. The provider signs each
challenge with the workload key named in the quote. Token counts remain provider reports, with
bounds limiting authorization and signatures identifying the reporting
workload key.

Every sidecar endpoint requires the escrow's private bearer token, including
status, output, cancellation and freezing. The provider's launch configuration
holds the token and a path to its private signing configuration; public
activation records contain neither the token nor the workload secret. The
current agent-to-sidecar connection is restricted to loopback HTTP.
