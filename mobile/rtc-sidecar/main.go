package main

import (
	"errors"
	"io"
	"os"
)

type recordReadResult struct {
	record ipcRecord
	err    error
}

func run(input io.Reader, output io.Writer) error {
	peer := newRTCPeer(output)
	defer peer.close()
	readResults := make(chan recordReadResult, 1)
	stopReading := make(chan struct{})
	defer close(stopReading)
	go func() {
		for {
			record, err := readRecord(input)
			select {
			case readResults <- recordReadResult{record: record, err: err}:
			case <-stopReading:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	for {
		select {
		case fatalErr := <-peer.fatalErrors:
			return fatalErr
		case result := <-readResults:
			if result.err != nil {
				select {
				case fatalErr := <-peer.fatalErrors:
					return fatalErr
				default:
				}
				if errors.Is(result.err, io.EOF) {
					return nil
				}
				peer.fail("RTC_IPC_READ_FAILED")
				select {
				case fatalErr := <-peer.fatalErrors:
					return fatalErr
				default:
				}
				return result.err
			}
			closed, err := peer.handle(result.record)
			if err != nil {
				select {
				case fatalErr := <-peer.fatalErrors:
					return fatalErr
				default:
				}
				peer.fail("RTC_COMMAND_FAILED")
				select {
				case fatalErr := <-peer.fatalErrors:
					return fatalErr
				default:
				}
				return err
			}
			if closed {
				return nil
			}
		}
	}
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		os.Exit(1)
	}
}
