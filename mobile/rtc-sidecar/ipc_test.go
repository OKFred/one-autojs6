package main

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestRecordGoldenEncoding(t *testing.T) {
	var output bytes.Buffer
	writer := recordWriter{output: &output}
	if err := writer.write(recordBinaryInput, []byte{0xaa, 0xbb}); err != nil {
		t.Fatal(err)
	}
	const expected = "0000000304aabb"
	if actual := hex.EncodeToString(output.Bytes()); actual != expected {
		t.Fatalf("unexpected IPC encoding: got %s want %s", actual, expected)
	}
	record, err := readRecord(bytes.NewReader(output.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if record.typ != recordBinaryInput || !bytes.Equal(record.payload, []byte{0xaa, 0xbb}) {
		t.Fatalf("unexpected decoded record: %#v", record)
	}
}

func TestRecordRejectsInvalidLengths(t *testing.T) {
	for _, value := range []string{"00000000", "00420002"} {
		content, err := hex.DecodeString(value)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := readRecord(bytes.NewReader(content)); err == nil {
			t.Fatalf("expected invalid length %s to be rejected", value)
		}
	}
}
