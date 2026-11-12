// checkProtocol independently checks the public protocol vectors with the
// published Emulator number encoder, Go SHA-256 and btcd BIP340 verification.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
)

type vectors struct {
	Schema  string `json:"schema"`
	Amounts []struct {
		Label       string `json:"label"`
		Decimal     string `json:"decimal"`
		ExpectedHex string `json:"expectedHex,omitempty"`
		Fits        bool   `json:"fits"`
	} `json:"amounts"`
	Messages []struct {
		Label        string `json:"label"`
		PreimageHex  string `json:"preimageHex"`
		DigestHex    string `json:"digestHex"`
		PublicKeyHex string `json:"publicKeyHex"`
		SignatureHex string `json:"signatureHex"`
		Valid        bool   `json:"valid"`
	} `json:"messages"`
	Canonical []struct {
		Label   string          `json:"label"`
		Body    json.RawMessage `json:"body"`
		UTF8Hex string          `json:"utf8Hex"`
	} `json:"canonical"`
}

func checkProtocol() {
	input, err := io.ReadAll(io.LimitReader(os.Stdin, 8<<20))
	if err != nil || len(input) >= 8<<20 {
		fail("invalid vector input")
	}
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	var v vectors
	if err := decoder.Decode(&v); err != nil {
		fail("invalid vectors: %v", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		fail("trailing vector input")
	}
	if v.Schema != "hive-public-crypto-vectors/v1" {
		fail("unsupported vector schema")
	}
	if len(v.Amounts) < 5 || len(v.Messages) < 5 || len(v.Canonical) < 1 {
		fail("incomplete vector set")
	}
	for _, c := range v.Amounts {
		n, err := strconv.ParseUint(c.Decimal, 10, 64)
		if err != nil || strconv.FormatUint(n, 10) != c.Decimal || n == 0 {
			fail("%s: invalid decimal vector", c.Label)
		}
		encoded, err := arkade.BigNumFromUint64(n).FixedBytes(8)
		if (err == nil) != c.Fits {
			fail("%s: unexpected eight-byte encoding result", c.Label)
		}
		if c.Fits && hex.EncodeToString(encoded) != c.ExpectedHex {
			fail("%s: encoding differs from Emulator", c.Label)
		}
	}
	for _, c := range v.Canonical {
		decoder := json.NewDecoder(bytes.NewReader(c.Body))
		decoder.UseNumber()
		var body any
		if err := decoder.Decode(&body); err != nil {
			fail("%s: invalid body", c.Label)
		}
		var encoded bytes.Buffer
		encoder := json.NewEncoder(&encoded)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(body); err != nil {
			fail("%s: JSON encoding failed", c.Label)
		}
		// The quote profile has ASCII field names and string values; Go sorts
		// object keys lexically. One encoder newline is not part of the message.
		canonical := strings.TrimSuffix(encoded.String(), "\n")
		if hex.EncodeToString([]byte(canonical)) != c.UTF8Hex {
			fail("%s: independent canonical JSON mismatch", c.Label)
		}
	}
	for _, c := range v.Messages {
		preimage := protocolHex(c.PreimageHex)
		digest := sha256.Sum256(preimage)
		if hex.EncodeToString(digest[:]) != c.DigestHex {
			fail("%s: SHA-256 differs", c.Label)
		}
		signature, sigErr := schnorr.ParseSignature(protocolHex(c.SignatureHex))
		key, keyErr := schnorr.ParsePubKey(protocolHex(c.PublicKeyHex))
		valid := sigErr == nil && keyErr == nil && signature.Verify(digest[:], key)
		if valid != c.Valid {
			fail("%s: unexpected BIP340 verification result", c.Label)
		}
	}
	fmt.Printf("{\"status\":\"passed\",\"amountCases\":%d,\"canonicalCases\":%d,\"signatureCases\":%d}\n", len(v.Amounts), len(v.Canonical), len(v.Messages))
}
func protocolHex(value string) []byte {
	data, err := hex.DecodeString(value)
	if err != nil || hex.EncodeToString(data) != value {
		fail("invalid lowercase hex vector")
	}
	return data
}
func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "protocol-vectors: "+format+"\n", args...)
	os.Exit(1)
}
