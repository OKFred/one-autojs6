package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"

	"github.com/pion/webrtc/v4"
)

const (
	dataChannelLabel         = "scrcpy-binary-v1"
	dataChannelProtocol      = "one-autojs6.scrcpy-binary.v1"
	dataChannelLowWaterBytes = 1 * 1024 * 1024
	dataChannelMaxBuffer     = 8 * 1024 * 1024
	maxBrowserMessageBytes   = 64 * 1024
	maxDeviceMessageBytes    = 4 * 1024 * 1024
)

var stunURLPattern = regexp.MustCompile(`(?i)^stuns?:[^\s?#]+$`)

type stringList []string

func (values *stringList) UnmarshalJSON(data []byte) error {
	var single string
	if err := json.Unmarshal(data, &single); err == nil {
		*values = []string{single}
		return nil
	}
	var multiple []string
	if err := json.Unmarshal(data, &multiple); err != nil {
		return errors.New("ICE urls must be a string or string array")
	}
	*values = multiple
	return nil
}

type iceServerConfig struct {
	URLs stringList `json:"urls"`
}

type configureRecord struct {
	ICEServers []iceServerConfig `json:"iceServers"`
}

type descriptionRecord struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type candidateRecord struct {
	Candidate     string  `json:"candidate"`
	SDPMid        *string `json:"sdpMid,omitempty"`
	SDPMLineIndex *uint16 `json:"sdpMLineIndex,omitempty"`
}

type selectedPairRecord struct {
	LocalCandidateType  string `json:"localCandidateType"`
	RemoteCandidateType string `json:"remoteCandidateType"`
	Protocol            string `json:"protocol"`
}

type stateRecord struct {
	State        string              `json:"state"`
	ReasonCode   string              `json:"reasonCode,omitempty"`
	SelectedPair *selectedPairRecord `json:"selectedPair,omitempty"`
}

type rtcPeer struct {
	writer       *recordWriter
	connection   *webrtc.PeerConnection
	channel      *webrtc.DataChannel
	chunker      chunker
	assembler    *chunkAssembler
	mu           sync.Mutex
	fatalOnce    sync.Once
	fatalErrors  chan error
	lastState    string
	configured   bool
	offerApplied bool
	closed       bool
	chunkPayload int
}

func newRTCPeer(output io.Writer) *rtcPeer {
	peer := &rtcPeer{
		writer:       &recordWriter{output: output},
		fatalErrors:  make(chan error, 1),
		chunkPayload: chunkPayloadMaxBytes,
	}
	peer.assembler = newChunkAssembler(maxBrowserMessageBytes, func() {
		peer.fail("RTC_CHUNK_TIMEOUT")
	})
	return peer
}

func decodeStrict(payload []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("JSON record contains trailing data")
	}
	return nil
}

func (peer *rtcPeer) configure(payload []byte) error {
	peer.mu.Lock()
	if peer.configured || peer.closed {
		peer.mu.Unlock()
		return errors.New("sidecar configure sequence is invalid")
	}
	peer.configured = true
	peer.mu.Unlock()
	var input configureRecord
	if err := decodeStrict(payload, &input); err != nil {
		return fmt.Errorf("decode configure record: %w", err)
	}
	if len(input.ICEServers) < 1 || len(input.ICEServers) > 4 {
		return errors.New("one to four STUN servers are required")
	}
	configuration := webrtc.Configuration{ICEServers: make([]webrtc.ICEServer, 0, len(input.ICEServers))}
	for _, server := range input.ICEServers {
		if len(server.URLs) < 1 || len(server.URLs) > 4 {
			return errors.New("one to four STUN URLs are required")
		}
		urls := make([]string, len(server.URLs))
		for index, value := range server.URLs {
			if len(value) < 6 || len(value) > 2048 || !stunURLPattern.MatchString(value) {
				return errors.New("only bounded STUN URLs are supported")
			}
			urls[index] = value
		}
		configuration.ICEServers = append(configuration.ICEServers, webrtc.ICEServer{URLs: urls})
	}
	connection, err := webrtc.NewPeerConnection(configuration)
	if err != nil {
		return fmt.Errorf("create PeerConnection: %w", err)
	}
	peer.connection = connection
	connection.OnICECandidate(peer.onICECandidate)
	connection.OnDataChannel(peer.onDataChannel)
	connection.OnConnectionStateChange(peer.onConnectionState)
	return nil
}

