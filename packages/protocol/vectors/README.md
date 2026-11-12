# Protocol vectors

`protocol.json` contains reusable public vectors for `hive-metered/v2`
(schema `hive-protocol-vectors/v2`). Every integer field is an unsigned
decimal string. Hexadecimal fields use lowercase, and JSON object keys are
sorted by UTF-16 code units. There are no private keys in the fixture: the
generator derives every key from a fixed label, so the file is reproducible
byte for byte. Normal verification reads the saved public data.

## Quote bytes and identity

Each quote vector contains the signed body, trusted validation context,
canonical JSON text, canonical UTF-8 bytes, framed preimage and SHA-256 digest.
The quote digest is both `quoteId` and the escrow id. Regtest and Mutinynet
vectors differ in their signed network, producing distinct ids.

The quote preimage is:

```text
UTF8("hive-metered/v2/quote") || 00 || uint32_be(payload_length) || payload
```

`payload` is the exact canonical JSON encoding of the quote body. No JSON
numbers are permitted. The signature is a 64-byte BIP340 signature over the
32-byte SHA-256 digest, using the quote's RFQ public key. Quote verification
checks the schema and signature; funding validation additionally checks the
trusted context and expiry. Historical signatures remain verifiable after
expiry, while an expired quote cannot authorize new funding.

The profile permits only regtest and Mutinynet without the mainnet opt-in.
Every deployment key, participant key, payout destination, request identity,
steward pair key, cap, rate and deadline in the funding context must match the
signed body. `stewardPairKeys` lists the three pairs' MuSig2 keys, x-only, in
the order 01, 02, 12; they hold the escrow's exits and register its claim. Canonical parsers reject duplicate
keys, alternate escapes, whitespace and reordered keys at the wire boundary;
profile validators reject missing and unknown fields.

## Receipt bytes and signatures

Each receipt case contains the signed envelope, expected payer and cap, exact
eight-byte amount, preimage and digest. Amounts `1`, `330`, `331` and
`9223372036854775807` exercise ordinary values, the contract's dust boundary and
the largest positive signed ScriptNum that fits in eight bytes.

```text
UTF8("arkade-metered-escrow/v1") || escrow_id_32_bytes || num2bin(amount, 8)
```

Receipt signatures use BIP340 over the 32-byte SHA-256 digest of that preimage.
Positive amounts below `2^63` encode as eight-byte little-endian magnitudes.
The maximum has a final byte of `7f`; `2^63` would require an extra sign byte and
is rejected. The maximum vector tests the codec and cannot represent a funded
Bitcoin output. Quotes cap funding at Bitcoin's monetary maximum.

The `negatives` array names each operation and its rejected input. It covers
canonical encoding, invalid numeric forms, unsupported networks, quote and
receipt domains, wrong signers, changed amounts, escrow replay, trusted-context
mismatches, overflow and unknown fields. Funding and cumulative receipt
progression require application state and observed outputs in addition to
valid signatures.

The `costs` array checks cumulative token charging. Input and output charges are
summed in millisatoshis per million tokens before one ceiling to satoshis. A
cost above the quote's cap fails.

## Reproduction

From the repository root:

```bash
pnpm vectors:check
python3 -c "import json;print(json.dumps(json.load(open('packages/protocol/vectors/protocol.json'))['crypto']))" \
  | (cd tools/delegatee-ref && go run . protocol)
```

The first command regenerates the file from `tools/protocol-vectors.ts` and
requires identical bytes; without `--check` the generator writes it. The second
reads the saved `crypto` view and recomputes every amount encoding, canonical
body and digest in Go, verifying each BIP340 signature with btcd. Neither moves
value or touches a network. A Rust implementation can consume the same JSON,
compare every encoded byte and digest, verify signatures, and apply the
negative cases to its own profile validator.
