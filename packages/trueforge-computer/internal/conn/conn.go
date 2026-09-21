// Package conn owns the socket: it dials the relay, answers requests on it, and decides what
// a close code means for the next attempt.
package conn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"trueforge.dev/computer/internal/protocol"
)

// ErrRevoked ends the loop for good; the caller turns it into exit code 3.
var ErrRevoked = errors.New("the machine credential was revoked")

// ConnectPath is the relay's upgrade endpoint.
const ConnectPath = "/api/v1/computers/connect"

const (
	defaultDialTimeout = 20 * time.Second
	// A connection that lasted this long counts as healthy, which is the only thing that
	// resets the backoff step.
	defaultStableAfter = 60 * time.Second
	// The read limit is generous but finite: a relay that sends more than this is broken, and
	// the client should not try to buffer it.
	readLimitBytes = 8 << 20
	writeTimeout   = 30 * time.Second
)

// Dispatcher answers one request frame. It returns the bytes to write back, or nil to say
// nothing at all.
type Dispatcher func(ctx context.Context, head protocol.Envelope, frame []byte) []byte

type Options struct {
	BaseURL    string
	Credential string
	Hello      protocol.Hello
	Dispatch   Dispatcher
	// OnDisconnect runs after every session ends, so half-finished uploads can be dropped.
	OnDisconnect func()
	// OnReplyDropped runs when an answer could not be written because its socket had closed.
	// The work is already done and its outcome is now unknown to the server.
	OnReplyDropped func(head protocol.Envelope, cause error)
	Logger         *slog.Logger

	DialTimeout       time.Duration
	HeartbeatInterval time.Duration
	ReadDeadline      time.Duration
	StableAfter       time.Duration
	// Sleep is injected by tests so the reconnect policy can be exercised in milliseconds.
	Sleep func(ctx context.Context, d time.Duration) error
	// Jitter is injected by tests; it returns a value in [0, n).
	Jitter jitterFunc
}

type Client struct {
	options Options
	dialURL string
	logger  *slog.Logger

	// writeMu serialises frame writes: handlers answer from their own goroutines.
	writeMu sync.Mutex
}

func New(options Options) (*Client, error) {
	if options.Dispatch == nil {
		return nil, errors.New("a dispatcher is required")
	}
	if options.Credential == "" {
		return nil, errors.New("a machine credential is required")
	}
	dialURL, err := DialURL(options.BaseURL)
	if err != nil {
		return nil, err
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	if options.DialTimeout <= 0 {
		options.DialTimeout = defaultDialTimeout
	}
	if options.HeartbeatInterval <= 0 {
		options.HeartbeatInterval = protocol.HeartbeatIntervalMS * time.Millisecond
	}
	if options.ReadDeadline <= 0 {
		// Roughly two heartbeats: below that a slow network looks like a dead peer, above it a
		// half-open socket stays invisible.
		options.ReadDeadline = 2*options.HeartbeatInterval + 5*time.Second
	}
	if options.StableAfter <= 0 {
		options.StableAfter = defaultStableAfter
	}
	if options.Sleep == nil {
		options.Sleep = sleepContext
	}
	if options.Jitter == nil {
		// #nosec G404 -- jitter, not a security decision.
		options.Jitter = func(n int64) int64 { return rand.Int63n(max(n, 1)) }
	}
	if options.OnDisconnect == nil {
		options.OnDisconnect = func() {}
	}
	if options.OnReplyDropped == nil {
		options.OnReplyDropped = func(protocol.Envelope, error) {}
	}
	return &Client{options: options, dialURL: dialURL, logger: options.Logger}, nil
}

// DialURL turns a base URL into the WebSocket endpoint. The credential travels in a header,
// never in the URL, so it cannot end up in an access log.
func DialURL(baseURL string) (string, error) {
	trimmed := strings.TrimSuffix(strings.TrimSpace(baseURL), "/")
	if trimmed == "" {
		return "", errors.New("a server URL is required")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("parse the server URL %q: %w", baseURL, err)
	}
	switch parsed.Scheme {
	case "https", "wss":
		parsed.Scheme = "wss"
	case "http", "ws":
		parsed.Scheme = "ws"
	default:
		return "", fmt.Errorf("the server URL %q must be http(s) or ws(s)", baseURL)
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("the server URL %q has no host", baseURL)
	}
	parsed.Path = strings.TrimSuffix(parsed.Path, "/") + ConnectPath
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

// Run dials until the context ends or the credential is revoked.
func (c *Client) Run(ctx context.Context) error {
	step := 0
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		startedAt := time.Now()
		err := c.session(ctx)
		lasted := time.Since(startedAt)
		if ctx.Err() != nil {
			return ctx.Err()
		}

		kind := classify(err)
		if kind == kindRevoked {
			c.logger.Error("the machine credential was revoked; this computer will not reconnect",
				"lasted_s", lasted.Seconds())
			return ErrRevoked
		}

		var delay time.Duration
		delay, step = nextDelay(kind, step, lasted, c.options.StableAfter, c.options.Jitter)
		c.logReconnect(kind, err, lasted, delay, step)
		if err := c.options.Sleep(ctx, delay); err != nil {
			return err
		}
	}
}

func (c *Client) logReconnect(kind closeKind, err error, lasted time.Duration, delay time.Duration, step int) {
	fields := []any{"error", errorText(err), "lasted_s", lasted.Seconds(), "delay_s", delay.Seconds(), "step", step}
	switch kind {
	case kindReplaced:
		c.logger.Error("another connection took this credential over; waiting before trying again so the two do not evict each other", fields...)
	case kindUnauthorized:
		c.logger.Error("the server refused the machine credential; retrying slowly", fields...)
	case kindRevoked, kindTransient:
		c.logger.Warn("disconnected; reconnecting", fields...)
	}
}

func (c *Client) session(parent context.Context) error {
	dialCtx, cancelDial := context.WithTimeout(parent, c.options.DialTimeout)
	socket, response, err := websocket.Dial(dialCtx, c.dialURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + c.options.Credential}},
	})
	cancelDial()
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
			_ = response.Body.Close()
		}
		return &upgradeError{status: status, err: fmt.Errorf("dial %s: %w", c.dialURL, err)}
	}
	socket.SetReadLimit(readLimitBytes)

	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	defer func() {
		_ = socket.CloseNow()
		c.options.OnDisconnect()
	}()
	c.logger.Info("connected", "url", c.dialURL)

	helloFrame, err := json.Marshal(c.options.Hello)
	if err != nil {
		return fmt.Errorf("encode hello: %w", err)
	}
	if err := c.write(ctx, socket, helloFrame); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}

	pong := make(chan struct{}, 8)
	heartbeatCtx, stopHeartbeats := context.WithCancel(ctx)
	defer stopHeartbeats()
	go c.heartbeat(heartbeatCtx, socket, pong)

	for {
		readCtx, cancelRead := context.WithTimeout(ctx, c.options.ReadDeadline)
		kind, payload, err := socket.Read(readCtx)
		cancelRead()
		if err != nil {
			return err
		}
		if kind != websocket.MessageText {
			continue
		}
		switch string(payload) {
		case protocol.HeartbeatPong:
			select {
			case pong <- struct{}{}:
			default:
			}
			continue
		case protocol.HeartbeatPing:
			// The relay answers our pings without waking, and does not send its own; answering
			// one anyway costs nothing and keeps a different relay working.
			if err := c.write(ctx, socket, []byte(protocol.HeartbeatPong)); err != nil {
				return err
			}
			continue
		}
		go c.handle(ctx, socket, payload)
	}
}

