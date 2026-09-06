package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"sync"
	"time"
)

const (
	chunkMagic           uint32 = 0x41364443
	chunkVersion         byte   = 1
	chunkFlagStart       byte   = 1
	chunkFlagEnd         byte   = 2
	chunkHeaderBytes            = 20
	chunkPayloadMaxBytes        = 12 * 1024
	chunkAssemblyTimeout        = 5 * time.Second
	maxChunkMessageID    uint32 = 1<<32 - 1
)

type chunker struct {
	nextMessageID uint32
	exhausted     bool
}

type chunkAssembly struct {
	messageID uint32
	total     uint32
	next      uint32
	startedAt time.Time
	content   []byte
}

type chunkTimer interface {
	Stop() bool
}

type chunkAssembler struct {
	mu              sync.Mutex
	maxMessageBytes uint32
	now             func() time.Time
	afterFunc       func(time.Duration, func()) chunkTimer
	timeout         time.Duration
	onTimeout       func()
	active          *chunkAssembly
	lastMessageID   uint32
	hasLastMessage  bool
	timer           chunkTimer
	timerGeneration uint64
	closed          bool
}

func newChunkAssembler(maxMessageBytes uint32, onTimeout func()) *chunkAssembler {
	return &chunkAssembler{
		maxMessageBytes: maxMessageBytes,
		now:             time.Now,
		afterFunc: func(delay time.Duration, callback func()) chunkTimer {
			return time.AfterFunc(delay, callback)
		},
		timeout:   chunkAssemblyTimeout,
		onTimeout: onTimeout,
	}
}

func (sender *chunker) split(content []byte, payloadMaxBytes int) ([][]byte, error) {
	if len(content) == 0 {
		return nil, errors.New("empty data-channel messages are not supported")
	}
	if payloadMaxBytes < 1 || payloadMaxBytes > chunkPayloadMaxBytes {
		return nil, errors.New("invalid data-channel chunk payload limit")
	}
	if uint64(len(content)) > uint64(^uint32(0)) {
		return nil, errors.New("data-channel message exceeds framing limit")
	}
	if sender.exhausted {
		return nil, errors.New("data-channel message ID space is exhausted")
	}
	messageID := sender.nextMessageID
	if messageID == maxChunkMessageID {
		sender.exhausted = true
	} else {
		sender.nextMessageID++
	}
	result := make([][]byte, 0, (len(content)+payloadMaxBytes-1)/payloadMaxBytes)
	for offset := 0; offset < len(content); offset += payloadMaxBytes {
		end := offset + payloadMaxBytes
		if end > len(content) {
			end = len(content)
		}
		flags := byte(0)
		if offset == 0 {
			flags |= chunkFlagStart
		}
		if end == len(content) {
			flags |= chunkFlagEnd
		}
		chunk := make([]byte, chunkHeaderBytes+end-offset)
		binary.BigEndian.PutUint32(chunk[0:4], chunkMagic)
		chunk[4] = chunkVersion
		chunk[5] = flags
		binary.BigEndian.PutUint16(chunk[6:8], 0)
		binary.BigEndian.PutUint32(chunk[8:12], messageID)
		binary.BigEndian.PutUint32(chunk[12:16], uint32(len(content)))
		binary.BigEndian.PutUint32(chunk[16:20], uint32(offset))
		copy(chunk[chunkHeaderBytes:], content[offset:end])
		result = append(result, chunk)
	}
	return result, nil
}

func (assembler *chunkAssembler) push(chunk []byte) ([]byte, error) {
	assembler.mu.Lock()
	defer assembler.mu.Unlock()
	if assembler.closed {
		return nil, errors.New("data-channel reassembler is closed")
	}
	if len(chunk) < chunkHeaderBytes || len(chunk) > chunkHeaderBytes+chunkPayloadMaxBytes {
		return nil, errors.New("invalid data-channel chunk length")
	}
	if binary.BigEndian.Uint32(chunk[0:4]) != chunkMagic || chunk[4] != chunkVersion {
		return nil, errors.New("invalid data-channel chunk signature")
	}
	flags := chunk[5]
	if flags & ^byte(chunkFlagStart|chunkFlagEnd) != 0 || binary.BigEndian.Uint16(chunk[6:8]) != 0 {
		return nil, errors.New("invalid data-channel chunk flags")
	}
	messageID := binary.BigEndian.Uint32(chunk[8:12])
	total := binary.BigEndian.Uint32(chunk[12:16])
	offset := binary.BigEndian.Uint32(chunk[16:20])
	payload := chunk[chunkHeaderBytes:]
	if total == 0 || total > assembler.maxMessageBytes || len(payload) == 0 {
		return nil, errors.New("invalid data-channel message bounds")
	}
	if uint64(offset)+uint64(len(payload)) > uint64(total) {
		return nil, errors.New("data-channel chunk exceeds declared message")
	}
	now := assembler.now()
	if assembler.active != nil && now.Sub(assembler.active.startedAt) >= assembler.timeout {
		assembler.active = nil
		assembler.cancelTimerLocked()
		return nil, errors.New("data-channel reassembly timed out")
	}
	if flags&chunkFlagStart != 0 {
		expectedMessageID := uint32(0)
		if assembler.hasLastMessage {
			if assembler.lastMessageID == maxChunkMessageID {
				return nil, errors.New("data-channel message ID space is exhausted")
			}
			expectedMessageID = assembler.lastMessageID + 1
		}
		if offset != 0 ||
			assembler.active != nil ||
			messageID != expectedMessageID {
			return nil, errors.New("invalid data-channel message start")
		}
		assembler.active = &chunkAssembly{
			messageID: messageID,
			total:     total,
			startedAt: now,
			content:   make([]byte, total),
		}
		assembler.startTimerLocked()
	}
	active := assembler.active
	if active == nil || active.messageID != messageID || active.total != total || active.next != offset {
		return nil, errors.New("out-of-order data-channel chunk")
	}
	copy(active.content[offset:], payload)
	active.next += uint32(len(payload))
	if flags&chunkFlagEnd == 0 {
		if active.next == active.total {
			return nil, errors.New("final data-channel chunk flag is missing")
		}
		return nil, nil
	}
	if active.next != active.total {
		return nil, fmt.Errorf("incomplete data-channel message: %d of %d", active.next, active.total)
	}
	content := active.content
	assembler.lastMessageID = active.messageID
	assembler.hasLastMessage = true
	assembler.active = nil
	assembler.cancelTimerLocked()
	return content, nil
}

func (assembler *chunkAssembler) startTimerLocked() {
	assembler.cancelTimerLocked()
	assembler.timerGeneration++
	generation := assembler.timerGeneration
	assembler.timer = assembler.afterFunc(assembler.timeout, func() {
		assembler.mu.Lock()
		if assembler.closed || assembler.active == nil || generation != assembler.timerGeneration {
			assembler.mu.Unlock()
			return
		}
		assembler.active = nil
		assembler.timer = nil
		assembler.timerGeneration++
		onTimeout := assembler.onTimeout
		assembler.mu.Unlock()
		if onTimeout != nil {
			onTimeout()
		}
	})
}

func (assembler *chunkAssembler) cancelTimerLocked() {
	if assembler.timer != nil {
		assembler.timer.Stop()
		assembler.timer = nil
	}
	assembler.timerGeneration++
}

func (assembler *chunkAssembler) close() {
	assembler.mu.Lock()
	defer assembler.mu.Unlock()
	if assembler.closed {
		return
	}
	assembler.closed = true
	assembler.active = nil
	assembler.cancelTimerLocked()
}