func (peer *rtcPeer) applyOffer(payload []byte) error {
	peer.mu.Lock()
	if !peer.configured || peer.offerApplied || peer.closed {
		peer.mu.Unlock()
		return errors.New("remote description sequence is invalid")
	}
	peer.offerApplied = true
	peer.mu.Unlock()
	var input descriptionRecord
	if err := decodeStrict(payload, &input); err != nil {
		return fmt.Errorf("decode remote description: %w", err)
	}
	if input.Type != "offer" || len(input.SDP) < 1 || len(input.SDP) > 48*1024 {
		return errors.New("remote description must be a bounded offer")
	}
	if err := peer.connection.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  input.SDP,
	}); err != nil {
		return fmt.Errorf("apply remote offer: %w", err)
	}
	answer, err := peer.connection.CreateAnswer(nil)
	if err != nil {
		return fmt.Errorf("create answer: %w", err)
	}
	if err := peer.connection.SetLocalDescription(answer); err != nil {
		return fmt.Errorf("apply local answer: %w", err)
	}
	local := peer.connection.LocalDescription()
	if local == nil {
		return errors.New("local answer is unavailable")
	}
	return peer.writeJSON(recordLocalDescription, descriptionRecord{
		Type: "answer",
		SDP:  local.SDP,
	})
}

func (peer *rtcPeer) addCandidate(payload []byte) error {
	peer.mu.Lock()
	validSequence := peer.configured && peer.offerApplied && !peer.closed
	peer.mu.Unlock()
	if !validSequence {
		return errors.New("remote candidate sequence is invalid")
	}
	var input candidateRecord
	if err := decodeStrict(payload, &input); err != nil {
		return fmt.Errorf("decode remote candidate: %w", err)
	}
	if len(input.Candidate) > 4096 || (input.SDPMid != nil && len(*input.SDPMid) > 256) {
		return errors.New("remote candidate exceeds limit")
	}
	return peer.connection.AddICECandidate(webrtc.ICECandidateInit{
		Candidate:     input.Candidate,
		SDPMid:        input.SDPMid,
		SDPMLineIndex: input.SDPMLineIndex,
	})
}

func (peer *rtcPeer) sendBinary(payload []byte) error {
	if len(payload) < 1 || len(payload) > maxDeviceMessageBytes {
		return errors.New("device frame exceeds limit")
	}
	peer.mu.Lock()
	channel := peer.channel
	closed := peer.closed
	payloadMaxBytes := peer.chunkPayload
	peer.mu.Unlock()
	if closed || channel == nil || channel.ReadyState() != webrtc.DataChannelStateOpen {
		return errors.New("data channel is not open")
	}
	chunks, err := peer.chunker.split(payload, payloadMaxBytes)
	if err != nil {
		return err
	}
	wireBytes := len(payload) + len(chunks)*chunkHeaderBytes
	if channel.BufferedAmount()+uint64(wireBytes) > dataChannelMaxBuffer {
		return errors.New("data channel backpressure limit reached")
	}
	for _, chunk := range chunks {
		if err := channel.Send(chunk); err != nil {
			return fmt.Errorf("send data-channel chunk: %w", err)
		}
	}
	return nil
}

func (peer *rtcPeer) onICECandidate(candidate *webrtc.ICECandidate) {
	if candidate == nil {
		return
	}
	value := candidate.ToJSON()
	if err := peer.writeJSON(recordLocalCandidate, candidateRecord{
		Candidate:     value.Candidate,
		SDPMid:        value.SDPMid,
		SDPMLineIndex: value.SDPMLineIndex,
	}); err != nil {
		return
	}
}

func (peer *rtcPeer) onDataChannel(channel *webrtc.DataChannel) {
	if channel.Label() != dataChannelLabel ||
		channel.Protocol() != dataChannelProtocol ||
		!channel.Ordered() ||
		channel.MaxPacketLifeTime() != nil ||
		channel.MaxRetransmits() != nil ||
		channel.Negotiated() {
		peer.fail("RTC_DATA_CHANNEL_INVALID")
		_ = channel.Close()
		return
	}
	peer.mu.Lock()
	if peer.channel != nil || peer.closed {
		peer.mu.Unlock()
		peer.fail("RTC_DATA_CHANNEL_DUPLICATE")
		_ = channel.Close()
		return
	}
	peer.channel = channel
	peer.mu.Unlock()
	channel.SetBufferedAmountLowThreshold(dataChannelLowWaterBytes)
	channel.OnOpen(func() {
		maxMessageSize := peer.connection.SCTP().GetCapabilities().MaxMessageSize
		peer.mu.Lock()
		if maxMessageSize > 0 {
			if maxMessageSize <= chunkHeaderBytes {
				peer.mu.Unlock()
				peer.fail("RTC_MAX_MESSAGE_SIZE_TOO_SMALL")
				return
			}
			if negotiatedPayload := int(maxMessageSize) - chunkHeaderBytes; negotiatedPayload < peer.chunkPayload {
				peer.chunkPayload = negotiatedPayload
			}
		}
		peer.mu.Unlock()
		selectedPair := peer.selectedPair()
		peer.emitState(stateRecord{State: "ready", SelectedPair: selectedPair})
	})
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		if message.IsString {
			peer.fail("RTC_TEXT_FRAME_REJECTED")
			return
		}
		content, err := peer.assembler.push(message.Data)
		if err != nil {
			peer.fail("RTC_CHUNK_INVALID")
			return
		}
		if content != nil {
			if err := peer.write(recordBinaryOutput, content); err != nil {
				return
			}
		}
	})
	channel.OnError(func(error) {
		peer.fail("RTC_DATA_CHANNEL_FAILED")
	})
	channel.OnClose(func() {
		peer.emitState(stateRecord{State: "closed", ReasonCode: "RTC_DATA_CHANNEL_CLOSED"})
	})
}

