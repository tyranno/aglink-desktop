package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestControlServiceConnectReadsLargeHistoryReplies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")

		data, err := json.Marshal(map[string]string{
			"history": strings.Repeat("x", 64*1024),
		})
		if err != nil {
			t.Errorf("marshal large reply: %v", err)
			return
		}

		writeCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := wsjson.Write(writeCtx, conn, controlOut{
			Kind:  "reply",
			ReqID: "r-large",
			Data:  data,
		}); err != nil {
			t.Errorf("write large reply: %v", err)
			return
		}

		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	defer server.Close()

	service := &ControlService{
		addr:    strings.TrimPrefix(server.URL, "http://"),
		pending: map[string]chan json.RawMessage{},
	}
	replyCh := make(chan json.RawMessage, 1)
	service.pending["r-large"] = replyCh

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		errCh <- service.connectOnce(ctx)
	}()

	select {
	case data := <-replyCh:
		if len(data) < 64*1024 {
			t.Fatalf("delivered reply was truncated: %d bytes", len(data))
		}
	case err := <-errCh:
		t.Fatalf("connectOnce returned before delivering large reply: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for large reply delivery")
	}
}

func TestUploadAttachmentControlInIncludesTarget(t *testing.T) {
	msg := uploadAttachmentControlIn(`C:\tmp\a.png`, "설명", "web", "conv-7")
	if msg.Type != "upload_attachment" {
		t.Fatalf("type = %q, want upload_attachment", msg.Type)
	}
	if msg.Path != `C:\tmp\a.png` || msg.Caption != "설명" {
		t.Fatalf("path/caption = %q/%q", msg.Path, msg.Caption)
	}
	var target map[string]string
	if err := json.Unmarshal(msg.Target, &target); err != nil {
		t.Fatalf("target json: %v", err)
	}
	if target["kind"] != "web" || target["id"] != "conv-7" {
		t.Fatalf("target = %#v, want web conv-7", target)
	}
}
