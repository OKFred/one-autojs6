package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

const (
	recordConfigure         byte = 0x01
	recordRemoteDescription byte = 0x02
	recordICECandidate      byte = 0x03
	recordBinaryInput       byte = 0x04
	recordClose             byte = 0x05

	recordLocalDescription byte = 0x81
	recordLocalCandidate   byte = 0x82
	recordState            byte = 0x83
	recordBinaryOutput     byte = 0x84

	maxIPCPayloadBytes = 4*1024*1024 + 64*1024
)

type ipcRecord struct {
	typ     byte
	payload []byte
}

type recordWriter struct {
	mu     sync.Mutex
	output io.Writer
}

func readRecord(input io.Reader) (ipcRecord, error) {
	var header [4]byte
	if _, err := io.ReadFull(input, header[:]); err != nil {
		return ipcRecord{}, err
	}
	recordBytes := binary.BigEndian.Uint32(header[:])
	if recordBytes < 1 || recordBytes > maxIPCPayloadBytes+1 {
		return ipcRecord{}, errors.New("invalid IPC record length")
	}
	content := make([]byte, recordBytes)
	if _, err := io.ReadFull(input, content); err != nil {
		return ipcRecord{}, err
	}
	return ipcRecord{typ: content[0], payload: content[1:]}, nil
}

func (writer *recordWriter) write(typ byte, payload []byte) error {
	if len(payload) > maxIPCPayloadBytes {
		return errors.New("IPC payload exceeds limit")
	}
	writer.mu.Lock()
	defer writer.mu.Unlock()
	var header [5]byte
	binary.BigEndian.PutUint32(header[:4], uint32(len(payload)+1))
	header[4] = typ
	written, err := writer.output.Write(header[:])
	if err != nil {
		return fmt.Errorf("write IPC header: %w", err)
	}
	if written != len(header) {
		return io.ErrShortWrite
	}
	written, err = writer.output.Write(payload)
	if err != nil {
		return fmt.Errorf("write IPC payload: %w", err)
	}
	if written != len(payload) {
		return io.ErrShortWrite
	}
	return nil
}

func (writer *recordWriter) writeJSON(typ byte, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode IPC JSON: %w", err)
	}
	return writer.write(typ, payload)
}