// heartbeat pings on a timer and closes the socket when two pings go unanswered. Without this
// a half-open socket, which is what a suspended laptop leaves behind, reads as connected.
func (c *Client) heartbeat(ctx context.Context, socket *websocket.Conn, pong <-chan struct{}) {
	ticker := time.NewTicker(c.options.HeartbeatInterval)
	defer ticker.Stop()
	missed := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-pong:
			missed = 0
		case <-ticker.C:
			if err := c.write(ctx, socket, []byte(protocol.HeartbeatPing)); err != nil {
				return
			}
			missed++
			if missed >= 2 {
				c.logger.Warn("no answer to two heartbeats; closing a socket that is probably half open")
				_ = socket.Close(websocket.StatusPolicyViolation, "no heartbeat answer")
				return
			}
		}
	}
}

// handle answers one request on the socket it arrived on. A reply whose socket has closed is
// dropped rather than written to a newer one, so the relay never sees an answer it cannot
// match; the relay may reissue the request, which makes every op at-least-once.
func (c *Client) handle(ctx context.Context, socket *websocket.Conn, payload []byte) {
	var head protocol.Envelope
	if err := json.Unmarshal(payload, &head); err != nil || head.ID == "" {
		c.logger.Warn("dropping a frame that is not a request", "error", errorText(err))
		return
	}
	answer := c.options.Dispatch(ctx, head, payload)
	if answer == nil {
		return
	}
	// The platform closes the whole socket on an oversized frame, taking every other request
	// on this computer with it, so an answer that big is refused here instead.
	if len(answer) > protocol.MaxFrameBytes {
		c.logger.Error("refusing to send an oversized reply", "id", head.ID, "bytes", len(answer))
		answer = protocol.EncodeError(head.ID, protocol.ErrFrameTooBig,
			fmt.Sprintf("the reply is %d bytes, over the %d frame limit", len(answer), protocol.MaxFrameBytes))
	}
	if err := c.write(ctx, socket, answer); err != nil {
		c.options.OnReplyDropped(head, err)
	}
}

func (c *Client) write(ctx context.Context, socket *websocket.Conn, payload []byte) error {
	if len(payload) > protocol.MaxFrameBytes {
		return fmt.Errorf("refusing a %d byte frame, over the %d limit", len(payload), protocol.MaxFrameBytes)
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return socket.Write(writeCtx, websocket.MessageText, payload)
}

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func errorText(err error) string {
	if err == nil {
		return "clean close"
	}
	return err.Error()
}
