package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"time"

	"github.com/arkade-os/arkd/pkg/ark-lib/offchain"
	"github.com/arkade-os/arkd/pkg/ark-lib/txutils"
	"github.com/arkade-os/delegatee/pkg/template"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
	"github.com/btcsuite/btcwallet/waddrmgr"
)

// spendInput is a derive input plus the coins an offchain template spends and
// the Operator's checkpoint tapscript.
type spendInput struct {
	input
	CheckpointTapscript string `json:"checkpointTapscript"`
	Dust                uint64 `json:"dust"`
	Sources             []struct {
		Txid   string `json:"txid"`
		Vout   uint32 `json:"vout"`
		Amount uint64 `json:"amount"`
		// The transaction that created the coin, hex; it pays the contract at vout.
		Tx     string `json:"tx"`
		Expiry int64  `json:"expiry"`
	} `json:"sources"`
}

func hexTx(tx *wire.MsgTx) string {
	var b bytes.Buffer
	must(0, tx.Serialize(&b))
	return hex.EncodeToString(b.Bytes())
}

// spend builds what the delegatee submits for an offchain template: the
// template's transaction, then the ark transaction and its checkpoints.
func spend(path string) {
	var in spendInput
	must(0, json.Unmarshal(must(os.ReadFile(path)), &in))
	docs := map[string][]byte{}
	doc := string(in.Template)
	for name, raw := range in.Artifacts {
		art := must(template.ParseArtifact(raw))
		docs[art.ID] = raw
		doc = strings.ReplaceAll(doc, "<artifact:"+name+">", art.ID)
	}
	resolve := func(_ context.Context, id string) ([]byte, error) { return docs[id], nil }
	tmpl := must(template.Parse(context.Background(), []byte(doc), resolve))
	vars := map[string][]byte{}
	for k, v := range in.Variables {
		vars[k] = must(hex.DecodeString(v))
	}
	sources := make([]*template.Source, len(in.Sources))
	for i, s := range in.Sources {
		hash := must(chainhash.NewHashFromStr(s.Txid))
		tx := wire.NewMsgTx(3)
		must(0, tx.Deserialize(bytes.NewReader(must(hex.DecodeString(s.Tx)))))
		sources[i] = &template.Source{
			Outpoint: wire.OutPoint{Hash: *hash, Index: s.Vout}, Tx: tx, Amount: s.Amount,
			Expiry: time.Unix(s.Expiry, 0), CreatedAt: time.Unix(s.Expiry-4096, 0),
		}
	}
	inst := must(tmpl.Instantiate(context.Background(), template.Context{
		Keys:      template.Keys{Server: key(in.ServerKey), Emulator: key(in.EmulatorKey), Delegate: key(in.DelegateKey)},
		Variables: vars,
		Sources:   sources,
	}))
	act := must(inst.Build(context.Background(), sources, template.Fee{Dust: in.Dust}))
	logical := act.Tx
	ins := make([]offchain.VtxoInput, len(sources))
	for i, s := range sources {
		leaf := logical.Inputs[i].TaprootLeafScript[0]
		ctrl := must(txscript.ParseControlBlock(leaf.ControlBlock))
		ins[i] = offchain.VtxoInput{
			Outpoint: &s.Outpoint, Amount: int64(s.Amount),
			Tapscript:          &waddrmgr.Tapscript{ControlBlock: ctrl, RevealedScript: leaf.Script},
			RevealedTapscripts: inst.Tapscripts(i),
		}
	}
	unroll := must(hex.DecodeString(in.CheckpointTapscript))
	ark, checkpoints := must2(offchain.BuildTxs(ins, logical.UnsignedTx.TxOut, unroll))
	conditions := make([][]string, len(sources))
	leaves := make([]string, len(sources))
	for i := range sources {
		leaves[i] = hex.EncodeToString(logical.Inputs[i].TaprootLeafScript[0].Script)
		w := must(txutils.GetArkPsbtConditionWitness(logical, i))
		for _, item := range w {
			conditions[i] = append(conditions[i], hex.EncodeToString(item))
		}
	}
	cps := make([]map[string]string, len(checkpoints))
	for i, cp := range checkpoints {
		cps[i] = map[string]string{"txid": cp.UnsignedTx.TxHash().String(), "tx": hexTx(cp.UnsignedTx)}
	}
	outputs := make([]map[string]any, len(logical.UnsignedTx.TxOut))
	for i, o := range logical.UnsignedTx.TxOut {
		outputs[i] = map[string]any{"script": hex.EncodeToString(o.PkScript), "amount": o.Value}
	}
	must(0, json.NewEncoder(os.Stdout).Encode(map[string]any{
		"templateId":  tmpl.ID(),
		"leaves":      leaves,
		"conditions":  conditions,
		"outputs":     outputs,
		"extension":   act.Extension,
		"locktime":    logical.UnsignedTx.LockTime,
		"arkTxid":     ark.UnsignedTx.TxHash().String(),
		"arkTx":       hexTx(ark.UnsignedTx),
		"checkpoints": cps,
	}))
}

func must2[A, B any](a A, b B, err error) (A, B) {
	must(0, err)
	return a, b
}
