//go:build js && wasm

// Command scriptorium-wasm is the browser core: it owns the parley session
// (pairing, crypto, reconnect) and, from M2, the doc service that relays
// opaque Yjs updates. It exposes exactly two functions to JavaScript —
// scriptorium_send(json) (UI→core) and scriptoriumOnEvent(json) (core→UI).
// JSON at the bridge; CBOR on the wire. JS owns the CRDT/editor/preview; this
// core never parses document content.
//
// Only file in the module allowed to import syscall/js.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"syscall/js"
	"time"

	qrcode "github.com/skip2/go-qrcode"

	"github.com/richardwooding/scriptorium/internal/proto"
	"github.com/richardwooding/parley/service"
	"github.com/richardwooding/parley/session"
)

type command struct {
	Type   string `json:"type"`
	Phrase string `json:"phrase,omitempty"`
	Name   string `json:"name,omitempty"`
	// doc-service fields (wired in M2)
	FileID  string `json:"fileID,omitempty"`
	Update  string `json:"update,omitempty"` // base64 opaque Yjs blob
	To      uint32 `json:"to,omitempty"`
	State   string `json:"state,omitempty"` // base64 catch-up state
}

type app struct {
	mu     sync.Mutex
	gen    int
	client *session.Client
	mux    *service.Mux
}

var current app

func main() {
	js.Global().Set("scriptorium_send", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) == 1 {
			go dispatch(args[0].String())
		}
		return nil
	}))
	emit("core.ready", map[string]any{})
	select {}
}

func emit(typ string, fields map[string]any) {
	fields["type"] = typ
	if b, err := json.Marshal(fields); err == nil {
		js.Global().Call("scriptoriumOnEvent", string(b))
	}
}
func emitError(msg string) { emit("error", map[string]any{"message": msg}) }

var commands = map[string]func(command){
	"create": func(c command) { create(c.Name) },
	"join":   func(c command) { join(c.Phrase, c.Name) },
	"leave":  func(command) { leave() },
}

func dispatch(raw string) {
	var cmd command
	if err := json.Unmarshal([]byte(raw), &cmd); err != nil {
		emitError("bad command: " + err.Error())
		return
	}
	if h, ok := commands[cmd.Type]; ok {
		h(cmd)
		return
	}
	emitError("unknown command " + cmd.Type)
}

func relayURL() string {
	loc := js.Global().Get("location")
	scheme := "ws"
	if loc.Get("protocol").String() == "https:" {
		scheme = "wss"
	}
	return scheme + "://" + loc.Get("host").String() + "/ws"
}
func shareURL(phrase string) string {
	loc := js.Global().Get("location")
	return loc.Get("protocol").String() + "//" + loc.Get("host").String() + "/#" + phrase
}

func create(name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, phrase, err := session.Host(ctx, relayURL(), proto.Options()...)
	if err != nil {
		emitError("couldn't start a workspace: " + err.Error())
		return
	}
	start(client, name)
	url := shareURL(phrase)
	qr := ""
	if png, e := qrcode.Encode(url, qrcode.Medium, 220); e == nil {
		qr = base64.StdEncoding.EncodeToString(png)
	}
	emit("session.created", map[string]any{"phrase": phrase, "url": url, "qr": qr, "self": uint32(client.Self())})
}

func join(phrase, name string) {
	phrase = strings.TrimSpace(phrase)
	if phrase == "" {
		emitError("enter a code phrase")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, err := session.Join(ctx, relayURL(), phrase, proto.Options()...)
	if err != nil {
		msg := "couldn't join: " + err.Error()
		switch {
		case strings.Contains(err.Error(), "not found"):
			msg = "no workspace with that phrase — check for typos"
		case strings.Contains(err.Error(), "unwrap"):
			msg = "wrong phrase"
		case strings.Contains(err.Error(), "full"):
			msg = "this workspace is full"
		}
		emitError(msg)
		return
	}
	start(client, name)
	emit("session.joined", map[string]any{"self": uint32(client.Self())})
}

func start(client *session.Client, name string) {
	mux := service.NewMux(client) // doc service added in M2
	if name = strings.TrimSpace(name); name != "" {
		mux.SetName(name)
	}
	mux.SetReconnectable()
	closePrev()
	current.mu.Lock()
	current.gen++
	myGen := current.gen
	current.client, current.mux = client, mux
	current.mu.Unlock()
	go pump(mux, myGen)
}

func closePrev() {
	current.mu.Lock()
	current.gen++
	client, mux := current.client, current.mux
	current.client, current.mux = nil, nil
	current.mu.Unlock()
	if client != nil {
		_ = client.Close()
	}
	if mux != nil {
		mux.Close()
	}
}

func leave() { closePrev() }

func isCurrent(gen int) bool {
	current.mu.Lock()
	defer current.mu.Unlock()
	return gen == current.gen
}

func pump(mux *service.Mux, gen int) {
	for ev := range mux.Events() {
		switch e := ev.(type) {
		case service.Roster:
			members := map[string]string{}
			var host uint32
			for id, role := range e.Members {
				members[jsUint(id)] = e.Names[id]
				if role == session.RoleHost {
					host = uint32(id)
				}
			}
			emit("roster", map[string]any{"members": members, "host": host})
		case service.Promoted:
			emit("session.promoted", map[string]any{"self": uint32(e.Self)})
		case service.ServiceError:
			emitError(e.Service + ": " + e.Err.Error())
		case service.SessionEvent:
			if closed, ok := e.Event.(session.Closed); ok {
				if !pumpClosed(mux, gen, closed.Reason) {
					return
				}
			}
		}
	}
}

func pumpClosed(mux *service.Mux, gen int, reason string) bool {
	if !isCurrent(gen) {
		return false
	}
	if reason == "connection lost" && reconnectNet(mux, gen) {
		return true
	}
	if isCurrent(gen) {
		emit("session.closed", map[string]any{"reason": reason})
	}
	return false
}

func reconnectNet(mux *service.Mux, gen int) bool {
	emit("session.reconnecting", map[string]any{})
	backoff := 500 * time.Millisecond
	for attempt := 0; attempt < 40; attempt++ {
		if !isCurrent(gen) {
			return false
		}
		current.mu.Lock()
		client := current.client
		current.mu.Unlock()
		if client == nil {
			return false
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := client.Reconnect(ctx)
		cancel()
		if err == nil {
			mux.Rebind(client)
			emit("session.resumed", map[string]any{})
			return true
		}
		time.Sleep(backoff)
		if backoff < 4*time.Second {
			backoff *= 2
		}
	}
	return false
}
