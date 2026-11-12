// Reference derivations from arkade-os/delegatee's own template package and the
// emulator's opcode table, for the tests that compare the TypeScript derivation.
//
//	go run . opcodes            the emulator's opcode names and values
//	go run . derive input.json  address and leaves of a template's first input
//	go run . spend input.json   the ark and checkpoint txs an offchain template builds
//	go run . protocol < crypto  the protocol vectors' crypto section (packages/protocol/vectors)
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/arkade-os/delegatee/pkg/template"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
)

type input struct {
	ServerKey   string                     `json:"serverKey"`
	EmulatorKey string                     `json:"emulatorKey"`
	DelegateKey string                     `json:"delegateKey"`
	Artifacts   map[string]json.RawMessage `json:"artifacts"`
	Template    json.RawMessage            `json:"template"`
	Variables   map[string]string          `json:"variables"`
}

func must[T any](v T, err error) T {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	return v
}

func key(s string) *btcec.PublicKey { return must(btcec.ParsePubKey(must(hex.DecodeString(s)))) }

func main() {
	switch os.Args[1] {
	case "opcodes":
		names := make([]string, 0, len(arkade.OpcodeByName))
		for name := range arkade.OpcodeByName {
			names = append(names, name)
		}
		sort.Strings(names)
		out := map[string]int{}
		for _, name := range names {
			out[name] = int(arkade.OpcodeByName[name])
		}
		must(0, json.NewEncoder(os.Stdout).Encode(out))
	case "derive":
		var in input
		must(0, json.Unmarshal(must(os.ReadFile(os.Args[2])), &in))
		ids := map[string]string{}
		docs := map[string][]byte{}
		doc := string(in.Template)
		for name, raw := range in.Artifacts {
			art := must(template.ParseArtifact(raw))
			ids[name] = art.ID
			docs[art.ID] = raw
			doc = strings.ReplaceAll(doc, "<artifact:"+name+">", art.ID)
		}
		resolve := func(_ context.Context, id string) ([]byte, error) {
			if raw, ok := docs[id]; ok {
				return raw, nil
			}
			return nil, fmt.Errorf("unknown artifact %s", id)
		}
		tmpl := must(template.Parse(context.Background(), []byte(doc), resolve))
		vars := map[string][]byte{}
		for k, v := range in.Variables {
			vars[k] = must(hex.DecodeString(v))
		}
		inst := must(tmpl.Instantiate(context.Background(), template.Context{
			Keys:      template.Keys{Server: key(in.ServerKey), Emulator: key(in.EmulatorKey), Delegate: key(in.DelegateKey)},
			Variables: vars,
		}))
		must(0, json.NewEncoder(os.Stdout).Encode(map[string]any{
			"artifactIds": ids,
			"templateId":  tmpl.ID(),
			"pkScript":    hex.EncodeToString(inst.PkScript(0)),
			"tapscripts":  inst.Tapscripts(0),
		}))
	case "spend":
		spend(os.Args[2])
	case "protocol":
		checkProtocol()
	default:
		fmt.Fprintln(os.Stderr, "usage: delegatee-ref opcodes | derive <input.json> | spend <input.json> | protocol")
		os.Exit(2)
	}
}
