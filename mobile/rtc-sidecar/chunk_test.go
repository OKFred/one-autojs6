package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type manualChunkTimer struct {
	mu       sync.Mutex
	callback func()
	stopped  bool
}

func (timer *manualChunkTimer) Stop() bool {
	timer.mu.Lock()
	defer timer.mu.Unlock()
	wasRunning := !timer.stopped
	timer.stopped = true
	return wasRunning
}

func (timer *manualChunkTimer) fire() {
	timer.callback()
}

func (timer *manualChunkTimer) isStopped() bool {
	timer.mu.Lock()
	defer timer.mu.Unlock()
	return timer.stopped
}

func TestChunkHeaderAndFourMiBRoundTrip(t *testing.T) {
	content := make([]byte, maxDeviceMessageBytes)
	for index := range content {
		content[index] = byte(index % 251)
	}
	var sender chunker
	chunks, err := sender.split(content, chunkPayloadMaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) < 2 {
		t.Fatal("expected a fragmented message")
	}
	first := chunks[0]
	if binary.BigEndian.Uint32(first[0:4]) != chunkMagic ||
		first[4] != chunkVersion ||
		first[5] != chunkFlagStart ||
		binary.BigEndian.Uint16(first[6:8]) != 0 ||
		binary.BigEndian.Uint32(first[12:16]) != maxDeviceMessageBytes ||
		binary.BigEndian.Uint32(first[16:20]) != 0 ||
		len(first) != chunkHeaderBytes+chunkPayloadMaxBytes {
		t.Fatalf("unexpected first chunk header: %x", first[:chunkHeaderBytes])
	}
	const expectedFirstHeader = "4136444301010000000000000040000000000000"
	if actual := fmt.Sprintf("%x", first[:chunkHeaderBytes]); actual != expectedFirstHeader {
		t.Fatalf("browser interop header mismatch: got %s want %s", actual, expectedFirstHeader)
	}
	if binary.BigEndian.Uint32(first[8:12]) != 0 {
		t.Fatalf("first message ID must be zero: %d", binary.BigEndian.Uint32(first[8:12]))
	}
	last := chunks[len(chunks)-1]
	if last[5] != chunkFlagEnd {
		t.Fatalf("unexpected final chunk flags: %d", last[5])
	}
	assembler := newChunkAssembler(maxDeviceMessageBytes, nil)
	var complete []byte
	for _, chunk := range chunks {
		complete, err = assembler.push(chunk)
		if err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(complete, content) {
		t.Fatal("reassembled content differs from original")
	}
	secondMessage, err := sender.split([]byte{0x7f}, chunkPayloadMaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	if binary.BigEndian.Uint32(secondMessage[0][8:12]) != 1 {
		t.Fatal("second message ID must increment to one")
	}
	complete, err = assembler.push(secondMessage[0])
	if err != nil || !bytes.Equal(complete, []byte{0x7f}) {
		t.Fatalf("second message failed strict sequence: %x %v", complete, err)
	}
	invalidFirst := bytes.Clone(secondMessage[0])
	binary.BigEndian.PutUint32(invalidFirst[8:12], 7)
	if _, err := newChunkAssembler(maxDeviceMessageBytes, nil).push(invalidFirst); err == nil {
		t.Fatal("first inbound message ID other than zero must be rejected")
	}
}

func TestChunkAssemblerRejectsOutOfOrderAndTimesOut(t *testing.T) {
	var sender chunker
	chunks, err := sender.split(
		bytes.Repeat([]byte{0x42}, chunkPayloadMaxBytes+1),
		chunkPayloadMaxBytes,
	)
	if err != nil {
		t.Fatal(err)
	}
	assembler := newChunkAssembler(maxBrowserMessageBytes, nil)
	clock := time.Unix(1, 0)
	assembler.now = func() time.Time { return clock }
	if _, err := assembler.push(chunks[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := assembler.push(chunks[0]); err == nil {
		t.Fatal("expected a duplicate start chunk to be rejected")
	}
	assembler.close()
	assembler = newChunkAssembler(maxBrowserMessageBytes, nil)
	assembler.now = func() time.Time { return clock }
	if _, err := assembler.push(chunks[0]); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(chunkAssemblyTimeout + time.Millisecond)
	if _, err := assembler.push(chunks[1]); err == nil {
		t.Fatal("expected an expired reassembly to be rejected")
	}
}

func TestChunkAssemblerTimeoutFiresWithoutAnotherChunk(t *testing.T) {
	var sender chunker
	chunks, err := sender.split(
		bytes.Repeat([]byte{0x31}, chunkPayloadMaxBytes+1),
		chunkPayloadMaxBytes,
	)
	if err != nil {
		t.Fatal(err)
	}
	timedOut := make(chan struct{}, 1)
	assembler := newChunkAssembler(maxBrowserMessageBytes, func() {
		timedOut <- struct{}{}
	})
	var timer *manualChunkTimer
	assembler.afterFunc = func(delay time.Duration, callback func()) chunkTimer {
		if delay != chunkAssemblyTimeout {
			t.Fatalf("unexpected timeout: %s", delay)
		}
		timer = &manualChunkTimer{callback: callback}
		return timer
	}
	if _, err := assembler.push(chunks[0]); err != nil {
		t.Fatal(err)
	}
	if timer == nil {
		t.Fatal("expected active reassembly timer")
	}
	timer.fire()
	select {
	case <-timedOut:
	default:
		t.Fatal("expected timeout callback without another chunk")
	}
	assembler.mu.Lock()
	active := assembler.active
	assembler.mu.Unlock()
	if active != nil {
		t.Fatal("timed-out assembly must be discarded")
	}
}

func TestChunkAssemblerCancelsStaleTimeoutOnCompletionAndClose(t *testing.T) {
	var sender chunker
	chunks, err := sender.split(
		bytes.Repeat([]byte{0x53}, chunkPayloadMaxBytes+1),
		chunkPayloadMaxBytes,
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, testCase := range []struct {
		name   string
		finish func(*chunkAssembler, [][]byte) error
	}{
		{
			name: "completion",
			finish: func(assembler *chunkAssembler, chunks [][]byte) error {
				_, err := assembler.push(chunks[1])
				return err
			},
		},
		{
			name: "close",
			finish: func(assembler *chunkAssembler, _ [][]byte) error {
				assembler.close()
				return nil
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			var timeoutCount atomic.Int32
			assembler := newChunkAssembler(maxBrowserMessageBytes, func() {
				timeoutCount.Add(1)
			})
			var timer *manualChunkTimer
			assembler.afterFunc = func(_ time.Duration, callback func()) chunkTimer {
				timer = &manualChunkTimer{callback: callback}
				return timer
			}
			if _, err := assembler.push(chunks[0]); err != nil {
				t.Fatal(err)
			}
			if err := testCase.finish(assembler, chunks); err != nil {
				t.Fatal(err)
			}
			if timer == nil || !timer.isStopped() {
				t.Fatal("expected timeout timer to be stopped")
			}
			timer.fire()
			if actual := timeoutCount.Load(); actual != 0 {
				t.Fatalf("stale timer fired timeout callback %d times", actual)
			}
			assembler.close()
		})
	}
}

func TestChunkAssemblerEnforcesBrowserFrameLimit(t *testing.T) {
	var sender chunker
	chunks, err := sender.split(
		bytes.Repeat([]byte{0x23}, maxBrowserMessageBytes+1),
		chunkPayloadMaxBytes,
	)
	if err != nil {
		t.Fatal(err)
	}
	assembler := newChunkAssembler(maxBrowserMessageBytes, nil)
	if _, err := assembler.push(chunks[0]); err == nil {
		t.Fatal("expected oversized browser message to be rejected")
	}
}

func TestChunkerHonorsNegotiatedMessageLimit(t *testing.T) {
	var sender chunker
	chunks, err := sender.split(bytes.Repeat([]byte{0x51}, 201), 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) != 3 {
		t.Fatalf("unexpected chunk count: %d", len(chunks))
	}
	for _, chunk := range chunks {
		if len(chunk) > chunkHeaderBytes+100 {
			t.Fatalf("chunk exceeds negotiated record size: %d", len(chunk))
		}
	}
}

func TestChunkMessageIDExhaustionDoesNotWrap(t *testing.T) {
	sender := chunker{nextMessageID: maxChunkMessageID}
	lastMessage, err := sender.split([]byte{0x7a}, chunkPayloadMaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	if actual := binary.BigEndian.Uint32(lastMessage[0][8:12]); actual != maxChunkMessageID {
		t.Fatalf("unexpected final message ID: %d", actual)
	}
	if !sender.exhausted || sender.nextMessageID != maxChunkMessageID {
		t.Fatal("sender must enter a non-wrapping exhausted state")
	}
	if _, err := sender.split([]byte{0x7b}, chunkPayloadMaxBytes); err == nil {
		t.Fatal("sender must reject a message after ID exhaustion")
	}

	assembler := newChunkAssembler(maxBrowserMessageBytes, nil)
	defer assembler.close()
	assembler.hasLastMessage = true
	assembler.lastMessageID = maxChunkMessageID - 1
	complete, err := assembler.push(lastMessage[0])
	if err != nil || !bytes.Equal(complete, []byte{0x7a}) {
		t.Fatalf("receiver rejected final message ID: %x %v", complete, err)
	}
	wrapped := bytes.Clone(lastMessage[0])
	binary.BigEndian.PutUint32(wrapped[8:12], 0)
	wrapped[chunkHeaderBytes] = 0x7b
	if _, err := assembler.push(wrapped); err == nil {
		t.Fatal("receiver must reject a wrapped message ID after exhaustion")
	}
}