func (peer *rtcPeer) selectedPair() *selectedPairRecord {
	if peer.connection == nil || peer.connection.SCTP() == nil || peer.connection.SCTP().Transport() == nil {
		return nil
	}
	pair, err := peer.connection.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil || pair.Remote == nil {
		return nil
	}
	protocol := strings.ToLower(pair.Local.Protocol.String())
	if protocol != "udp" && protocol != "tcp" {
		return nil
	}
	return &selectedPairRecord{
		LocalCandidateType:  pair.Local.Typ.String(),
		RemoteCandidateType: pair.Remote.Typ.String(),
		Protocol:            protocol,
	}
}

func (peer *rtcPeer) onConnectionState(state webrtc.PeerConnectionState) {
	switch state {
	case webrtc.PeerConnectionStateConnected:
		peer.mu.Lock()
		channel := peer.channel
		peer.mu.Unlock()
		if channel != nil && channel.ReadyState() == webrtc.DataChannelStateOpen {
			peer.emitState(stateRecord{State: "ready", SelectedPair: peer.selectedPair()})
		}
	case webrtc.PeerConnectionStateDisconnected:
		peer.emitState(stateRecord{State: "disconnected", ReasonCode: "RTC_DISCONNECTED"})
	case webrtc.PeerConnectionStateFailed:
		peer.fail("RTC_CONNECTION_FAILED")
	case webrtc.PeerConnectionStateClosed:
		peer.emitState(stateRecord{State: "closed", ReasonCode: "RTC_CONNECTION_CLOSED"})
	default:
	}
}

func (peer *rtcPeer) emitState(state stateRecord) {
	peer.mu.Lock()
	if peer.closed {
		peer.mu.Unlock()
		return
	}
	if peer.lastState == state.State && state.State != "ready" {
		peer.mu.Unlock()
		return
	}
	peer.lastState = state.State
	peer.mu.Unlock()
	if err := peer.writeJSON(recordState, state); err != nil {
		return
	}
}

func (peer *rtcPeer) fail(reasonCode string) {
	peer.emitState(stateRecord{State: "failed", ReasonCode: reasonCode})
}

func (peer *rtcPeer) write(typ byte, payload []byte) error {
	err := peer.writer.write(typ, payload)
	if err != nil {
		peer.handleOutputFailure(typ, err)
	}
	return err
}

func (peer *rtcPeer) writeJSON(typ byte, value any) error {
	err := peer.writer.writeJSON(typ, value)
	if err != nil {
		peer.handleOutputFailure(typ, err)
	}
	return err
}

func (peer *rtcPeer) handleOutputFailure(recordType byte, outputErr error) {
	peer.fatalOnce.Do(func() {
		fatalErr := fmt.Errorf("write IPC record 0x%02x: %w", recordType, outputErr)
		peer.mu.Lock()
		peer.closed = true
		peer.lastState = "failed"
		connection := peer.connection
		peer.mu.Unlock()
		peer.assembler.close()
		if recordType != recordState {
			if stateErr := peer.writer.writeJSON(recordState, stateRecord{
				State:      "failed",
				ReasonCode: "RTC_IPC_WRITE_FAILED",
			}); stateErr != nil {
				fatalErr = fmt.Errorf("%w; report IPC failure state: %v", fatalErr, stateErr)
			}
		}
		peer.fatalErrors <- fatalErr
		if connection != nil {
			_ = connection.Close()
		}
	})
}

func (peer *rtcPeer) close() error {
	peer.mu.Lock()
	if peer.closed {
		peer.mu.Unlock()
		return nil
	}
	peer.closed = true
	connection := peer.connection
	peer.mu.Unlock()
	peer.assembler.close()
	if connection != nil {
		return connection.Close()
	}
	return nil
}

func (peer *rtcPeer) handle(record ipcRecord) (bool, error) {
	switch record.typ {
	case recordConfigure:
		return false, peer.configure(record.payload)
	case recordRemoteDescription:
		return false, peer.applyOffer(record.payload)
	case recordICECandidate:
		return false, peer.addCandidate(record.payload)
	case recordBinaryInput:
		if err := peer.sendBinary(record.payload); err != nil {
			peer.fail("RTC_SEND_FAILED")
			return false, err
		}
		return false, nil
	case recordClose:
		var value struct{}
		if err := decodeStrict(record.payload, &value); err != nil {
			return false, fmt.Errorf("decode close record: %w", err)
		}
		return true, peer.close()
	default:
		return false, errors.New("unsupported IPC record type")
	}
}
