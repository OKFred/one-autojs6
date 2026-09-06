package main

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

var errTestOutput = errors.New("test output failure")

type failFirstOutput struct {
	mu     sync.Mutex
	calls  int
	buffer bytes.Buffer
}

func (output *failFirstOutput) Write(content []byte) (int, error) {
	output.mu.Lock()
	defer output.mu.Unlock()
	output.calls++
	if output.calls == 1 {
		return 0, errTestOutput
	}
	return output.buffer.Write(content)
}

func (output *failFirstOutput) bytes() []byte {
	output.mu.Lock()
	defer output.mu.Unlock()
	return bytes.Clone(output.buffer.Bytes())
}

type alwaysFailOutput struct{}

func (alwaysFailOutput) Write([]byte) (int, error) {
	return 0, errTestOutput
}

func TestCandidateOutputFailureClosesPeerAndReportsFailure(t *testing.T) {
	output := &failFirstOutput{}
	peer := newRTCPeer(output)
	peer.onICECandidate(&webrtc.ICECandidate{
		Foundation: "1",
		Priority:   1,
		Address:    "192.0.2.1",
		Protocol:   webrtc.ICEProtocolUDP,
		Port:       3478,
		Typ:        webrtc.ICECandidateTypeHost,
		Component:  1,
	})
	select {
	case fatalErr := <-peer.fatalErrors:
		if !errors.Is(fatalErr, errTestOutput) || !strings.Contains(fatalErr.Error(), "0x82") {
			t.Fatalf("unexpected propagated output error: %v", fatalErr)
		}
	case <-time.After(time.Second):
		t.Fatal("candidate output error was not propagated")
	}
	peer.mu.Lock()
	closed := peer.closed
	peer.mu.Unlock()
	if !closed {
		t.Fatal("candidate output error must close the peer")
	}
	record, err := readRecord(bytes.NewReader(output.bytes()))
	if err != nil {
		t.Fatalf("read best-effort failure state: %v", err)
	}
	if record.typ != recordState {
		t.Fatalf("unexpected best-effort record type: 0x%02x", record.typ)
	}
	var state stateRecord
	if err := decodeStrict(record.payload, &state); err != nil {
		t.Fatalf("decode best-effort failure state: %v", err)
	}
	if state.State != "failed" || state.ReasonCode != "RTC_IPC_WRITE_FAILED" {
		t.Fatalf("unexpected best-effort failure state: %#v", state)
	}
}

func TestReassemblyTimerEmitsTimeoutState(t *testing.T) {
	var output bytes.Buffer
	peer := newRTCPeer(&output)
	var timer *manualChunkTimer
	peer.assembler.afterFunc = func(_ time.Duration, callback func()) chunkTimer {
		timer = &manualChunkTimer{callback: callback}
		return timer
	}
	var sender chunker
	chunks, err := sender.split(
		bytes.Repeat([]byte{0x61}, chunkPayloadMaxBytes+1),
		chunkPayloadMaxBytes,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := peer.assembler.push(chunks[0]); err != nil {
		t.Fatal(err)
	}
	if timer == nil {
		t.Fatal("expected active reassembly timer")
	}
	timer.fire()
	record, err := readRecord(bytes.NewReader(output.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if record.typ != recordState {
		t.Fatalf("unexpected record type: 0x%02x", record.typ)
	}
	var state stateRecord
	if err := decodeStrict(record.payload, &state); err != nil {
		t.Fatal(err)
	}
	if state.State != "failed" || state.ReasonCode != "RTC_CHUNK_TIMEOUT" {
		t.Fatalf("unexpected timeout state: %#v", state)
	}
	if err := peer.close(); err != nil {
		t.Fatal(err)
	}
}

func TestRunPropagatesStateOutputFailure(t *testing.T) {
	var input bytes.Buffer
	inputWriter := recordWriter{output: &input}
	if err := inputWriter.write(0xff, nil); err != nil {
		t.Fatal(err)
	}
	err := run(bytes.NewReader(input.Bytes()), alwaysFailOutput{})
	if err == nil || !errors.Is(err, errTestOutput) {
		t.Fatalf("expected output failure from run, got %v", err)
	}
	if !strings.Contains(err.Error(), "0x83") {
		t.Fatalf("expected state record context, got %v", err)
	}
}

func TestRecordWriterRejectsShortOutput(t *testing.T) {
	writer := recordWriter{output: io.Discard}
	writer.output = shortWriter{}
	if err := writer.write(recordBinaryOutput, []byte{0x01}); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("expected short-write error, got %v", err)
	}
}

type shortWriter struct{}

func (shortWriter) Write(content []byte) (int, error) {
	if len(content) == 0 {
		return 0, nil
	}
	return len(content) - 1, nil
}
