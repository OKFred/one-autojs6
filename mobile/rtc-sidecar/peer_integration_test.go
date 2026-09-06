package main

import (
	"bytes"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

const integrationTimeout = 15 * time.Second

type integrationCandidateEvent struct {
	candidate *webrtc.ICECandidateInit
	done      bool
}

type integrationBinaryResult struct {
	payload    []byte
	chunkSizes []int
}

func TestRTCPeerInteroperatesWithPionController(t *testing.T) {
	var settings webrtc.SettingEngine
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetSCTPMaxMessageSize(4096)
	controller, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create controller PeerConnection: %v", err)
	}

	sidecarInputReader, sidecarInputWriter := io.Pipe()
	sidecarOutputReader, sidecarOutputWriter := io.Pipe()
	t.Cleanup(func() {
		_ = controller.Close()
		_ = sidecarInputWriter.Close()
		_ = sidecarInputReader.Close()
		_ = sidecarOutputWriter.Close()
		_ = sidecarOutputReader.Close()
	})

	runDone := make(chan error, 1)
	go func() {
		runDone <- run(sidecarInputReader, sidecarOutputWriter)
	}()

	input := &recordWriter{output: sidecarInputWriter}
	if err := input.writeJSON(recordConfigure, configureRecord{
		ICEServers: []iceServerConfig{{URLs: stringList{"stun:127.0.0.1:9"}}},
	}); err != nil {
		t.Fatalf("configure sidecar: %v", err)
	}

	ordered := true
	protocol := dataChannelProtocol
	channel, err := controller.CreateDataChannel(dataChannelLabel, &webrtc.DataChannelInit{
		Ordered:  &ordered,
		Protocol: &protocol,
	})
	if err != nil {
		t.Fatalf("create controller DataChannel: %v", err)
	}
	if channel.Label() != dataChannelLabel || channel.Protocol() != dataChannelProtocol {
		t.Fatalf("unexpected controller DataChannel identity: %q/%q", channel.Label(), channel.Protocol())
	}

	channelOpen := make(chan struct{})
	var channelOpenOnce sync.Once
	channel.OnOpen(func() {
		channelOpenOnce.Do(func() { close(channelOpen) })
	})
	channelErrors := make(chan error, 1)
	channel.OnError(func(channelErr error) {
		select {
		case channelErrors <- channelErr:
		default:
		}
	})

	deviceMessages := make(chan integrationBinaryResult, 1)
	deviceAssembler := newChunkAssembler(maxDeviceMessageBytes, func() {
		select {
		case channelErrors <- errors.New("controller reassembly timed out"):
		default:
		}
	})
	defer deviceAssembler.close()
	var deviceChunkSizes []int
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		if message.IsString {
			select {
			case channelErrors <- errors.New("sidecar sent a text DataChannel message"):
			default:
			}
			return
		}
		deviceChunkSizes = append(deviceChunkSizes, len(message.Data))
		payload, pushErr := deviceAssembler.push(message.Data)
		if pushErr != nil {
			select {
			case channelErrors <- pushErr:
			default:
			}
			return
		}
		if payload != nil {
			deviceMessages <- integrationBinaryResult{
				payload:    payload,
				chunkSizes: append([]int(nil), deviceChunkSizes...),
			}
		}
	})

	offerCandidates := make(chan integrationCandidateEvent, 256)
	controller.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			offerCandidates <- integrationCandidateEvent{done: true}
			return
		}
		value := candidate.ToJSON()
		offerCandidates <- integrationCandidateEvent{candidate: &value}
	})

	offer, err := controller.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create controller offer: %v", err)
	}
	if !bytes.Contains([]byte(offer.SDP), []byte("a=max-message-size:4096")) {
		t.Fatal("controller offer did not advertise the configured max-message-size")
	}
	if err := controller.SetLocalDescription(offer); err != nil {
		t.Fatalf("apply controller offer: %v", err)
	}
	if err := input.writeJSON(recordRemoteDescription, descriptionRecord{Type: "offer", SDP: offer.SDP}); err != nil {
		t.Fatalf("send controller offer: %v", err)
	}

	var controllerCandidatesSent atomic.Int32
	candidateWriterDone := make(chan error, 1)
	go func() {
		for event := range offerCandidates {
			if event.done {
				candidateWriterDone <- nil
				return
			}
			value := event.candidate
			if err := input.writeJSON(recordICECandidate, candidateRecord{
				Candidate:     value.Candidate,
				SDPMid:        value.SDPMid,
				SDPMLineIndex: value.SDPMLineIndex,
			}); err != nil {
				candidateWriterDone <- err
				return
			}
			controllerCandidatesSent.Add(1)
		}
	}()

	readyStates := make(chan stateRecord, 8)
	browserMessages := make(chan []byte, 1)
	outputErrors := make(chan error, 1)
	outputDone := make(chan struct{})
	var sidecarCandidatesReceived atomic.Int32
	go func() {
		defer close(outputDone)
		var pendingCandidates []webrtc.ICECandidateInit
		answerApplied := false
		for {
			record, readErr := readRecord(sidecarOutputReader)
			if readErr != nil {
				if !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrClosedPipe) {
					outputErrors <- readErr
				}
				return
			}
			switch record.typ {
			case recordLocalDescription:
				var answer descriptionRecord
				if decodeErr := decodeStrict(record.payload, &answer); decodeErr != nil {
					outputErrors <- decodeErr
					return
				}
				if answer.Type != "answer" {
					outputErrors <- errors.New("sidecar returned a non-answer description")
					return
				}
				if applyErr := controller.SetRemoteDescription(webrtc.SessionDescription{
					Type: webrtc.SDPTypeAnswer,
					SDP:  answer.SDP,
				}); applyErr != nil {
					outputErrors <- applyErr
					return
				}
				answerApplied = true
				for _, candidate := range pendingCandidates {
					if applyErr := controller.AddICECandidate(candidate); applyErr != nil {
						outputErrors <- applyErr
						return
					}
				}
				pendingCandidates = nil
			case recordLocalCandidate:
				var candidate candidateRecord
				if decodeErr := decodeStrict(record.payload, &candidate); decodeErr != nil {
					outputErrors <- decodeErr
					return
				}
				value := webrtc.ICECandidateInit{
					Candidate:     candidate.Candidate,
					SDPMid:        candidate.SDPMid,
					SDPMLineIndex: candidate.SDPMLineIndex,
				}
				sidecarCandidatesReceived.Add(1)
				if !answerApplied {
					pendingCandidates = append(pendingCandidates, value)
					continue
				}
				if applyErr := controller.AddICECandidate(value); applyErr != nil {
					outputErrors <- applyErr
					return
				}
			case recordState:
				var state stateRecord
				if decodeErr := decodeStrict(record.payload, &state); decodeErr != nil {
					outputErrors <- decodeErr
					return
				}
				if state.State == "failed" {
					outputErrors <- errors.New(state.ReasonCode)
					return
				}
				if state.State == "ready" {
					readyStates <- state
				}
			case recordBinaryOutput:
				browserMessages <- bytes.Clone(record.payload)
			default:
				outputErrors <- errors.New("sidecar emitted an unexpected IPC record")
				return
			}
		}
	}()

	ready := waitForIntegrationReady(t, readyStates, outputErrors, channelErrors)
	if ready.SelectedPair == nil || ready.SelectedPair.Protocol != "udp" {
		t.Fatalf("expected a selected UDP candidate pair, got %#v", ready.SelectedPair)
	}
	if ready.SelectedPair.LocalCandidateType != "host" || ready.SelectedPair.RemoteCandidateType != "host" {
		t.Fatalf("expected a direct host candidate pair, got %#v", ready.SelectedPair)
	}
	select {
	case <-channelOpen:
	case err := <-outputErrors:
		t.Fatalf("sidecar output failed before DataChannel opened: %v", err)
	case err := <-channelErrors:
		t.Fatalf("DataChannel failed to open: %v", err)
	case <-time.After(integrationTimeout):
		t.Fatal("timed out waiting for controller DataChannel to open")
	}

	if controllerCandidatesSent.Load() == 0 || sidecarCandidatesReceived.Load() == 0 {
		t.Fatalf(
			"expected bidirectional trickle ICE, controller sent %d and received %d candidates",
			controllerCandidatesSent.Load(),
			sidecarCandidatesReceived.Load(),
		)
	}

	browserPayload := bytes.Repeat([]byte{0x5a}, maxBrowserMessageBytes)
	var browserChunker chunker
	browserChunks, err := browserChunker.split(browserPayload, chunkPayloadMaxBytes)
	if err != nil {
		t.Fatalf("split browser payload: %v", err)
	}
	for _, chunk := range browserChunks {
		if err := channel.Send(chunk); err != nil {
			t.Fatalf("send browser chunk: %v", err)
		}
	}
	select {
	case received := <-browserMessages:
		if !bytes.Equal(received, browserPayload) {
			t.Fatal("sidecar did not preserve the browser message boundary")
		}
	case err := <-outputErrors:
		t.Fatalf("sidecar failed while receiving browser payload: %v", err)
	case err := <-channelErrors:
		t.Fatalf("DataChannel failed while receiving browser payload: %v", err)
	case <-time.After(integrationTimeout):
		t.Fatal("timed out waiting for sidecar to reassemble browser payload")
	}

	devicePayload := bytes.Repeat([]byte{0xa5}, 32*1024)
	if err := input.write(recordBinaryInput, devicePayload); err != nil {
		t.Fatalf("send device payload to sidecar: %v", err)
	}
	select {
	case received := <-deviceMessages:
		if !bytes.Equal(received.payload, devicePayload) {
			t.Fatal("controller did not preserve the device message boundary")
		}
		if len(received.chunkSizes) < 2 {
			t.Fatalf("expected negotiated fragmentation, got %d DataChannel message", len(received.chunkSizes))
		}
		for _, size := range received.chunkSizes {
			if size > 4096 {
				t.Fatalf("sidecar exceeded negotiated max-message-size: %d", size)
			}
		}
		if received.chunkSizes[0] != 4096 {
			t.Fatalf("sidecar did not use negotiated payload size: first chunk was %d bytes", received.chunkSizes[0])
		}
	case err := <-outputErrors:
		t.Fatalf("sidecar failed while sending device payload: %v", err)
	case err := <-channelErrors:
		t.Fatalf("DataChannel failed while sending device payload: %v", err)
	case <-time.After(integrationTimeout):
		t.Fatal("timed out waiting for controller to reassemble device payload")
	}

	select {
	case err := <-candidateWriterDone:
		if err != nil {
			t.Fatalf("send controller candidates: %v", err)
		}
	case <-time.After(integrationTimeout):
		t.Fatal("timed out waiting for controller ICE gathering to finish")
	}
	if err := input.writeJSON(recordClose, struct{}{}); err != nil {
		t.Fatalf("close sidecar: %v", err)
	}
	select {
	case err := <-runDone:
		if err != nil {
			t.Fatalf("sidecar run failed: %v", err)
		}
	case <-time.After(integrationTimeout):
		t.Fatal("timed out waiting for sidecar shutdown")
	}
	_ = sidecarOutputWriter.Close()
	select {
	case <-outputDone:
	case <-time.After(integrationTimeout):
		t.Fatal("timed out waiting for sidecar output reader shutdown")
	}
}

func waitForIntegrationReady(
	t *testing.T,
	readyStates <-chan stateRecord,
	outputErrors <-chan error,
	channelErrors <-chan error,
) stateRecord {
	t.Helper()
	timer := time.NewTimer(integrationTimeout)
	defer timer.Stop()
	for {
		select {
		case state := <-readyStates:
			if state.SelectedPair != nil {
				return state
			}
		case err := <-outputErrors:
			t.Fatalf("sidecar failed before ready: %v", err)
		case err := <-channelErrors:
			t.Fatalf("DataChannel failed before ready: %v", err)
		case <-timer.C:
			t.Fatal("timed out waiting for sidecar ready state")
		}
	}
}
